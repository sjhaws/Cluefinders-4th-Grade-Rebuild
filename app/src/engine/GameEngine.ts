import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { LoadedAseq, ResourceManager } from '../ResourceManager';
import {
  ScriptVm,
  isLabel,
  toNumber,
  toText,
  truthy,
  type EngineObject,
  type ScriptHost,
  type ScriptJson,
  type Value,
} from './ScriptVm';
import { DisplayObject, GenericObject, type ScriptObject } from './ScriptObject';
import { bitmapFonts } from './BitmapFont';
import { WorldState } from './WorldState';
import { CLASSES } from './classes';
import { RSmackerMovie, TempAnimation, aoPosition } from './DisplayObjects';
import { STAGE_H, STAGE_W } from './constants';

const FADE_MS = 400;
const MAX_LOG = 300;

/** Scene-wide settings behind RScenePort: background music and scene-level key handlers. */
export class SceneState {
  private readonly values = new Map<string, Value>([
    ['isbackgroundmusicenabled', 1],
    ['backgroundmusicvolume', 50],
  ]);
  private music: HTMLAudioElement | null = null;
  private suspensions = 0;

  constructor(private readonly engine: GameEngine) {}

  /** Movies silence the background music while they play. */
  suspendMusic(suspend: boolean): void {
    this.suspensions = Math.max(0, this.suspensions + (suspend ? 1 : -1));
    this.updateMusic();
  }

  get(key: string): Value {
    return this.values.get(key) ?? 0;
  }

  set(key: string, value: Value): void {
    this.values.set(key, value);
    if (key.startsWith('backgroundmusic') || key === 'isbackgroundmusicenabled') this.updateMusic();
  }

  handler(event: string): Value | undefined {
    return this.values.get(event.toLowerCase());
  }

  /** Handlers point into the current script, so they can't survive a script switch. */
  clearHandlers(): void {
    for (const [key, value] of this.values) if (isLabel(value)) this.values.delete(key);
  }

  private updateMusic() {
    const url = this.engine.resources.getSoundUrl(toNumber(this.get('backgroundmusicid')));
    const enabled = truthy(this.get('isbackgroundmusicenabled')) && this.suspensions === 0;
    if (!url || !enabled) {
      this.music?.pause();
      if (!url) this.music = null;
      return;
    }
    if (!this.music || !this.music.src.endsWith(url)) {
      this.music?.pause();
      this.music = new Audio(url);
      this.music.loop = true;
    }
    this.music.volume = Math.min(1, Math.max(0, toNumber(this.get('backgroundmusicvolume')) / 100));
    this.engine.playAudio(this.music);
  }
}

/**
 * Runs the game's scripts: implements the engine functions and object
 * classes they call, routes input to script objects, and switches scripts.
 */
export class GameEngine implements ScriptHost {
  readonly app = new Application();
  readonly sceneRoot = new Container();
  readonly world = new WorldState();
  readonly scene: SceneState;
  onWarn: ((message: string) => void) | null = null;
  onScriptChange: ((name: string) => void) | null = null;

  private readonly background = new Container();
  private readonly fade = new Graphics();
  private readonly notice = new Text({
    text: '',
    style: { fill: 0xffffff, fontFamily: 'Verdana, sans-serif', fontSize: 14, align: 'center', wordWrap: true, wordWrapWidth: 560 },
  });
  private readonly objects = new Set<ScriptObject>();
  private readonly keyListeners = new Set<(key: string) => void>();
  private readonly paletteListeners = new Set<() => void>();
  private readonly sounds = new Set<HTMLAudioElement>();
  private readonly soundTags = new Map<number, HTMLAudioElement>();
  private nextSoundTag = 1;
  private vm: ScriptVm | null = null;
  private palette: Uint8Array | null = null;
  private paletteNames: string[] = [];
  private pressed: DisplayObject | null = null;
  /** The object most recently released; IntersectTest checks it against a receiver. */
  private dropped: DisplayObject | null = null;
  private fadeTarget = 0;
  private sceneToken = 0;
  readonly log: string[] = [];
  /** Default sounds for puzzle answers (SetAnswerPickUpSound and friends). */
  readonly answerSounds = { pickup: 0, gohome: 0, snap: 0 };
  /** Debug fast-forward (`?turbo=8`): animations, delays and sounds run this many times faster. */
  timeScale = 1;

