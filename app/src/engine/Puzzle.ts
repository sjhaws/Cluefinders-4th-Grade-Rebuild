import { Sprite, Text } from 'pixi.js';
import type { EngineObject, Value } from './ScriptVm';
import { isEngineObject, toNumber, toText } from './ScriptVm';
import { DisplayObject, ScriptObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';

const SLIDE_MS = 150;

type AnswerSound = 'pickup' | 'gohome' | 'snap';

/** Stand-ins for the Mac font names puzzles ask for, until FONT.RSC is decoded. */
function fontFamily(name: string): string {
  return name.toLowerCase() === 'chicago' ? '"Arial Black", Verdana, sans-serif' : 'Verdana, sans-serif';
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
    if (id) this.engine.playSound(id);
  }

  /** Slides to a position. */
  moveTo(x: number, y: number): void {
    if (this.view.x === x && this.view.y === y) {
      this.slide = null;
      return;
    }
    this.slide = { fromX: this.view.x, fromY: this.view.y, toX: x, toY: y, t: 0 };
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
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'homex':
      case 'homey':
        if (name.toLowerCase() === 'homex') this.homeX = toNumber(value);
        else this.homeY = toNumber(value);
        if (!this.container && !this.grabOffset) this.view.position.set(this.homeX, this.homeY);
        return;
      case 'value': this.value = value; return;
      case 'attribute': this.attribute = value; return;
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
    if (this.grabOffset) this.view.position.set(Math.round(x - this.grabOffset[0]), Math.round(y - this.grabOffset[1]));
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

/** `RGraphicTextAnswer x, y, z, graphicID, text, attribute[, value]`: a graphic with a label on it. */
export class RGraphicTextAnswer extends RAnswer {
  private readonly label = new Text({ text: '', style: { fill: 0x000000, fontFamily: fontFamily(''), fontSize: 12 } });
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
      // setFont name, style, size[, colorIndex]
      this.label.style.fontFamily = fontFamily(toText(args[0]));
      this.label.style.fontWeight = toNumber(args[1]) & 1 ? 'bold' : 'normal';
      if (args[2] !== undefined) this.label.style.fontSize = toNumber(args[2]);
      if (args[3] !== undefined) this.colorIndex = toNumber(args[3]);
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
 * An invisible drop area for answers. `value` is the target; `answerValue`
 * sums the values of the answers in it. Events: answerPlaced, answerRemoved.
 * `x, y, w, h, z[, value]`
 */
export class RValueContainer extends DisplayObject {
  readonly answers: RAnswer[] = [];
  value: Value;
  enabled = true;
  protected readonly rect: { x: number; y: number; w: number; h: number };

  constructor(engine: GameEngine, className: string, args: Value[]) {
    super(engine, className);
    const [x, y, w, h, z] = args.slice(0, 5).map(toNumber);
    this.rect = { x, y, w, h };
    this.view.position.set(x, y);
    this.view.zIndex = z;
    this.touchy = false;
    this.value = args[5] ?? 0;
  }

  answerValue(): number {
    return this.answers.reduce((sum, a) => sum + toNumber(a.value), 0);
  }

  isSolved(): boolean {
    return this.answers.length > 0 && this.answerValue() === toNumber(this.value);
  }

  isFull(): boolean {
    return false;
  }

  accepts(_answer: RAnswer): boolean {
    return this.enabled;
  }

  /** Does the answer, where it is now, overlap this area? */
  hits(answer: RAnswer): boolean {
    const r = this.rect;
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
    this.layout();
  }

  /** Centres the answers in the area. */
  layout(): void {
    const r = this.rect;
    for (const a of this.answers) a.moveTo(Math.round(r.x + (r.w - a.w) / 2), Math.round(r.y + (r.h - a.h) / 2));
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'value': return this.value;
      case 'answervalue': return this.answerValue();
      case 'answercount': return this.answers.length;
      case 'isfull': return this.isFull() ? 1 : 0;
      case 'issolved': return this.isSolved() ? 1 : 0;
      case 'enabled': return this.enabled ? 1 : 0;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'value': this.value = value; return;
      case 'enabled': this.enabled = toNumber(value) !== 0; return;
      default: super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'playanimation':
      case 'stopanimation':
        return 0;
      default:
        return super.send(method, args);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const a of this.answers) if (a.container === this) a.container = null;
    this.answers.length = 0;
    super.destroy();
  }
}

/** A value container that lines its answers up left to right, as many as fit its width. */
export class RHorizontalValueContainer extends RValueContainer {
  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RHorizontalValueContainer', args);
  }

  private usedWidth(): number {
    return this.answers.reduce((sum, a) => sum + a.w, 0);
  }

  accepts(answer: RAnswer): boolean {
    return this.enabled && (answer.container === this || this.usedWidth() + answer.w <= this.rect.w);
  }

  isFull(): boolean {
    const smallest = Math.min(...this.answers.map((a) => a.w), Infinity);
    return this.answers.length > 0 && this.usedWidth() + smallest > this.rect.w;
  }

  layout(): void {
    let x = this.rect.x;
    for (const a of this.answers) {
      a.moveTo(Math.round(x), Math.round(this.rect.y + this.rect.h - a.h));
      x += a.w;
    }
  }
}

/**
 * Owns a puzzle's answers and containers, resolves drops, and fires
 * `puzzleSolved` when every container is solved (`puzzleWrong` when they
 * are all full but not solved). Scripts name answers and containers by
 * variable, e.g. `send puzzle, addAnswer, ("cups."+n)`.
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

  /** Called by an answer the player just let go of. */
  answerDropped(answer: RAnswer): void {
    this.prune();
    const from = answer.container;
    const target = this.containers.find((c) => c.enabled && c.hits(answer));
    if (target && target === from) {
      target.layout(); // moved within its container: slide back into line
      return;
    }
    if (from) {
      from.remove(answer);
      answer.fire('removedFromContainer');
      from.fire('answerRemoved');
    }
    if (target && target.accepts(answer)) {
      target.add(answer);
      answer.playSound('snap');
      answer.fire('addedToContainer');
      target.fire('answerPlaced');
    } else {
      answer.goHome();
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
    if (this.containers.length > 0 && this.containers.every((c) => c.isFull())) this.fire('puzzleWrong');
  }
}
