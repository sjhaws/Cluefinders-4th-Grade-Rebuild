import type { Value } from './ScriptVm';
import { isEngineObject, toNumber, toText, truthy } from './ScriptVm';
import { ScriptObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { RCharacter } from './Character';
import { RAnimation } from './DisplayObjects';
import { RMap } from './Map';

/** One step of an action queue. `start` must call `done` exactly once unless stopped. */
export interface QueueAction {
  start(done: () => void): void;
  stop(): void;
  pause?(): void;
  resume?(): void;
}

/** Objects that can run inside another queue, added by variable name (`sQueue.add "walkInCAct"`). */
interface RunnableAsAction {
  runAsAction(done: () => void): void;
  stopAction(): void;
}

function isRunnable(v: Value): v is Value & RunnableAsAction {
  return isEngineObject(v) && 'runAsAction' in v;
}

/** Wraps callback-style work; `run` returns a function that cancels it. */
class TaskAction implements QueueAction {
  private cancel: (() => void) | void = undefined;
  constructor(private readonly run: (done: () => void) => (() => void) | void) {}
  start(done: () => void) {
    let finished = false;
    this.cancel = this.run(() => {
      if (!finished) {
        finished = true;
        done();
      }
    });
  }
  stop() {
    if (this.cancel) this.cancel();
  }
}

class SoundAction implements QueueAction {
  private audio: HTMLAudioElement | null = null;
  constructor(private readonly engine: GameEngine, private readonly id: number) {}
  start(done: () => void) {
    this.audio = this.engine.playSound(this.id, done);
  }
  stop() {
    this.audio?.pause();
  }
  pause() {
    this.audio?.pause();
  }
  resume() {
    if (this.audio) this.engine.playAudio(this.audio);
  }
}

function delay(ms: number, timeScale = 1): QueueAction {
  return new TaskAction((done) => {
    const timer = setTimeout(done, Math.max(0, ms) / timeScale);
    return () => clearTimeout(timer);
  });
}

const instant = (): QueueAction => delay(0);

/** Builds a queue action from `add` arguments: an action class name plus its arguments, or a variable name. */
export function makeAction(engine: GameEngine, first: Value, args: Value[]): QueueAction {
  const name = toText(first);
  // the target object's name, bound when the action is added (OWS3 queues "mouse.i" for i = 2..4)
  const bound = args.length > 0 ? engine.bindName(toText(args[0])) : '';
  switch (name.toLowerCase()) {
    case 'soundaction':
      return new SoundAction(engine, toNumber(args[0]));
    case 'delayaction': // milliseconds (e.g. 30000 between ambient sounds)
      return delay(toNumber(args[0]), engine.timeScale);
    case 'randomdelayaction': {
      const lo = toNumber(args[0]);
      return delay(lo + Math.random() * Math.max(0, toNumber(args[1]) - lo), engine.timeScale);
    }
    case 'emptyaction':
      return instant();
    case 'movieaction':
      return new TaskAction((done) => engine.playMovie(toText(args[0]), done));
    case 'propertyaction':
      return new TaskAction((done) => {
        const target = engine.lookupVar(bound);
        if (isEngineObject(target)) target.setProp(toText(args[1]), undefined, args[2] ?? 0);
        else engine.warn(`PropertyAction: ${toText(args[0])} is not an object`);
        setTimeout(done, 0);
      });
    case 'characteranimaction': // "name", animID[, repeat[, visibleAfter[, wait]]]
      return characterAction(engine, bound,(c) =>
        c.playAnim(toNumber(args[1]), args[2] === undefined ? 1 : toNumber(args[2]), args[3] === undefined || truthy(args[3]))
      );
    case 'characterspeechaction':
      return characterAction(engine, bound,(c) => c.playSpeech(toNumber(args[1])));
    case 'animaction': {
      // AnimAction id, z[, repeat]  or  AnimAction id, x, y, z, repeat (e.g. CWS2's shimmer over the solved bolt)
      const n = args.map((a) => toNumber(a));
      const positioned = args.length >= 5;
      const [z, repeat] = positioned ? [n[3], n[4]] : [n[1], args[2] === undefined ? 1 : n[2]];
      const at: [number, number] | null = positioned ? [n[1], n[2]] : null;
      return new TaskAction((done) => engine.playTempAnimation(n[0], z, repeat, done, at));
    }
    case 'verbaction': // VerbAction "objectName", wait, "method", args... -- e.g. "puzzle", kTrue, "anchorAnswers"
      return new TaskAction((done) => {
        const target = engine.lookupVar(bound);
        if (isEngineObject(target)) target.send(toText(args[2]), args.slice(3));
        else engine.warn(`VerbAction: ${toText(args[0])} is not an object`);
        setTimeout(done, 0);
      });
    case 'movexaction':
    case 'moveyaction':
      return moveAction(engine, name.toLowerCase() === 'movexaction' ? 'x' : 'y', args);
    case 'mapaction': // MapAction "map", wait: walks the map's moves
      return new TaskAction((done) => {
        const target = engine.lookupVar(bound);
        if (!(target instanceof RMap)) {
          engine.warn(`MapAction: ${toText(args[0])} is not a map`);
          setTimeout(done, 0);
          return;
        }
        if (args[1] === undefined || truthy(args[1])) {
          target.startMove(done);
          return () => target.detach();
        }
        target.startMove(null);
        setTimeout(done, 0);
      });
    case 'playanimaction':
      return new TaskAction((done) => {
        const target = engine.lookupVar(bound);
        if (!(target instanceof RAnimation)) {
          engine.warn(`PlayAnimAction: ${toText(args[0])} is not an animation`);
          setTimeout(done, 0);
          return;
        }
        if (truthy(args[1] ?? 1)) target.playOnce(done);
        else {
          target.playOnce(() => {});
          setTimeout(done, 0);
        }
      });
  }
  if (!engine.isClass(name)) {
    const target = engine.lookupVar(name);
    if (isRunnable(target)) {
      return new TaskAction((done) => {
        target.runAsAction(done);
        return () => target.stopAction();
      });
    }
  }
  engine.warn(`queue action ${name} is not implemented`);
  return instant();
}

/** Assumed step rate for MoveX/YAction velocities (pixels per step); not measured against the original. */
const MOVE_STEP_MS = 1000 / 30;

/**
 * `MoveXAction "animation", "object", start, velocity, acceleration, end`:
 * slides an object (or OMMultiTrinket) along one axis until it reaches `end`.
 * The named animation runs only while the move does: CWS4's conveyor belt is
 * still until a package rides onto or off it, and so are OWS4's logs.
 */
function moveAction(engine: GameEngine, axis: 'x' | 'y', args: Value[]): QueueAction {
  return new TaskAction((done) => {
    const target = engine.lookupVar(toText(args[1]));
    if (!isEngineObject(target)) {
      engine.warn(`move action: ${toText(args[1])} is not an object`);
      setTimeout(done, 0);
      return;
    }
    let pos = toNumber(args[2]);
    let vel = toNumber(args[3]);
    const accel = toNumber(args[4]);
    const end = toNumber(args[5]);
    const dir = Math.sign(end - pos) || 1;
    const shown = engine.lookupVar(toText(args[0]));
    const restore = shown instanceof RAnimation ? shown.runWhileMoving() : () => {};
    const finish = () => {
      clearInterval(timer);
      restore();
      done();
    };
    target.setProp(axis, undefined, pos);
    const timer = setInterval(() => {
      if ((target as { destroyed?: boolean }).destroyed) {
        finish();
        return;
      }
      pos += vel;
      vel += accel;
      const stalled = vel * dir <= 0 && accel * dir <= 0; // would never arrive
      if ((end - pos) * dir <= 0 || stalled) pos = end;
      target.setProp(axis, undefined, Math.round(pos));
      if (pos === end) finish();
    }, MOVE_STEP_MS / engine.timeScale);
    return () => {
      clearInterval(timer);
      restore();
    };
  });
}

function characterAction(engine: GameEngine, who: Value, run: (c: RCharacter) => Promise<void>): QueueAction {
  let character: RCharacter | null = null;
  return new TaskAction((done) => {
    const target = engine.lookupVar(toText(who));
    if (!(target instanceof RCharacter)) {
      engine.warn(`character ${toText(who)} not found`);
      setTimeout(done, 0);
      return;
    }
    character = target;
    void run(target).then(done);
    return () => character?.interrupt();
  });
}

/**
 * Sequential action queue (`sQueue` in the scripts): `add` actions, `start`
 * runs them in order, `finished` fires when the queue empties. Can also run
 * inside another queue or composite, by variable name.
 */
export class RQueue extends ScriptObject implements RunnableAsAction {
  private pending: QueueAction[] = [];
  private current: QueueAction | null = null;
  private active = false;
  private paused = false;
  private onComplete: (() => void) | null = null;

  constructor(engine: GameEngine) {
    super(engine, 'RQueue');
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'actioncount': return this.pending.length + (this.current ? 1 : 0);
      case 'isactive': return this.active ? 1 : 0;
      default: return super.getProp(name, key);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'add':
        this.pending.push(makeAction(this.engine, args[0], args.slice(1)));
        return 0;
      case 'start':
        this.begin();
        return 0;
      case 'halt':
        this.stopAction();
        return 0;
      case 'clear':
        this.pending = [];
        return 0;
      case 'pause':
        this.paused = true;
        this.current?.pause?.();
        return 0;
      case 'resume':
        this.paused = false;
        this.current?.resume?.();
        return 0;
      default:
        return super.send(method, args);
    }
  }

  runAsAction(done: () => void): void {
    this.onComplete = done;
    this.begin();
  }

  stopAction(): void {
    this.current?.stop();
    this.current = null;
    this.active = false;
    this.onComplete = null;
  }

  private begin() {
    if (this.active) return;
    this.active = true;
    this.next();
  }

  private next() {
    if (this.destroyed || !this.active) return;
    const action = this.pending.shift();
    if (!action) {
      this.current = null;
      this.active = false;
      const complete = this.onComplete;
      this.onComplete = null;
      this.fire('finished');
      complete?.();
      return;
    }
    this.current = action;
    action.start(() => {
      if (this.current !== action) return;
      this.current = null;
      this.next();
    });
  }

  destroy(): void {
    this.stopAction();
    this.pending = [];
    super.destroy();
  }
}

