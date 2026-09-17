import { Sprite, Text, Texture } from 'pixi.js';
import type { EngineObject, Value } from './ScriptVm';
import { isEngineObject, toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject, ScriptObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { familyForFontName, sequenceList } from './DisplayObjects';
import { AseqAnimation } from '../AseqAnimation';
import { PaletteSwaps, RecoloredFrames, recolorFrames } from './PaletteSwap';
import { spriteHit } from './hitTest';

const SLIDE_MS = 150;

type AnswerSound = 'pickup' | 'gohome' | 'snap';
type Verdict = 'solved' | 'wrong' | 'pending';

function makeLabel(text: string): Text {
  return new Text({ text, style: { fill: 0x000000, fontFamily: familyForFontName(''), fontSize: 12 } });
}

/**
 * A draggable puzzle piece (RAnswer in the EXE). It rests at its home
 * position or in a container; when it's dropped, its RPuzzle decides where
 * it lands. Events: pickedUp, dropped, addedToContainer, removedFromContainer.
 */
export class RAnswer extends DisplayObject {
  homeX: number;
  homeY: number;
  value: Value;
  attribute: Value;
  puzzle: RPuzzle | null = null;
  container: RValueContainer | null = null;
  /** isUsed: placed in a container. Deleting the container doesn't clear it (OWS2 keeps a finished sentence's words). */
  used = false;
  anchored = false;
  /** A hot point (e.g. a push pin's tip) is where the answer lands instead of its middle. */
  usesHotPoint = false;
  hotPointX = 0;
  hotPointY = 0;
  /** Graphic pixels outside the answer's own area (extraTop etc.): stacked or lined-up neighbours overlap them. */
  readonly extra = { left: 0, top: 0, right: 0, bottom: 0 };
  protected readonly graphic = new Sprite();
  protected size: [number, number] = [0, 0];
  /** PWS2 recolours its letter tiles between crosswords (replacePaletteEntry). */
  private readonly swaps = new PaletteSwaps();
  private readonly recolored = new RecoloredFrames();
  private baseFrame: Texture | null = null;
  private paletteOff: (() => void) | null = null;
  private grabOffset: [number, number] | null = null;
  private slide: { fromX: number; fromY: number; toX: number; toY: number; t: number } | null = null;

  constructor(
    engine: GameEngine,
    className: string,
    [x, y, z, graphicId]: number[],
    attribute: Value | undefined,
    value: Value | undefined
  ) {
    super(engine, className);
    this.movable = true;
    this.homeX = x;
    this.homeY = y;
    this.attribute = attribute ?? 0;
    this.value = value ?? 0;
    this.view.position.set(x, y);
    this.view.zIndex = z;
    this.view.addChild(this.graphic);
    this.setGraphic(graphicId);
  }

  get w(): number {
    return this.size[0];
  }

  get h(): number {
    return this.size[1];
  }

  /** Width without the extra margins: what the answer takes up in a row. */
  get logicalW(): number {
    return this.w - this.extra.left - this.extra.right;
  }

  /** Height without the extra margins: what the answer takes up in a stack. */
  get logicalH(): number {
    return this.h - this.extra.top - this.extra.bottom;
  }

  /** Offset from the answer's position to the point where it lands. */
  dropOffset(): [number, number] {
    return this.usesHotPoint ? [this.hotPointX, this.hotPointY] : [this.w / 2, this.h / 2];
  }

  dropPoint(): [number, number] {
    const [ox, oy] = this.dropOffset();
    return [this.view.x + ox, this.view.y + oy];
  }

  protected setGraphic(id: number): void {
    this.props.set('graphicid', id);
    this.size = this.engine.frameSize(id) ?? this.size;
    void this.engine.loadAseq(id).then((loaded) => {
      if (!loaded || this.destroyed || this.props.get('graphicid') !== id) return;
      this.baseFrame = loaded.frames[0];
      this.redrawGraphic();
    });
    this.layoutContent();
  }

  protected redrawGraphic(): void {
    if (!this.baseFrame || this.destroyed) return;
    this.graphic.texture = this.recolored.apply(this.engine, [this.baseFrame], this.swaps)[0];
  }

  /** Positions anything drawn over the graphic. */
  protected layoutContent(): void {}

  playSound(kind: AnswerSound): void {
    const id = toNumber(this.props.get(`${kind}sound`) ?? 0) || this.engine.answerSounds[kind];
    if (id > 0) this.engine.playSound(id);
  }

  /** Slides to a position. */
  moveTo(x: number, y: number): void {
    if (this.view.x === x && this.view.y === y) {
      this.slide = null;
      return;
    }
    this.slide = { fromX: this.view.x, fromY: this.view.y, toX: x, toY: y, t: 0 };
  }

  /** Jumps to a position. */
  placeAt(x: number, y: number): void {
    this.slide = null;
    this.view.position.set(x, y);
  }

  goHome(): void {
    if (this.view.x !== this.homeX || this.view.y !== this.homeY) this.playSound('gohome');
    this.moveTo(this.homeX, this.homeY);
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'homex': return this.homeX;
      case 'homey': return this.homeY;
      case 'isused': return this.used ? 1 : 0;
      case 'value': return this.value;
      case 'attribute': return this.attribute;
      case 'width': return this.w;
      case 'height': return this.h;
      case 'isusinghotpoint': return this.usesHotPoint ? 1 : 0;
      case 'hotpointx': return this.hotPointX;
      case 'hotpointy': return this.hotPointY;
      case 'extraleft': return this.extra.left;
      case 'extratop': return this.extra.top;
      case 'extraright': return this.extra.right;
      case 'extrabottom': return this.extra.bottom;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'homex':
      case 'homey':
        if (name.toLowerCase() === 'homex') this.homeX = toNumber(value);
        else this.homeY = toNumber(value);
        if (!this.container && !this.grabOffset) this.placeAt(this.homeX, this.homeY);
        return;
      case 'value': this.value = value; return;
      case 'attribute': this.attribute = value; return;
      case 'isusinghotpoint': this.usesHotPoint = truthy(value); return;
      case 'hotpointx': this.hotPointX = toNumber(value); return;
      case 'hotpointy': this.hotPointY = toNumber(value); return;
      case 'extraleft': this.extra.left = toNumber(value); return;
      case 'extratop': this.extra.top = toNumber(value); return;
      case 'extraright': this.extra.right = toNumber(value); return;
      case 'extrabottom': this.extra.bottom = toNumber(value); return;
      case 'graphicid':
      case 'graphic':
        this.setGraphic(toNumber(value));
        return;
      default: super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'replacepaletteentry':
        this.swaps.replace(toNumber(args[0]), toNumber(args[1]));
        this.paletteOff ??= this.engine.onPalette(() => this.redrawGraphic());
        this.redrawGraphic();
        return 0;
      case 'playanimation':
      case 'stopanimation':
      case 'playanimations':
      case 'stopanimations':
      case 'setaocursor':
        return 0;
      default:
        return super.send(method, args);
    }
  }

  onPointerDown(x: number, y: number): void {
    if (this.anchored || !this.movable) return;
    this.slide = null;
    this.grabOffset = [x - this.view.x, y - this.view.y];
    this.playSound('pickup');
    this.fire('pickedUp');
  }

  onPointerMove(x: number, y: number): void {
    if (!this.grabOffset) return;
    this.view.position.set(Math.round(x - this.grabOffset[0]), Math.round(y - this.grabOffset[1]));
    if (this.puzzle && !this.puzzle.destroyed) this.puzzle.answerMoved(this);
  }

  onPointerUp(): void {
    if (!this.grabOffset) return;
    this.grabOffset = null;
    this.fire('dropped');
    if (this.destroyed) return;
    if (this.puzzle && !this.puzzle.destroyed) this.puzzle.answerDropped(this);
    else this.goHome();
  }

  tick(deltaMs: number): void {
    const s = this.slide;
    if (!s) return;
    s.t = Math.min(1, s.t + deltaMs / SLIDE_MS);
    this.view.position.set(Math.round(s.fromX + (s.toX - s.fromX) * s.t), Math.round(s.fromY + (s.toY - s.fromY) * s.t));
    if (s.t >= 1) this.slide = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.paletteOff?.();
    this.recolored.release();
    this.container?.remove(this);
    this.puzzle = null;
    super.destroy();
  }
}

