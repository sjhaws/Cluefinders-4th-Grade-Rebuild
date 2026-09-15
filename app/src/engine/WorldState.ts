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
  'wscurrentlevelentrycount', 'wstotalguesscount', 'wstotalcorrectguesscount', 'isautolevelingenabled',
]);

// ---- auto-levelling (4THADV32.EXE RWorldPort: autoLevel VA 0x4506a9, correctGuess 0x450913,
// incorrectGuess 0x451742, defaults 0x454159, player reset 0x4517d3) ----
const MIN_LEVEL = 1;
const MAX_LEVEL = 4;
/** The last 20 answers per workshop are kept (1 = correct). */
const GUESS_HISTORY = 20;
/** Workshops (EXE location ids 1-10) level by their answer history. */
const HISTORY_LEVELED = ['cws1', 'cws2', 'cws3', 'cws4', 'ows1', 'ows2', 'ows3', 'ows4', 'pws1', 'pws2'];
/** The base-camp puzzles and mastery rooms go up a level every time autoLevel is sent. */
const STEP_LEVELED = ['cba1', 'cba2', 'cma', 'oma'];
/**
 * Level-change thresholds (wsAutoLevelingA/B/X/Y). The EXE starts every workshop
 * at these; STARTUP.MPS then sets CWS3/CWS4 to 6/8/4/10 and PWS1 to 3/4/3/8.
 */
interface AutoLevelRule { a: number; b: number; x: number; y: number }
const DEFAULT_AUTO_LEVEL_RULE: AutoLevelRule = { a: 5, b: 6, x: 4, y: 10 };
const AUTO_LEVEL_RULE_PROPS: Record<string, keyof AutoLevelRule> = {
  wsautolevelinga: 'a', wsautolevelingb: 'b', wsautolevelingx: 'x', wsautolevelingy: 'y',
};
/** levelColor marks: the level was passed (levelled up from) or dropped (levelled down from). */
const LEVEL_PASSED = 1;
const LEVEL_DROPPED = 2;
const ITEMS_PER_ROUND = 12; // kNumItemsPerCRound / kNumItemsPerORound
/** Gem slots around each OHUB door (OHUB's kNumGemSlots), of which kNumMissingGemSlots are empty. */
const OHUB_GEM_SLOTS = [39, 39, 39, 39, 44];
const OHUB_MISSING_SLOTS = 12;

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

/**
 * The 16 gems (13-28) form a 4x4 grid: gem = row * 4 + column + 13. Each OHUB
 * door has its own pattern shape, with rows and columns drawn at random
 * (EXE VA 0x451a20). Doors 3 and 4 never pair rows that add up to 3.
 */
function makeGemPattern(round: number): number[] {
  const gem = (row: number, col: number) => row * 4 + col + 13;
  const cols = shuffle([0, 1, 2, 3]);
  let rows = shuffle([0, 1, 2, 3]);
  if (round === 3 || round === 4) {
    while (rows[0] + rows[1] === 3) rows = shuffle(rows);
  }
  const [r0, r1, r2] = rows;
  const [c0, c1, c2] = cols;
  switch (round) {
    case 1: return cols.map((c) => gem(r0, c)); // one row, all four columns
    case 2: return rows.map((r, i) => gem(r, cols[i])); // four different rows and columns
    case 3: return [gem(r0, c0), gem(r0, c1), gem(r1, c0), gem(r1, c1)]; // a 2x2 block
    case 4: return [gem(r0, c0), gem(r0, c1), gem(r1, c2)];
    default: return [gem(r0, c0), gem(r1, c1), gem(r0, c0), gem(r2, c2)]; // A B A C
  }
}

/**
 * Draws a door's 12 empty slots (1-based) from its shuffled slots, reshuffling
 * until they include an odd slot and aren't evenly spaced around the pattern
 * (not every gap, taken modulo the pattern length, equal to the first).
 */
