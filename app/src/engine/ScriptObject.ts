import { Container } from 'pixi.js';
import type { EngineObject, Value } from './ScriptVm';
import { toNumber, toText, truthy } from './ScriptVm';
import type { GameEngine } from './GameEngine';
import { viewHit } from './hitTest';

export function propKey(name: string, key: Value | undefined): string {
  return key === undefined ? name.toLowerCase() : `${name.toLowerCase()}[${toText(key).toLowerCase()}]`;
}

/**
 * Base for engine objects scripts create with `set var, Class, args`.
 * Unknown properties are stored as-is, so handlers bound with
 * `set_prop obj, event, label` are found again by `fire(event)`.
 */
export class ScriptObject implements EngineObject {
  protected readonly props = new Map<string, Value>();
  destroyed = false;
  /** The script variable this object was created into, e.g. "object.3" (the `name` property). */
  varName = '';

  constructor(
    readonly engine: GameEngine,
    readonly className: string
  ) {
    engine.track(this);
  }

  getProp(name: string, key: Value | undefined): Value {
    if (key === undefined && this.varName && name.toLowerCase() === 'name') return this.varName;
    return this.props.get(propKey(name, key)) ?? 0;
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    this.props.set(propKey(name, key), value);
  }

  send(method: string, _args: Value[]): Value {
    this.engine.warn(`${this.className}.${method} is not implemented`);
    return 0;
  }

  /** Runs the script handler bound to `event`, if any. */
  fire(event: string): void {
    const handler = this.props.get(event.toLowerCase());
    if (handler) this.engine.invokeHandler(handler, this);
  }

  destroy(): void {
    this.destroyed = true;
    this.engine.untrack(this);
  }
}

/** An engine object with a view on the stage: z order, visibility, position and pointer input. */
export class DisplayObject extends ScriptObject {
  readonly view = new Container();
  touchy = true;
  /** Movable objects follow the pointer while pressed (scripts check where they were dropped). */
  movable = false;
  private grab: [number, number] | null = null;

  constructor(engine: GameEngine, className: string) {
    super(engine, className);
    engine.sceneRoot.addChild(this.view);
  }

  getProp(name: string, key: Value | undefined): Value {
    // scripts can still hold a deleted object (e.g. a frame handler after cleanup); its view is gone
    if (this.destroyed) return super.getProp(name, key);
    switch (name.toLowerCase()) {
      case 'x': return this.view.x;
      case 'y': return this.view.y;
      case 'z': return this.view.zIndex;
      case 'visible': return this.view.visible ? 1 : 0;
      case 'touchy': return this.touchy ? 1 : 0;
      case 'movable': return this.movable ? 1 : 0;
      case 'width': return this.view.width;
      case 'height': return this.view.height;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    if (this.destroyed) return;
    switch (name.toLowerCase()) {
      case 'x': this.view.x = toNumber(value); return;
      case 'y': this.view.y = toNumber(value); return;
      case 'z': this.view.zIndex = toNumber(value); return;
      case 'visible': this.view.visible = truthy(value); return;
      case 'touchy': this.touchy = truthy(value); return;
      case 'movable': this.movable = truthy(value); return;
      default: super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'show': // e.g. OWS1's `VerbAction "rewardAnim.n", kTrue, "show"`
        if (!this.destroyed) this.view.visible = true;
        return 0;
      case 'hide':
        if (!this.destroyed) this.view.visible = false;
        return 0;
      default:
        return super.send(method, args);
    }
  }

  containsPoint(x: number, y: number): boolean {
    if (!this.view.visible || !this.touchy || this.destroyed) return false;
    const b = this.view.getBounds();
    if (x < b.minX || x >= b.maxX || y < b.minY || y >= b.maxY) return false;
    return viewHit(this.view, x, y); // transparent pixels don't count: overlapping characters stay clickable
  }

  onPointerDown(x: number, y: number): void {
    if (this.movable) this.grab = [x - this.view.x, y - this.view.y];
    this.fire('mouseDown');
  }

  onPointerMove(x: number, y: number): void {
    if (this.grab) this.view.position.set(Math.round(x - this.grab[0]), Math.round(y - this.grab[1]));
  }

  onPointerUp(_x: number, _y: number, _inside: boolean): void {
    this.grab = null;
    this.fire('mouseUp');
  }

  onDoubleClick(_x: number, _y: number): void {
    this.fire('dblClick');
  }

  /** Called every frame with elapsed milliseconds. */
  tick(_deltaMs: number): void {}

  destroy(): void {
    if (this.destroyed) return;
    super.destroy();
    this.view.destroy({ children: true });
  }
}

/** Stand-in for engine classes that aren't implemented yet: stores properties, ignores methods. */
export class GenericObject extends ScriptObject {
  send(method: string, args: Value[]): Value {
    this.engine.warn(`${this.className}.${method}(${args.map(toText).join(', ')}) is not implemented`);
    return 0;
  }
}