/** `RGraphicAnswer x, y, z, graphicID, attribute[, value]` */
export class RGraphicAnswer extends RAnswer {
  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RGraphicAnswer', args.slice(0, 4).map(toNumber), args[4], args[5]);
  }
}

/** Font settings shared by the text answers: `setFont name, style, size[, colorIndex]`. */
function applyFont(labels: Text[], args: Value[]): number | null {
  for (const label of labels) {
    label.style.fontFamily = familyForFontName(toText(args[0] ?? ''));
    label.style.fontWeight = toNumber(args[1]) & 1 ? 'bold' : 'normal';
    if (args[2] !== undefined) label.style.fontSize = toNumber(args[2]);
  }
  return args[3] !== undefined ? toNumber(args[3]) : null;
}

/** `RGraphicTextAnswer x, y, z, graphicID, text, attribute[, value]`: a graphic with a label on it. */
export class RGraphicTextAnswer extends RAnswer {
  private readonly label = makeLabel('');
  private colorIndex: number | null = null;
  private readonly unsubscribe: () => void;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RGraphicTextAnswer', args.slice(0, 4).map(toNumber), args[5], args[6]);
    this.label.text = toText(args[4] ?? '');
    this.view.addChild(this.label);
    this.layoutContent();
    this.unsubscribe = engine.onPalette(() => this.restyle());
  }

  /**
   * The text is centred on the graphic and textOffsetX/Y nudge it from there:
   * OWS4 shifts it by half its boxes' 3D depth onto the front face (-6.5, 6.5),
   * CWS3 by 2 in boxes sized to the text.
   */
  protected layoutContent(): void {
    if (!this.label) return; // called from the base constructor before fields exist
    const ox = toNumber(this.props.get('textoffsetx') ?? 0);
    const oy = toNumber(this.props.get('textoffsety') ?? 0);
    this.label.anchor.set(0.5);
    this.label.position.set(Math.round(this.w / 2 + ox), Math.round(this.h / 2 + oy));
  }

  private restyle() {
    if (this.colorIndex !== null) this.label.style.fill = this.engine.paletteColor(this.colorIndex);
  }

  getProp(name: string, key: Value | undefined): Value {
    if (name.toLowerCase() === 'text') return this.label.text;
    return super.getProp(name, key);
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'text':
        this.label.text = toText(value);
        return;
      case 'textoffsetx':
      case 'textoffsety':
        this.props.set(name.toLowerCase(), toNumber(value));
        this.layoutContent();
        return;
      case 'textcolorindex':
        this.colorIndex = toNumber(value);
        this.restyle();
        return;
      default:
        super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    if (method.toLowerCase() === 'setfont') {
      this.colorIndex = applyFont([this.label], args) ?? this.colorIndex;
      this.restyle();
      this.layoutContent();
      return 0;
    }
    return super.send(method, args);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.unsubscribe();
    super.destroy();
  }
}