/** Runs its actions in parallel; finishes when all of them have. */
export class RCompositeAction extends ScriptObject implements RunnableAsAction {
  private readonly actions: QueueAction[] = [];
  private running: QueueAction[] = [];

  constructor(engine: GameEngine) {
    super(engine, 'RCompositeAction');
  }

  send(method: string, args: Value[]): Value {
    if (method.toLowerCase() === 'add') {
      this.actions.push(makeAction(this.engine, args[0], args.slice(1)));
      return 0;
    }
    return super.send(method, args);
  }

  runAsAction(done: () => void): void {
    this.running = [...this.actions];
    let remaining = this.running.length;
    if (remaining === 0) {
      setTimeout(done, 0);
      return;
    }
    for (const action of this.running) {
      let finished = false;
      action.start(() => {
        if (finished) return;
        finished = true;
        if (--remaining === 0) {
          this.running = [];
          done();
        }
      });
    }
  }

  stopAction(): void {
    for (const action of this.running) action.stop();
    this.running = [];
  }

  destroy(): void {
    this.stopAction();
    super.destroy();
  }
}

/**
 * Runs one of its actions, picked at random, inside a queue:
 * `RRandomAction useAllBeforeRepeat[, wait]`. With useAllBeforeRepeat each
 * action plays once before any plays again (e.g. rotating "right answer" lines).
 */
