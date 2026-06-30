import { randomUUID } from 'crypto';
import type { ProductionDoc, SourceDoc, GraphicDoc, StromFlowTemplate, OutputDoc } from '../db/types.js';
import { getSourcesDb, getTemplatesDb, getGraphicsDb } from '../db/index.js';
import { StromClient } from './strom.js';

/**
 * Generates a Strom flow from a template + source assignments,
 * creates it in Strom, starts it, and returns the flow ID.
 *
 * Throws if no templateId is set, template is not found,
 * or Strom creation/start fails.
 */
export interface ActivationResult {
  flowId: string;
  mixerBlockId: string | null;
  audioMixerBlockId: string | null;
  whepOutputEntries?: Array<{ outputId: string; endpointId: string }>;
  pgmWhepEndpointId?: string;
  /** Maps mixerInput (e.g. 'video_in_1') → time_offset block ID — so the WS layer can apply live offset changes */
  sourceOffsetBlockIds: Record<string, string>;
}

function findPgmFeedPad(flow: StromFlowTemplate['flow']): string | null {
  const existingOutput = flow.blocks.find(
    (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.mpegtssrt_output',
  ) as Record<string, unknown> | undefined;
  if (existingOutput) {
    const outputId = existingOutput['id'] as string;
    const feedLink = flow.links.find((link) => {
      const l = link as Record<string, unknown>;
      return ((l['to'] as string | undefined) ?? '').startsWith(`${outputId}:`);
    }) as Record<string, unknown> | undefined;
    if (feedLink) return feedLink['from'] as string;
  }
  const encPgm = flow.blocks.find(
    (b) =>
      (b as Record<string, unknown>)['block_definition_id'] === 'builtin.videoenc' &&
      (b as Record<string, unknown>)['name'] === 'Enc PGM',
  ) as Record<string, unknown> | undefined;
  if (encPgm) return `${encPgm['id'] as string}:video_out`;
  return null;
}

function insertPreEncoderFormat(
  flow: StromFlowTemplate['flow'],
  endpointSuffix: string,
): void {
  const mixer = flow.blocks.find((b) =>
    (b as Record<string, unknown>)['block_definition_id'] === 'builtin.vision_mixer',
  ) as Record<string, unknown> | undefined;
  if (!mixer) return;
  const mixerId = mixer['id'] as string;

  const encoders = [
    { name: 'Enc PGM',  mixerPad: 'pgm_out',  encPad: 'video_in' },
    { name: 'Enc MV',   mixerPad: 'multiview_out', encPad: 'video_in' },
  ];

  for (const enc of encoders) {
    const encBlock = flow.blocks.find((b) =>
      (b as Record<string, unknown>)['block_definition_id'] === 'builtin.videoenc' &&
      (b as Record<string, unknown>)['name'] === enc.name,
    ) as Record<string, unknown> | undefined;
    if (!encBlock) continue;

    const encId = encBlock['id'] as string;
    const fmtId = `b-fmt-${enc.name.toLowerCase().replace(/\s+/g, '-')}-${endpointSuffix}`;

    const existingLink = flow.links.findIndex((link) => {
      const l = link as Record<string, unknown>;
      return l['from'] === `${mixerId}:${enc.mixerPad}` && l['to'] === `${encId}:${enc.encPad}`;
    });
    if (existingLink === -1) continue;

    flow.links.splice(existingLink, 1);

    flow.blocks.push({
      id: fmtId,
      block_definition_id: 'builtin.videoformat',
      name: `Format ${enc.name}`,
      properties: { format: 'NV12' },
      position: { x: 400, y: enc.name === 'Enc PGM' ? 50 : 600 },
    } as any);

    flow.links.push(
      { from: `${mixerId}:${enc.mixerPad}`, to: `${fmtId}:video_in` },
      { from: `${fmtId}:video_out`, to: `${encId}:${enc.encPad}` },
    );
  }
}

export async function activateStromFlow(
  production: ProductionDoc,
  strom: StromClient,
  stromUrl?: string,
  outputDocs?: OutputDoc[],
): Promise<ActivationResult> {
  if (!production.templateId) {
    // Fall back to the default vision mixer template.
    production.templateId = 'tmpl-default-vision-mixer';
  }

  // Load template
  const templatesDb = getTemplatesDb();
  const template = await templatesDb.get(production.templateId) as unknown as StromFlowTemplate;

  // Virtual source IDs for test streams — no DB lookup needed
  const VIRTUAL_SOURCES: Record<string, Pick<SourceDoc, 'streamType' | 'address' | 'name'>> = {
    'Whip': { streamType: 'whip', address: '', name: 'WHIP Input' },
    '__test1__': { streamType: 'test1', address: '', name: 'Test - Pinwheel' },
    '__test2__': { streamType: 'test2', address: '', name: 'Test - Colors' },
  };

  // Load all assigned real sources
  const sourcesDb = getSourcesDb();
  const sourceMap = new Map<string, SourceDoc>();
  for (const assignment of production.sources) {
    if (assignment.sourceId in VIRTUAL_SOURCES) continue;
    const src = await sourcesDb.get(assignment.sourceId) as unknown as SourceDoc;
    sourceMap.set(assignment.sourceId, src);
  }

  // Deep-clone the template flow so we don't mutate the stored template
  const flow = JSON.parse(JSON.stringify(template.flow)) as StromFlowTemplate['flow'];

  // Derive a per-production suffix from the production ID so that WHEP endpoint
  // names and SRT output ports are unique — multiple productions can run
  // simultaneously without conflicting on shared resources.
  const endpointSuffix = production._id.replace(/^prod-/, '').slice(0, 8);

  // Remap all template block/element IDs to fresh random values so that two
  // productions running concurrently don't share element names in Strom's
  // global GStreamer pipeline context, which requires unique element names.
  {
    const idMap = new Map<string, string>();
    for (const b of flow.blocks) {
      const old = (b as Record<string, unknown>)['id'] as string | undefined;
      if (old) { const n = randomUUID().replace(/-/g, ''); idMap.set(old, n); (b as Record<string, unknown>)['id'] = n; }
    }
    for (const e of flow.elements) {
      const old = (e as Record<string, unknown>)['id'] as string | undefined;
      if (old) { const n = randomUUID().replace(/-/g, ''); idMap.set(old, n); (e as Record<string, unknown>)['id'] = n; }
    }
    // Patch links: "blockId:pad" → "newId:pad"
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      for (const side of ['from', 'to'] as const) {
        const val = l[side] as string | undefined;
        if (!val) continue;
        const colonIdx = val.indexOf(':');
        const blockId = colonIdx >= 0 ? val.slice(0, colonIdx) : val;
        const pad = colonIdx >= 0 ? val.slice(colonIdx) : '';
        const mapped = idMap.get(blockId);
        if (mapped) l[side] = mapped + pad;
      }
    }
  }

  // Resolve pgm_resolution: production.values takes precedence over the template
  // mixer block's default — avoids in-mixer upscaling on static inputs (test
  // sources) which causes QoS/videoconvert falling-behind events.
  const pgmResolution = (() => {
    if (typeof production.values?.pgm_resolution === 'string') return production.values.pgm_resolution;
    const mixer = flow.blocks.find(
      (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.vision_mixer',
    ) as Record<string, unknown> | undefined;
    const p = (mixer?.['properties'] ?? {}) as Record<string, unknown>;
    return typeof p['pgm_resolution'] === 'string' ? p['pgm_resolution'] : '1280x720';
  })();

  const pgmBitrate = typeof production.values?.bitrate === 'number' ? production.values.bitrate : undefined;
  const pgmFramerate = typeof production.values?.pgm_framerate === 'string' ? production.values.pgm_framerate : undefined;
  const multiviewResolution = typeof production.values?.multiview_resolution === 'string' ? production.values.multiview_resolution : undefined;
  const multiviewFramerate = typeof production.values?.multiview_framerate === 'string' ? production.values.multiview_framerate : undefined;

  for (const block of flow.blocks) {
    const b = block as Record<string, unknown>;
    const props = (b['properties'] ?? {}) as Record<string, unknown>;

    if (b['block_definition_id'] === 'builtin.vision_mixer') {
      props['pgm_resolution'] = pgmResolution;
      if (pgmFramerate !== undefined) props['pgm_framerate'] = pgmFramerate;
      if (multiviewResolution !== undefined) props['multiview_resolution'] = multiviewResolution;
      if (multiviewFramerate !== undefined) props['multiview_framerate'] = multiviewFramerate;
      b['properties'] = props;
    }

    if (b['block_definition_id'] === 'builtin.videoformat') {
      props['resolution'] = pgmResolution;
      b['properties'] = props;
    }

    if (b['block_definition_id'] === 'builtin.videoenc' && pgmBitrate !== undefined) {
      if ((b['name'] as string | undefined) === 'Enc PGM') {
        props['bitrate'] = pgmBitrate;
        b['properties'] = props;
      }
    }

    // Uniquify WHEP endpoint_ids per production so concurrent productions don't
    // collide on the same WHEP stream name.
    if (b['block_definition_id'] === 'builtin.whep_output') {
      if (typeof props['endpoint_id'] === 'string') {
        props['endpoint_id'] = `${props['endpoint_id']}-${endpointSuffix}`;
      }
      b['properties'] = props;
    }
  }

  // Insert a videoformat block (NV12) between vision mixer PGM output and
  // the encoder. This ensures proper pixel format negotiation, especially
  // for DeckLink sources which output UYVY that some encoders can't handle.
  insertPreEncoderFormat(flow, endpointSuffix);

  // Extract the PGM WHEP endpoint_id (now uniquified to 'pgm-{suffix}') so the
  // activation route can construct the full WHEP URL for the production doc.
  let pgmWhepEndpointId: string | undefined;
  for (const block of flow.blocks) {
    const b = block as Record<string, unknown>;
    if (
      b['block_definition_id'] === 'builtin.whep_output' &&
      (b['name'] as string | undefined) === 'PGM Output'
    ) {
      const props = (b['properties'] ?? {}) as Record<string, unknown>;
      if (typeof props['endpoint_id'] === 'string') pgmWhepEndpointId = props['endpoint_id'];
      break;
    }
  }

  // Find the PGM feed pad before stripping program output blocks.
  // builtin.whep_output is intentionally kept — it carries the multiview stream
  // that the controller's WHEP viewer connects to via /blocks/{id}/multiview-endpoint.
  const pgmFeedPad = findPgmFeedPad(flow);

  // Strip only SRT/EFP program output blocks from the template.
  // User-assigned outputs are injected below; the template's WHEP block stays.
  const OUTPUT_BLOCK_DEFS = new Set([
    'builtin.mpegtssrt_output',
    'builtin.efpsrt_output',
    'builtin.ndi_output',
    'builtin.decklink_output',
  ]);
  const strippedOutputIds = new Set<string>(
    (flow.blocks as Record<string, unknown>[])
      .filter((b) => OUTPUT_BLOCK_DEFS.has(b['block_definition_id'] as string))
      .map((b) => b['id'] as string),
  );
  flow.blocks = flow.blocks.filter((b) => !strippedOutputIds.has((b as Record<string, unknown>)['id'] as string));
  flow.links = flow.links.filter((link) => {
    const l = link as Record<string, unknown>;
    const fromId = ((l['from'] as string | undefined) ?? '').split(':')[0];
    const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
    return !strippedOutputIds.has(fromId) && !strippedOutputIds.has(toId);
  });

  // Find the vision mixer block
  const mixerBlock = flow.blocks.find(
    (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.vision_mixer',
  ) as Record<string, unknown> | undefined;
  const mixerBlockId = typeof mixerBlock?.['id'] === 'string' ? mixerBlock['id'] : null;

  // Find the audio mixer block (may not exist in older templates)
  const audioMixerBlock = flow.blocks.find(
    (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.mixer',
  ) as Record<string, unknown> | undefined;
  const audioMixerBlockId = typeof audioMixerBlock?.['id'] === 'string' ? audioMixerBlock['id'] : null;

  // Re-wire all WHEP outputs to the audio mixer main_out (AFV-controlled program mix).
  // AUX 1 / AUX 2 are independent monitor buses routed to their own aux_out pads —
  // they are not exposed via WHEP (Strom's whepserversink only supports a single
  // audio track). When Strom adds multi-track WHEP, route aux buses as separate tracks.
  if (audioMixerBlockId) {
    for (const block of flow.blocks) {
      const b = block as Record<string, unknown>;
      if (b['block_definition_id'] !== 'builtin.whep_output') continue;
      const whepId = b['id'] as string;
      flow.links = (flow.links as Array<Record<string, unknown>>).filter(
        (l) => !((l['to'] as string | undefined) ?? '').startsWith(`${whepId}:audio`),
      );
      flow.links.push({ from: `${audioMixerBlockId}:main_out`, to: `${whepId}:audio_in` });
    }
  }

  // Strip ALL inputs wired to video_in_N pads on the mixer (dynamic blocks AND
  // static template placeholders like videotestsrc). We rebuild all video inputs
  // from production.sources, so the template's static elements must be removed.
  const DYNAMIC_INPUT_BLOCK_DEFS = new Set(['builtin.mpegtssrt_input', 'builtin.efpsrt_input', 'builtin.whip_input', 'builtin.ndi_input', 'builtin.decklink_input']);
  const strippedVideoInputIds = new Set<string>();

  // Collect dynamic block IDs (mpegtssrt_input, whip_input)
  for (const block of flow.blocks) {
    const b = block as Record<string, unknown>;
    if (DYNAMIC_INPUT_BLOCK_DEFS.has(b['block_definition_id'] as string)) {
      strippedVideoInputIds.add(b['id'] as string);
    }
  }

  // Collect static elements/blocks directly wired to video_in_N (e.g. format blocks)
  if (mixerBlockId) {
    const videoInPattern = new RegExp(`^${mixerBlockId}:video_in_\\d+$`);
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      if (videoInPattern.test((l['to'] as string | undefined) ?? '')) {
        strippedVideoInputIds.add(((l['from'] as string | undefined) ?? '').split(':')[0]);
      }
    }
    // One more level back: strip raw elements wired INTO those format blocks
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
      if (strippedVideoInputIds.has(toId)) {
        strippedVideoInputIds.add(((l['from'] as string | undefined) ?? '').split(':')[0]);
      }
    }
  }

  flow.blocks = flow.blocks.filter((b) => !strippedVideoInputIds.has((b as Record<string, unknown>)['id'] as string));
  flow.elements = flow.elements.filter((el) => !strippedVideoInputIds.has((el as Record<string, unknown>)['id'] as string));
  flow.links = flow.links.filter((link) => {
    const l = link as Record<string, unknown>;
    const fromId = ((l['from'] as string | undefined) ?? '').split(':')[0];
    const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
    return !strippedVideoInputIds.has(fromId) && !strippedVideoInputIds.has(toId);
  });

  // Dynamically generate input blocks based on each source's streamType and wire
  // them to the correct mixer pad.
  const sortedAssignments = [...production.sources].sort((a, b) =>
    a.mixerInput.localeCompare(b.mixerInput),
  );

  // Set num_inputs on the vision mixer based solely on the number of dynamic sources.
  // All static template video inputs are stripped above, so no static pad count needed.
  // Allowed values: 2, 4, 6, 8, 10 (non-live property — must be set at creation).
  // Also set input_{N}_label for each assigned source so Strom renders the name
  // in the multiview overlay (verified: property format from strom/backend/src/blocks/builtin/vision_mixer/properties.rs).
  if (mixerBlock && mixerBlockId) {
    const numInputs = Math.max(2, sortedAssignments.length);
    const props = (mixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['num_inputs'] = numInputs;

    for (const assignment of sortedAssignments) {
      const padMatch = /video_in_(\d+)$/.exec(assignment.mixerInput);
      if (!padMatch) continue;
      const padIndex = parseInt(padMatch[1], 10);
      const src = sourceMap.get(assignment.sourceId) ?? (VIRTUAL_SOURCES[assignment.sourceId] as SourceDoc | undefined);
      if (src?.name) {
        props[`input_${padIndex}_label`] = src.name;
      }
    }

    mixerBlock['properties'] = props;
  }

  // Set num_channels on the audio mixer = number of SRT/EFP/WHIP sources
  // (test1/test2/html sources don't carry audio in this template).
  // num_channels is a Strom enum: valid values are 2, 4, 8, 12, 16, 24, 32.
  // Round up to the nearest valid value; never set it below 2.
  if (audioMixerBlock) {
    const ALLOWED_CHANNEL_COUNTS = [2, 4, 8, 12, 16, 24, 32];
    const srtEfpCount = sortedAssignments.filter((a) => {
      const src = sourceMap.get(a.sourceId) ?? (VIRTUAL_SOURCES[a.sourceId] as SourceDoc | undefined);
      return src && src.streamType !== 'test1' && src.streamType !== 'test2' && src.streamType !== 'html';
    }).length;
    const numChannels = ALLOWED_CHANNEL_COUNTS.find((n) => n >= srtEfpCount) ?? 32;
    const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['num_channels'] = numChannels;
    audioMixerBlock['properties'] = props;
  }

  // Compute the highest latency across all SRT/EFP sources. Each source keeps its
  // own configured latency; the max is used only to set min_upstream_latency on the
  // mixers so the aggregators never starve waiting for the slowest source.
  const srtLatencies = sortedAssignments
    .map((a) => sourceMap.get(a.sourceId) ?? (VIRTUAL_SOURCES[a.sourceId] as SourceDoc | undefined))
    .filter((s): s is SourceDoc => !!s && s.streamType !== 'test1' && s.streamType !== 'test2' && s.streamType !== 'whip' && s.streamType !== 'html')
    .map((s) => s.latency ?? 125);
  const maxSourceLatency = srtLatencies.length > 0 ? Math.max(...srtLatencies) : 125;

  if (mixerBlock) {
    const props = (mixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['latency'] = 100;
    props['min_upstream_latency'] = maxSourceLatency;
    mixerBlock['properties'] = props;
  }
  if (audioMixerBlock) {
    const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['latency'] = 100;
    props['min_upstream_latency'] = maxSourceLatency;
    audioMixerBlock['properties'] = props;
  }

  let audioChannelIndex = 0;
  const ROW_H = 150;        // vertical spacing between rows
  const ROW_START = 50;     // y of first input row
  const COL_ELEM = -500;    // col 1: cefsrc / videotestsrc elements
  const COL_INPUT = -250;   // col 2: input blocks (mpegtssrt_input, whip_input, videoformat)
  const COL_OFFSET = 0;     // col 3: time_offset blocks (between source and mixer)
  const COL_OUTPUT = 850;   // col 5: output blocks

  // Maps mixerInput → time_offset block ID — returned so the WS layer can apply live changes.
  const sourceOffsetBlockIds: Record<string, string> = {};

  for (const assignment of sortedAssignments) {
    const padMatch = /video_in_(\d+)$/.exec(assignment.mixerInput);
    if (!padMatch || !mixerBlockId) continue;
    const padIndex = parseInt(padMatch[1], 10);

    const source = sourceMap.get(assignment.sourceId) ?? (VIRTUAL_SOURCES[assignment.sourceId] as SourceDoc | undefined);
    if (!source) continue;

    const yPos = ROW_START + padIndex * ROW_H;
    const inputId = `b-input-${padIndex}-${endpointSuffix}`;

    // Insert a time_offset block between this source and the vision mixer.
    // Starts at 0 ms; operators adjust it live via SOURCE_OFFSET_SET WS messages.
    const offsetId = `b-offset-${padIndex}-${endpointSuffix}`;
    flow.blocks.push({
      id: offsetId,
      block_definition_id: 'builtin.time_offset',
      name: `Offset V${padIndex}`,
      properties: { offset_ms: 0.0 },
      position: { x: COL_OFFSET, y: yPos },
    });
    sourceOffsetBlockIds[assignment.mixerInput] = offsetId;
    // Final link: offset → mixer (applies to all source types below)
    flow.links.push({ from: `${offsetId}:out`, to: `${mixerBlockId}:${assignment.mixerInput}` });

    const TEST_PATTERNS: Record<string, string> = { test1: 'Pinwheel', test2: 'Colors' }
    if (source.streamType === 'test1' || source.streamType === 'test2') {
      const elemId = `e-test-${padIndex}-${endpointSuffix}`;
      const fmtId = `b-fmt-${padIndex}-${endpointSuffix}`;
      flow.elements.push({
        id: elemId,
        element_type: 'videotestsrc',
        properties: { pattern: TEST_PATTERNS[source.streamType] },
        position: [COL_ELEM, yPos],
      });
      flow.blocks.push({
        id: fmtId,
        block_definition_id: 'builtin.videoformat',
        name: `Format V${padIndex}`,
        properties: { resolution: '1920x1080' },
        position: { x: COL_INPUT, y: yPos },
      });
      flow.links.push(
        { from: `${elemId}:src`, to: `${fmtId}:video_in` },
        { from: `${fmtId}:video_out`, to: `${offsetId}:in` },
      );
    } else if (source.streamType === 'html') {
      const elemId = `e-html-${padIndex}-${endpointSuffix}`;
      flow.elements.push({
        id: elemId,
        element_type: 'cefsrc',
        properties: { url: source.address },
        position: [COL_ELEM, yPos],
      });
      // Connect directly to offset block — same pattern as before but via offset.
      // Skipping builtin.videoformat avoids autovideoconvert trying to use GL,
      // which conflicts with cefsrc's X11/Xvfb rendering context on GPU hosts.
      flow.links.push({ from: `${elemId}:src`, to: `${offsetId}:in` });
    } else if (source.streamType === 'whip') {
      const audioChannel = audioChannelIndex++;
      const endpointId = `whip-${padIndex}-${endpointSuffix}`;
      flow.blocks.push({
        id: inputId,
        block_definition_id: 'builtin.whip_input',
        name: `WHIP Input (V${padIndex})`,
        properties: { endpoint_id: endpointId },
        position: { x: COL_INPUT, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${offsetId}:in` });
      flow.links.push({ from: `${inputId}:audio_out`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlock && audioMixerBlockId) {
        flow.links.push({ from: `${inputId}:audio_out`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
        if (source.name) {
          const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
          props[`ch${audioChannel + 1}_label`] = source.name;
          audioMixerBlock['properties'] = props;
        }
      }
    } else if (source.streamType === 'ndi') {
      const audioChannel = audioChannelIndex++;
      // url_address (direct IP:port) works in bridge/Docker; ndi_name requires mDNS
      const isUrlAddr = /^\d+\.\d+\.\d+\.\d+:\d+$/.test(source.address || '');
      const props: Record<string, string> = { mode: 'combined' };
      if (isUrlAddr) {
        props['url_address'] = source.address || '';
      } else {
        props['ndi_name'] = source.address || '';
      }
      flow.blocks.push({
        id: inputId,
        block_definition_id: 'builtin.ndi_input',
        name: source.name || `NDI Input (V${padIndex})`,
        properties: props,
        position: { x: COL_INPUT, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${offsetId}:in` });
      flow.links.push({ from: `${inputId}:audio_out`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlock && audioMixerBlockId) {
        flow.links.push({ from: `${inputId}:audio_out`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
        if (source.name) {
          const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
          props[`ch${audioChannel + 1}_label`] = source.name;
          audioMixerBlock['properties'] = props;
        }
      }
    } else if (source.streamType === 'sdi') {
      const deviceNumber = source.address || '0';
      const audioChannel = audioChannelIndex++;
      flow.blocks.push({
        id: inputId,
        block_definition_id: 'builtin.decklink_input',
        name: source.name || `SDI Input (V${padIndex})`,
        properties: { device_number: deviceNumber, stream_mode: 'audio_video' },
        position: { x: COL_INPUT, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${offsetId}:in` });
      flow.links.push({ from: `${inputId}:audio_out`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlock && audioMixerBlockId) {
        flow.links.push({ from: `${inputId}:audio_out`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
        if (source.name) {
          const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
          props[`ch${audioChannel + 1}_label`] = source.name;
          audioMixerBlock['properties'] = props;
        }
      }
    } else {
      // srt → builtin.mpegtssrt_input, efp → builtin.efpsrt_input
      const audioChannel = audioChannelIndex++;
      flow.blocks.push({
        id: inputId,
        block_definition_id: source.streamType === 'efp' ? 'builtin.efpsrt_input' : 'builtin.mpegtssrt_input',
        name: `${source.streamType === 'efp' ? 'EFP' : 'SRT'} Input (V${padIndex})`,
        properties: {
          srt_uri: source.address || 'srt://127.0.0.1:5005?mode=caller',
          latency: source.latency ?? 125,
        },
        position: { x: COL_INPUT, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${offsetId}:in` });
      // Wire audio:
      //  - Vision mixer: audio_in_N must match the video pad index N so the mixer
      //    correlates audio with the correct video source (a3 for video_in_3, etc.).
      //  - Audio mixer: sequential 1-indexed inputs (it doesn't know about video pads).
      flow.links.push({ from: `${inputId}:audio_out_0`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlock && audioMixerBlockId) {
        flow.links.push({ from: `${inputId}:audio_out_0`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
        if (source.name) {
          const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
          props[`ch${audioChannel + 1}_label`] = source.name;
          audioMixerBlock['properties'] = props;
        }
      }
    }
  }

  // Strip any cefsrc elements (and any intermediate videoformat blocks) from the template
  // that are wired to dsk_in_N pads. These are replaced by graphicAssignments at activation.
  if (mixerBlockId) {
    const dskLinkPattern = new RegExp(`^${mixerBlockId}:dsk_in_\\d+$`);
    const stripIds = new Set<string>();

    // First pass: collect IDs directly connected to dsk_in_N (may be videoformat blocks or cefsrc)
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      const to = (l['to'] as string | undefined) ?? '';
      if (dskLinkPattern.test(to)) {
        stripIds.add(((l['from'] as string | undefined) ?? '').split(':')[0]);
      }
    }

    // Second pass: follow one more hop back to catch cefsrc feeding into a videoformat block
    const firstPassIds = new Set(stripIds);
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
      if (firstPassIds.has(toId)) {
        stripIds.add(((l['from'] as string | undefined) ?? '').split(':')[0]);
      }
    }

    if (stripIds.size > 0) {
      flow.elements = flow.elements.filter(
        (el) => !stripIds.has((el as Record<string, unknown>)['id'] as string),
      );
      flow.blocks = flow.blocks.filter(
        (b) => !stripIds.has((b as Record<string, unknown>)['id'] as string),
      );
      flow.links = flow.links.filter((link) => {
        const l = link as Record<string, unknown>;
        const fromId = ((l['from'] as string | undefined) ?? '').split(':')[0];
        const toId = ((l['to'] as string | undefined) ?? '').split(':')[0];
        return !stripIds.has(fromId) && !stripIds.has(toId);
      });
    }
  }

  // Build cefsrc elements for each graphic assignment (DSK overlays).
  const graphicAssignments = production.graphicAssignments ?? [];
  if (graphicAssignments.length > 0 && mixerBlockId) {
    const graphicsDb = getGraphicsDb();
    let maxDskIndex = -1;

    for (const assignment of graphicAssignments) {
      const dskMatch = /dsk_in_(\d+)$/.exec(assignment.dskInput);
      if (!dskMatch) continue;
      const dskIndex = parseInt(dskMatch[1], 10);
      maxDskIndex = Math.max(maxDskIndex, dskIndex);

      let graphic: GraphicDoc;
      try {
        graphic = await graphicsDb.get(assignment.graphicId) as unknown as GraphicDoc;
      } catch {
        continue; // skip graphics that no longer exist
      }

      const elemId = `e-dsk-${dskIndex}-${endpointSuffix}`;
      const fmtId = `b-dsk-fmt-${dskIndex}-${endpointSuffix}`;
      const dskY = ROW_START + (sortedAssignments.length + dskIndex) * ROW_H;
      flow.elements.push({
        id: elemId,
        element_type: 'cefsrc',
        properties: { url: graphic.url },
        position: [COL_ELEM, dskY],
      });
      const fmtProps: Record<string, unknown> = { resolution: pgmResolution };
      if (pgmFramerate !== undefined) fmtProps['framerate'] = pgmFramerate;
      flow.blocks.push({
        id: fmtId,
        block_definition_id: 'builtin.videoformat',
        name: `Format DSK${dskIndex}`,
        properties: fmtProps,
        position: { x: COL_INPUT, y: dskY },
      });
      flow.links.push(
        { from: `${elemId}:src`, to: `${fmtId}:video_in` },
        { from: `${fmtId}:video_out`, to: `${mixerBlockId}:${assignment.dskInput}` },
      );
    }

    // Set num_dsk_inputs on the vision mixer so DSK pads are available
    if (maxDskIndex >= 0 && mixerBlock) {
      const props = (mixerBlock['properties'] ?? {}) as Record<string, unknown>;
      props['num_dsk_inputs'] = maxDskIndex + 1;
      mixerBlock['properties'] = props;
    }
  }

  // Inject output blocks for each assigned OutputDoc
  const whepOutputEntries: Array<{ outputId: string; endpointId: string }> = [];
  let outputBlockIndex = 0;
  if (outputDocs && outputDocs.length > 0) {
    for (const outputDoc of outputDocs) {
      // Sanitize the output doc ID for use in block/endpoint IDs: strip non-alphanumeric chars,
      // take the last 8 chars. This matters for '__whep__' (virtual) which contains underscores
      // that Strom may reject in endpoint_id.
      const idSlug = outputDoc._id.replace(/[^a-z0-9]/gi, '').slice(-8) || 'out';
      const blockId = `b-out-${idSlug}-${endpointSuffix}`;
      if (outputDoc.outputType === 'whep') {
        const endpointId = `whep-out-${idSlug}-${endpointSuffix}`;
        flow.blocks.push({
          id: blockId,
          block_definition_id: 'builtin.whep_output',
          name: outputDoc.name,
          properties: { endpoint_id: endpointId, mode: 'audio_video' },
          position: { x: COL_OUTPUT, y: ROW_START + outputBlockIndex * ROW_H },
        });
        if (pgmFeedPad) flow.links.push({ from: pgmFeedPad, to: `${blockId}:video_in` });
        // Wire audio from the audio mixer main_out — required for audio_video mode
        if (audioMixerBlockId) flow.links.push({ from: `${audioMixerBlockId}:main_out`, to: `${blockId}:audio_in` });
        whepOutputEntries.push({ outputId: outputDoc._id, endpointId });
        outputBlockIndex++;
      } else if (outputDoc.outputType === 'ndi') {
        flow.blocks.push({
          id: blockId,
          block_definition_id: 'builtin.ndi_output',
          name: outputDoc.name || 'NDI Output',
          properties: { ndi_name: outputDoc.name || 'Open Live NDI', mode: 'combined' },
          position: { x: COL_OUTPUT, y: ROW_START + outputBlockIndex * ROW_H },
        });
        outputBlockIndex++;
        if (pgmFeedPad) flow.links.push({ from: pgmFeedPad, to: `${blockId}:video_in` });
        if (audioMixerBlockId) flow.links.push({ from: `${audioMixerBlockId}:main_out`, to: `${blockId}:audio_in` });
      } else if (outputDoc.outputType === 'sdi') {
        const dev = outputDoc.url && /^\d+$/.test(outputDoc.url) ? outputDoc.url : '0';
        flow.blocks.push({
          id: blockId,
          block_definition_id: 'builtin.decklink_output',
          name: outputDoc.name || 'SDI Output',
          properties: { device_number: dev, stream_mode: 'audio_video' },
          position: { x: COL_OUTPUT, y: ROW_START + outputBlockIndex * ROW_H },
        });
        outputBlockIndex++;
        if (pgmFeedPad) flow.links.push({ from: pgmFeedPad, to: `${blockId}:video_in` });
        if (audioMixerBlockId) flow.links.push({ from: `${audioMixerBlockId}:main_out`, to: `${blockId}:audio_in` });
      } else {
        // mpegtssrt or efpsrt — both use the MPEG-TS/SRT output block.
        // Skip if no URL — an empty srt_uri fails at GStreamer READY state.
        if (!outputDoc.url) continue;
        flow.blocks.push({
          id: blockId,
          block_definition_id: 'builtin.mpegtssrt_output',
          name: outputDoc.name,
          properties: { srt_uri: outputDoc.url },
          position: { x: COL_OUTPUT, y: ROW_START + outputBlockIndex * ROW_H },
        });
        outputBlockIndex++;
        if (pgmFeedPad) flow.links.push({ from: pgmFeedPad, to: `${blockId}:video_in` });
        // Wire audio from the audio mixer main_out
        if (audioMixerBlockId) flow.links.push({ from: `${audioMixerBlockId}:main_out`, to: `${blockId}:audio_in_0` });
      }
    }
  }

  // POST /api/flows takes the full Flow struct. The server requires 'id' in the
  // body but overwrites it with a new UUID — always use created.flow.id for
  // all subsequent calls.
  const flowName = `${production.name}-${randomUUID().slice(0, 8)}`;
  const created = await strom.flows.create({
    id: randomUUID(),
    name: flowName,
    properties: {
      description: `prod:${production._id}`,
      ephemeral: true,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements: flow.elements as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocks: flow.blocks as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    links: flow.links as any,
  });

  const flowId = created.flow.id;

  try {
    await strom.flows.start(flowId);
  } catch (err) {
    // Log the full flow JSON so we can see what topology failed at GStreamer READY
    console.error('[flow-generator] Flow start failed. Generated flow JSON:',
      JSON.stringify({ blocks: flow.blocks, links: flow.links, elements: flow.elements }, null, 2));
    // Start failed — clean up the created flow so the endpoint isn't left registered
    try {
      await strom.flows.delete(flowId);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  return { flowId, mixerBlockId, audioMixerBlockId, whepOutputEntries: whepOutputEntries.length > 0 ? whepOutputEntries : undefined, pgmWhepEndpointId, sourceOffsetBlockIds };
}

/**
 * Stops and deletes the Strom flow associated with a production.
 * Silently ignores errors (flow may already be gone).
 */
export async function deactivateStromFlow(
  stromFlowId: string,
  strom: StromClient,
): Promise<void> {
  try {
    await strom.flows.stop(stromFlowId);
  } catch {
    // ignore — flow may not be running
  }
  try {
    await strom.flows.delete(stromFlowId);
  } catch {
    // ignore — flow may not exist
  }
}
