import type { Value } from './ScriptVm';
import { toNumber, toText } from './ScriptVm';
import { ScriptObject, propKey } from './ScriptObject';
import type { GameEngine } from './GameEngine';

type Stored = number | string;

interface PlayerRecord {
  name: string;
  props: Record<string, Stored>;
}

const PLAYERS_KEY = 'cf4.players';
const GLOBALS_KEY = 'cf4.globals';
/**
 * Where a brand-new player starts. Inferred, not confirmed: "CBA1" sits next to
 * currentLocation/inGame in 4THADV32.EXE's strings, and sign-in led straight to
 * CBA1 (the desert camp) in a capture session. FL.MPS is a QA level select.
 */
const NEW_PLAYER_LOCATION = 'CBA1';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: progress lasts for this session only */
  }
}

function toStored(v: Value): Stored {
  return typeof v === 'number' ? v : toText(v);
}

/**
 * The persistent game state behind RWorldPort: the player roster and each
 * player's properties, plus properties shared by all players. Saved to
 * localStorage in place of the original's 4THADV.DAT.
 */
export class WorldState {
  private readonly globalNames = new Set<string>();
  private readonly globals: Record<string, Stored> = load(GLOBALS_KEY, {});
  private readonly players: PlayerRecord[] = load(PLAYERS_KEY, []);
  private readonly session: Record<string, Stored> = {};
  private active: PlayerRecord | null = null;

  declare(name: string, isGlobal: boolean, initial: Value): void {
    const key = name.toLowerCase();
    if (isGlobal) {
      this.globalNames.add(key);
      if (!(key in this.globals)) this.globals[key] = toStored(initial);
    } else if (this.active && !(key in this.active.props)) {
      this.active.props[key] = toStored(initial);
    }
  }

  get(name: string, key: Value | undefined): Value {
    const k = propKey(name, key);
    switch (name.toLowerCase()) {
      case 'playerscount': return this.players.length;
      case 'playername': return this.active?.name ?? '';
      case 'currentlocation': return this.active?.props[k] ?? NEW_PLAYER_LOCATION;
      case 'currentlevel': return this.active?.props[k] ?? 1; // puzzle data tables start at level 1
    }
    if (this.globalNames.has(k) || k in this.globals) return this.globals[k] ?? 0;
    return (this.active ? this.active.props[k] : this.session[k]) ?? 0;
  }

  set(name: string, key: Value | undefined, value: Value): void {
    const k = propKey(name, key);
    if (this.globalNames.has(k) || k in this.globals) {
      this.globals[k] = toStored(value);
      store(GLOBALS_KEY, this.globals);
    } else if (this.active) {
      this.active.props[k] = toStored(value);
      store(PLAYERS_KEY, this.players);
    } else {
      this.session[k] = toStored(value);
    }
  }

  activate(nameOrIndex: string): void {
    if (nameOrIndex.startsWith('#')) {
      this.active = this.players[toNumber(nameOrIndex.slice(1))] ?? null;
      return;
    }
    const lower = nameOrIndex.toLowerCase();
    let player = this.players.find((p) => p.name.toLowerCase() === lower);
    if (!player) {
      player = { name: nameOrIndex, props: {} };
      this.players.push(player);
      store(PLAYERS_KEY, this.players);
    }
    this.active = player;
  }

  remove(name: string): void {
    const i = this.players.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
    if (i < 0) return;
    if (this.active === this.players[i]) this.active = null;
    this.players.splice(i, 1);
    store(PLAYERS_KEY, this.players);
  }

  newGame(): void {
    if (!this.active) return;
    this.active.props = {};
    store(PLAYERS_KEY, this.players);
  }
}

/** Script handle on the shared world state; creating and deleting handles doesn't touch the state. */
export class RWorldPort extends ScriptObject {
  constructor(engine: GameEngine) {
    super(engine, 'RWorldPort');
  }

  getProp(name: string, key: Value | undefined): Value {
    return this.engine.world.get(name, key);
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    this.engine.world.set(name, key, value);
  }

  send(method: string, args: Value[]): Value {
    const world = this.engine.world;
    switch (method.toLowerCase()) {
      case 'addintproperty':
      case 'addstringproperty':
        world.declare(toText(args[0]), false, args[1] ?? (method.toLowerCase() === 'addintproperty' ? 0 : ''));
        return 0;
      case 'addglobalintproperty':
      case 'addglobalstringproperty':
        world.declare(toText(args[0]), true, args[1] ?? 0);
        return 0;
      case 'activatedatafile':
        return 0;
      case 'activateplayer':
        world.activate(toText(args[0]));
        return 0;
      case 'removeplayer':
        world.remove(toText(args[0]));
        return 0;
      case 'newgame':
        world.newGame();
        return 0;
      case 'autolevel': // raises currentLevel after correct answers; not modelled yet
        return 0;
      default:
        return super.send(method, args);
    }
  }
}

/** Script handle on scene-wide settings: background music and scene-level key handlers. */
export class RScenePort extends ScriptObject {
  constructor(engine: GameEngine) {
    super(engine, 'RScenePort');
  }

  getProp(name: string, key: Value | undefined): Value {
    return this.engine.scene.get(propKey(name, key));
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    this.engine.scene.set(propKey(name, key), value);
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'startbackgroundmusic':
      case 'resumebackgroundmusic':
        this.engine.scene.set('isbackgroundmusicenabled', 1);
        return 0;
      case 'stopbackgroundmusic':
      case 'pausebackgroundmusic':
        this.engine.scene.set('isbackgroundmusicenabled', 0);
        return 0;
      default:
        return super.send(method, args);
    }
  }
}
