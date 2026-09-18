import { Assets, Rectangle, Texture } from 'pixi.js';
import type { AseqResourceEntry, GameManifest, SequenceDoc } from './types';

const ASSET_BASE = '/assets/';
/**
 * Production builds stamp every game file's URL with a hash of all the game
 * files, so browsers may cache them for good (public/_headers) and still
 * fetch fresh copies after the files change.
 */
const VERSION = __ASSET_VERSION__ ? `?v=${__ASSET_VERSION__}` : '';

function assetUrl(path: string): string {
  return `${ASSET_BASE}${path}${VERSION}`;
}

export interface LoadedAseq {
  entry: AseqResourceEntry;
  frames: Texture[];
  sequence: SequenceDoc;
}

export interface SoundRef {
  id: number;
  url: string;
}

/**
 * Loads manifest.json and resolves assets. Images and sounds are loaded
 * lazily per resource -- the full asset set is hundreds of MB.
 */
export class ResourceManager {
  private manifest!: GameManifest;
  private soundUrlById = new Map<number, string>();
  private soundsByBundle = new Map<string, SoundRef[]>();
  private aseqCache = new Map<string, Promise<LoadedAseq>>();
  private aseqById = new Map<number, AseqResourceEntry>();

  async load(manifestUrl = assetUrl('manifest.json')): Promise<void> {
    const res = await fetch(manifestUrl);
    if (!res.ok) {
      throw new Error(`Failed to load manifest: ${res.status} ${res.statusText}`);
    }
    this.manifest = await res.json();

    // audio_files keys are "<bundle>_<resource id>"; ids are unique across the game
    for (const [key, filename] of Object.entries(this.manifest.audio_files)) {
      const split = key.lastIndexOf('_');
      const bundle = key.slice(0, split);
      const id = Number(key.slice(split + 1));
      if (!Number.isFinite(id)) continue;
      const url = assetUrl(`audio/${filename}`);
      this.soundUrlById.set(id, url);
      const list = this.soundsByBundle.get(bundle) ?? [];
      list.push({ id, url });
      this.soundsByBundle.set(bundle, list);
    }
    for (const list of this.soundsByBundle.values()) list.sort((a, b) => a.id - b.id);
    // image resource ids are unique across the game, except a few FONT.RSC ids that clash with
    // COMMON.RSC (e.g. 20, the open backpack); scripts mean the game image
    for (const r of this.manifest.aseq_resources) {
      const existing = this.aseqById.get(r.resource_id);
      if (!existing || existing.bundle === 'font') this.aseqById.set(r.resource_id, r);
    }
  }

  findAseq(id: number): AseqResourceEntry | undefined {
    return this.aseqById.get(id);
  }

  getScriptUrl(name: string): string {
    return assetUrl(`scripts/${name}.json`);
  }

  getPaletteIndexUrl(): string {
    return assetUrl('palettes/index.json');
  }

  getPaletteUrl(name: string): string {
    return assetUrl(`palettes/${name}.pal`);
  }

  getFontIndexUrl(): string {
    return assetUrl('fonts/index.json');
  }

  /** FONT.RSC ids clash with COMMON.RSC ones, so fonts live under their own path. */
  getFontAtlasUrl(id: number): string {
    return assetUrl(`fonts/${id}.png`);
  }

  bundleNames(): string[] {
    const names = new Set(this.manifest.aseq_resources.map((r) => r.bundle));
    for (const bundle of this.soundsByBundle.keys()) names.add(bundle);
    return [...names].sort();
  }

  listAseqForBundle(bundle: string): AseqResourceEntry[] {
    return this.manifest.aseq_resources
      .filter((r) => r.bundle === bundle)
      .sort((a, b) => a.resource_id - b.resource_id);
  }

  listSoundsForBundle(bundle: string): SoundRef[] {
    return this.soundsByBundle.get(bundle) ?? [];
  }

  getSoundUrl(id: number): string | undefined {
    return this.soundUrlById.get(id);
  }

  getImageUrl(path: string): string {
    return assetUrl(`images/${path}`);
  }

  getVideoUrl(name: string): string | undefined {
    // scripts name movies like "MVTitle.smk"; the manifest is keyed by lower-case stem
    const filename = this.manifest.video_files[name.toLowerCase().replace(/\.smk$/, '')];
    return filename ? assetUrl(`video/${filename}`) : undefined;
  }

  loadAseq(entry: AseqResourceEntry): Promise<LoadedAseq> {
    const key = `${entry.bundle}/${entry.resource_id}`;
    let pending = this.aseqCache.get(key);
    if (!pending) {
      pending = this.fetchAseq(entry);
      pending.catch(() => this.aseqCache.delete(key));
      this.aseqCache.set(key, pending);
    }
    return pending;
  }

  private async fetchAseq(entry: AseqResourceEntry): Promise<LoadedAseq> {
    if (!entry.decoded || !entry.sheets || !entry.frames || !entry.sequence_file) {
      throw new Error(`${entry.bundle}/${entry.resource_id} is not decoded: ${entry.error ?? 'unknown'}`);
    }
    const sheets = await Promise.all(entry.sheets.map((s) => Assets.load<Texture>(this.getImageUrl(s))));
    for (const sheet of sheets) sheet.source.scaleMode = 'nearest';
    const frames = entry.frames.map(
      (f) => new Texture({ source: sheets[f.sheet].source, frame: new Rectangle(f.x, f.y, f.w, f.h) })
    );
    const res = await fetch(this.getImageUrl(entry.sequence_file));
    if (!res.ok) throw new Error(`Failed to load ${entry.sequence_file}: ${res.status}`);
    return { entry, frames, sequence: await res.json() };
  }
}