/**
 * A phrase that wraps onto a second line: two boxes with text that move as
 * one answer. `x1, y1, graphic1, text1, x2, y2, graphic2, text2, z, attribute[, value]`
 */
export class RDoubleGraphicTextAnswer extends RAnswer {
  private readonly graphic2 = new Sprite();
  private readonly label1 = makeLabel('');
  private readonly label2 = makeLabel('');
  private readonly offset2: [number, number];
  private colorIndex: number | null = null;
  private readonly unsubscribe: () => void;

  constructor(engine: GameEngine, args: Value[]) {
    const [x1, y1, g1, , x2, y2, g2, , z] = args.map((a) => toNumber(a));
    super(engine, 'RDoubleGraphicTextAnswer', [x1, y1, z, g1], args[9], args[10]);
    this.offset2 = [x2 - x1, y2 - y1];
    this.label1.text = toText(args[3] ?? '');
    this.label2.text = toText(args[7] ?? '');
    this.graphic2.position.set(this.offset2[0], this.offset2[1]);
    this.view.addChild(this.graphic2, this.label1, this.label2);
    const [w1, h1] = this.size;
    const [w2, h2] = engine.frameSize(g2) ?? [0, 0];
    this.size = [Math.max(w1, this.offset2[0] + w2), Math.max(h1, this.offset2[1] + h2)];
    void engine.loadAseq(g2).then((loaded) => {
      if (loaded && !this.destroyed) this.graphic2.texture = loaded.frames[0];
    });
    this.layoutContent();
    this.unsubscribe = engine.onPalette(() => this.restyle());
  }

  protected layoutContent(): void {
    if (!this.label1) return;
    const n = (key: string) => toNumber(this.props.get(key) ?? 2);
    this.label1.position.set(n('text1offsetx'), n('text1offsety'));
    this.label2.position.set(this.offset2[0] + n('text2offsetx'), this.offset2[1] + n('text2offsety'));
  }

  private restyle() {
    if (this.colorIndex === null) return;
    const fill = this.engine.paletteColor(this.colorIndex);
    this.label1.style.fill = fill;
    this.label2.style.fill = fill;
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'text1offsetx':
      case 'text1offsety':
      case 'text2offsetx':
      case 'text2offsety':
        this.props.set(name.toLowerCase(), toNumber(value));
        this.layoutContent();
        return;
      case 'graphic1offsetz':
      case 'graphic2offsetz':
        return; // layering within the answer: both boxes draw together here
      default:
        super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    if (method.toLowerCase() === 'setfont') {
      this.colorIndex = applyFont([this.label1, this.label2], args) ?? this.colorIndex;
      this.restyle();
      return 0;
    }
    return super.send(method, args);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.unsubscribe();
    super.destroy();
  }
}

/**
 * An invisible drop area for answers. `value` is the target; `answerValue`
 * sums the values of the answers in it. Events: answerPlaced, answerRemoved,
 * answerFlyOn / answerFlyOff (an answer dragged over or away from it).
 * `x, y, w, h, z[, value]`
 */
export class RValueContainer extends DisplayObject {
  readonly answers: RAnswer[] = [];
  /** Answers currently being dragged over this container. */
  readonly flyOver = new Set<RAnswer>();
  value: Value;
  enabled = true;
  protected readonly areaW: number;
  protected readonly areaH: number;

  constructor(engine: GameEngine, className: string, [x, y, w, h, z]: number[], value: Value | undefined) {
    super(engine, className);
    this.areaW = w;
    this.areaH = h;
    this.view.position.set(x, y);
    this.view.zIndex = z;
    this.touchy = false;
    this.value = value ?? 0;
  }

  /** The drop area; it follows the container's x/y (e.g. CWS3's sled). */
  get rect() {
    return { x: this.view.x, y: this.view.y, w: this.areaW, h: this.areaH };
  }

  answerValue(): number {
    return this.answers.reduce((sum, a) => sum + toNumber(a.value), 0);
  }

  evaluate(): Verdict {
    if (this.answers.length > 0 && sameValue(this.answerValue(), toNumber(this.value))) return 'solved';
    return this.isFull() ? 'wrong' : 'pending';
  }

  isSolved(): boolean {
    return this.evaluate() === 'solved';
  }

  isFull(): boolean {
    return false;
  }

  accepts(_answer: RAnswer): boolean {
    return this.enabled;
  }

  /** Is the answer, where it is now, over this area? */
  hits(answer: RAnswer): boolean {
    const r = this.rect;
    if (answer.usesHotPoint) {
      const [px, py] = answer.dropPoint();
      return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
    }
    const { x, y } = answer.view;
    return x < r.x + r.w && x + answer.w > r.x && y < r.y + r.h && y + answer.h > r.y;
  }

  /** How strongly the answer is over this container; a drop goes to the highest score. */
  /** How strongly a dropped answer targets this container: its overlap, so where drop areas overlap (PWS2's slanted boxes) the most-covered one wins. */
  hitScore(answer: RAnswer): number {
    if (!this.hits(answer)) return 0;
    const r = this.rect;
    return Math.max(1, overlapArea(answer, r.x, r.y, r.w, r.h));
  }

  /** Called on every move of a dragged answer, over this container or not, so it can preview the drop. */
  hover(_answer: RAnswer, _over: boolean): void {}

  /** An answer already in this container was dragged and dropped on it again. */
  rearrange(_answer: RAnswer): void {
    this.layout();
  }

