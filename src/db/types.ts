// --------------- Macro types ---------------

export type MacroActionType = 'CUT' | 'TRANSITION' | 'TAKE' | 'GRAPHIC_ON' | 'GRAPHIC_OFF' | 'DSK_TOGGLE';

export interface MacroAction {
  type: MacroActionType;
  sourceId?: string;
  transitionType?: string;
  durationMs?: number;
  overlayId?: string;
  layer?: number;
  visible?: boolean;
}

export interface Macro {
  id: string;      // "macro-<uuid>"
  slot: number;    // 0-7 (F1-F8)
  label: string;
  color: string;   // hex color, e.g. "#3B82F6"
  actions: MacroAction[];
}

// --------------- Audio element types ---------------

export interface AudioElement {
  id: string;
  blockId: string;
  elementId: string;
  label: string;
}

// --------------- Source types ---------------

export type StreamType = 'srt' | 'efp' | 'whip' | 'test1' | 'test2' | 'html' | 'ndi' | 'sdi';

export type SourceStatus = 'active' | 'inactive';

export interface SourceDoc {
  _id: string;
  _rev?: string;
  type: 'source';
  name: string;
  address: string;
  streamType: StreamType;
  status: SourceStatus;
  liveCamera?: boolean;
  /** SRT receiver buffer latency in ms. Only applies to srt/efp stream types. Default 125. */
  latency?: number;
  createdAt: string;
  updatedAt: string;
}

// --------------- Graphic types ---------------

export interface GraphicDoc {
  _id: string;        // "gfx-{uuid}"
  _rev?: string;
  type: 'graphic';
  name: string;
  url: string;
  createdAt: string;
  updatedAt: string;
}

// --------------- Output types ---------------

export type OutputType = 'mpegtssrt' | 'efpsrt' | 'whep' | 'ndi' | 'sdi' | 'recorder';

export interface OutputDoc {
  _id: string;           // "output-{uuid}"
  _rev?: string;
  type: 'output';
  name: string;
  outputType: OutputType;
  url?: string;          // SRT URI for mpegtssrt/efpsrt; undefined for whep/ndi/sdi
  outputDir?: string;    // recorders: subdirectory within media folder
  container?: string;    // recorders: mp4, mkv, mpegts (default: mp4)
  audioSource?: string;  // recorders: "pgm" or mixerInput (e.g. "video_in_0") for pre-fader
  videoSource?: string;  // recorders: "pgm" or sourceId to record from
  createdAt: string;
  updatedAt: string;
}

export interface ProductionOutputAssignment {
  outputId: string;      // references OutputDoc._id
}

// --------------- Production config types ---------------

export interface ProductionConfigDoc {
  _id: string;         // "cfg-<uuid>"
  _rev?: string;
  type: 'production-config';
  name: string;
  templateId: string;
  values: Record<string, string | number>;
  createdAt: string;
  updatedAt: string;
}

// --------------- Template types ---------------

export interface TemplateProperty {
  id: string;
  label: string;
  type: 'select' | 'text' | 'number';
  default: string | number;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
}

export interface FlowElement {
  id: string;
  element_type: string;
  properties?: Record<string, unknown>;
  block_id?: string;
  x?: number;
  y?: number;
}

export interface FlowLink {
  from_element: string;
  from_pad?: string;
  to_element: string;
  to_pad?: string;
}

export interface FlowBlock {
  id: string;
  name: string;
  category?: string;
  description?: string;
  elements?: FlowElement[];
  links?: FlowLink[];
  inputs?: string[];
  outputs?: string[];
  properties?: Record<string, unknown>;
}

/**
 * Describes a parametric input slot in a template.
 * id must match `mixerInput` in ProductionSourceAssignment (e.g. 'video_in_0').
 * Input blocks are generated dynamically at activation time based on source type —
 * no blockId or addressProperty needed.
 */
export interface TemplateInputSlot {
  id: string;
}

