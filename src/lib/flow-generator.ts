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
  whepOutputEntries?: Array<{ outputId: string; endpointId: string }>;
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

export async function activateStromFlow(
  production: ProductionDoc,
  strom: StromClient,
  stromUrl?: string,
  outputDocs?: OutputDoc[],
): Promise<ActivationResult> {
  if (!production.templateId) {
    throw new Error('Production has no templateId — cannot activate Strom flow');
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

    // Uniquify the multiview WHEP endpoint_id per production so concurrent
    // productions don't collide on the same WHEP stream name.
    if (b['block_definition_id'] === 'builtin.whep_output') {
      if (typeof props['endpoint_id'] === 'string') {
        props['endpoint_id'] = `${props['endpoint_id']}-${endpointSuffix}`;
      }
      b['properties'] = props;
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

  // Strip ALL inputs wired to video_in_N pads on the mixer (dynamic blocks AND
  // static template placeholders like videotestsrc). We rebuild all video inputs
  // from production.sources, so the template's static elements must be removed.
  const DYNAMIC_INPUT_BLOCK_DEFS = new Set(['builtin.mpegtssrt_input', 'builtin.whip_input']);
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
    const ALLOWED_INPUT_COUNTS = [2, 4, 6, 8, 10];
    const numInputs = ALLOWED_INPUT_COUNTS.find((n) => n >= sortedAssignments.length) ?? 10;
    const props = (mixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['num_inputs'] = String(numInputs);

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

  // Set num_channels on the audio mixer = number of dynamic SRT/EFP sources
  // (test/whip sources don't carry audio in this template).
  // num_channels is a Strom enum: valid values are 2, 4, 8, 12, 16, 24, 32.
  // Round up to the nearest valid value; never set it below 2.
  if (audioMixerBlock) {
    const ALLOWED_CHANNEL_COUNTS = [2, 4, 8, 12, 16, 24, 32];
    const srtEfpCount = sortedAssignments.filter((a) => {
      const src = sourceMap.get(a.sourceId) ?? (VIRTUAL_SOURCES[a.sourceId] as SourceDoc | undefined);
      return src && src.streamType !== 'test1' && src.streamType !== 'test2' && src.streamType !== 'whip' && src.streamType !== 'html';
    }).length;
    const numChannels = ALLOWED_CHANNEL_COUNTS.find((n) => n >= srtEfpCount) ?? 32;
    const props = (audioMixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['num_channels'] = numChannels;
    audioMixerBlock['properties'] = props;
  }

  // Use the highest latency across all SRT/EFP sources so timestamps align at the mixer.
  // Mismatched latencies cause QoS frame-drop events on the encoder.
  const srtLatencies = sortedAssignments
    .map((a) => sourceMap.get(a.sourceId) ?? (VIRTUAL_SOURCES[a.sourceId] as SourceDoc | undefined))
    .filter((s): s is SourceDoc => !!s && s.streamType !== 'test1' && s.streamType !== 'test2' && s.streamType !== 'whip' && s.streamType !== 'html')
    .map((s) => s.latency ?? 125);
  const sharedLatency = srtLatencies.length > 0 ? Math.max(...srtLatencies) : 125;

  let audioChannelIndex = 0;

  for (const assignment of sortedAssignments) {
    const padMatch = /video_in_(\d+)$/.exec(assignment.mixerInput);
    if (!padMatch || !mixerBlockId) continue;
    const padIndex = parseInt(padMatch[1], 10);

    const source = sourceMap.get(assignment.sourceId) ?? (VIRTUAL_SOURCES[assignment.sourceId] as SourceDoc | undefined);
    if (!source) continue;

    const yPos = 100 + padIndex * 150;
    const inputId = `b-input-${padIndex}-${endpointSuffix}`;

    const TEST_PATTERNS: Record<string, string> = { test1: 'Pinwheel', test2: 'Colors' }
    if (source.streamType === 'test1' || source.streamType === 'test2') {
      const elemId = `e-test-${padIndex}-${endpointSuffix}`;
      const fmtId = `b-fmt-${padIndex}-${endpointSuffix}`;
      flow.elements.push({
        id: elemId,
        element_type: 'videotestsrc',
        properties: { pattern: TEST_PATTERNS[source.streamType] },
        position: [50, yPos],
      });
      flow.blocks.push({
        id: fmtId,
        block_definition_id: 'builtin.videoformat',
        name: `Format V${padIndex}`,
        properties: { resolution: '1920x1080' },
        position: { x: 300, y: yPos },
      });
      flow.links.push(
        { from: `${elemId}:src`, to: `${fmtId}:video_in` },
        { from: `${fmtId}:video_out`, to: `${mixerBlockId}:${assignment.mixerInput}` },
      );
    } else if (source.streamType === 'html') {
      const elemId = `e-html-${padIndex}-${endpointSuffix}`;
      flow.elements.push({
        id: elemId,
        element_type: 'cefsrc',
        properties: { url: source.address },
        position: [50, yPos],
      });
      // Connect directly to the mixer — same pattern as DSK overlays.
      // Skipping builtin.videoformat avoids autovideoconvert trying to use GL,
      // which conflicts with cefsrc's X11/Xvfb rendering context on GPU hosts.
      flow.links.push({ from: `${elemId}:src`, to: `${mixerBlockId}:${assignment.mixerInput}` });
    } else if (source.streamType === 'whip') {
      const endpointId = `whip-${padIndex}-${endpointSuffix}`;
      flow.blocks.push({
        id: inputId,
        block_definition_id: 'builtin.whip_input',
        name: `WHIP Input (V${padIndex})`,
        properties: { endpoint_id: endpointId },
        position: { x: 300, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${mixerBlockId}:${assignment.mixerInput}` });
    } else {
      // srt or efp — both use the MPEG-TS/SRT input block
      const audioChannel = audioChannelIndex++;
      flow.blocks.push({
        id: inputId,
        block_definition_id: 'builtin.mpegtssrt_input',
        name: `${source.streamType === 'efp' ? 'EFP' : 'SRT'} Input (V${padIndex})`,
        properties: {
          srt_uri: source.address || 'srt://127.0.0.1:5005?mode=caller',
          latency: sharedLatency,
        },
        position: { x: 300, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${mixerBlockId}:${assignment.mixerInput}` });
      // Wire audio:
      //  - Vision mixer: audio_in_N must match the video pad index N so the mixer
      //    correlates audio with the correct video source (a3 for video_in_3, etc.).
      //  - Audio mixer: sequential 1-indexed inputs (it doesn't know about video pads).
      flow.links.push({ from: `${inputId}:audio_out_0`, to: `${mixerBlockId}:audio_in_${padIndex}` });
      if (audioMixerBlockId) {
        flow.links.push({ from: `${inputId}:audio_out_0`, to: `${audioMixerBlockId}:input_${audioChannel + 1}` });
      }
    }
  }

  // Strip any cefsrc elements from the template that are wired to dsk_in_N pads.
  // These are replaced by the production's graphicAssignments at activation time.
  if (mixerBlockId) {
    const dskLinkPattern = new RegExp(`^${mixerBlockId}:dsk_in_\\d+$`);
    const dskSourceElementIds = new Set<string>();
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      const to = (l['to'] as string | undefined) ?? '';
      if (dskLinkPattern.test(to)) {
        const fromParts = ((l['from'] as string | undefined) ?? '').split(':');
        dskSourceElementIds.add(fromParts[0]);
      }
    }
    if (dskSourceElementIds.size > 0) {
      flow.elements = flow.elements.filter(
        (el) => !dskSourceElementIds.has((el as Record<string, unknown>)['id'] as string),
      );
      flow.links = flow.links.filter((link) => {
        const l = link as Record<string, unknown>;
        const to = (l['to'] as string | undefined) ?? '';
        const fromId = ((l['from'] as string | undefined) ?? '').split(':')[0];
        return !dskLinkPattern.test(to) && !dskSourceElementIds.has(fromId);
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
      flow.elements.push({
        id: elemId,
        element_type: 'cefsrc',
        properties: { url: graphic.url },
        position: [50, 600 + dskIndex * 150],
      });
      flow.links.push({ from: `${elemId}:src`, to: `${mixerBlockId}:${assignment.dskInput}` });
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
          position: { x: 1600, y: 800 + whepOutputEntries.length * 150 },
        });
        if (pgmFeedPad) flow.links.push({ from: pgmFeedPad, to: `${blockId}:video_in` });
        // Wire audio from the audio mixer main_out — required for audio_video mode
        if (audioMixerBlockId) flow.links.push({ from: `${audioMixerBlockId}:main_out`, to: `${blockId}:audio_in` });
        whepOutputEntries.push({ outputId: outputDoc._id, endpointId });
      } else {
        // mpegtssrt or efpsrt — both use the MPEG-TS/SRT output block.
        // Skip if no URL — an empty srt_uri fails at GStreamer READY state.
        if (!outputDoc.url) continue;
        flow.blocks.push({
          id: blockId,
          block_definition_id: 'builtin.mpegtssrt_output',
          name: outputDoc.name,
          properties: { srt_uri: outputDoc.url },
          position: { x: 1600, y: 300 + flow.blocks.length * 80 },
        });
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

  return { flowId, whepOutputEntries: whepOutputEntries.length > 0 ? whepOutputEntries : undefined };
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