  add(answer: RAnswer): void {
    if (!this.answers.includes(answer)) this.answers.push(answer);
    answer.container = this;
    answer.used = true;
    this.layout();
  }

  remove(answer: RAnswer): void {
    const i = this.answers.indexOf(answer);
    if (i >= 0) this.answers.splice(i, 1);
    if (answer.container === this) {
      answer.container = null;
      answer.used = false;
    }
    this.flyOver.delete(answer);
    this.layout();
  }

  /** Centres the answers in the area. */
  layout(immediate = false): void {
    const r = this.rect;
    for (const a of this.answers) {
      const x = Math.round(r.x + (r.w - a.w) / 2);
      const y = Math.round(r.y + (r.h - a.h) / 2);
      if (immediate) a.placeAt(x, y);
      else a.moveTo(x, y);
    }
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'value': return this.value;
      case 'answervalue': return this.answerValue();
      case 'answercount': return this.answers.length;
      case 'isfull': return this.isFull() ? 1 : 0;
      case 'issolved': return this.isSolved() ? 1 : 0;
      case 'enabled': return this.enabled ? 1 : 0;
      case 'width': return this.areaW;
      case 'height': return this.areaH;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'value': this.value = value; return;
      case 'enabled': this.enabled = truthy(value); return;
      case 'x':
      case 'y':
        super.setProp(name, key, value);
        this.layout(true); // answers ride along
        return;
      default: super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'playanimation':
      case 'stopanimation':
      case 'replacepaletteentry':
        return 0;
      default:
        return super.send(method, args);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const a of this.answers) if (a.container === this) a.container = null;
    this.answers.length = 0;
    this.flyOver.clear();
    super.destroy();
  }
}

/** A value container that lines its answers up left to right, as many as fit its width. */
export class RHorizontalValueContainer extends RValueContainer {
  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RHorizontalValueContainer', args.slice(0, 5).map(toNumber), args[5]);
  }

  private usedWidth(): number {
    return this.answers.reduce((sum, a) => sum + a.w, 0);
  }

  accepts(answer: RAnswer): boolean {
    return this.enabled && (answer.container === this || this.usedWidth() + answer.w <= this.areaW);
  }

  isFull(): boolean {
    const smallest = Math.min(...this.answers.map((a) => a.w), Infinity);
    return this.answers.length > 0 && this.usedWidth() + smallest > this.areaW;
  }

  layout(immediate = false): void {
    const r = this.rect;
    let x = r.x;
    for (const a of this.answers) {
      const px = Math.round(x);
      const py = Math.round(r.y + r.h - a.h);
      if (immediate) a.placeAt(px, py);
      else a.moveTo(px, py);
      x += a.w;
    }
  }
}

/**
 * A column answers stack up in (OWS1), following 4THADV32.EXE's
 * RStackingContainer: `x, y, w, h, z[, value[, solvedAnswerCount]]`. Answers
 * sit left-aligned, bottom up, overlapping by their extraTop/extraBottom
 * pixels; taking one out drops the ones above it (droppedSound). It takes an
 * answer while the stack still fits its height, and is solved when the values
 * add up to `value` (with solvedAnswerCount answers, unless that is -1).
 */
export class RStackingContainer extends RValueContainer {
  solvedAnswerCount: number;
  droppedSound = -1;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RStackingContainer', args.slice(0, 5).map(toNumber), args[5] ?? 1);
    this.solvedAnswerCount = args[6] === undefined ? -1 : toNumber(args[6]);
  }

  private usedHeight(): number {
    return this.answers.reduce((sum, a) => sum + a.logicalH, 0);
  }

  hits(answer: RAnswer): boolean {
    return this.hitScore(answer) > 0;
  }

  hitScore(answer: RAnswer): number {
    const r = this.rect;
    return overlapArea(answer, r.x, r.y, r.w, r.h);
  }

  accepts(answer: RAnswer): boolean {
    return this.enabled && (answer.container === this || this.usedHeight() + answer.logicalH <= this.areaH);
  }

  isFull(): boolean {
    return this.answers.length > 0 && this.usedHeight() >= this.areaH;
  }

  evaluate(): Verdict {
    const counted = this.solvedAnswerCount === -1 || this.answers.length === this.solvedAnswerCount;
    if (this.answers.length > 0 && counted && sameValue(this.answerValue(), toNumber(this.value))) return 'solved';
    return this.isFull() ? 'wrong' : 'pending';
  }

  layout(immediate = false): void {
    const r = this.rect;
    let level = r.y + r.h;
    for (const a of this.answers) {
      level -= a.logicalH;
      const x = Math.round(r.x - a.extra.left);
      const y = Math.round(level - a.extra.top);
      if (immediate) a.placeAt(x, y);
      else a.moveTo(x, y);
    }
  }

  remove(answer: RAnswer): void {
    const i = this.answers.indexOf(answer);
    const hadAbove = i >= 0 && i < this.answers.length - 1;
    super.remove(answer);
    if (hadAbove && this.droppedSound > 0) this.engine.playSound(this.droppedSound);
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'solvedanswercount': return this.solvedAnswerCount;
      case 'droppedsound': return this.droppedSound;
      case 'highlighted': return 0;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'solvedanswercount': this.solvedAnswerCount = toNumber(value); return;
      case 'droppedsound': this.droppedSound = toNumber(value); return;
      case 'highlighted': return;
      default: super.setProp(name, key, value);
    }
  }
}