export interface StromFlowTemplate {
  _id: string;
  _rev?: string;
  type: 'template';
  name: string;
  description?: string;
  /**
   * Raw Strom flow JSON — stored and forwarded as-is.
   * Using Record<string, unknown>[] to accommodate the full Strom block
   * schema (block_definition_id, position, computed_external_pads, etc.)
   * without fighting the type system.
   */
  flow: {
    ephemeral?: boolean;
    elements: Record<string, unknown>[];
    blocks: Record<string, unknown>[];
    links: Record<string, unknown>[];
  };
  /** Defines which blocks are parametric source inputs */
  inputs: TemplateInputSlot[];
  audioElements: AudioElement[];
  /** Configurable properties shown when creating a production from this template */
  properties?: TemplateProperty[];
  createdAt: string;
  updatedAt: string;
}

// --------------- Production types ---------------

/**
 * Maps a source from the sources catalogue to a mixer input in the template.
 */
export interface ProductionSourceAssignment {
  sourceId: string;   // references SourceDoc._id
  mixerInput: string; // references TemplateInputSlot.id (e.g. 'video_in_0')
}

/**
 * Maps a graphic from the graphics catalogue to a DSK pad on the vision mixer.
 */
export interface ProductionGraphicAssignment {
  graphicId: string;  // references GraphicDoc._id
  dskInput: string;   // DSK pad name (e.g. 'dsk_in_0', 'dsk_in_1')
}

export type PipelineStatus = 'stopped' | 'running';

export interface Pipeline {
  stromConfig: Record<string, unknown> | null;
  status: PipelineStatus;
}

export interface GraphicOverlay {
  id: string;
  name: string;
  template: string;
  params: Record<string, unknown>;
  active: boolean;
}

export interface Tally {
  pgm: string | null;
  pvw: string | null;
}

export type ProductionStatus = 'active' | 'inactive' | 'activating';

export interface ProductionDoc {
  _id: string;
  _rev?: string;
  type: 'production';
  name: string;
  status: ProductionStatus;
  /** Source-to-mixer-input assignments for this production */
  sources: ProductionSourceAssignment[];
  /** Output assignments for this production */
  outputAssignments?: ProductionOutputAssignment[];
  /** WHEP output URLs — set when flow reaches 'playing', cleared on deactivate */
  whepOutputUrls?: Array<{ outputId: string; url: string }>;
  /** Graphic-to-DSK-pad assignments for this production */
  graphicAssignments?: ProductionGraphicAssignment[];
  /** ID of the StromFlowTemplate to use when activating */
  templateId?: string;
  /** ID of the running Strom flow (set on activate, cleared on deactivate) */
  stromFlowId?: string;
  /** WHEP multiview endpoint URL — set when flow reaches 'playing' state, cleared on deactivate */
  whepEndpoint?: string;
  /** WHEP PGM output endpoint URL — set when flow reaches 'playing' state, cleared on deactivate */
  pgmWhepEndpoint?: string;
  /** WHIP ingest endpoint URLs for each __whip__ source assignment — set on activate, cleared on deactivate */
  whipEndpoints?: Array<{ mixerInput: string; url: string }>;
  /** SRT program output URI (listener) — set on activate, cleared on deactivate */
  srtOutputUri?: string;
  /** Template property values chosen at production creation, keyed by property id */
  values?: Record<string, string | number>;
  /** Scheduled on-air start time — ISO 8601 UTC string (e.g. "2026-05-01T18:30:00.000Z") */
  airTime?: string;
  pipeline: Pipeline;
  graphics: GraphicOverlay[];
  macros: Macro[];
  tally: Tally;
  overlayAlpha?: number;
  mixerBlockId?: string;
  audioMixerBlockId?: string;
  /** Maps mixerInput (e.g. 'video_in_1') → time_offset block ID — set on activate, cleared on deactivate */
  sourceOffsetBlockIds?: Record<string, string>;
  /** DSK layer visibility state, keyed by 0-based layer index */
  dskLayers?: Record<number, boolean>;
  /** Warnings accumulated when a referenced source/graphic/output was deleted while production was inactive */
  deletionWarnings?: Array<{ type: 'source' | 'graphic' | 'output'; name: string }>;
  createdAt: string;
  updatedAt: string;
}
