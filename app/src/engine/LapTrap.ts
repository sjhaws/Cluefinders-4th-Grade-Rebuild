import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { Value } from './ScriptVm';
import { toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import type { LoadedAseq } from '../ResourceManager';
import type { SequenceDoc } from '../types';
import { familyForFontName } from './DisplayObjects';
import { STAGE_H, STAGE_W } from './constants';

/**
 * Location ids from 4THADV32.EXE's location table ({int id; char name[12]}
 * records at file offset 0xa86e8). Map buttons carry these ids.
 */
const LOCATION_IDS: Record<string, number> = {
  CWS1: 1, CWS2: 2, CWS3: 3, CWS4: 4, OWS1: 5, OWS2: 6, OWS3: 7, OWS4: 8, PWS1: 9, PWS2: 10,
  CBA1: 12, CBA2: 13, CHUB: 15, OHUB: 16, CMA: 18, OMA: 19,
  CLOC01: 21, CLOC02: 22, CLOC03: 23, CLOC04: 24, CLOC05: 25, CLOC06: 26, CLOC07: 27, CLOC08A: 28, CLOC08B: 29,
  CLOC09: 30, CLOC11: 31, CLOC13: 32, CLOC14: 33,
  OLOC02: 34, OLOC03: 35, OLOC04: 36, OLOC05: 37, OLOC06: 38, OLOC07: 39, OLOC08: 40, OLOC09: 41,
  PBA: 42, PLOC2: 43, PLOC3: 44, SIGNIN: 46,
};

type MapKind = 'cairo' | 'oasis';

/** Which map the MAP button opens from a location (the EXE's jump table at VA 0x434858); null disables it. */
function mapFor(location: string): MapKind | null {
  const id = LOCATION_IDS[location.toUpperCase()] ?? 0;
  if ((id >= 1 && id <= 4) || id === 12 || id === 13 || id === 15 || id === 18 || (id >= 21 && id <= 33)) return 'cairo';
  if ((id >= 5 && id <= 8) || id === 16 || (id >= 34 && id <= 40)) return 'oasis';
  return null;
}

/** Map pages: background image, first-visit speech, and destination buttons (image id -> location) from the EXE. */
const MAPS: Record<MapKind, { image: number; speech: number; seenProp: string; spots: [number, string][] }> = {
  cairo: {
    image: 30575,
    speech: 30511,
    seenProp: 'seenCairoMap',
    spots: [[30522, 'CBA2'], [30523, 'CHUB'], [30524, 'CWS1'], [30525, 'CWS2'], [30526, 'CWS3'], [30527, 'CWS4'], [30528, 'CMA']],
  },
  oasis: {
    image: 30520,
    speech: 30512,
    seenProp: 'seenOasisMap',
    spots: [[30529, 'OWS1'], [30530, 'OWS2'], [30531, 'OWS3'], [30532, 'OWS4'], [30533, 'OHUB']],
  },
};

/** LAPTRAP.RSC image ids (and two from COMMON.RSC). Every image carries its own screen position. */
const IMG = {
  frame: 30501,
  quit: 30502,
  returnToGame: 30503,
  signIn: 30504,
  settings: 30505,
  map: 30506,
  chooseActivity: 30507,
  club: 30508,
  progress: 30509,
  credits: 30510,
  settingsPage: 30511,
  musicYes: 30512,
  musicNo: 30513,
  progressPage: 30515,
  levelButtons: 30516, // COMMON.RSC
  autoLevelBox: 30517, // COMMON.RSC
  progressChooseActivity: 30519,
  back: 30538,
  next: 30539,
  clubPage: 30541,
  done: 30555,
  chooseActivityPage: 30556,
  go: 30557,
  exit: 30558,
  chooseLevels: 30559,
  activitySignIn: 30560,
  dialogFace: 30561,
  dialogYes: 30563,
  dialogNo: 30564,
  quitDialog: 30566,
  changeLevelDialog: 30569,
  changeCmaLevelDialog: 30570,
};
const CREDIT_PAGES = [30535, 30536, 30537];
/** Club page portraits and the biography page each opens (matched by artwork). */
const CLUB_MEMBERS: [number, number][] = [
  [30548, 30542], // Joni
  [30549, 30543], // Santiago
  [30550, 30544], // Owen
  [30551, 30545], // Leslie
  [30552, 30546], // LapTrap
  [30553, 30547], // Socrates
];
const CLICK_SOUND = 30507;
const PRACTICE_INTRO_SPEECH = 30506; // played the first time the LapTrap opens outside the game (seenLapTrapInPractice)
const CHOOSE_ACTIVITY_SPEECH = [30501, 30514]; // first visit (seenChooseActivity), EXE VA 0x432a99
const PROGRESS_SPEECH = 30510; // first visit (seenProgressLevels)

/** Choose Activity page (EXE VA 0x432fee): a GO button per activity, top edge of each row. */
const ACTIVITY_ROWS: [string, number][] = [
  ['CWS1', 89], ['CWS2', 107], ['OWS1', 125], ['PWS1', 143],
  ['CWS3', 183], ['OWS2', 201], ['OWS4', 219], ['PWS2', 237],
  ['CWS4', 278], ['OWS3', 296], ['OMA', 335], ['CMA', 378],
];
/** Progress and Levels page (EXE VA 0x4357a1): level buttons and an auto-level box per activity row. */
const PROGRESS_ROWS: [string, number][] = [
  ['CWS1', 69], ['CWS2', 85], ['OWS1', 101], ['PWS1', 117], ['CBA1', 133],
  ['CWS3', 171], ['OWS2', 187], ['OWS4', 203], ['PWS2', 219],
  ['CWS4', 261], ['OWS3', 277], ['CBA2', 314], ['OMA', 330], ['CMA', 367],
];
const FIRST_ROW_Y = 69; // the button images' stored positions are for the first row
const LEVEL_SPACING = 24;
const LEVELS = [1, 2, 3, 4];
/** A finished Pyramid or Crocodile Bridge activity can change level without losing work. */
const SOLVED_PROPS: Record<string, string> = { PWS1: 'PWS1Solved', PWS2: 'PWS2Solved', OMA: 'OMASolved' };

interface Button {
  sprite: Sprite;
  frames: Texture[];
  enabled: boolean;
  selected: boolean;
  onClick: () => void;
  /** Where the image's stored position puts it on this page. */
  base: [number, number];
  /** Picks the frame when a button draws more than normal/pressed/disabled. */
  frameIndex?: (pressed: boolean) => number;
  frameOffsets?: Map<number, [number, number]>;
}

/** Per-frame positions from an image's first sequence list (bigger highlighted frames sit a pixel up-left). */
function frameOffsets(sequence: SequenceDoc): Map<number, [number, number]> {
  const offsets = new Map<number, [number, number]>();
  for (const entry of sequence.lists?.[0] ?? []) {
    const [x, y, tag] = entry as unknown as number[];
    if (tag >= 0 && !offsets.has(tag)) offsets.set(tag, [x, y]);
  }
  return offsets;
}

/**
 * The LapTrap: the kids' laptop, a full-screen menu built by the EXE rather
 * than by scripts. `RLapTrap z[, currentActivity]`. Choosing a place on the
 * map, an activity (or Sign In) sets `selectedLocation` and fires
 * `locationSelected`; Return to Game fires `closed`. Buttons use frame 0
 * normal, 1 pressed or selected, 2 disabled.
 */
export class RLapTrap extends DisplayObject {
  private readonly page = new Container();
  private buttons: Button[] = [];
  private pressed: Button | null = null;
  private pageToken = 0;
  private speech: HTMLAudioElement | null = null;
  /** The activity the LapTrap was opened from (scripts pass gCurLocation). */
  private readonly currentActivity: string | null;
  /** Progress rows whose level was changed while the page is open: no more warnings for them. */
  private readonly levelChanged = new Set<string>();

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RLapTrap');
    this.view.zIndex = Math.max(toNumber(args[0]), 30000);
    this.currentActivity = args[1] === undefined || args[1] === 0 ? null : toText(args[1]).toUpperCase();
    this.view.addChild(new Graphics().rect(0, 0, STAGE_W, STAGE_H).fill({ color: 0x000000, alpha: 0.55 }), this.page);
    this.showMain();
    const world = engine.world;
    if (!this.inGame && !truthy(world.get('seenLapTrapInPractice', undefined))) {
      world.set('seenLapTrapInPractice', undefined, 1);
      this.speak(PRACTICE_INTRO_SPEECH);
    }
  }

  private get inGame(): boolean {
    return truthy(this.engine.world.get('inGame', undefined));
  }

  // ---- page building ------------------------------------------------------

  private clearPage() {
    this.pageToken++;
    for (const child of this.page.removeChildren()) child.destroy();
    this.buttons = [];
    this.pressed = null;
  }

  /** Adds an image at its stored position (moved by `offset`); the texture arrives when loaded. */
  private addImage(id: number, onLoad?: (loaded: LoadedAseq) => void, offset: [number, number] = [0, 0]): Sprite {
    const sprite = new Sprite(Texture.EMPTY);
    const [x, y] = this.engine.originOf(id) ?? [0, 0];
    sprite.position.set(x + offset[0], y + offset[1]);
    this.page.addChild(sprite);
    const token = this.pageToken;
    void this.engine.loadAseq(id).then((loaded) => {
      if (!loaded || this.destroyed || token !== this.pageToken) return;
      if (onLoad) onLoad(loaded);
      else sprite.texture = loaded.frames[0];
    });
    return sprite;
  }

  private addButton(id: number, onClick: () => void, enabled = true, selected = false, offset: [number, number] = [0, 0]): Button {
    const sprite = this.addImage(id, (loaded) => {
      button.frames = loaded.frames;
      if (button.frameIndex) button.frameOffsets = frameOffsets(loaded.sequence);
      this.refresh(button);
    }, offset);
    const button: Button = { sprite, frames: [], enabled, selected, onClick, base: [sprite.x, sprite.y] };
    this.buttons.push(button);
    return button;
  }

  private refresh(b: Button) {
    const f = b.frames;
    if (b.frameIndex) {
      const index = b.frameIndex(b === this.pressed);
      const [dx, dy] = b.frameOffsets?.get(index) ?? [0, 0];
      b.sprite.texture = f[index] ?? Texture.EMPTY;
      b.sprite.position.set(b.base[0] + dx, b.base[1] + dy);
      return;
    }
    let index = 0;
    if (!b.enabled) index = f.length > 2 ? 2 : 0;
    else if ((b === this.pressed || b.selected) && f.length > 1) index = 1;
    b.sprite.texture = f[index] ?? Texture.EMPTY;
    b.sprite.alpha = !b.enabled && f.length <= 2 ? 0.5 : 1;
  }

  private showMain() {
    this.clearPage();
    this.addImage(IMG.frame);
    this.addButton(IMG.quit, () => this.showQuitDialog());
    this.addButton(IMG.returnToGame, () => this.close());
    this.addButton(IMG.signIn, () => this.select('SIGNIN'));
    this.addButton(IMG.settings, () => this.showSettings());
    if (this.inGame) {
      const map = mapFor(toText(this.engine.world.get('currentLocation', undefined)));
      this.addButton(IMG.map, () => map && this.showMap(map), map !== null);
    } else {
      this.addButton(IMG.chooseActivity, () => this.showChooseActivity());
    }
    this.addButton(IMG.club, () => this.showClub());
    this.addButton(IMG.progress, () => this.showProgress(true));
    this.addButton(IMG.credits, () => this.showCredits(0));
  }

  private showMap(kind: MapKind) {
    const def = MAPS[kind];
    const world = this.engine.world;
    this.clearPage();
    this.addImage(def.image);
    for (const [id, location] of def.spots) {
      // only places the player has been to can be travelled to
      const visited = toNumber(world.get('visitedCount', location)) > 0;
      this.addButton(id, () => this.select(location), visited);
    }
    this.addButton(IMG.exit, () => this.showMain());
    if (!truthy(world.get(def.seenProp, undefined))) {
      world.set(def.seenProp, undefined, 1);
      this.speak(def.speech);
    }
  }

  /** Practice mode's activity list: GO goes to an activity; the one the LapTrap was opened from just closes it. */
  private showChooseActivity() {
    const world = this.engine.world;
    this.clearPage();
    this.addImage(IMG.chooseActivityPage);
    for (const [location, y] of ACTIVITY_ROWS) {
      const current = location === this.currentActivity;
      this.addButton(IMG.go, () => (current ? this.close() : this.select(location)), true, current, [0, y - ACTIVITY_ROWS[0][1]]);
    }
    this.addButton(IMG.exit, () => this.showMain());
    this.addButton(IMG.chooseLevels, () => this.showProgress(true));
    this.addButton(IMG.activitySignIn, () => this.select('SIGNIN'));
    if (!truthy(world.get('seenChooseActivity', undefined))) {
      world.set('seenChooseActivity', undefined, 1);
      this.speak(...CHOOSE_ACTIVITY_SPEECH);
    }
  }

  private showSettings() {
    const off = truthy(this.engine.world.get('isBackgroundMusicOff', undefined));
    this.clearPage();
    this.addImage(IMG.settingsPage);
    this.addButton(IMG.musicYes, () => this.setMusic(true), true, !off);
    this.addButton(IMG.musicNo, () => this.setMusic(false), true, off);
    this.addButton(IMG.exit, () => this.showMain());
  }

  private setMusic(on: boolean) {
    this.engine.world.set('isBackgroundMusicOff', undefined, on ? 0 : 1);
    this.engine.scene.set('isbackgroundmusicenabled', on ? 1 : 0);
    this.showSettings();
  }

  private showCredits(index: number) {
    this.clearPage();
    this.addImage(CREDIT_PAGES[index]);
    if (index > 0) this.addButton(IMG.back, () => this.showCredits(index - 1));
    if (index < CREDIT_PAGES.length - 1) this.addButton(IMG.next, () => this.showCredits(index + 1));
    this.addButton(IMG.exit, () => this.showMain());
  }

  private showClub() {
    this.clearPage();
    this.addImage(IMG.clubPage);
    for (const [portrait, bio] of CLUB_MEMBERS) this.addButton(portrait, () => this.showBio(bio));
    this.addButton(IMG.exit, () => this.showMain());
  }

  private showBio(page: number) {
    this.clearPage();
    this.addImage(page);
    this.addButton(IMG.done, () => this.showClub());
  }

  // ---- progress and levels -------------------------------------------------

  /**
   * Progress and Levels (EXE VA 0x4357a1): per activity, four level buttons
   * coloured by levelColor (none / mastered / found difficult) with the current
   * level outlined, and the auto-levelling box. The Cairo and Oasis hubs and
   * the Palace Doors have no levels.
   */
  private showProgress(opening: boolean) {
    const world = this.engine.world;
    if (opening) this.levelChanged.clear();
    this.clearPage();
    this.addImage(IMG.progressPage);
    const title = new Text({
      text: `Progress and Levels for ${toText(world.get('playerName', undefined))}`,
      style: { fontFamily: familyForFontName('Chicago'), fontSize: 14, fill: 0x000000 },
    });
    title.anchor.set(0.5, 0);
    title.position.set(STAGE_W / 2, 11);
    this.page.addChild(title);

    for (const [location, y] of PROGRESS_ROWS) {
      const dy = y - FIRST_ROW_Y;
      for (const level of LEVELS) {
        const button = this.addButton(IMG.levelButtons, () => this.chooseLevel(location, level), true, false, [(level - 1) * LEVEL_SPACING, dy]);
        // frames: 16 per colour, 4 per level (normal, pressed, current, current pressed)
        button.frameIndex = (pressed) => {
          const colour = toNumber(world.get('levelColor', `${location}.${level}`));
          const current = toNumber(world.get('currentLevel', location)) === level;
          return colour * 16 + (level - 1) * 4 + (current ? 2 : 0) + (pressed ? 1 : 0);
        };
      }
      const box = this.addButton(IMG.autoLevelBox, () => {
        const on = truthy(world.get('isAutoLevelingEnabled', location));
        world.set('isAutoLevelingEnabled', location, on ? 0 : 1);
        this.refresh(box);
      }, true, false, [0, dy]);
      box.frameIndex = () => (truthy(world.get('isAutoLevelingEnabled', location)) ? 0 : 1); // 0 = X (on)
    }

    this.addButton(IMG.exit, () => this.showMain());
    if (!this.inGame) this.addButton(IMG.progressChooseActivity, () => this.showChooseActivity());
    if (opening && !truthy(world.get('seenProgressLevels', undefined))) {
      world.set('seenProgressLevels', undefined, 1);
      this.speak(PROGRESS_SPEECH);
    }
  }

  /** A level button (EXE VA 0x431e5a): changing the level of unfinished work asks first. */
  private chooseLevel(location: string, level: number) {
    const world = this.engine.world;
    if (toNumber(world.get('currentLevel', location)) === level) return;
    const apply = () => {
      world.set('currentLevel', location, level);
      this.levelChanged.add(location);
      this.showProgress(false);
    };
    if (!this.levelChangeLosesWork(location)) {
      apply();
      return;
    }
    // modal dialog over the page
    this.buttons = [];
    this.addImage(location === 'CMA' ? IMG.changeCmaLevelDialog : IMG.changeLevelDialog);
    this.addImage(IMG.dialogFace);
    this.addButton(IMG.dialogYes, apply);
    this.addButton(IMG.dialogNo, () => this.showProgress(false));
  }

  private levelChangeLosesWork(location: string): boolean {
    const world = this.engine.world;
    if (this.levelChanged.has(location)) return false;
    if (location === 'CMA') {
      // the Secret Chamber keeps its board between visits
      if (!this.inGame && this.currentActivity === 'CMA') return true;
      return toNumber(world.get('visitedCount', 'CMA')) > 0 && !truthy(world.get('CMASolved', undefined));
    }
    if (location !== this.currentActivity) return false;
    const solved = SOLVED_PROPS[location];
    return !(solved && truthy(world.get(solved, undefined)));
  }

  private showQuitDialog() {
    this.showMain();
    this.buttons = []; // the dialog is modal
    this.addImage(IMG.quitDialog);
    this.addButton(IMG.dialogYes, () => this.engine.exitGame());
    this.addButton(IMG.dialogNo, () => this.showMain());
  }

  // ---- actions -------------------------------------------------------------

  /** Plays speech clips one after another; a new speech or closing the LapTrap cuts it off. */
  private speak(...ids: number[]) {
    this.speech?.pause();
    const [id, ...rest] = ids;
    const audio = this.engine.playSound(id, () => {
      if (rest.length > 0 && this.speech === audio && !this.destroyed) this.speak(...rest);
    });
    this.speech = audio;
  }

  private select(location: string) {
    this.speech?.pause();
    this.props.set('selectedlocation', location);
    this.fire('locationSelected');
  }

  private close() {
    this.speech?.pause();
    this.fire('closed');
  }

  // ---- input -----------------------------------------------------------------

  containsPoint(): boolean {
    return this.view.visible && !this.destroyed; // modal
  }

  private buttonAt(x: number, y: number): Button | null {
    for (let i = this.buttons.length - 1; i >= 0; i--) {
      const b = this.buttons[i];
      const s = b.sprite;
      if (b.enabled && x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height) return b;
    }
    return null;
  }

  onPointerDown(x: number, y: number): void {
    this.pressed = this.buttonAt(x, y);
    if (this.pressed) this.refresh(this.pressed);
  }

  onPointerUp(x: number, y: number): void {
    const b = this.pressed;
    this.pressed = null;
    if (!b) return;
    this.refresh(b);
    if (this.buttonAt(x, y) !== b) return;
    this.engine.playSound(CLICK_SOUND);
    b.onClick();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.speech?.pause();
    this.speech = null;
    super.destroy();
  }
}
