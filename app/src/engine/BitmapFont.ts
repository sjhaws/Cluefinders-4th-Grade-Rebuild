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
 * The strike indexes its glyphs by Mac OS Roman byte -- these are Mac fonts --
 * while a script's text arrives as Unicode, because the extractor decodes .MPS
 * strings as Mac OS Roman (see mps.py). The two agree below 128 and nowhere
 * above it: CWS1's "60 \u00f7 6 = ?" holds U+00F7 for a glyph stored at 0xD6.
 */
const MAC_ROMAN_HIGH = '\u00c4\u00c5\u00c7\u00c9\u00d1\u00d6\u00dc\u00e1\u00e0\u00e2\u00e4\u00e3\u00e5\u00e7\u00e9\u00e8\u00ea\u00eb\u00ed\u00ec\u00ee\u00ef\u00f1\u00f3\u00f2\u00f4\u00f6\u00f5\u00fa\u00f9\u00fb\u00fc\u2020\u00b0\u00a2\u00a3\u00a7\u2022\u00b6\u00df\u00ae\u00a9\u2122\u00b4\u00a8\u2260\u00c6\u00d8\u221e\u00b1\u2264\u2265\u00a5\u00b5\u2202\u2211\u220f\u03c0\u222b\u00aa\u00ba\u03a9\u00e6\u00f8\u00bf\u00a1\u00ac\u221a\u0192\u2248\u2206\u00ab\u00bb\u2026\u00a0\u00c0\u00c3\u00d5\u0152\u0153\u2013\u2014\u201c\u201d\u2018\u2019\u00f7\u25ca\u00ff\u0178\u2044\u20ac\u2039\u203a\ufb01\ufb02\u2021\u00b7\u201a\u201e\u2030\u00c2\u00ca\u00c1\u00cb\u00c8\u00cd\u00ce\u00cf\u00cc\u00d3\u00d4\uf8ff\u00d2\u00da\u00db\u00d9\u0131\u02c6\u02dc\u00af\u02d8\u02d9\u02da\u00b8\u02dd\u02db\u02c7';
const TO_MAC_ROMAN = new Map<number, number>();
for (let i = 0; i < MAC_ROMAN_HIGH.length; i++) TO_MAC_ROMAN.set(MAC_ROMAN_HIGH.charCodeAt(i), 128 + i);

/** The strike's index for a character, or -1 when this font has no glyph for it. */
export function macRomanCode(ch: string): number {
  const code = ch.charCodeAt(0);
  if (code < 128) return code;
  return TO_MAC_ROMAN.get(code) ?? -1;
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
      const rect = font.glyphs[String(macRomanCode(ch))];
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
        const code = macRomanCode(ch);
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
