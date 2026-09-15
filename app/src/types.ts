// Types mirroring extractor/build_manifest.py's manifest.json output.

export interface AseqFrameRect {
  sheet: number; // index into AseqResourceEntry.sheets
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AseqResourceEntry {
  bundle: string;
  resource_id: number;
  decoded: boolean;
  frame_count: number; // 0 when decoded is false
  error?: string; // set when decoded is false
  header_fields?: number[];
  big_endian?: boolean;
  palette?: string | null; // scene palette name; "shared" = shared character/UI range; null = placeholder
  sheets?: string[]; // RGBA PNG paths relative to assets/images/
  frames?: AseqFrameRect[];
  sequence_file?: string; // SequenceDoc JSON, relative to assets/images/
  origin?: [number, number]; // copy of SequenceDoc.origin, so positions are known before loading
}

/** [x, y, tag, value]. tag >= 0 shows that frame with its top-left at (x, y);
 * negative tags are commands (see SEQ_* in AseqAnimation.ts). */
export type SequenceEntry = [number, number, number, number];

export interface SequenceDoc {
  origin?: [number, number]; // screen position when a script passes kUseAOCoords
  unknown_word?: number;
  table?: number[];
  lists?: SequenceEntry[][];
  raw_hex?: string; // present instead of lists when the sequence data didn't parse
}

export interface GameManifest {
  generated_from: string;
  bundles: Record<string, [string, number][]>;
  audio_files: Record<string, string>;
  video_files: Record<string, string>;
  aseq_resources: AseqResourceEntry[];
  notes: string;
}
