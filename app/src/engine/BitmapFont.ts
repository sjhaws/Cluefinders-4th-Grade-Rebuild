import { Assets, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { ResourceManager } from '../ResourceManager';

/** One glyph: [x in the atlas, width, offset from the pen, advance]. */
export type GlyphRect = [number, number, number, number];

export interface BitmapFontData {
  id: number;
  family: string;
  points: number;
  bold: boolean;
  ascent: number;
  descent: number;
  leading: number;
  lineHeight: number;
  height: number;
  maxWidth: number;
  kernMax: number;
  atlas: string;
  atlasWidth: number;
  glyphs: Record<string, GlyphRect>;
}

/**
 * The game's own bitmap fonts, extracted from FONT.RSC (see extractor/nfnt.py).
 * Each font is one atlas image holding every glyph side by side, so a glyph is
 * a rectangle in it; the atlas is white on transparent and gets tinted to the
 * palette colour the script asked for.
 */
export class BitmapFontSet {
  private readonly fonts = new Map<number, BitmapFontData>();
  private readonly atlases = new Map<number, Texture>();
  private readonly glyphTextures = new Map<string, Texture>();
  private resources: ResourceManager | null = null;
  private loading: Promise<void> | null = null;
  loaded = false;

  /** Idempotent: the first caller fetches the index, later ones share it. */
  ensureLoaded(resources: ResourceManager): Promise<void> {
    this.resources = resources;
    if (!this.loading) this.loading = this.load(resources);
    return this.loading;
  }

  private async load(resources: ResourceManager): Promise<void> {
    // `?webfonts` forces the web-face fallback, to compare against the real fonts.
    if (new URLSearchParams(location.search).has('webfonts')) {
      this.loaded = false;
      return;
    }
    try {
      const index = await (await fetch(resources.getFontIndexUrl())).json() as Record<string, BitmapFontData>;
      for (const font of Object.values(index)) this.fonts.set(font.id, font);
      this.loaded = this.fonts.size > 0;
    } catch {
      this.loaded = false;        // no fonts extracted yet: callers fall back to a web font
    }
  }

  byId(id: number): BitmapFontData | null {
    return this.fonts.get(id) ?? null;
  }

  /**
   * The closest face to what a script asked for: same family, preferring the
   * same weight, then the nearest point size. The game ships Geneva at 10/12/14,
   * Chicago at 12/14 and Arial at 12, but scripts ask for sizes it never had
   * (Geneva 9), so the nearest one wins rather than nothing.
   */
  resolve(family: string, points: number, bold: boolean): BitmapFontData | null {
    const wanted = family.toLowerCase();
    let best: BitmapFontData | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const font of this.fonts.values()) {
      if (font.family.toLowerCase() !== wanted) continue;
      const score = Math.abs(font.points - points) * 2 + (font.bold === bold ? 0 : 1);
      if (score < bestScore) {
        best = font;
        bestScore = score;
      }
    }
    return best;
  }

  async ensureAtlas(font: BitmapFontData): Promise<void> {
    if (this.atlases.has(font.id) || !this.resources) return;
    const texture = await Assets.load<Texture>(this.resources.getFontAtlasUrl(font.id));
    this.atlases.set(font.id, texture);
  }

  hasAtlas(font: BitmapFontData): boolean {
    return this.atlases.has(font.id);
  }

  glyphTexture(font: BitmapFontData, code: number): Texture | null {
    const rect = font.glyphs[String(code)];
    const atlas = this.atlases.get(font.id);
    if (!rect || !atlas || rect[1] <= 0) return null;
    const key = `${font.id}:${code}`;
    let texture = this.glyphTextures.get(key);
    if (!texture) {
      texture = new Texture({
        source: atlas.source,
        frame: new Rectangle(rect[0], 0, rect[1], font.height),
      });
      this.glyphTextures.set(key, texture);
    }
    return texture;
  }

  /** Pen advance for a string -- what the original's text measurement returns. */
  measure(font: BitmapFontData, text: string): number {
    let width = 0;
    for (const ch of text) {
      const rect = font.glyphs[String(ch.charCodeAt(0))];
      if (rect) width += rect[3];
    }
    return width;
  }

  /** Greedy word wrap; one line per paragraph when no width is given. */
  wrap(font: BitmapFontData, text: string, width: number): string[] {
    const paragraphs = text.split('\n');
    if (width <= 0) return paragraphs;
    const lines: string[] = [];
    for (const paragraph of paragraphs) {
      let line = '';
      for (const word of paragraph.split(' ')) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && this.measure(font, candidate) > width) {
          lines.push(line);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    return lines;
  }
}

/** Shared by every RText: one index fetch and one atlas load per font. */
export const bitmapFonts = new BitmapFontSet();

/**
 * Text drawn from a bitmap font, one sprite per glyph. Glyphs sit at
 * pen + offset with the pen advancing per glyph, exactly as the original lays
 * them out, so widths match the game's own measurements.
 */
export class BitmapLabel extends Container {
  private font: BitmapFontData | null = null;
  private value = '';
  private colour = 0xffffff;
  private wrapWidth = 0;
  private centred = false;
  textWidth = 0;
  textHeight = 0;

  setFont(font: BitmapFontData | null): void {
    this.font = font;
    if (font && !bitmapFonts.hasAtlas(font)) {
      void bitmapFonts.ensureAtlas(font).then(() => this.rebuild());
    }
    this.rebuild();
  }

  setText(text: string): void {
    this.value = text;
    this.rebuild();
  }

  setColour(colour: number): void {
    this.colour = colour;
    if (this.destroyed) return;
    for (const child of this.children) (child as Sprite).tint = colour;
  }

  setWrapWidth(width: number): void {
    this.wrapWidth = width;
    this.rebuild();
  }

  setCentred(centred: boolean): void {
    this.centred = centred;
    this.rebuild();
  }

  get ready(): boolean {
    return this.font !== null && bitmapFonts.hasAtlas(this.font);
  }

  private rebuild(): void {
    this.removeChildren();
    const font = this.font;
    if (!font) {
      this.textWidth = this.textHeight = 0;
      return;
    }
    const lines = bitmapFonts.wrap(font, this.value, this.wrapWidth);
    this.textWidth = Math.max(0, ...lines.map((line) => bitmapFonts.measure(font, line)));
    this.textHeight = lines.length * font.lineHeight;
    if (!bitmapFonts.hasAtlas(font)) return;      // measured now, drawn once the atlas lands
    let y = 0;
    for (const line of lines) {
      let pen = this.centred ? -bitmapFonts.measure(font, line) / 2 : 0;
      for (const ch of line) {
        const code = ch.charCodeAt(0);
        const rect = font.glyphs[String(code)];
        if (!rect) continue;
        const texture = bitmapFonts.glyphTexture(font, code);
        if (texture) {
          const sprite = new Sprite(texture);
          sprite.position.set(Math.round(pen + rect[2]), y);
          sprite.tint = this.colour;
          this.addChild(sprite);
        }
        pen += rect[3];
      }
      y += font.lineHeight;
    }
    if (this.centred) {
      for (const child of this.children) child.y -= this.textHeight / 2;
    }
  }
}