export class RRandomAction extends ScriptObject implements RunnableAsAction {
  private readonly entries: [Value, Value[]][] = [];
  private pool: number[] = [];
  private current: QueueAction | null = null;
  private useAll: boolean;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RRandomAction');
    this.useAll = truthy(args[0] ?? 0);
  }

  getProp(name: string, key: Value | undefined): Value {
    if (name.toLowerCase() === 'useallbeforerepeat') return this.useAll ? 1 : 0;
    return super.getProp(name, key);
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    if (name.toLowerCase() === 'useallbeforerepeat') this.useAll = truthy(value);
    else super.setProp(name, key, value);
  }

  send(method: string, args: Value[]): Value {
    if (method.toLowerCase() === 'add') {
      this.entries.push([args[0], args.slice(1)]);
      this.pool.push(this.entries.length - 1);
      return 0;
    }
    return super.send(method, args);
  }

  runAsAction(done: () => void): void {
    if (this.entries.length === 0) {
      setTimeout(done, 0);
      return;
    }
    if (this.pool.length === 0) this.pool = this.entries.map((_, i) => i);
    const slot = Math.floor(Math.random() * this.pool.length);
    const index = this.pool[slot];
    if (this.useAll) this.pool.splice(slot, 1);
    const [first, rest] = this.entries[index];
    const action = makeAction(this.engine, first, rest);
    this.current = action;
    action.start(() => {
      if (this.current !== action) return;
      this.current = null;
      done();
    });
  }

  stopAction(): void {
    this.current?.stop();
    this.current = null;
  }

  destroy(): void {
    this.stopAction();
    super.destroy();
  }
}

/** Keyboard input: sets `key` and fires `keyPressed` for every key press. */
export class RKbdInp extends ScriptObject {
  private readonly unsubscribe: () => void;

  constructor(engine: GameEngine) {
    super(engine, 'RKbdInp');
    this.unsubscribe = engine.addKeyListener((key) => {
      this.props.set('key', key);
      this.fire('keyPressed');
    });
  }

  destroy(): void {
    this.unsubscribe();
    super.destroy();
  }
}
