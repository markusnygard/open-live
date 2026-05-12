import { getTemplatesDb, getSourcesDb, getDb } from './index.js';
import type { StromFlowTemplate } from './types.js';

/**
 * Well-known CouchDB ID for the default vision-mixer template.
 * Using a fixed ID lets us check for existence with a single GET
 * instead of querying by name.
 */
export const DEFAULT_TEMPLATE_ID = 'tmpl-default-vision-mixer';

const DEFAULT_TEMPLATE: Omit<StromFlowTemplate, '_id' | '_rev'> = {
  type: 'template',
  name: 'Open Live Default',
  description: 'Vision mixer with PGM/MV WHEP outputs, audio mixer, SRT program output. SRT/EFP input blocks are generated dynamically at activation. Chromium overlays available in optional-overlays.ts.',
  flow: {
    ephemeral: true,
    elements: [
      {
        id: 'ee26dc9a315d44336ace15b71f7eec523',
        element_type: 'videotestsrc',
        properties: { pattern: 'Spokes' },
        position: [-500.0, 500.0],
      },
      {
        id: 'e040249992a1d4736afaf00dfec6bbb18',
        element_type: 'videotestsrc',
        properties: { pattern: 'Colors' },
        position: [-500.0, 350.0],
      },
    ],
    blocks: [
      {
        id: 'bba5be208b1904f9aae46c38c6c4d23a2',
        block_definition_id: 'builtin.vision_mixer',
        name: 'Mixer',
        properties: {
          num_inputs: '4',
          pgm_resolution: '1280x720',
        },
        position: { x: 250.0, y: 200.0 },
      },
      {
        id: 'bdaf7aa1547ee4a11b8b2b147264b2694',
        block_definition_id: 'builtin.whep_output',
        name: 'Multiview Output',
        properties: { endpoint_id: 'mv', low_latency: true, mode: 'audio_video' },
        position: { x: 850.0, y: 600.0 },
      },
      {
        id: 'b9f3c2e1a4d5b6c7e8f9a0b1c2d3e4f5',
        block_definition_id: 'builtin.whep_output',
        name: 'PGM Output',
        properties: { endpoint_id: 'pgm', low_latency: true, mode: 'audio_video' },
        position: { x: 850.0, y: 300.0 },
      },
      {
        id: 'b035ceff6c25d4bc2bb7a1d36eb0c4308',
        block_definition_id: 'builtin.videoenc',
        name: 'Enc MV',
        properties: { bitrate: 4000 },
        position: { x: 550.0, y: 600.0 },
      },
      {
        id: 'b370f5d3ce9774e869f262aa5714f7a74',
        block_definition_id: 'builtin.videoenc',
        name: 'Enc PGM',
        properties: { bitrate: 10000 },
        position: { x: 550.0, y: 50.0 },
      },
      {
        id: 'b08c7a35f181a4f6a90f5e2c517df284a',
        block_definition_id: 'builtin.mixer',
        name: 'Audio Mixer',
        properties: { num_aux_buses: 2, num_channels: 2, num_groups: 2 },
        position: { x: 250.0, y: 650.0 },
      },
      {
        id: 'b0454efed640a402cafb4727e6a259514',
        block_definition_id: 'builtin.mpegtssrt_output',
        name: 'SRT Output',
        properties: { srt_uri: 'srt://:6000?mode=listener' },
        position: { x: 850.0, y: 50.0 },
      },
      {
        id: 'bc8ed07a386a04aa5957bcad179a932c1',
        block_definition_id: 'builtin.videoformat',
        name: 'Format V3',
        properties: { resolution: '1280x720' },
        position: { x: -250.0, y: 500.0 },
      },
      {
        id: 'b5f982d927d42434dbb114ab629124662',
        block_definition_id: 'builtin.videoformat',
        name: 'Format V2',
        properties: { resolution: '1280x720' },
        position: { x: -250.0, y: 350.0 },
      },
    ],
    links: [
      // PGM/MV video routing
      { from: 'bba5be208b1904f9aae46c38c6c4d23a2:pgm_out',       to: 'b370f5d3ce9774e869f262aa5714f7a74:video_in' },
      { from: 'b370f5d3ce9774e869f262aa5714f7a74:encoded_out',    to: 'b0454efed640a402cafb4727e6a259514:video_in' },
      { from: 'b370f5d3ce9774e869f262aa5714f7a74:encoded_out',    to: 'b9f3c2e1a4d5b6c7e8f9a0b1c2d3e4f5:video_in' },
      { from: 'bba5be208b1904f9aae46c38c6c4d23a2:multiview_out',  to: 'b035ceff6c25d4bc2bb7a1d36eb0c4308:video_in' },
      { from: 'b035ceff6c25d4bc2bb7a1d36eb0c4308:encoded_out',    to: 'bdaf7aa1547ee4a11b8b2b147264b2694:video_in' },
      // Static video inputs: test sources (V2, V3)
      { from: 'e040249992a1d4736afaf00dfec6bbb18:src',            to: 'b5f982d927d42434dbb114ab629124662:video_in' },
      { from: 'b5f982d927d42434dbb114ab629124662:video_out',      to: 'bba5be208b1904f9aae46c38c6c4d23a2:video_in_2' },
      { from: 'ee26dc9a315d44336ace15b71f7eec523:src',            to: 'bc8ed07a386a04aa5957bcad179a932c1:video_in' },
      { from: 'bc8ed07a386a04aa5957bcad179a932c1:video_out',      to: 'bba5be208b1904f9aae46c38c6c4d23a2:video_in_3' },
      // Audio mixer → all consumers
      { from: 'b08c7a35f181a4f6a90f5e2c517df284a:main_out',       to: 'b0454efed640a402cafb4727e6a259514:audio_in_0' },
      { from: 'b08c7a35f181a4f6a90f5e2c517df284a:main_out',       to: 'bdaf7aa1547ee4a11b8b2b147264b2694:audio_in' },
      { from: 'b08c7a35f181a4f6a90f5e2c517df284a:main_out',       to: 'bba5be208b1904f9aae46c38c6c4d23a2:pgm_audio_in' },
      // Dynamic SRT/EFP source links are added by flow-generator at activation
    ],
  },
  inputs: [],
  audioElements: [],
  properties: [
    {
      id: 'pgm_resolution',
      label: 'PGM Resolution',
      type: 'select',
      default: '1280x720',
      options: [
        { value: '3840x2160', label: '4K (3840×2160)' },
        { value: '1920x1080', label: 'HD (1920×1080)' },
        { value: '1280x720',  label: '720p (1280×720)' },
        { value: '720x576',   label: 'SD PAL (720×576)' },
        { value: '720x480',   label: 'SD NTSC (720×480)' },
        { value: '640x360',   label: 'Low (640×360)' },
        { value: '320x240',   label: 'Very Low (320×240)' },
      ],
    },
    {
      id: 'multiview_resolution',
      label: 'Multiview Resolution',
      type: 'select',
      default: '1280x720',
      options: [
        { value: '3840x2160', label: '4K (3840×2160)' },
        { value: '1920x1080', label: 'HD (1920×1080)' },
        { value: '1280x720',  label: '720p (1280×720)' },
        { value: '720x576',   label: 'SD PAL (720×576)' },
        { value: '720x480',   label: 'SD NTSC (720×480)' },
        { value: '640x360',   label: 'Low (640×360)' },
        { value: '320x240',   label: 'Very Low (320×240)' },
      ],
    },
    {
      id: 'pgm_framerate',
      label: 'PGM Frame Rate',
      type: 'select',
      default: '25/1',
      options: [
        { value: '10/1',       label: '10 fps' },
        { value: '15/1',       label: '15 fps' },
        { value: '24000/1001', label: '23.976 fps' },
        { value: '24/1',       label: '24 fps' },
        { value: '25/1',       label: '25 fps' },
        { value: '30000/1001', label: '29.97 fps' },
        { value: '30/1',       label: '30 fps' },
        { value: '50/1',       label: '50 fps' },
        { value: '60000/1001', label: '59.94 fps' },
        { value: '60/1',       label: '60 fps' },
      ],
    },
    {
      id: 'multiview_framerate',
      label: 'Multiview Frame Rate',
      type: 'select',
      default: '25/1',
      options: [
        { value: '10/1',       label: '10 fps' },
        { value: '15/1',       label: '15 fps' },
        { value: '24000/1001', label: '23.976 fps' },
        { value: '24/1',       label: '24 fps' },
        { value: '25/1',       label: '25 fps' },
        { value: '30000/1001', label: '29.97 fps' },
        { value: '30/1',       label: '30 fps' },
        { value: '50/1',       label: '50 fps' },
        { value: '60000/1001', label: '59.94 fps' },
        { value: '60/1',       label: '60 fps' },
      ],
    },
    {
      id: 'bitrate',
      label: 'Encoder Bitrate',
      type: 'number',
      default: 4000,
      unit: 'kbps',
      min: 100,
      max: 100000,
    },
  ],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * Ensures the default template is up to date in CouchDB.
 * Always overwrites so deploys pick up seed changes.
 * Also removes legacy dev fixtures (template, production, sources) if present.
 */
export async function seedDefaultTemplate(): Promise<void> {
  const templatesDb = getTemplatesDb();
  const sourcesDb = getSourcesDb();
  const productionsDb = getDb();

  type WithRev = { _rev: string };
  const destroy = async (
    database: ReturnType<typeof getTemplatesDb>,
    id: string,
  ): Promise<void> => {
    try {
      const doc = await database.get(id) as WithRev;
      await (database as unknown as { destroy: (id: string, rev: string) => Promise<unknown> })
        .destroy(id, doc._rev);
    } catch {
      // already gone — ignore
    }
  };

  // Upsert the default template
  try {
    const existing = await templatesDb.get(DEFAULT_TEMPLATE_ID) as WithRev;
    await templatesDb.insert({ ...DEFAULT_TEMPLATE, _rev: existing._rev } as never, DEFAULT_TEMPLATE_ID);
  } catch {
    await templatesDb.insert(DEFAULT_TEMPLATE as never, DEFAULT_TEMPLATE_ID);
  }

  // Remove legacy dev fixtures
  await destroy(templatesDb as unknown as ReturnType<typeof getTemplatesDb>, 'tmpl-dev-test-no-sources');
  await destroy(productionsDb as unknown as ReturnType<typeof getTemplatesDb>, 'prod-dev-test');
  await destroy(sourcesDb as unknown as ReturnType<typeof getTemplatesDb>, 'src-dev-pat-1');
  await destroy(sourcesDb as unknown as ReturnType<typeof getTemplatesDb>, 'src-dev-pat-2');
  await destroy(sourcesDb as unknown as ReturnType<typeof getTemplatesDb>, 'src-dev-pat-3');
  await destroy(sourcesDb as unknown as ReturnType<typeof getTemplatesDb>, 'src-dev-pat-4');
}