/**
 * A row answers line up in (OWS2's sentence), following 4THADV32.EXE's
 * RHorizontalContainer: `x, y, w, h, z`. A dropped answer goes in by its x
 * among the others and the row closes up from the left, neighbours overlapping
 * by their extraLeft/extraRight pixels (slideSound when others shift); deltaZ
 * restacks them left to right. answerMatchString is the answers' attributes
 * run together, and the row is solved when it equals an addAnswerMatch string.
 */
export class RHorizontalContainer extends RValueContainer {
  private readonly matches: string[] = [];
  private deltaZ = 0;
  private slideSound = -1;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RHorizontalContainer', args.slice(0, 5).map(toNumber), 0);
  }

  private matchString(): string {
    return this.answers.map((a) => toText(a.attribute)).join('');
  }

  private usedWidth(): number {
    return this.answers.reduce((sum, a) => sum + a.logicalW, 0);
  }

  hits(answer: RAnswer): boolean {
    return this.hitScore(answer) > 0;
  }

  hitScore(answer: RAnswer): number {
    const r = this.rect;
    return overlapArea(answer, r.x, r.y, r.w, r.h);
  }

  accepts(answer: RAnswer): boolean {
    return this.enabled && (answer.container === this || this.usedWidth() + answer.logicalW <= this.areaW);
  }

  isFull(): boolean {
    return this.answers.length > 0 && this.usedWidth() >= this.areaW;
  }

  evaluate(): Verdict {
    if (this.answers.length > 0 && this.matches.includes(this.matchString())) return 'solved';
    return this.isFull() ? 'wrong' : 'pending';
  }

  /** Puts the answer in the row before the first answer to its right. */
  private insert(answer: RAnswer) {
    const i = this.answers.indexOf(answer);
    if (i >= 0) this.answers.splice(i, 1);
    const left = answer.view.x + answer.extra.left;
    const at = this.answers.findIndex((a) => a.view.x + a.extra.left > left);
    this.answers.splice(at < 0 ? this.answers.length : at, 0, answer);
    if (at >= 0 && this.slideSound > 0) this.engine.playSound(this.slideSound);
  }

  add(answer: RAnswer): void {
    this.insert(answer);
    answer.container = this;
    answer.used = true;
    this.layout();
  }

  rearrange(answer: RAnswer): void {
    this.insert(answer);
    this.layout();
  }

  remove(answer: RAnswer): void {
    const i = this.answers.indexOf(answer);
    const hadRight = i >= 0 && i < this.answers.length - 1;
    super.remove(answer);
    if (hadRight && this.slideSound > 0) this.engine.playSound(this.slideSound);
  }

  layout(immediate = false): void {
    const r = this.rect;
    let x = r.x;
    for (const a of this.answers) {
      const px = Math.round(x - a.extra.left);
      const py = Math.round(r.y - a.extra.top);
      if (immediate) a.placeAt(px, py);
      else a.moveTo(px, py);
      x += a.logicalW;
    }
    this.restack();
  }

  private restack() {
    if (this.deltaZ === 0) return;
    const base = this.view.zIndex + 1;
    const n = this.answers.length;
    this.answers.forEach((a, i) => {
      a.view.zIndex = this.deltaZ > 0 ? base + i * this.deltaZ : base + (n - 1 - i) * -this.deltaZ;
    });
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'answermatchstring': return this.matchString();
      case 'deltaz': return this.deltaZ;
      case 'slidesound': return this.slideSound;
      case 'highlighted': return 0;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'deltaz':
        this.deltaZ = toNumber(value);
        this.restack();
        return;
      case 'slidesound': this.slideSound = toNumber(value); return;
      case 'highlighted': return;
      default: super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'addanswermatch':
        this.matches.push(toText(args[0] ?? ''));
        return 0;
      case 'dumpanswermatches': // a debug listing in the original
        return 0;
      default:
        return super.send(method, args);
    }
  }
}

/**
 * A drop target that wants an answer with a matching `attribute`: the right
 * phrase for a question (CWS3), the right country for the pin (CWS4).
 * `x, y, w, h, z, attribute` (a rectangle) or `imageID, z, attribute` (a
 * shape at the image's position; with doPixelCompare only its opaque pixels
 * count). Holds one answer; anchorAnswerAtPoint snaps the answer's hot point
 * to (answerAnchorPointX, answerAnchorPointY).
 */
export class RAttributeContainer extends RValueContainer {
  attribute: Value;
  private readonly shape: Sprite | null;
  private anchorAtPoint = false;
  private anchorX = 0;
  private anchorY = 0;
  private pixelCompare = false;
  /** PWS2 recolours its crossword boxes between puzzles (replacePaletteEntry). */
  private readonly swaps = new PaletteSwaps();
  private readonly recolored = new RecoloredFrames();
  private baseFrame: Texture | null = null;
  private paletteOff: (() => void) | null = null;

  constructor(engine: GameEngine, args: Value[]) {
    const shapeId = args.length >= 6 ? null : toNumber(args[0]);
    super(engine, 'RAttributeContainer', RAttributeContainer.area(engine, args, shapeId), 0);
    this.attribute = shapeId === null ? args[5] : args.length === 5 ? args[4] : args[2];
    if (shapeId === null) {
      this.shape = null;
      return;
    }
    const id = shapeId;
    const shape = new Sprite(Texture.EMPTY);
    // `imageID, x, y, z, attribute` draws its image (OWS3's answer slots); the
    // `imageID, z, attribute` shape is a hit mask over a map that shows the place.
    shape.alpha = args.length === 5 ? 1 : 0;
    this.view.addChild(shape);
    this.shape = shape;
    void engine.loadAseq(id).then((loaded) => {
      if (!loaded || this.destroyed) return;
      this.baseFrame = loaded.frames[0];
      this.redrawShape();
    });
  }

