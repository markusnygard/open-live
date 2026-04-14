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
  description: 'Vision mixer with PGM and multiview WHEP outputs. Input blocks are generated dynamically at activation.',
  flow: {
    ephemeral: true,
    elements: [],
    blocks: [
      {
        id: 'b0428b4f5e08f4f59a395e3fcb123d6d5',
        block_definition_id: 'builtin.vision_mixer',
        name: 'Mixer',
        properties: {
          num_inputs: '10',
          multiview_resolution: '1920x1080',
          pgm_resolution: '1920x1080',
        },
        position: { x: 750.0, y: 300.0 },
      },
      {
        id: 'bbc31abafa6d44469b9793e5b123474c9',
        block_definition_id: 'builtin.whep_output',
        name: 'PGM Output',
        properties: { endpoint_id: 'pgm' },
        position: { x: 1300.0, y: 250.0 },
      },
      {
        id: 'bf3796dfea9fc4a04aee0dc5f673a3bbe',
        block_definition_id: 'builtin.whep_output',
        name: 'Multiview Output',
        properties: { endpoint_id: 'mv' },
        position: { x: 1300.0, y: 400.0 },
      },
      {
        id: 'b8aac53567d734cb0961329773c352fe1',
        block_definition_id: 'builtin.videoenc',
        name: 'Enc MV',
        properties: {},
        position: { x: 1050.0, y: 400.0 },
      },
      {
        id: 'b4f7ddae23338475db80497ac69b83fd4',
        block_definition_id: 'builtin.videoenc',
        name: 'Enc PGM',
        properties: {},
        position: { x: 1050.0, y: 250.0 },
      },
    ],
    links: [
      { from: 'b0428b4f5e08f4f59a395e3fcb123d6d5:pgm_out',      to: 'b4f7ddae23338475db80497ac69b83fd4:video_in' },
      { from: 'b4f7ddae23338475db80497ac69b83fd4:encoded_out',   to: 'bbc31abafa6d44469b9793e5b123474c9:video_in' },
      { from: 'b0428b4f5e08f4f59a395e3fcb123d6d5:multiview_out', to: 'b8aac53567d734cb0961329773c352fe1:video_in' },
      { from: 'b8aac53567d734cb0961329773c352fe1:encoded_out',   to: 'bf3796dfea9fc4a04aee0dc5f673a3bbe:video_in' },
    ],
  },
  inputs: [],
  audioElements: [],
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
