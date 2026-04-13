import { randomUUID } from 'crypto';
import type { ProductionDoc, SourceDoc, StromFlowTemplate } from '../db/types.js';
import { getSourcesDb, getTemplatesDb } from '../db/index.js';
import { StromClient } from './strom.js';

/**
 * Generates a Strom flow from a template + source assignments,
 * creates it in Strom, starts it, and returns the flow ID.
 *
 * Throws if no templateId is set, template is not found,
 * or Strom creation/start fails.
 */
export async function activateStromFlow(
  production: ProductionDoc,
  strom: StromClient,
): Promise<string> {
  if (!production.templateId) {
    throw new Error('Production has no templateId — cannot activate Strom flow');
  }

  // Load template
  const templatesDb = getTemplatesDb();
  const template = await templatesDb.get(production.templateId) as unknown as StromFlowTemplate;

  // Virtual source IDs for test streams — no DB lookup needed
  const VIRTUAL_SOURCES: Record<string, Pick<SourceDoc, 'streamType' | 'address' | 'name'>> = {
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

  // Make WHEP output endpoint IDs unique per production so multiple productions
  // can run simultaneously without conflicting on shared endpoint names.
  const endpointSuffix = production._id.replace(/^prod-/, '').slice(0, 8);
  for (const block of flow.blocks) {
    const b = block as Record<string, unknown>;
    if (b['block_definition_id'] === 'builtin.whep_output') {
      const props = (b['properties'] ?? {}) as Record<string, unknown>;
      if (typeof props['endpoint_id'] === 'string') {
        props['endpoint_id'] = `${props['endpoint_id']}-${endpointSuffix}`;
      }
      b['properties'] = props;
    }
  }

  // Find the mixer block so we can set its input count and wire inputs to it
  const mixerBlock = flow.blocks.find(
    (b) => (b as Record<string, unknown>)['block_definition_id'] === 'builtin.vision_mixer',
  ) as Record<string, unknown> | undefined;
  const mixerBlockId = typeof mixerBlock?.['id'] === 'string' ? mixerBlock['id'] : null;

  // Strip any pre-wired input blocks/elements/links from the template.
  // The template may have been seeded with hardcoded inputs; we generate them
  // fresh from production.sources so the count is always correct.
  if (mixerBlockId) {
    const mixerInputLinkPattern = new RegExp(`^${mixerBlockId}:video_in_`);
    // Collect IDs of blocks/elements feeding into the mixer
    const inputFeederIds = new Set<string>();
    for (const link of flow.links) {
      const l = link as Record<string, unknown>;
      if (typeof l['to'] === 'string' && mixerInputLinkPattern.test(l['to'])) {
        const fromId = (l['from'] as string).split(':')[0];
        inputFeederIds.add(fromId);
      }
    }
    // Remove those links, blocks, and elements
    flow.links = flow.links.filter((link) => {
      const l = link as Record<string, unknown>;
      return typeof l['to'] !== 'string' || !mixerInputLinkPattern.test(l['to'] as string);
    });
    flow.blocks = flow.blocks.filter((b) => !inputFeederIds.has((b as Record<string, unknown>)['id'] as string));
    flow.elements = flow.elements.filter((e) => !inputFeederIds.has((e as Record<string, unknown>)['id'] as string));
  }

  // Dynamically generate input blocks based on each source's streamType and wire
  // them to the correct mixer pad.
  const sortedAssignments = [...production.sources].sort((a, b) =>
    a.mixerInput.localeCompare(b.mixerInput),
  );

  // Set num_inputs on the mixer to the smallest allowed value >= source count.
  // Allowed values: 2, 4, 6, 8, 10 (non-live property — must be set at creation).
  if (mixerBlock) {
    const ALLOWED_INPUT_COUNTS = [2, 4, 6, 8, 10];
    const numInputs = ALLOWED_INPUT_COUNTS.find((n) => n >= sortedAssignments.length) ?? 10;
    const props = (mixerBlock['properties'] ?? {}) as Record<string, unknown>;
    props['num_inputs'] = String(numInputs);
    mixerBlock['properties'] = props;
  }

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
        properties: { resolution: '640x360' },
        position: { x: 300, y: yPos },
      });
      flow.links.push(
        { from: `${elemId}:src`, to: `${fmtId}:video_in` },
        { from: `${fmtId}:video_out`, to: `${mixerBlockId}:${assignment.mixerInput}` },
      );
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
      flow.blocks.push({
        id: inputId,
        block_definition_id: 'builtin.mpegtssrt_input',
        name: `${source.streamType === 'efp' ? 'EFP' : 'SRT'} Input (V${padIndex})`,
        properties: { srt_uri: source.address || 'srt://127.0.0.1:5005?mode=caller' },
        position: { x: 300, y: yPos },
      });
      flow.links.push({ from: `${inputId}:video_out`, to: `${mixerBlockId}:${assignment.mixerInput}` });
    }
  }

  // POST /api/flows takes the full Flow struct. The server requires 'id' in the
  // body but overwrites it with a new UUID — always use created.flow.id for
  // all subsequent calls.
  const flowName = `${production.name}-${randomUUID().slice(0, 8)}`;
  const created = await strom.flows.create({
    id: randomUUID(),
    name: flowName,
    description: `prod:${production._id}`,
    ...(flow.ephemeral !== undefined ? { ephemeral: flow.ephemeral } : {}),
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
    // Start failed — clean up the created flow so the endpoint isn't left registered
    try {
      await strom.flows.delete(flowId);
    } catch {
      // ignore cleanup errors
    }
    throw err;
  }

  return flowId;
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