  private redrawShape(): void {
    if (!this.shape || !this.baseFrame || this.destroyed) return;
    this.shape.texture = this.recolored.apply(this.engine, [this.baseFrame], this.swaps)[0];
  }

  send(method: string, args: Value[]): Value {
    if (method.toLowerCase() === 'replacepaletteentry') {
      this.swaps.replace(toNumber(args[0]), toNumber(args[1]));
      this.paletteOff ??= this.engine.onPalette(() => this.redrawShape());
      this.redrawShape();
      return 0;
    }
    return super.send(method, args);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.paletteOff?.();
    this.recolored.release();
    super.destroy();
  }

  /** `x, y, w, h, z` for the rectangle form, or the shape image's position and size. */
  private static area(engine: GameEngine, args: Value[], shapeId: number | null): number[] {
    if (shapeId === null) return args.slice(0, 5).map(toNumber);
    const [w, h] = engine.frameSize(shapeId) ?? [0, 0];
    if (args.length === 5) return [toNumber(args[1]), toNumber(args[2]), w, h, toNumber(args[3])];
    const [x, y] = engine.originOf(shapeId) ?? [0, 0];
    return [x, y, w, h, toNumber(args[1])];
  }

  hits(answer: RAnswer): boolean {
    if (!answer.usesHotPoint && !this.pixelCompare) return super.hits(answer);
    const [px, py] = answer.dropPoint();
    const r = this.rect;
    if (px < r.x || px >= r.x + r.w || py < r.y || py >= r.y + r.h) return false;
    if (!this.pixelCompare || !this.shape || this.shape.texture === Texture.EMPTY) return true;
    return spriteHit(this.shape, px, py);
  }

  accepts(answer: RAnswer): boolean {
    return this.enabled && (this.answers.length === 0 || this.answers.includes(answer));
  }

  isFull(): boolean {
    return this.answers.length > 0;
  }

  evaluate(): Verdict {
    if (this.answers.length === 0) return 'pending';
    const want = toText(this.attribute);
    return this.answers.every((a) => toText(a.attribute) === want) ? 'solved' : 'wrong';
  }

  layout(immediate = false): void {
    if (!this.anchorAtPoint) {
      super.layout(immediate);
      return;
    }
    const r = this.rect;
    for (const a of this.answers) {
      const [ox, oy] = a.dropOffset();
      const x = Math.round(r.x + this.anchorX - ox);
      const y = Math.round(r.y + this.anchorY - oy);
      if (immediate) a.placeAt(x, y);
      else a.moveTo(x, y);
    }
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'attribute': return this.attribute;
      case 'anchoransweratpoint': return this.anchorAtPoint ? 1 : 0;
      case 'answeranchorpointx': return this.anchorX;
      case 'answeranchorpointy': return this.anchorY;
      case 'dopixelcompare': return this.pixelCompare ? 1 : 0;
      case 'highlighted': return this.shape && this.shape.alpha > 0 ? 1 : 0;
      case 'answerproperty': // `get_prop container, answerProperty, "attribute", var`: a property of the answer in it
        return this.answers[0] && key !== undefined ? this.answers[0].getProp(toText(key), undefined) : 0;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'attribute': this.attribute = value; return;
      case 'anchoransweratpoint': this.anchorAtPoint = truthy(value); return;
      case 'answeranchorpointx': this.anchorX = toNumber(value); return;
      case 'answeranchorpointy': this.anchorY = toNumber(value); return;
      case 'dopixelcompare': this.pixelCompare = truthy(value); return;
      case 'highlighted':
        if (this.shape) this.shape.alpha = truthy(value) ? 0.5 : 0;
        return;
      default: super.setProp(name, key, value);
    }
  }
}

/**
 * Puzzle totals compared with a little slack: OWS1's decimal targets arrive as
 * `targetValue*100` (8.7 * 100 = 869.9999999999999) while its blocks sum to 870.
 */
