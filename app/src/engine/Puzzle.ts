import { Sprite, Text, Texture } from 'pixi.js';
import type { EngineObject, Value } from './ScriptVm';
import { isEngineObject, toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject, ScriptObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { familyForFontName } from './DisplayObjects';
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
  anchored = false;
  /** A hot point (e.g. a push pin's tip) is where the answer lands instead of its middle. */
  usesHotPoint = false;
  hotPointX = 0;
  hotPointY = 0;
  protected readonly graphic = new Sprite();
  protected size: [number, number] = [0, 0];
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
      if (loaded && !this.destroyed && this.props.get('graphicid') === id) this.graphic.texture = loaded.frames[0];
    });
    this.layoutContent();
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
      case 'isused': return this.container ? 1 : 0;
      case 'value': return this.value;
      case 'attribute': return this.attribute;
      case 'width': return this.w;
      case 'height': return this.h;
      case 'isusinghotpoint': return this.usesHotPoint ? 1 : 0;
      case 'hotpointx': return this.hotPointX;
      case 'hotpointy': return this.hotPointY;
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
      case 'graphicid':
      case 'graphic':
        this.setGraphic(toNumber(value));
        return;
      default: super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'playanimation':
      case 'stopanimation':
      case 'playanimations':
      case 'stopanimations':
      case 'replacepaletteentry':
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

  protected layoutContent(): void {
    if (!this.label) return; // called from the base constructor before fields exist
    const ox = this.props.get('textoffsetx');
    const oy = this.props.get('textoffsety');
    if (ox === undefined && oy === undefined) {
      this.label.anchor.set(0.5);
      this.label.position.set(Math.round(this.w / 2), Math.round(this.h / 2));
    } else {
      this.label.anchor.set(0);
      this.label.position.set(toNumber(ox ?? 0), toNumber(oy ?? 0));
    }
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
    if (this.answers.length > 0 && this.answerValue() === toNumber(this.value)) return 'solved';
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

  add(answer: RAnswer): void {
    if (!this.answers.includes(answer)) this.answers.push(answer);
    answer.container = this;
    this.layout();
  }

  remove(answer: RAnswer): void {
    const i = this.answers.indexOf(answer);
    if (i >= 0) this.answers.splice(i, 1);
    if (answer.container === this) answer.container = null;
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

  constructor(engine: GameEngine, args: Value[]) {
    const shapeId = args.length >= 6 ? null : toNumber(args[0]);
    super(engine, 'RAttributeContainer', RAttributeContainer.area(engine, args, shapeId), 0);
    this.attribute = shapeId === null ? args[5] : args[2];
    if (shapeId === null) {
      this.shape = null;
      return;
    }
    const id = shapeId;
    const shape = new Sprite(Texture.EMPTY);
    shape.alpha = 0; // the shape is a hit mask; the map underneath shows the place
    this.view.addChild(shape);
    this.shape = shape;
    void engine.loadAseq(id).then((loaded) => {
      if (loaded && !this.destroyed) shape.texture = loaded.frames[0];
    });
  }

  /** `x, y, w, h, z` for the rectangle form, or the shape image's position and size. */
  private static area(engine: GameEngine, args: Value[], shapeId: number | null): number[] {
    if (shapeId === null) return args.slice(0, 5).map(toNumber);
    const [x, y] = engine.originOf(shapeId) ?? [0, 0];
    const [w, h] = engine.frameSize(shapeId) ?? [0, 0];
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
    const target = this.containers.find((c) => c.enabled && c.hits(answer));
    if (target && target === from) {
      target.layout(); // moved within its container: slide back into place
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
