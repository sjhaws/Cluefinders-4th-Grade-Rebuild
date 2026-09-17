import { Texture } from 'pixi.js';
import type { GameEngine } from './GameEngine';

/**
 * Copies frames with palette entries swapped, by the colours those entries have
 * in the current palette. The extracted images are already RGBA, so a palette
 * swap is a colour swap: look up both indices, then rewrite matching pixels.
 */
export function recolorFrames(engine: GameEngine, frames: Texture[], swaps: [number, number][]): Texture[] {
  const pairs = swaps
    .filter(([a, b]) => a !== b)
    .map(([a, b]) => [engine.paletteColor(a), engine.paletteColor(b)] as const);
  return frames.map((texture) => {
    const { x, y, width, height } = texture.frame;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return texture;
    ctx.drawImage(texture.source.resource as CanvasImageSource, x, y, width, height, 0, 0, width, height);
    const image = ctx.getImageData(0, 0, width, height);
    const d = image.data;
    for (let p = 0; p < d.length; p += 4) {
      if (d[p + 3] === 0) continue;
      const rgb = (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
      for (const [from, to] of pairs) {
        if (rgb !== from) continue;
        d[p] = (to >> 16) & 255;
        d[p + 1] = (to >> 8) & 255;
        d[p + 2] = to & 255;
        break;
      }
    }
    ctx.putImageData(image, 0, 0);
    const out = Texture.from(canvas);
    out.source.scaleMode = 'nearest';
    return out;
  });
}

/**
 * Which palette index each original index is drawn with now.
 *
 * `replacePaletteEntry from, to` means "whatever is currently drawn with
 * `from` is drawn with `to` from now on", so the swaps chain: PWS2 recolours
 * each crossword by remapping the five indices of its authored scheme
 * (colorIndex.4.1..5) onto the scheme for the number completed.
 */
export class PaletteSwaps {
  private readonly map = new Map<number, number>();

  /** Records one swap. Returns whether anything is actually recoloured now. */
  replace(from: number, to: number): boolean {
    let matched = false;
    for (const [original, current] of this.map) {
      if (current === from) {
        this.map.set(original, to);
        matched = true;
      }
    }
    if (!matched && !this.map.has(from)) this.map.set(from, to);
    return this.active;
  }

  /** False when every index still maps to itself, so the frames can be used as they are. */
  get active(): boolean {
    for (const [original, current] of this.map) if (original !== current) return true;
    return false;
  }

  pairs(): [number, number][] {
    return [...this.map];
  }
}

/**
 * Holds the recoloured copies of a set of frames, so callers can swap them in
 * and drop the previous copies without leaking textures.
 */
export class RecoloredFrames {
  private generated: Texture[] = [];

  /** The frames to draw: recoloured copies, or the originals when nothing is swapped. */
  apply(engine: GameEngine, base: Texture[], swaps: PaletteSwaps): Texture[] {
    const previous = this.generated;
    this.generated = swaps.active && base.length ? recolorFrames(engine, base, swaps.pairs()) : [];
    for (const texture of previous) texture.destroy(true);
    return this.generated.length ? this.generated : base;
  }

  release(): void {
    for (const texture of this.generated) texture.destroy(true);
    this.generated = [];
  }
}