function pickMissingSlots(slotCount: number, patternLength: number): number[] {
  for (;;) {
    const slots = shuffle(range(1, slotCount));
    const firstGap = Math.abs((slots[1] - slots[0]) % patternLength);
    let odd = false;
    let other = false;
    let irregular = false;
    for (let i = 0; i < OHUB_MISSING_SLOTS; i++) {
      if (!odd && slots[i] % 2 === 1) odd = true;
      else other = true;
      if (i > 1 && Math.abs((slots[i] - slots[i - 1]) % patternLength) !== firstGap) irregular = true;
      if (odd && other && irregular) return slots.slice(0, OHUB_MISSING_SLOTS);
    }
  }
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
  /** Auto-level thresholds by workshop: engine globals in the EXE, set each run by STARTUP, not saved. */
  private readonly autoLevelRules = new Map<string, AutoLevelRule>();

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
      case 'currentlevel': return this.bag()[k] ?? MIN_LEVEL; // puzzle data tables start at level 1
      case 'isautolevelingenabled': return this.bag()[k] ?? 1; // on for a new player
      case 'itempresent': return this.itemsAt(this.location())[toNumber(key) - 1] ?? 0;
      case 'itemspresentcount':
        return this.itemsAt(key === undefined ? this.location() : toText(key)).filter(Boolean).length;
      case 'backpackitempresent': return this.backpack()[toNumber(key)] ?? 0;
      case 'wsnextiteminqueue': return this.queue(key === undefined ? this.location() : toText(key))[0] ?? 0;
      case 'patternitemcount': return this.gemPattern().gems.length;
      case 'patternitem': return this.gemPattern().gems[toNumber(key) - 1] ?? 0;
      case 'missingitemslot': return this.gemPattern().missing[toNumber(key) - 1] ?? 0;
    }
    const ruleField = AUTO_LEVEL_RULE_PROPS[name.toLowerCase()];
    if (ruleField) return this.autoLevelRule(toText(key ?? this.location()))[ruleField];
    if (this.globalNames.has(k) || k in this.globals) return this.globals[k] ?? 0;
    return (this.active ? this.active.props[k] : this.session[k]) ?? 0;
  }

  set(name: string, key: Value | undefined, value: Value): void {
    const ruleField = AUTO_LEVEL_RULE_PROPS[name.toLowerCase()];
    if (ruleField) {
      const loc = toText(key ?? this.location()).toLowerCase();
      this.autoLevelRules.set(loc, { ...this.autoLevelRule(loc), [ruleField]: toNumber(value) });
      return;
    }
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
   * RWorldPort distributeItems (EXE VA 0x4509b2), sent by CHUB/OHUB after each
   * round and done for a new player. The round's 12 items are Cairo glyphs at
   * random (repeats allowed) or, for the Oasis, the gems missing from the
   * current OHUB door, slot by slot. Workshops are ranked by the share of
   * answers they got right since the last deal, and the weaker ones get more
   * of the items to earn: 3/3/3/3 when the best and worst are within 0.251,
   * otherwise 4/3/3/2 or 4/4/2/2 (spread under 0.5, split by whether the
   * middle two are within 0.1), else 5/3/2/2 or 6/2/2/2 (worst two within 0.5).
   */
  distributeItems(prefix = this.location().charAt(0)): void {
    const region = WORKSHOP_REGIONS.find((r) => r.prefix === prefix) ?? WORKSHOP_REGIONS[0];
    let ids: number[];
    if (region.prefix === 'o') {
      const { gems, missing } = this.gemPattern();
      ids = missing.map((slot) => gems[(slot - 1) % gems.length]);
    } else {
      ids = Array.from({ length: ITEMS_PER_ROUND }, () => region.items[Math.floor(Math.random() * region.items.length)]);
    }

    const ranked = region.workshops.map((ws) => {
      const guesses = toNumber(this.get('wsTotalGuessCount', ws));
      return { ws, ratio: guesses > 0 ? toNumber(this.get('wsTotalCorrectGuessCount', ws)) / guesses : 1 };
    });
    // the EXE's exchange sort: ascending, ties keep workshop order
    for (let b = 2; b >= 0; b--) {
      for (let d = b; d <= 2; d++) {
        if (ranked[d + 1].ratio < ranked[d].ratio) [ranked[d], ranked[d + 1]] = [ranked[d + 1], ranked[d]];
      }
    }
    const r = ranked.map((w) => w.ratio);
    let counts: number[];
    if (r[3] - r[0] < 0.251) counts = [3, 3, 3, 3];
    else if (r[3] - r[0] < 0.5) counts = r[2] - r[1] < 0.1 ? [4, 3, 3, 2] : [4, 4, 2, 2];
    else counts = r[1] - r[0] < 0.5 ? [5, 3, 2, 2] : [6, 2, 2, 2];

    this.bag()[`distributed:${region.prefix}`] = 1;
    let next = 0;
    ranked.forEach(({ ws }, i) => {
      this.set('wsTotalGuessCount', ws, 0);
      this.set('wsTotalCorrectGuessCount', ws, 0);
      this.writeList(`queue:${ws}`, ids.slice(next, next + counts[i]));
      next += counts[i];
    });
  }

  /**
   * The gem pattern on the OHUB door being worked on (round = doors opened + 1):
   * patternItem 1..n repeats around the door's slots and missingItemSlot 1..12
   * are the empty ones. Made once per round and saved with the player; the
   * EXE makes all five at the start of a game (VA 0x451a20).
   */
  gemPattern(): { gems: number[]; missing: number[] } {
    const round = Math.min(OHUB_GEM_SLOTS.length, toNumber(this.get('hubRoundsCompleted', 'OHUB')) + 1);
    let gems = this.readList(`ohubPattern:${round}`);
    let missing = this.readList(`ohubMissing:${round}`);
    if (gems.length === 0 || missing.length !== OHUB_MISSING_SLOTS) {
      gems = makeGemPattern(round);
      missing = pickMissingSlots(OHUB_GEM_SLOTS[round - 1], gems.length);
      this.writeList(`ohubPattern:${round}`, gems);
      this.writeList(`ohubMissing:${round}`, missing);
    }
    return { gems, missing };
  }

  // ---- auto-levelling ----

  private autoLevelRule(location: string): AutoLevelRule {
    return this.autoLevelRules.get(location.toLowerCase()) ?? DEFAULT_AUTO_LEVEL_RULE;
  }

  /** Records an answer in a workshop: statistics per round and per level, plus the history autoLevel reads. */
  recordGuess(location: string, correct: boolean): void {
    const loc = location.toLowerCase();
    const bump = (name: string, key: string) => this.set(name, key, toNumber(this.get(name, key)) + 1);
    const level = toNumber(this.get('currentLevel', loc));
    bump('wsTotalGuessCount', loc);
    bump('wsLevelGuessCount', `${loc}.${level}`);
    if (correct) {
      bump('wsTotalCorrectGuessCount', loc);
      bump('wsLevelCorrectGuessCount', `${loc}.${level}`);
    }
    if (!HISTORY_LEVELED.includes(loc)) return;
    // When the history is full the EXE shifts it but then writes the new answer
    // to the wrong field (the round's correct count); this keeps the answer.
    this.writeList(`guesses:${loc}`, [...this.readList(`guesses:${loc}`), correct ? 1 : 0].slice(-GUESS_HISTORY));
  }

  /**
   * RWorldPort autoLevel. The base-camp puzzles and mastery rooms go up a level
   * each time. A workshop scans its answers from the newest back, stopping
   * after B correct ones or Y answers: it goes up when it found B correct
   * answers, at least A of them straight after another correct one (or the
   * first answer on record), and down when Y answers held fewer than X correct.
   * Either way the history restarts. The level only moves while
   * isAutoLevelingEnabled, but levelColor still records the result.
   */
  autoLevel(location: string): void {
    const loc = location.toLowerCase();
    const level = toNumber(this.get('currentLevel', loc));
    const enabled = toNumber(this.get('isAutoLevelingEnabled', loc)) !== 0;
    const moveTo = (mark: number, next: number) => {
      this.set('levelColor', `${loc}.${level}`, mark);
      if (enabled && next >= MIN_LEVEL && next <= MAX_LEVEL) this.set('currentLevel', loc, next);
    };
    if (STEP_LEVELED.includes(loc)) {
      moveTo(LEVEL_PASSED, level + 1);
      return;
    }
    if (!HISTORY_LEVELED.includes(loc)) return;

    const { a, b, x, y } = this.autoLevelRule(loc);
    const history = this.readList(`guesses:${loc}`);
    let correct = 0;
    let runs = 0;
    let seen = 0;
    for (let i = history.length - 1; i >= 0 && correct < b && seen < y; i--, seen++) {
      if (!history[i]) continue;
      correct++;
      if (i === 0 || history[i - 1]) runs++;
    }
    if (correct === b && runs >= a) moveTo(LEVEL_PASSED, level + 1);
    else if (seen === y && correct < x) moveTo(LEVEL_DROPPED, level - 1);
    else return;
    this.writeList(`guesses:${loc}`, []);
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
      case 'autolevel':
        world.autoLevel(args[0] === undefined ? world.location() : toText(args[0]));
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
      case 'incorrectguess':
        world.recordGuess(args[0] === undefined ? world.location() : toText(args[0]), method.toLowerCase() === 'correctguess');
        return 0;
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
