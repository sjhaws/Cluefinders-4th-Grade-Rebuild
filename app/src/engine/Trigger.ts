import type { Value } from './ScriptVm';
import { toNumber, toText } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { RAnimation } from './DisplayObjects';

/**
 * A lever pulled by dragging (OMA's catapult trigger), following 4THADV32.EXE's
 * RTrigger: `RTrigger imageID, z`. Dragging down shows a later frame every
 * framePixelDelta pixels (sfxID plays once per pull); letting go fires `fired`
 * if the frame changed, `clicked` if not. Scripts read the frame as the force.
 */
export class RTrigger extends RAnimation {
  private framePixelDelta = 1;
  private sfxId = -1;
  private userData = '';
  private pull: { frame: number; y: number; played: boolean } | null = null;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, [args[0]]);
    if (args[1] !== undefined) this.view.zIndex = toNumber(args[1]);
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'framepixeldelta': return this.framePixelDelta;
      case 'sfxid': return this.sfxId;
      case 'userdata': return this.userData;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'framepixeldelta': this.framePixelDelta = Math.max(1, toNumber(value)); return;
      case 'sfxid': this.sfxId = toNumber(value); return;
      case 'userdata': this.userData = toText(value); return;
      default: super.setProp(name, key, value);
    }
  }

  onPointerDown(_x: number, y: number): void {
    this.pull = { frame: toNumber(this.getProp('frame', undefined)), y, played: false };
    this.fire('mouseDown');
  }

  onPointerMove(_x: number, y: number): void {
    const pull = this.pull;
    if (!pull) return;
    const count = Math.max(1, toNumber(this.getProp('framecount', undefined)));
    const frame = Math.min(count, Math.max(1, pull.frame + Math.trunc((y - pull.y) / this.framePixelDelta)));
    this.setProp('frame', undefined, frame);
    if (!pull.played && this.sfxId > 0) this.engine.playSound(this.sfxId);
    pull.played = true;
  }

  onPointerUp(): void {
    const pull = this.pull;
    this.pull = null;
    if (!pull) return;
    this.fire('mouseUp');
    this.fire(toNumber(this.getProp('frame', undefined)) !== pull.frame ? 'fired' : 'clicked');
  }
}

/**
 * A clock (OMA moves the thrown rock with it), following RAnimationTrigger:
 * `RAnimationTrigger framesPerSecond`; after `start` it fires `newFrame` at that
 * rate until `stop`.
 */
export class RAnimationTrigger extends DisplayObject {
  private fps: number;
  private running = false;
  private elapsed = 0;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RAnimationTrigger');
    this.fps = args[0] === undefined ? 8 : Math.max(1, toNumber(args[0]));
    this.touchy = false;
  }

  containsPoint(): boolean {
    return false;
  }

  getProp(name: string, key: Value | undefined): Value {
    if (name.toLowerCase() === 'framespersecond') return this.fps;
    return super.getProp(name, key);
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    if (name.toLowerCase() === 'framespersecond') this.fps = Math.max(1, toNumber(value));
    else super.setProp(name, key, value);
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'start':
        this.running = true;
        this.elapsed = 0;
        return 0;
      case 'stop':
        this.running = false;
        return 0;
      default:
        return super.send(method, args);
    }
  }

  tick(deltaMs: number): void {
    if (!this.running) return;
    this.elapsed += deltaMs;
    const period = 1000 / this.fps;
    if (this.elapsed < period) return;
    this.elapsed = Math.min(this.elapsed - period, period); // one frame per tick, like the original
    this.fire('newFrame');
  }
}
