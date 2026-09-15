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
const BACKPACK_SLOTS = 12;
/** Properties kept per location (EXE property list); an unkeyed get/set means the current location. */
const PER_LOCATION = new Set([
  'visitedcount', 'currentdataset', 'currentlevel', 'hubroundscompleted', 'levelcolor',
  'wscurrentlevelentrycount', 'wstotalguesscount', 'wstotalcorrectguesscount',
]);
const ITEMS_PER_ROUND = 12; // kNumItemsPerCRound / kNumItemsPerORound

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** Cairo glyphs 1-12 and Oasis gems 13-28 (kCGlyphStart..kGemEnd) are earned in each region's workshops. */
const WORKSHOP_REGIONS = [
  { prefix: 'c', items: range(1, 12), workshops: ['cws1', 'cws2', 'cws3', 'cws4'] },
  { prefix: 'o', items: range(13, 28), workshops: ['ows1', 'ows2', 'ows3', 'ows4'] },
];

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

  /** Per-location properties: scripts set them without a key (the current location) and read them by location. */
  private locationKey(name: string, key: Value | undefined): Value | undefined {
    return key === undefined && PER_LOCATION.has(name.toLowerCase()) ? this.location() : key;
  }

  get(name: string, key: Value | undefined): Value {
    key = this.locationKey(name, key);
    const k = propKey(name, key);
    switch (name.toLowerCase()) {
      case 'playerscount': return this.players.length;
      case 'playername': return this.active?.name ?? '';
      case 'currentlocation': return this.bag()[k] ?? NEW_PLAYER_LOCATION;
      case 'currentlevel': return this.bag()[k] ?? 1; // puzzle data tables start at level 1
      case 'itempresent': return this.itemsAt(this.location())[toNumber(key) - 1] ?? 0;
      case 'itemspresentcount':
        return this.itemsAt(key === undefined ? this.location() : toText(key)).filter(Boolean).length;
      case 'backpackitempresent': return this.backpack()[toNumber(key)] ?? 0;
      case 'wsnextiteminqueue': return this.queue(key === undefined ? this.location() : toText(key))[0] ?? 0;
    }
    if (this.globalNames.has(k) || k in this.globals) return this.globals[k] ?? 0;
    return (this.active ? this.active.props[k] : this.session[k]) ?? 0;
  }

  set(name: string, key: Value | undefined, value: Value): void {
    key = this.locationKey(name, key);
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

  // ---- items: earned in workshops, carried in the backpack, placed at hubs ----
  // Lists are stored as comma-separated player properties so they save with the player.

  private bag(): Record<string, Stored> {
    return this.active ? this.active.props : this.session;
  }

  private readList(key: string): number[] {
    const raw = this.bag()[key];
    return typeof raw === 'string' && raw !== '' ? raw.split(',').map(Number) : [];
  }

  private writeList(key: string, items: number[]): void {
    this.bag()[key] = items.join(',');
    if (this.active) store(PLAYERS_KEY, this.players);
  }

  location(): string {
    return toText(this.get('currentLocation', undefined)).toLowerCase();
  }

  /** Item slots at a location (1-based in scripts); removed items leave a 0 so loops over slots stay stable. */
  itemsAt(location: string): number[] {
    return this.readList(`items:${location.toLowerCase()}`);
  }

  addItem(id: number): void {
    const items = this.itemsAt(this.location());
    const free = items.indexOf(0);
    if (free >= 0) items[free] = id;
    else items.push(id);
    this.writeList(`items:${this.location()}`, items);
  }

  removeItem(id: number): void {
    const items = this.itemsAt(this.location());
    const i = items.indexOf(id);
    if (i >= 0) items[i] = 0;
    this.writeList(`items:${this.location()}`, items);
  }

  /** The backpack's slots (0-based), 0 = empty. */
  backpack(): number[] {
    const slots = this.readList('backpack');
    return Array.from({ length: BACKPACK_SLOTS }, (_, i) => slots[i] ?? 0);
  }

  /** Puts an item in the first empty slot; returns the slot, or -1 when the backpack is full. */
  backpackAdd(id: number): number {
    const slots = this.backpack();
    const i = slots.indexOf(0);
    if (i >= 0) {
      slots[i] = id;
      this.writeList('backpack', slots);
    }
    return i;
  }

  backpackRemove(index: number): void {
    const slots = this.backpack();
    if (index >= 0 && index < slots.length) slots[index] = 0;
    this.writeList('backpack', slots);
  }

  /** Items a workshop has still to award, in order. */
  queue(location: string): number[] {
    const loc = location.toLowerCase();
    const region = WORKSHOP_REGIONS.find((r) => r.workshops.includes(loc));
    if (region && !this.bag()[`distributed:${region.prefix}`]) this.distributeItems(region.prefix);
    return this.readList(`queue:${loc}`);
  }

  removeNextFromQueue(location: string): void {
    this.writeList(`queue:${location.toLowerCase()}`, this.queue(location).slice(1));
  }

  /**
   * Deals a round's items out to the region's four workshops, three each.
   * Inferred: the EXE does this at the start and after each hub round.
   */
  distributeItems(prefix = this.location().charAt(0)): void {
    const region = WORKSHOP_REGIONS.find((r) => r.prefix === prefix) ?? WORKSHOP_REGIONS[0];
    const ids = shuffle(region.items).slice(0, ITEMS_PER_ROUND);
    const per = ITEMS_PER_ROUND / region.workshops.length;
    this.bag()[`distributed:${region.prefix}`] = 1;
    region.workshops.forEach((ws, i) => this.writeList(`queue:${ws}`, ids.slice(i * per, (i + 1) * per)));
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
      case 'addobject':
        world.addItem(toNumber(args[0]));
        return 0;
      case 'removeobjectfromlocation':
        world.removeItem(toNumber(args[0]));
        return 0;
      case 'removenextobjectfromqueue':
        world.removeNextFromQueue(args[0] === undefined ? world.location() : toText(args[0]));
        return 0;
      case 'distributeitems':
        world.distributeItems();
        return 0;
      case 'correctguess':
      case 'incorrectguess': {
        // per-workshop answer statistics (wsTotalGuessCount / wsTotalCorrectGuessCount)
        const loc = args[0] === undefined ? world.location() : toText(args[0]);
        world.set('wsTotalGuessCount', loc, toNumber(world.get('wsTotalGuessCount', loc)) + 1);
        if (method.toLowerCase() === 'correctguess') {
          world.set('wsTotalCorrectGuessCount', loc, toNumber(world.get('wsTotalCorrectGuessCount', loc)) + 1);
        }
        return 0;
      }
      case 'backpackaddobject':
        return world.backpackAdd(toNumber(args[0]));
      case 'backpackremoveobject':
        world.backpackRemove(toNumber(args[0]));
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
