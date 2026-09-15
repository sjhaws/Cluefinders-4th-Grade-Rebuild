import { Container, Graphics, Sprite, Texture } from 'pixi.js';
import type { Value } from './ScriptVm';
import { toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
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

/** LAPTRAP.RSC image ids. Every image carries its own screen position. */
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
  back: 30538,
  next: 30539,
  clubPage: 30541,
  done: 30555,
  exit: 30558,
  dialogYes: 30563,
  dialogNo: 30564,
  quitDialog: 30566,
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

interface Button {
  sprite: Sprite;
  frames: Texture[];
  enabled: boolean;
  selected: boolean;
  onClick: () => void;
}

/**
 * The LapTrap: the kids' laptop, a full-screen menu built by the EXE rather
 * than by scripts. `RLapTrap z[, currentActivity]`. Choosing a place on the
 * map (or Sign In) sets `selectedLocation` and fires `locationSelected`;
 * Return to Game fires `closed`. Buttons use frame 0 normal, 1 pressed or
 * selected, 2 disabled.
 */
export class RLapTrap extends DisplayObject {
  private readonly page = new Container();
  private buttons: Button[] = [];
  private pressed: Button | null = null;
  private pageToken = 0;
  private speech: HTMLAudioElement | null = null;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RLapTrap');
    this.view.zIndex = Math.max(toNumber(args[0]), 30000);
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

  /** Adds an image at its stored position; returns the sprite (texture arrives when loaded). */
  private addImage(id: number, onLoad?: (frames: Texture[]) => void): Sprite {
    const sprite = new Sprite(Texture.EMPTY);
    const [x, y] = this.engine.originOf(id) ?? [0, 0];
    sprite.position.set(x, y);
    this.page.addChild(sprite);
    const token = this.pageToken;
    void this.engine.loadAseq(id).then((loaded) => {
      if (!loaded || this.destroyed || token !== this.pageToken) return;
      if (onLoad) onLoad(loaded.frames);
      else sprite.texture = loaded.frames[0];
    });
    return sprite;
  }

  private addButton(id: number, onClick: () => void, enabled = true, selected = false): Button {
    const sprite = this.addImage(id, (frames) => {
      button.frames = frames;
      this.refresh(button);
    });
    const button: Button = { sprite, frames: [], enabled, selected, onClick };
    this.buttons.push(button);
    return button;
  }

  private refresh(b: Button) {
    const f = b.frames;
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
      this.addButton(IMG.chooseActivity, () => {}, false); // practice-mode activity list isn't implemented yet
    }
    this.addButton(IMG.club, () => this.showClub());
    this.addButton(IMG.progress, () => this.showProgress());
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

  /** The progress page's level marks and auto-leveling boxes aren't drawn yet. */
  private showProgress() {
    this.clearPage();
    this.addImage(IMG.progressPage);
    this.addButton(IMG.exit, () => this.showMain());
  }

  private showQuitDialog() {
    this.showMain();
    this.buttons = []; // the dialog is modal
    this.addImage(IMG.quitDialog);
    this.addButton(IMG.dialogYes, () => this.engine.exitGame());
    this.addButton(IMG.dialogNo, () => this.showMain());
  }

  // ---- actions -------------------------------------------------------------

  private speak(id: number) {
    this.speech?.pause();
    this.speech = this.engine.playSound(id);
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
