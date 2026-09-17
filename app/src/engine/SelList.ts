import { Container, Graphics, Text } from 'pixi.js';
import type { Value } from './ScriptVm';
import { toNumber, toText } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { fontFor } from './DisplayObjects';
import { BitmapLabel, bitmapFonts, type BitmapFontData } from './BitmapFont';

const MAX_ENTRIES = 50;
const MAX_NAME_LENGTH = 24;
/** addChar results, as the sign-in script checks them. */
const ADD_OK = 0;
const ADD_REJECTED = 1;
const ADD_LIST_FULL = 4;

/**
 * Selection list with type-to-select, used by the sign-in screen for player
 * names. Typing either matches an existing entry or starts a new one.
 */
export class RSelList extends DisplayObject {
  private readonly entries: string[] = [];
  private highlight = -1;
  private typed = '';
  private scroll = 0;
  private readonly width: number;
  private readonly height: number;
  private readonly background = new Graphics();
  private readonly rows = new Container();
  private readonly unsubscribe: () => void;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RSelList');
    this.view.position.set(toNumber(args[0]), toNumber(args[1]));
    this.width = toNumber(args[2]);
    this.height = toNumber(args[3]);
    this.view.addChild(this.background, this.rows);
    this.unsubscribe = engine.onPalette(() => this.render());
    // The font index arrives from a promise; redraw in the game's own face once it has.
    void bitmapFonts.ensureLoaded(engine.resources).then(() => this.render());
    this.render();
  }

  /** The game's own font for this list, if FONT.RSC has the id the script set. */
  private get bitmapFont(): BitmapFontData | null {
    return bitmapFonts.byId(toNumber(this.props.get('textfontid') ?? 0));
  }

  private get lineHeight(): number {
    const font = this.bitmapFont;
    if (font) return font.lineHeight + 2;
    return fontFor(toNumber(this.props.get('textfontid') ?? 0)).size + 4;
  }

  private get visibleLines(): number {
    return Math.max(1, Math.floor(this.height / this.lineHeight));
  }

  private exactMatch(): number {
    const t = this.typed.toLowerCase();
    return this.entries.findIndex((e) => e.toLowerCase() === t);
  }

  private get isNew(): boolean {
    return this.typed !== '' && this.exactMatch() < 0;
  }

  private currentEntry(): string {
    if (this.typed !== '') return this.exactMatch() >= 0 ? this.entries[this.exactMatch()] : this.typed;
    return this.entries[this.highlight] ?? '';
  }

  private matchTyped() {
    if (this.typed === '') return;
    const t = this.typed.toLowerCase();
    const i = this.entries.findIndex((e) => e.toLowerCase().startsWith(t));
    this.highlight = i;
    if (i >= 0) this.ensureVisible(i);
  }

  private ensureVisible(i: number) {
    if (i < this.scroll) this.scroll = i;
    if (i >= this.scroll + this.visibleLines) this.scroll = i - this.visibleLines + 1;
    this.scroll = Math.max(0, this.scroll);
  }

  private moveHighlight(delta: number) {
    if (!this.entries.length) return;
    this.typed = '';
    this.highlight = Math.min(this.entries.length - 1, Math.max(0, (this.highlight < 0 ? 0 : this.highlight) + delta));
    this.ensureVisible(this.highlight);
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'entryisvalid': return this.currentEntry().trim() !== '' ? 1 : 0;
      case 'entryisnew': return this.isNew ? 1 : 0;
      case 'listisfull': return this.entries.length >= MAX_ENTRIES ? 1 : 0;
      case 'currententry': return this.currentEntry();
      case 'candeletechar': return this.typed.length > 0 ? 1 : 0;
      case 'visiblelines': return this.visibleLines;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    super.setProp(name, key, value);
    this.render();
  }

  send(method: string, args: Value[]): Value {
    const result = this.handle(method, args);
    this.render();
    return result;
  }

  private handle(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'addlistentry':
        this.entries.push(toText(args[0]));
        if (this.highlight < 0 && this.typed === '') this.highlight = 0;
        return 0;
      case 'addchar': {
        const ch = toText(args[0]);
        if (this.typed.length >= MAX_NAME_LENGTH || (this.typed === '' && ch === ' ')) return ADD_REJECTED;
        const next = this.typed + ch;
        const createsNew = !this.entries.some((e) => e.toLowerCase().startsWith(next.toLowerCase()));
        if (createsNew && this.entries.length >= MAX_ENTRIES) {
          this.fire('listFull');
          return ADD_LIST_FULL;
        }
        this.typed = next;
        this.matchTyped();
        return ADD_OK;
      }
      case 'deletechar':
        this.typed = this.typed.slice(0, -1);
        this.matchTyped();
        return 0;
      case 'startnewentry':
        this.typed = '';
        this.highlight = -1;
        return 0;
      case 'movehighlightup': this.moveHighlight(-1); return 0;
      case 'movehighlightdown': this.moveHighlight(1); return 0;
      case 'scrolllistpageup': this.moveHighlight(-this.visibleLines); return 0;
      case 'scrolllistpagedown': this.moveHighlight(this.visibleLines); return 0;
      case 'scrolllistlineup': this.scroll = Math.max(0, this.scroll - 1); return 0;
      case 'scrolllistlinedown':
        this.scroll = Math.min(Math.max(0, this.entries.length - this.visibleLines), this.scroll + 1);
        return 0;
      case 'deleteentry': {
        const i = this.typed === '' ? this.highlight : this.exactMatch();
        if (i < 0) return 0;
        this.props.set('deletedentry', this.entries[i]);
        this.entries.splice(i, 1);
        this.typed = '';
        this.highlight = Math.min(i, this.entries.length - 1);
        return 0;
      }
      default:
        return super.send(method, args);
    }
  }

  private rowAt(y: number): number {
    return Math.floor((y - this.view.y) / this.lineHeight) + this.scroll;
  }

  onPointerDown(_x: number, y: number): void {
    const row = this.rowAt(y);
    if (row >= 0 && row < this.entries.length) {
      this.typed = '';
      this.highlight = row;
      this.render();
    }
  }

  onPointerUp(): void {}

  onDoubleClick(_x: number, y: number): void {
    const row = this.rowAt(y);
    if (row >= 0 && row < this.entries.length) this.fire('entrySelected');
  }

  private color(prop: string, fallback: number): number {
    const v = this.props.get(prop);
    return v === undefined ? fallback : this.engine.paletteColor(toNumber(v));
  }

  private render() {
    if (this.destroyed) return;
    const lineHeight = this.lineHeight;
    const font = fontFor(toNumber(this.props.get('textfontid') ?? 0));
    const bitmapFont = this.bitmapFont;
    this.background.clear().rect(0, 0, this.width, this.height).fill(this.color('listbackgroundcolor', 0xf2e6c4));
    for (const child of this.rows.removeChildren()) child.destroy();

    const shown: { text: string; highlighted: boolean; fresh: boolean }[] = this.entries.map((text, i) => ({
      text,
      highlighted: i === this.highlight,
      fresh: false,
    }));
    if (this.isNew) {
      shown.push({ text: this.typed, highlighted: true, fresh: true });
      this.ensureVisible(shown.length - 1);
    }
    shown.slice(this.scroll, this.scroll + this.visibleLines).forEach((row, i) => {
      const y = i * lineHeight;
      if (row.highlighted) {
        const bar = new Graphics().rect(0, y, this.width, lineHeight).fill(this.color('highlightedbackgroundcolor', 0x2b3a67));
        this.rows.addChild(bar);
      }
      const partialMatch = row.highlighted && !row.fresh && this.typed !== '' && this.exactMatch() < 0;
      const fill = row.highlighted
        ? this.color(partialMatch ? 'matchedtextcolor' : 'selectedtextcolor', 0xffffff)
        : this.color('normaltextcolor', 0x222222);
      const text = row.text + (row.fresh ? '_' : '');
      if (bitmapFont) {
        const label = new BitmapLabel();
        label.setFont(bitmapFont);
        label.setText(text);
        label.setColour(fill);
        label.position.set(6, y + 1);
        this.rows.addChild(label);
      } else {
        const label = new Text({
          text,
          style: { fontFamily: font.family, fontSize: font.size, fill },
        });
        label.position.set(6, y + 1);
        this.rows.addChild(label);
      }
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.unsubscribe();
    super.destroy();
  }
}