function sameValue(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function overlapArea(a: RAnswer, x: number, y: number, w: number, h: number): number {
  const ox = Math.min(a.view.x + a.w, x + w) - Math.max(a.view.x, x);
  const oy = Math.min(a.view.y + a.h, y + h) - Math.max(a.view.y, y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

/**
 * A bolt of cloth cut with the scissors (CWS2), following 4THADV32.EXE's
 * RFabricContainer: `segmentImageID, x, y, z, pixelsPerUnit, piecesPerUnit, units`.
 * The bolt is `piecesPerUnit × units` stacked piece images, pixelsPerUnit /
 * piecesPerUnit apart. The scissors mark the piece they overlap most and every
 * piece below it (drawn with the cut frame); that count picks the fraction
 * label (infoAOID entry count+1, e.g. "Halves", "1/2", "1", "1 1/2"). The bolt
 * is solved when the count equals correctSegments (-1: never).
 */
export class RFabricContainer extends RValueContainer {
  correctSegments = -1;
  private count = 0;
  private readonly total: number;
  private readonly step: number;
  private readonly pieces: Sprite[] = [];
  private baseFrames: Texture[] = [];
  private shownFrames: Texture[] = [];
  /** Original palette index -> the index it is drawn with (replacePaletteEntry). */
  private readonly palette = new Map<number, number>();
  private info: AseqAnimation | null = null;
  private infoOffset = 0;
  private infoWidth = 0;
  private recolorQueued = false;
  private readonly unsubscribe: () => void;

  constructor(engine: GameEngine, args: Value[]) {
    const [imageId, x, y, z, pixelsPerUnit, perUnit, units] = args.map((a) => toNumber(a));
    const total = Math.max(1, perUnit * Math.max(1, units));
    const step = pixelsPerUnit / Math.max(1, perUnit);
    const width = engine.frameSize(imageId)?.[0] ?? 71;
    super(engine, 'RFabricContainer', [x, y, width, Math.round(step * total) + 1, z], 0);
    this.total = total;
    this.step = step;
    for (let i = 0; i < total; i++) {
      const piece = new Sprite(Texture.EMPTY);
      piece.position.set(0, Math.round(i * step));
      this.pieces.push(piece);
      this.view.addChild(piece);
    }
    void engine.loadAseq(imageId).then((loaded) => {
      if (!loaded || this.destroyed) return;
      this.baseFrames = loaded.frames;
      this.recolor();
    });
    this.unsubscribe = engine.onPalette(() => this.queueRecolor());
  }

  private queueRecolor() {
    if (this.recolorQueued) return;
    this.recolorQueued = true;
    queueMicrotask(() => {
      this.recolorQueued = false;
      if (!this.destroyed) this.recolor();
    });
  }

  private recolor() {
    if (this.baseFrames.length === 0) return;
    const old = this.shownFrames;
    const swaps = [...this.palette];
    this.shownFrames = swaps.some(([a, b]) => a !== b) ? recolorFrames(this.engine, this.baseFrames, swaps) : this.baseFrames;
    this.refresh();
    if (old !== this.baseFrames) for (const t of old) t.destroy(true);
  }

  private refresh() {
    const f = this.shownFrames;
    this.pieces.forEach((piece, i) => {
      const cut = i >= this.total - this.count;
      piece.texture = f[cut && f.length > 1 ? 1 : 0] ?? Texture.EMPTY;
    });
    this.info?.showEntry(this.count);
  }

  private setCount(count: number) {
    if (count === this.count) return;
    this.count = count;
    this.refresh();
  }

  /** Pieces marked by the answer: from the piece it overlaps most down to the bottom (0 if none). */
  private countFor(answer: RAnswer): number {
    const r = this.rect;
    let best = 0;
    let count = 0;
    for (let i = 0; i < this.total; i++) {
      const area = overlapArea(answer, r.x, r.y + Math.round(i * this.step), this.areaW, Math.round(this.step) + 1);
      if (area > best) {
        best = area;
        count = this.total - i;
      }
    }
    return count;
  }

  private loadInfo(id: number) {
    void this.engine.loadAseq(id).then((loaded) => {
      if (!loaded || this.destroyed) return;
      this.info?.destroy();
      const anim = new AseqAnimation(loaded.frames);
      anim.loop = false;
      anim.setList(sequenceList(loaded));
      this.info = anim;
      this.infoWidth = loaded.frames[0]?.width ?? 0;
      this.view.addChild(anim);
      this.placeInfo();
      anim.showEntry(this.count);
    });
  }

  /** The label is centred over the bolt, infoVerticalOffset from its top. */
  private placeInfo() {
    this.info?.position.set(Math.round((this.areaW - this.infoWidth) / 2), this.infoOffset);
  }

  hits(answer: RAnswer): boolean {
    return this.hitScore(answer) > 0;
  }

  hitScore(answer: RAnswer): number {
    const r = this.rect;
    return overlapArea(answer, r.x, r.y, r.w, r.h);
  }

  hover(answer: RAnswer, over: boolean): void {
    if (this.answers.length > 0 && !this.answers.includes(answer)) return; // another cut is showing
    this.setCount(over ? this.countFor(answer) : 0);
  }

  accepts(answer: RAnswer): boolean {
    return this.enabled && (this.answers.length === 0 || this.answers.includes(answer));
  }

  isFull(): boolean {
    return this.answers.length > 0;
  }

  evaluate(): Verdict {
    if (this.answers.length === 0) return 'pending';
    return this.count === this.correctSegments ? 'solved' : 'wrong';
  }

  add(answer: RAnswer): void {
    super.add(answer);
    this.setCount(this.countFor(answer));
  }

  remove(answer: RAnswer): void {
    super.remove(answer);
    if (this.answers.length === 0) this.setCount(0);
  }

  layout(_immediate = false): void {
    // the scissors stay where they were dropped
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'correctsegments': return this.correctSegments;
      case 'segmentcount': return this.count;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'correctsegments': this.correctSegments = toNumber(value); return;
      case 'infoaoid': this.loadInfo(toNumber(value)); return;
      case 'infoverticaloffset':
        this.infoOffset = toNumber(value);
        this.placeInfo();
        return;
      default: super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    if (method.toLowerCase() === 'replacepaletteentry') {
      // replacePaletteEntry from, to: whatever currently draws with `from` now draws with `to`
      const from = toNumber(args[0]);
      const to = toNumber(args[1]);
      let matched = false;
      for (const [orig, current] of this.palette) {
        if (current === from) {
          this.palette.set(orig, to);
          matched = true;
        }
      }
      if (!matched && !this.palette.has(from)) this.palette.set(from, to);
      this.queueRecolor();
      return 0;
    }
    return super.send(method, args);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.unsubscribe();
    const shown = this.shownFrames;
    super.destroy();
    if (shown !== this.baseFrames) for (const t of shown) t.destroy(true);
  }
}

/**
 * Owns a puzzle's answers and containers and resolves drops. Fires
 * `puzzleSolved` when every container is solved, and `puzzleWrong` when an
 * answer lands where it doesn't belong (or value containers fill up wrongly).
 * Scripts name answers and containers by variable, e.g. `send puzzle, addAnswer, ("cups."+n)`.
 */
export class RPuzzle extends ScriptObject {
  private answers: RAnswer[] = [];
  private containers: RValueContainer[] = [];
  private solved = false;

  constructor(engine: GameEngine) {
    super(engine, 'RPuzzle');
  }

  private resolve(v: Value | undefined): EngineObject | null {
    const obj = isEngineObject(v) ? v : this.engine.lookupVar(toText(v ?? ''));
    return isEngineObject(obj) ? obj : null;
  }

  private answer(v: Value | undefined): RAnswer | null {
    const obj = this.resolve(v);
    if (obj instanceof RAnswer) return obj;
    this.engine.warn(`RPuzzle: ${toText(v ?? '')} is not an answer`);
    return null;
  }

  private container(v: Value | undefined): RValueContainer | null {
    const obj = this.resolve(v);
    if (obj instanceof RValueContainer) return obj;
    this.engine.warn(`RPuzzle: ${toText(v ?? '')} is not a supported container`);
    return null;
  }

  private prune() {
    this.answers = this.answers.filter((a) => !a.destroyed);
    this.containers = this.containers.filter((c) => !c.destroyed);
  }

  send(method: string, args: Value[]): Value {
    this.prune();
    switch (method.toLowerCase()) {
      case 'addanswer': {
        const a = this.answer(args[0]);
        if (a && !this.answers.includes(a)) {
          a.puzzle = this;
          this.answers.push(a);
        }
        return 0;
      }
      case 'removeanswer': {
        const a = this.answer(args[0]);
        if (a) {
          a.container?.remove(a);
          a.puzzle = null;
          this.answers = this.answers.filter((x) => x !== a);
        }
        return 0;
      }
      case 'addcontainer': {
        const c = this.container(args[0]);
        if (c && !this.containers.includes(c)) this.containers.push(c);
        return 0;
      }
      case 'removecontainer': {
        const c = this.container(args[0]);
        if (c) this.containers = this.containers.filter((x) => x !== c);
        return 0;
      }
      case 'addanswertocontainer': {
        const a = this.answer(args[0]);
        const c = this.container(args[1]);
        if (a && c) {
          a.container?.remove(a);
          c.add(a);
        }
        return 0;
      }
      case 'removeanswerfromcontainer': {
        const a = this.answer(args[0]);
        if (a?.container) {
          a.container.remove(a);
          a.goHome();
        }
        return 0;
      }
      case 'anchoranswers':
      case 'unanchoranswers': {
        const anchored = method.toLowerCase() === 'anchoranswers';
        for (const a of this.answers) a.anchored = anchored;
        return 0;
      }
      case 'reset':
        for (const a of this.answers) {
          a.container?.remove(a);
          a.goHome();
        }
        this.solved = false;
        return 0;
      default:
        return super.send(method, args);
    }
  }

  getProp(name: string, key: Value | undefined): Value {
    this.prune();
    switch (name.toLowerCase()) {
      case 'issolved': return this.allSolved() ? 1 : 0;
      case 'areanswersused': return this.answers.every((a) => a.container) ? 1 : 0;
      case 'arecontainersfull': return this.containers.every((c) => c.isFull()) ? 1 : 0;
      default: return super.getProp(name, key);
    }
  }

  private allSolved(): boolean {
    return this.containers.length > 0 && this.containers.every((c) => c.isSolved());
  }

  /** Called while an answer is dragged: fires answerFlyOn / answerFlyOff as it crosses containers. */
  answerMoved(answer: RAnswer): void {
    for (const c of this.containers) {
      if (c.destroyed) continue;
      const over = c.enabled && c.hits(answer);
      c.hover(answer, over);
      if (over === c.flyOver.has(answer)) continue;
      if (over) c.flyOver.add(answer);
      else c.flyOver.delete(answer);
      c.fire(over ? 'answerFlyOn' : 'answerFlyOff');
    }
  }

  /** Called by an answer the player just let go of. */
  answerDropped(answer: RAnswer): void {
    this.prune();
    for (const c of this.containers) {
      if (c.flyOver.delete(answer)) c.fire('answerFlyOff');
    }
    const from = answer.container;
    let target: RValueContainer | undefined;
    let best = 0;
    for (const c of this.containers) {
      const score = c.enabled ? c.hitScore(answer) : 0;
      if (score > best) {
        best = score;
        target = c;
      }
    }
    for (const c of this.containers) if (c !== target) c.hover(answer, false);
    if (target && target === from) {
      target.rearrange(answer); // moved within its container: back into place, or a new spot in a row
      return;
    }
    if (from) {
      from.remove(answer);
      answer.fire('removedFromContainer');
      from.fire('answerRemoved');
    }
    if (!target || !target.accepts(answer)) {
      answer.goHome();
      this.checkSolved();
      return;
    }
    target.add(answer);
    answer.playSound('snap');
    answer.fire('addedToContainer');
    target.fire('answerPlaced');
    if (this.destroyed) return;
    if (target instanceof RAttributeContainer && target.evaluate() === 'wrong') {
      this.solved = false;
      this.fire('puzzleWrong');
      return;
    }
    this.checkSolved();
  }

  private checkSolved() {
    if (this.destroyed) return;
    if (this.allSolved()) {
      if (!this.solved) {
        this.solved = true;
        this.fire('puzzleSolved');
      }
      return;
    }
    this.solved = false;
    const valueContainers = this.containers.filter((c) => !(c instanceof RAttributeContainer));
    if (valueContainers.length > 0 && valueContainers.every((c) => c.isFull())) this.fire('puzzleWrong');
  }
}