  constructor(readonly resources: ResourceManager) {
    this.scene = new SceneState(this);
  }

  /** The element holding the canvas; DOM overlays (movies) are positioned inside it. */
  overlayRoot: HTMLElement | null = null;

  async mount(root: HTMLElement): Promise<void> {
    this.overlayRoot = root;
    root.style.position = 'relative';
    await this.app.init({ width: STAGE_W, height: STAGE_H, background: 0x000000, antialias: false });
    root.appendChild(this.app.canvas);
    this.sceneRoot.sortableChildren = true;
    this.fade.rect(0, 0, STAGE_W, STAGE_H).fill(0x000000);
    this.fade.alpha = 0;
    this.notice.anchor.set(0.5);
    this.notice.position.set(STAGE_W / 2, STAGE_H / 2);
    this.app.stage.addChild(this.background, this.sceneRoot, this.fade, this.notice);
    try {
      this.paletteNames = await (await fetch(this.resources.getPaletteIndexUrl())).json();
    } catch {
      this.paletteNames = [];
    }
    // Before any script runs: scripts measure text to pick a box to hold it
    // (CWS3 sizes every word box that way), and a font arriving mid-scene would
    // size some boxes with a web stand-in's metrics and the rest with the
    // game's own.
    await bitmapFonts.ensureLoaded(this.resources);
    this.wireInput();
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS));
  }

  async boot(scriptName = 'STARTUP'): Promise<void> {
    await this.switchScript(scriptName);
  }

  // ---- ScriptHost -------------------------------------------------------

  isClass(name: string): boolean {
    return CLASSES.has(name.toLowerCase());
  }

  createObject(className: string, args: Value[]): EngineObject {
    const make = CLASSES.get(className.toLowerCase());
    return make ? make(this, args) : new GenericObject(this, className);
  }

  callGlobal(name: string, args: Value[]): Value {
    switch (name.toLowerCase()) {
      case 'cachedll':
      case 'uncachedll':
      case 'uncachealldlls':
      case 'activatedll':
      case 'deactivatedll':
      case 'deactivatealldlls':
      case 'setdoubleclicksenabled':
      case 'setuseembeddedanimationcoordinates':
      case 'setcorraltrinketnormalization':
      case 'freezescreen':
      case 'displayscreen': // shows what was drawn while frozen (OHUB's walk to the next door); the canvas redraws every frame
      case 'restorepalette':
      case 'pausesound':
      case 'resumesound':
        return 0;
      case 'scene':
        void this.setScene(toNumber(args[0]));
        return 0;
      case 'starttransition':
      case 'gotoblack':
        this.fade.alpha = 1;
        this.fadeTarget = 1;
        return 0;
      case 'endtransition':
        this.fadeTarget = 0;
        return 0;
      case 'playsound': {
        // returns a tag KillSound can stop (scripts keep it in e.g. sfxTag)
        const audio = this.playSound(toNumber(args[0]));
        if (!audio) return -1;
        if (truthy(args[1])) audio.loop = true; // `PlaySound id, kTrue` loops until KillSound
        const tag = this.nextSoundTag++;
        this.soundTags.set(tag, audio);
        audio.addEventListener('ended', () => this.soundTags.delete(tag), { once: true });
        return tag;
      }
      case 'killsound':
        if (args.length === 0) this.stopSounds();
        else {
          this.soundTags.get(toNumber(args[0]))?.pause();
          this.soundTags.delete(toNumber(args[0]));
        }
        return 0;
      case 'randomnumber': {
        const lo = toNumber(args[0]);
        const hi = toNumber(args[1]);
        return lo + Math.floor(Math.random() * (hi - lo + 1));
      }
      case 'logmessage': // developer logging in the original (e.g. OHUB's "Oasis round: 2")
        console.debug(`[script] ${args.map(toText).join(' ')}`);
        return 0;
      case 'intersecttest': {
        // IntersectTest "RECEIVER", "varName": does the object just dropped overlap the receiver?
        // or IntersectTest "objA", "objB": do two named objects overlap? (OHUB's gem slots)
        const receiver = this.lookupVar(toText(args[1]));
        const first = toText(args[0]);
        const named = first.toUpperCase() === 'RECEIVER' ? null : this.lookupVar(first);
        const moved = named instanceof DisplayObject ? named : this.dropped;
        if (!(receiver instanceof DisplayObject) || !moved || moved.destroyed || receiver.destroyed) return 0;
        if (!receiver.view.visible) return 0;
        const a = moved.view.getBounds();
        const b = receiver.view.getBounds();
        return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY ? 1 : 0;
      }
      case 'setanswerpickupsound':
        this.answerSounds.pickup = toNumber(args[0]);
        return 0;
      case 'setanswergohomesound':
        this.answerSounds.gohome = toNumber(args[0]);
        return 0;
      case 'setanswersnapsound':
        this.answerSounds.snap = toNumber(args[0]);
        return 0;
      case 'messagebox':
        this.showNotice(toText(args[0]));
        return 0;
      default:
        this.warn(`global ${name}(${args.map(toText).join(', ')}) is not implemented`);
        return 0;
    }
  }

  loadScript(name: string): void {
    setTimeout(() => void this.switchScript(name), 0);
  }

  exitGame(): void {
    this.stopSounds();
    this.fade.alpha = 1;
    this.fadeTarget = 1;
    this.showNotice('Thanks for playing!');
  }

  warn(message: string): void {
    console.warn(`[engine] ${message}`);
    this.log.push(message);
    if (this.log.length > MAX_LOG) this.log.shift();
    this.onWarn?.(message);
  }

  // ---- used by engine objects -----------------------------------------

  track(object: ScriptObject): void {
    this.objects.add(object);
  }

  untrack(object: ScriptObject): void {
    this.objects.delete(object);
    if (this.pressed === object) this.pressed = null;
    if (this.dropped === object) this.dropped = null;
  }

  invokeHandler(handler: Value, self: EngineObject | null): void {
    try {
      this.vm?.invoke(handler, self);
    } catch (err) {
      this.warn(`handler failed: ${err}`);
      console.error(err);
    }
  }

  /** A script variable by name, e.g. the character a CharacterSpeechAction names. */
  lookupVar(name: string): Value {
    const vm = this.vm;
    if (!vm) return 0;
    return vm.getVar(vm.resolveName(name)); // "answers.i" -> answers.<i>
  }

  /** Fixes a name's variable parts now: a queued `PropertyAction "mouse.i"` added in a loop means that pass's mouse. */
  bindName(name: string): string {
    return this.vm ? this.vm.resolveName(name) : name;
  }

  /** An image's stored screen position, known before the image loads (scripts read x/y right away). */
  originOf(id: number): [number, number] | null {
    return this.resources.findAseq(id)?.origin ?? null;
  }

  /** Width and height of an image's first frame, known before the image loads. */
  frameSize(id: number): [number, number] | null {
    const frame = this.resources.findAseq(id)?.frames?.[0];
    return frame ? [frame.w, frame.h] : null;
  }

  /** MovieAction: plays a movie full screen (a click skips it). Returns a cancel function. */
  playMovie(name: string, done: () => void): () => void {
    return new RSmackerMovie(this, [name]).playAsAction(done);
  }

  /** AnimAction: a one-shot animation at its stored position (or `at`). Returns a cancel function. */
  playTempAnimation(id: number, z: number, repeat: number, done: () => void, at: [number, number] | null = null): () => void {
    const anim = new TempAnimation(this, id, z, repeat, done, at);
    return () => anim.destroy();
  }

  addKeyListener(listener: (key: string) => void): () => void {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  }

  onPalette(listener: () => void): () => void {
    this.paletteListeners.add(listener);
    return () => this.paletteListeners.delete(listener);
  }

  paletteColor(index: number): number {
    const p = this.palette;
    if (!p) return 0xcccccc;
    const i = (index & 255) * 3;
    return (p[i] << 16) | (p[i + 1] << 8) | p[i + 2];
  }

  async loadAseq(id: number): Promise<LoadedAseq | null> {
    const entry = this.resources.findAseq(id);
    if (!entry) {
      this.warn(`image ${id} not found`);
      return null;
    }
    try {
      return await this.resources.loadAseq(entry);
    } catch (err) {
      this.warn(String(err));
      return null;
    }
  }

  playSound(id: number, onEnded?: () => void): HTMLAudioElement | null {
    const url = this.resources.getSoundUrl(id);
    if (!url) {
      this.warn(`sound ${id} not found`);
      if (onEnded) setTimeout(onEnded, 0);
      return null;
    }
    const audio = new Audio(url);
    const finish = () => {
      this.sounds.delete(audio);
      onEnded?.();
    };
    audio.addEventListener('ended', finish, { once: true });
    audio.addEventListener('error', finish, { once: true });
    this.sounds.add(audio);
    this.playAudio(audio);
    return audio;
  }

  playAudio(audio: HTMLAudioElement): void {
    audio.playbackRate = Math.min(16, this.timeScale); // browsers cap the rate at 16
    audio.play().catch((err: DOMException) => {
      // Autoplay blocked: 'ended' would never fire and queues would stall, so
      // end the sound silently after its duration instead.
      if (err?.name !== 'NotAllowedError') return;
      this.warn('audio blocked by autoplay policy');
      const end = () => setTimeout(() => audio.dispatchEvent(new Event('ended')), ((audio.duration || 0) * 1000) / this.timeScale);
      if (Number.isFinite(audio.duration)) end();
      else audio.addEventListener('loadedmetadata', end, { once: true });
    });
  }

  // ---- internals ---------------------------------------------------------

  private async switchScript(fileName: string) {
    const name = fileName.replace(/\.mps$/i, '').toUpperCase();
    this.vm?.halt();
    this.vm = null;
    this.pressed = null;
    for (const object of [...this.objects]) object.destroy();
    this.keyListeners.clear();
    this.scene.clearHandlers();
    this.clearBackground();

    let json: ScriptJson;
    try {
      const res = await fetch(this.resources.getScriptUrl(name));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (err) {
      this.showNotice(`Couldn't load script ${name}: ${err}`);
      return;
    }
    this.showNotice('');
    this.onScriptChange?.(name);
    const vm = new ScriptVm(json, this);
    this.vm = vm;
    try {
      vm.start();
    } catch (err) {
      this.warn(`${name} failed: ${err}`);
      console.error(err);
    }
  }

  private async setScene(id: number) {
    const token = ++this.sceneToken;
    const entry = this.resources.findAseq(id);
    if (entry) void this.loadPalette(entry.bundle);
    const loaded = await this.loadAseq(id);
    if (!loaded || token !== this.sceneToken) return;
    this.clearBackground();
    const sprite = new Sprite(loaded.frames[0]);
    const [x, y] = aoPosition(loaded);
    sprite.position.set(x, y);
    this.background.addChild(sprite);
  }

  private clearBackground() {
    for (const child of this.background.removeChildren()) child.destroy();
  }

  private async loadPalette(bundle: string) {
    const name = [...this.paletteNames].sort((a, b) => b.length - a.length).find((n) => bundle.startsWith(n));
    if (!name) return;
    try {
      const data = new Uint8Array(await (await fetch(this.resources.getPaletteUrl(name))).arrayBuffer());
      if (data.length !== 768) return;
      this.palette = data;
      for (const listener of this.paletteListeners) listener();
    } catch (err) {
      this.warn(`palette ${name}: ${err}`);
    }
  }

  private showNotice(text: string) {
    this.notice.text = text;
  }

  private stopSounds() {
    for (const audio of this.sounds) audio.pause();
    this.sounds.clear();
  }

  private tick(realDeltaMs: number) {
    const deltaMs = realDeltaMs * this.timeScale;
    if (this.fade.alpha !== this.fadeTarget) {
      const step = deltaMs / FADE_MS;
      this.fade.alpha = this.fadeTarget > this.fade.alpha
        ? Math.min(this.fadeTarget, this.fade.alpha + step)
        : Math.max(this.fadeTarget, this.fade.alpha - step);
    }
    for (const object of this.objects) if (object instanceof DisplayObject) object.tick(deltaMs);
  }

  private stagePoint(e: MouseEvent): [number, number] {
    const r = this.app.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * STAGE_W) / r.width, ((e.clientY - r.top) * STAGE_H) / r.height];
  }

  private hitTest(x: number, y: number): DisplayObject | null {
    let best: DisplayObject | null = null;
    for (const object of this.objects) {
      if (object instanceof DisplayObject && object.containsPoint(x, y) && (!best || object.view.zIndex >= best.view.zIndex)) {
        best = object;
      }
    }
    return best;
  }

  private fireScene(event: string) {
    const handler = this.scene.handler(event);
    if (handler) this.invokeHandler(handler, null);
  }

  private wireInput() {
    const canvas = this.app.canvas;
    canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = this.stagePoint(e);
      const target = this.hitTest(x, y);
      this.pressed = target;
      if (target) target.onPointerDown(x, y);
      else this.fireScene('backgroundClicked');
    });
    window.addEventListener('pointerup', (e) => {
      const target = this.pressed;
      this.pressed = null;
      if (!target || target.destroyed) return;
      const [x, y] = this.stagePoint(e);
      this.dropped = target;
      target.onPointerUp(x, y, target.containsPoint(x, y));
    });
    window.addEventListener('pointermove', (e) => {
      const target = this.pressed;
      if (!target || target.destroyed) return;
      const [x, y] = this.stagePoint(e);
      target.onPointerMove(x, y);
    });
    canvas.addEventListener('dblclick', (e) => {
      const [x, y] = this.stagePoint(e);
      this.hitTest(x, y)?.onDoubleClick(x, y);
    });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const key = keyName(e);
      if (!key) return;
      e.preventDefault();
      if (key === ' ') this.fireScene('spacebarPressed');
      if (key === 'Return') this.fireScene('returnPressed');
      for (const listener of [...this.keyListeners]) listener(key);
    });
  }
}

const KEY_NAMES: Record<string, string> = {
  Backspace: 'Backspace',
  Delete: 'Delete',
  Enter: 'Return',
  Return: 'Return', // some automation tools report Enter this way
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Home: 'Home',
  End: 'End',
  Tab: 'Tab',
};

/** Browser key event -> the key names the scripts compare against. */
function keyName(e: KeyboardEvent): string | null {
  // some synthetic events leave `key` empty; `code` still names the key (e.g. "Enter")
  const key = e.key && e.key !== 'Unidentified' ? e.key : e.code === 'NumpadEnter' ? 'Enter' : e.code;
  if (key in KEY_NAMES) return KEY_NAMES[key];
  if (key.length !== 1) return null;
  if (e.ctrlKey || e.metaKey) return `${e.metaKey ? 'Cmd' : 'Ctrl'}-${key.toUpperCase()}`;
  return key;
}
