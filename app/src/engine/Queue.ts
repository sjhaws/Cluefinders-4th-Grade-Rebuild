import type { Value } from './ScriptVm';
import { isEngineObject, toNumber, toText, truthy } from './ScriptVm';
import { ScriptObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { RCharacter } from './Character';
import { RAnimation } from './DisplayObjects';

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

function delay(ms: number): QueueAction {
  return new TaskAction((done) => {
    const timer = setTimeout(done, Math.max(0, ms));
    return () => clearTimeout(timer);
  });
}

const instant = (): QueueAction => delay(0);

/** Builds a queue action from `add` arguments: an action class name plus its arguments, or a variable name. */
export function makeAction(engine: GameEngine, first: Value, args: Value[]): QueueAction {
  const name = toText(first);
  switch (name.toLowerCase()) {
    case 'soundaction':
      return new SoundAction(engine, toNumber(args[0]));
    case 'delayaction': // milliseconds (e.g. 30000 between ambient sounds)
      return delay(toNumber(args[0]));
    case 'randomdelayaction': {
      const lo = toNumber(args[0]);
      return delay(lo + Math.random() * Math.max(0, toNumber(args[1]) - lo));
    }
    case 'emptyaction':
      return instant();
    case 'movieaction':
      return new TaskAction((done) => engine.playMoviePlaceholder(toText(args[0]), done));
    case 'propertyaction':
      return new TaskAction((done) => {
        const target = engine.lookupVar(toText(args[0]));
        if (isEngineObject(target)) target.setProp(toText(args[1]), undefined, args[2] ?? 0);
        else engine.warn(`PropertyAction: ${toText(args[0])} is not an object`);
        setTimeout(done, 0);
      });
    case 'characteranimaction':
      return characterAction(engine, args[0], (c) =>
        c.playAnim(toNumber(args[1]), args[2] === undefined ? 1 : toNumber(args[2]), args[3] === undefined || truthy(args[3]))
      );
    case 'characterspeechaction':
      return characterAction(engine, args[0], (c) => c.playSpeech(toNumber(args[1])));
    case 'animaction':
      return new TaskAction((done) =>
        engine.playTempAnimation(toNumber(args[0]), toNumber(args[1]), args[2] === undefined ? 1 : toNumber(args[2]), done)
      );
    case 'playanimaction':
      return new TaskAction((done) => {
        const target = engine.lookupVar(toText(args[0]));
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
