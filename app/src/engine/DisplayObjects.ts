import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { AseqAnimation } from '../AseqAnimation';
import type { LoadedAseq } from '../ResourceManager';
import type { SequenceEntry } from '../types';
import type { Value } from './ScriptVm';
import { toInt, toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { BitmapLabel, bitmapFonts, type BitmapFontData } from './BitmapFont';
import { PaletteSwaps, RecoloredFrames } from './PaletteSwap';
import { STAGE_H, STAGE_W } from './constants';
import type { VideoOwner } from './Media';

/** Scripts pass this for x and y to use the position stored with the image. */
export const USE_AO_COORDS = 11111;

export function sequenceList(loaded: LoadedAseq, index = 0): SequenceEntry[] {
  return loaded.sequence.lists?.[index] ?? loaded.frames.map((_, i): SequenceEntry => [0, 0, i, 0]);
}

/** The screen position stored with an image ("AO coordinates"), used when a script passes kUseAOCoords. */
export function aoPosition(loaded: LoadedAseq): [number, number] {
  return loaded.sequence.origin ?? [0, 0];
}

export interface FontSpec {
  family: string;
  size: number;
}

const SERIF = 'Georgia, "Times New Roman", serif';

/**
 * Web stand-ins keyed by the font ids scripts use, for when the real bitmap
 * fonts aren't available -- assets extracted without `extract_fonts.py`, or
 * `?webfonts`. Otherwise BitmapFont.ts draws FONT.RSC's own faces.
 */
export function fontFor(id: number): FontSpec {
  switch (id) {
    case 40: return { family: SERIF, size: 16 };
    case 50: return { family: SERIF, size: 17 };
    default: return { family: 'Verdana, sans-serif', size: 14 };
  }
}

/** Arial and its metric-compatible stand-ins. */
const ARIAL = 'Arial, "Liberation Sans", Helvetica, sans-serif';

/**
 * Families for the font names scripts ask for ("Arial", "Geneva", "Chicago").
 * The Windows build creates them with CreateFontA, so "Arial" is Arial and the
 * Mac names fall back to Windows faces. Widths matter: OWS2 sizes each word
 * box from the text width, and a wider stand-in (Verdana) overflows the row.
 */
export function familyForFontName(name: string): string {
  switch (name.toLowerCase()) {
    case 'chicago': return `"Arial Black", ${ARIAL}`;
    case 'times': return SERIF;
    default: return ARIAL;
  }
}

export class RAnimation extends DisplayObject {
  private anim: AseqAnimation | null = null;
  private onceDone: (() => void) | null = null;
  private readonly aoid: number;
  private looping = false;
  private pendingFrame: number | null = null;
  private frameNotification = false;
  private playWhenLoaded = false;
  private pausedMidway = false;
  /** Positioned in the constructor; the image's own position only applies when it wasn't. */
  private placed = false;
  /** PWS2 recolours its chalk alphabet between crosswords (replacePaletteEntry). */
  private baseFrames: Texture[] = [];
  private readonly swaps = new PaletteSwaps();
  private readonly recolored = new RecoloredFrames();
  private paletteOff: (() => void) | null = null;

  /** `RAnimation id` (at its stored position) or `RAnimation x, y, id`. */
  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RAnimation');
    this.movable = true; // scripts switch this off for scenery
    this.aoid = toNumber(args.length < 3 ? args[0] : args[2]);
    // The position is known up front, so scripts can read x/y -- and move it --
    // before the image loads: OWS4 builds its word boxes and slides them into
    // place in a group straight away, and a position set only once the image
    // arrived would undo the slide and leave each box behind its word.
    const given = args.length >= 3 && toNumber(args[0]) !== USE_AO_COORDS;
    const at = given ? [toInt(args[0]), toInt(args[1])] : engine.originOf(this.aoid);
    if (at) {
      this.view.position.set(at[0], at[1]);
      this.placed = true;
    }
    void this.init(this.aoid);
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'frame': return (this.anim?.current?.frame ?? this.pendingFrame ?? 0) + 1; // scripts count frames from 1
      case 'framecount': return this.anim?.frameCount ?? this.engine.resources.findAseq(this.aoid)?.frame_count ?? 0;
      case 'width': return this.engine.frameSize(this.aoid)?.[0] ?? this.view.width;
      case 'height': return this.engine.frameSize(this.aoid)?.[1] ?? this.view.height;
      case 'repeatcount': return this.looping ? -1 : 1;
      case 'framenotification': return this.frameNotification ? 1 : 0;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'frame': {
        const frame = toNumber(value) - 1;
        this.pendingFrame = frame;
        this.anim?.showFrame(frame);
        return;
      }
      case 'repeatcount': // -1 = loop forever. It doesn't start it: `play` does, or a move action
        this.looping = toNumber(value) < 0;
        if (this.anim) this.anim.loop = this.looping;
        return;
      case 'framenotification': // fire `frameNotify` on every frame
        this.frameNotification = truthy(value);
        return;
      default:
        super.setProp(name, key, value);
    }
  }

  /**
   * Runs the animation for as long as something moves along it -- CWS4's
   * conveyor while a package rides on or off, OWS4's logs under a sentence --
   * carrying on from the frame it rests on. The returned function puts it back
   * the way it was: still again for the belt, but CBA2's water, which its
   * script set playing for good, keeps going.
   */
  runWhileMoving(): () => void {
    const wasPlaying = this.anim ? this.anim.playing : this.playWhenLoaded;
    if (this.anim) this.anim.playing = true;
    else this.playWhenLoaded = true;
    return () => {
      if (this.destroyed) return;
      if (this.anim) this.anim.playing = wasPlaying;
      else this.playWhenLoaded = wasPlaying;
    };
  }

  /** Plays the animation once and calls `done` at the end. */
  playOnce(done: () => void): void {
    this.onceDone = done;
    if (this.anim) {
      this.anim.restart();
      this.anim.playing = true;
    }
  }

  private framesToShow(): Texture[] {
    return this.recolored.apply(this.engine, this.baseFrames, this.swaps);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.paletteOff?.();
    this.recolored.release();
    super.destroy();
  }

  private async init(aoid: number) {
    const loaded = await this.engine.loadAseq(aoid);
    if (!loaded || this.destroyed) return;
    this.baseFrames = loaded.frames;
    this.anim = new AseqAnimation(this.framesToShow(), {
      onResource: (id) => this.engine.playSound(id),
      onFrame: () => {
        if (this.frameNotification) this.fire('frameNotify');
      },
      onEnd: () => {
        if (this.looping) return;
        const done = this.onceDone;
        this.onceDone = null;
        this.fire('finished');
        this.fire('paused'); // it rests on its last frame (OMA's rock breakup waits for this)
        done?.();
      },
    });
    if (this.onceDone) queueMicrotask(() => this.anim && (this.anim.playing = true));
    this.anim.loop = this.looping;
    this.anim.playing = this.playWhenLoaded;
    this.anim.setList(sequenceList(loaded));
    if (this.pendingFrame !== null) this.anim.showFrame(this.pendingFrame);
    this.view.addChild(this.anim);
    if (!this.placed) {
      const [px, py] = aoPosition(loaded);
      this.view.position.set(px, py);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'replacepaletteentry':
        this.swaps.replace(toNumber(args[0]), toNumber(args[1]));
        this.paletteOff ??= this.engine.onPalette(() => this.anim?.setFrames(this.framesToShow()));
        this.anim?.setFrames(this.framesToShow());
        return 0;
      case 'play':
        if (this.anim) {
          if (!this.anim.playing && !this.pausedMidway) this.anim.restart();
          this.anim.playing = true;
        } else {
          this.playWhenLoaded = true; // OMA sends play right after creating the rock breakup
        }
        this.pausedMidway = false;
        return 0;
      case 'pause': // hold the current frame; play carries on from it (OWS4's running mice, the pulled logs)
        if (this.anim) this.anim.playing = false;
        this.playWhenLoaded = false;
        this.pausedMidway = true;
        return 0;
      case 'stop':
        if (this.anim) this.anim.playing = false;
        return 0;
      case 'forever': // loop from now on (OMA's river)
        this.looping = true;
        if (this.anim) {
          this.anim.loop = true;
          this.anim.playing = true;
        } else {
          this.playWhenLoaded = true;
        }
        return 0;
      case 'setaocursor':
        return 0;
      default:
        return super.send(method, args);
    }
  }

  tick(deltaMs: number): void {
    this.anim?.update(deltaMs);
  }
}

/** Image button: frame 0 normal, 1 pressed, 2 disabled (when present). Fires `hit` on click. */
export class RPButton extends DisplayObject {
  private frames: Texture[] = [];
  private readonly sprite = new Sprite(Texture.EMPTY);
  private enabled = true;
  private pressed = false;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RPButton');
    this.view.addChild(this.sprite);
    // `RPButton imageID` (OMA) places the button at its image's position, like x = kUseAOCoords
    if (args.length === 1) void this.init(USE_AO_COORDS, 0, toNumber(args[0]));
    else void this.init(toNumber(args[0]), toNumber(args[1]), toNumber(args[2]));
  }

  private async init(x: number, y: number, aoid: number) {
    const loaded = await this.engine.loadAseq(aoid);
    if (!loaded || this.destroyed) return;
    this.frames = loaded.frames;
    const [px, py] = x === USE_AO_COORDS ? aoPosition(loaded) : [x, y];
    this.view.position.set(px, py);
    this.refresh();
  }

  private refresh() {
    const disabledFrame = this.frames.length > 2;
    const index = !this.enabled && disabledFrame ? 2 : this.pressed && this.frames.length > 1 ? 1 : 0;
    this.sprite.texture = this.frames[index] ?? Texture.EMPTY;
    this.sprite.alpha = !this.enabled && !disabledFrame ? 0.5 : 1;
  }

  getProp(name: string, key: Value | undefined): Value {
    if (name.toLowerCase() === 'enabled') return this.enabled ? 1 : 0;
    return super.getProp(name, key);
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    if (name.toLowerCase() === 'enabled') {
      this.enabled = truthy(value);
      this.refresh();
      return;
    }
    super.setProp(name, key, value);
  }

  onPointerDown(): void {
    if (!this.enabled) return;
    this.pressed = true;
    this.refresh();
    this.fire('mouseDown');
  }

  onPointerUp(_x: number, _y: number, inside: boolean): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.refresh();
    this.fire('mouseUp');
    if (inside && this.enabled) {
      const sound = toNumber(this.getProp('clickSoundID', undefined));
      if (sound) this.engine.playSound(sound);
      this.fire('hit');
    }
  }
}

export class RText extends DisplayObject {
  private readonly label: Text;
  private readonly bitmap = new BitmapLabel();
  private bitmapFont: BitmapFontData | null = null;
  private readonly colorIndex: number;
  private fontId = 0;
  private fontName: string | null = null;
  private fontSize = 12;
  private bold = false;
  private centred = false;
  private wrapWidth = 0;
  private readonly unsubscribe: () => void;

  /**
   * `RText text, colorIndex, x, y[, centred]` or a wrapping text box: `RText text, colorIndex, x, y, w, h, wrap`.
   * With `centred` true the text is centred on (x, y): scripts pass a box's middle
   * (OWS4's sentence words, the Oasis location tabs), while with false they centre it themselves (CWS2).
   */
  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RText');
    this.colorIndex = toNumber(args[1]);
    this.label = new Text({ text: toText(args[0]), style: { fill: 0xffffff } });
    this.centred = args.length === 5 && truthy(args[4]);
    if (this.centred) this.label.anchor.set(0.5);
    this.view.addChild(this.label, this.bitmap);
    this.view.position.set(toInt(args[2]), toInt(args[3]));
    if (args.length >= 7 && toNumber(args[4]) > 0 && truthy(args[6])) {
      this.wrapWidth = toNumber(args[4]);
      this.label.style.wordWrap = true;
      this.label.style.wordWrapWidth = this.wrapWidth;
    }
    this.bitmap.setCentred(this.centred);
    this.bitmap.setWrapWidth(this.wrapWidth);
    this.bitmap.setText(toText(args[0]));
    // The index arrives after construction, so restyle again once it has.
    void bitmapFonts.ensureLoaded(engine.resources).then(() => this.restyle());
    this.restyle();
    this.unsubscribe = engine.onPalette(() => this.restyle());
  }

  /**
   * Draw with the game's own bitmap font when it has one for what the script
   * asked for, and with a web face otherwise -- a name the game never shipped
   * (Times), or a run where the fonts haven't been extracted.
   */
  private restyle() {
    // The font index arrives from a promise, which can settle after the text is
    // gone -- Pixi nulls a destroyed Text's style, so styling it then throws.
    // The scene can destroy the label without the script object knowing, so
    // check the label itself rather than trusting this object's own flag.
    if (this.destroyed || this.label.destroyed || !this.label.style) return;
    this.bitmapFont = this.fontName !== null
      ? bitmapFonts.resolve(this.fontName, this.fontSize, this.bold)
      : bitmapFonts.byId(this.fontId);
    const colour = this.engine.paletteColor(this.colorIndex);
    this.bitmap.visible = this.bitmapFont !== null;
    this.label.visible = this.bitmapFont === null;
    if (this.bitmapFont) {
      this.bitmap.setFont(this.bitmapFont);
      this.bitmap.setColour(colour);
      return;
    }
    if (this.fontName !== null) {
      this.label.style.fontFamily = familyForFontName(this.fontName);
      this.label.style.fontSize = this.fontSize;
      this.label.style.fontWeight = this.bold ? 'bold' : 'normal';
    } else {
      const font = fontFor(this.fontId);
      this.label.style.fontFamily = font.family;
      this.label.style.fontSize = font.size;
    }
    this.label.style.fill = colour;
  }

  /** Keep both labels in step; which one shows is decided in restyle(). */
  private setText(text: string): void {
    this.label.text = text;
    this.bitmap.setText(text);
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'text': return this.label.text;
      // A bitmap font measures exactly as the original did: the sum of the glyph
      // advances. For a web stand-in, round rather than ceil -- GetTextExtentPoint
      // sums whole advance widths, and a pixel too many picks a bigger word box in
      // OWS2 so its sentence overflows the row.
      case 'textwidth':
        return this.bitmapFont
          ? bitmapFonts.measure(this.bitmapFont, this.label.text)
          : Math.round(this.label.width);
      case 'textheight':
        return this.bitmapFont ? this.bitmap.textHeight : Math.ceil(this.label.height);
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    if (name.toLowerCase() === 'text') {
      this.setText(toText(value));
      return;
    }
    super.setProp(name, key, value);
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'setfont':
        // a font id (40, 50) or a Mac font name with style and size ("Geneva", 0, 12)
        if (typeof args[0] === 'string' && Number.isNaN(Number(args[0]))) {
          this.fontName = args[0];
          this.bold = (toNumber(args[1]) & 1) !== 0;
          this.fontSize = toNumber(args[2]) || 12;
        } else {
          this.fontId = toNumber(args[0]);
        }
        this.restyle();
        return 0;
      case 'settext':
        this.setText(toText(args[0]));
        return 0;
      case 'offset':
        this.view.position.set(this.view.x + toNumber(args[0]), this.view.y + toNumber(args[1]));
        return 0;
      default:
        return super.send(method, args);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.unsubscribe();
    super.destroy();
  }
}

/** An invisible clickable rectangle: `RHotSpot x1, y1, x2, y2[, z]`. */
export class RHotSpot extends DisplayObject {
  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RHotSpot');
    const [x1, y1, x2, y2] = args.map(toInt);
    const area = new Graphics().rect(0, 0, Math.max(1, x2 - x1), Math.max(1, y2 - y1)).fill({ color: 0, alpha: 0.001 });
    this.view.addChild(area);
    this.view.position.set(x1, y1);
    if (args.length > 4) this.view.zIndex = toInt(args[4]);
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'offset':
        this.view.position.set(this.view.x + toNumber(args[0]), this.view.y + toNumber(args[1]));
        return 0;
      case 'setaocursor':
        return 0;
      default:
        return super.send(method, args);
    }
  }
}

/** A one-shot animation for AnimAction: plays at its stored position, then removes itself. */
export class TempAnimation extends DisplayObject {
  private anim: AseqAnimation | null = null;

  constructor(
    engine: GameEngine,
    id: number,
    z: number,
    repeat: number,
    private readonly done: () => void,
    private readonly at: [number, number] | null = null
  ) {
    super(engine, 'TempAnimation');
    this.touchy = false;
    this.view.zIndex = z;
    void this.init(id, Math.max(1, repeat));
  }

  private async init(id: number, repeat: number) {
    const loaded = await this.engine.loadAseq(id);
    if (this.destroyed) return;
    if (!loaded) return this.finish();
    let plays = 0;
    this.anim = new AseqAnimation(loaded.frames, {
      onResource: (sound) => this.engine.playSound(sound),
      onEnd: () => {
        if (++plays >= repeat) {
          if (this.anim) this.anim.loop = false;
          queueMicrotask(() => this.finish());
        }
      },
    });
    this.anim.loop = true;
    this.anim.position.set(...(this.at ?? aoPosition(loaded)));
    this.view.addChild(this.anim);
    this.anim.setList(sequenceList(loaded));
  }

  private finish() {
    if (this.destroyed) return;
    this.destroy();
    this.done();
  }

  tick(deltaMs: number): void {
    this.anim?.update(deltaMs);
  }
}

const MOVIE_PLACEHOLDER_MS = 1500;

/**
 * A Smacker movie, converted to MP4 by extract_video.py:
 * `RSmackerMovie name[, x, y, bufferSize]`. It plays in the engine's one
 * movie player (Media: a <video> the Start tap unlocks, so iPhones play the
 * movies with sound), and each new frame is drawn into the game's canvas like
 * any other image. (Laid over the canvas as its own element, Chrome composited
 * it separately and could change how it converted and scaled it partway
 * through, which showed as the picture fading slightly every couple of seconds.)
 * `start` plays it and fires `finished` at the end; clicks fire `mouseDown`,
 * which scripts use to skip. A movie without a converted file shows a card.
 */
export class RSmackerMovie extends DisplayObject implements VideoOwner {
  private readonly name: string;
  private readonly url: string | undefined;
  private screen: Sprite | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private onDone: (() => void) | null = null;
  private started = false;
  private over = false;
  private musicSuspended = false;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RSmackerMovie');
    this.name = toText(args[0]);
    engine.movieLayer.addChild(this.view);
    this.view.zIndex = 50000;
    this.view.visible = false;
    // black backdrop: covers the scene while the video loads
    this.view.addChild(new Graphics().rect(0, 0, STAGE_W, STAGE_H).fill(0x000000));
    this.url = engine.resources.getVideoUrl(this.name);
    if (!this.url) {
      const caption = new Text({
        text: `Movie ${this.name}\n(not converted yet — click to skip)`,
        style: { fill: 0x9aa4b2, fontFamily: 'Verdana, sans-serif', fontSize: 14, align: 'center' },
      });
      caption.anchor.set(0.5);
      caption.position.set(STAGE_W / 2, STAGE_H / 2);
      this.view.addChild(caption);
      return;
    }
    engine.media.claimVideo(this, this.url); // starts loading it
  }

  videoReady(): void {
    if (this.destroyed || this.screen) return;
    // nearest-neighbour scaled, as the rest of the game draws
    this.screen = new Sprite(this.engine.media.videoFrames);
    this.view.addChild(this.screen);
  }

  videoEnded(): void {
    this.finish();
  }

  videoFailed(): void {
    this.engine.warn(`movie ${this.name} failed to load`);
    this.finish();
  }

  videoLost(): void {
    this.screen?.destroy();
    this.screen = null;
  }

  /** For MovieAction: plays, finishes at the end or on a click, then removes itself. Returns a cancel function. */
  playAsAction(done: () => void): () => void {
    this.onDone = done;
    this.send('start', []);
    return () => {
      this.onDone = null;
      this.destroy();
    };
  }

  private suspendMusic(suspend: boolean) {
    if (this.musicSuspended === suspend) return;
    this.musicSuspended = suspend;
    this.engine.scene.suspendMusic(suspend);
  }

  private finish() {
    if (this.over || this.destroyed) return;
    this.over = true;
    if (this.engine.media.ownsVideo(this)) this.engine.media.video.pause();
    this.suspendMusic(false);
    const done = this.onDone;
    if (done) {
      this.onDone = null;
      this.destroy();
      done();
    } else {
      this.fire('finished');
    }
  }

  private play(video: HTMLVideoElement) {
    video.play().catch((err: DOMException) => {
      if (this.destroyed || !this.engine.media.ownsVideo(this)) return;
      if (err?.name === 'NotAllowedError') {
        // sound blocked until the page has had a tap: play muted rather than not at all
        video.muted = true;
        video.play().catch(() => this.finish());
      } else if (err?.name !== 'AbortError') {
        this.finish();
      }
    });
  }

  onPointerDown(x: number, y: number): void {
    if (this.onDone) this.finish();
    else super.onPointerDown(x, y);
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'start':
        this.view.visible = true;
        this.over = false;
        this.suspendMusic(true);
        if (this.url) {
          const video = this.engine.media.claimVideo(this, this.url);
          if (this.started) video.currentTime = 0;
          this.started = true;
          this.play(video);
        } else {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.finish(), MOVIE_PLACEHOLDER_MS);
        }
        return 0;
      case 'stop':
        clearTimeout(this.timer);
        if (this.engine.media.ownsVideo(this)) this.engine.media.video.pause();
        return 0;
      default:
        return super.send(method, args);
    }
  }

  tick(deltaMs: number): void {
    super.tick(deltaMs);
    if (this.engine.media.ownsVideo(this)) this.engine.media.updateVideoFrame();
  }

  destroy(): void {
    if (this.destroyed) return;
    clearTimeout(this.timer);
    this.suspendMusic(false);
    this.engine.media.releaseVideo(this);
    this.screen?.destroy(); // the frames texture is the player's, not this movie's
    this.screen = null;
    super.destroy();
  }
}

interface DialogButton {
  value: Value;
  frames: Texture[];
  sprite: Sprite;
}

/** Modal message box: an image, optional graphic, and image buttons reporting `selectedButton`. */
export class RDialog extends DisplayObject {
  private readonly box = new Sprite(Texture.EMPTY);
  private readonly graphic = new Sprite(Texture.EMPTY);
  private readonly buttons: DialogButton[] = [];
  private pressed: DialogButton | null = null;
  /** Stored screen positions of the dialog's images, when they have one. */
  private readonly origins = new Map<Sprite, [number, number]>();

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RDialog');
    this.view.zIndex = Math.max(toNumber(args[1]), 20000);
    const shade = new Graphics().rect(0, 0, STAGE_W, STAGE_H).fill({ color: 0x000000, alpha: 0.35 });
    this.view.addChild(shade, this.box, this.graphic);
    void this.loadInto(this.box, toNumber(args[0]));
  }

  private async loadInto(sprite: Sprite, id: number): Promise<Texture[]> {
    const origin = this.engine.originOf(id);
    if (origin && (origin[0] !== 0 || origin[1] !== 0)) this.origins.set(sprite, origin);
    const loaded = await this.engine.loadAseq(id);
    if (!loaded || this.destroyed) return [];
    sprite.texture = loaded.frames[0];
    this.layout();
    return loaded.frames;
  }

  private layout() {
    const { box, graphic } = this;
    if (this.origins.has(box)) {
      // images with stored positions (PLOC2's Play Again dialog) sit where they were drawn
      for (const sprite of [box, graphic, ...this.buttons.map((b) => b.sprite)]) {
        const origin = this.origins.get(sprite);
        if (origin) sprite.position.set(origin[0], origin[1]);
      }
      return;
    }
    box.position.set(Math.round((STAGE_W - box.width) / 2), Math.round((STAGE_H - box.height) / 2));
    graphic.position.set(box.x + 24, box.y + Math.round((box.height - graphic.height) / 2));
    const total = this.buttons.reduce((sum, b) => sum + b.sprite.width, 0) + 16 * Math.max(0, this.buttons.length - 1);
    let x = box.x + box.width - 24 - total;
    for (const b of this.buttons) {
      b.sprite.position.set(x, box.y + box.height - 20 - b.sprite.height);
      x += b.sprite.width + 16;
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'addbutton': {
        const button: DialogButton = { value: args[1] ?? 0, frames: [], sprite: new Sprite(Texture.EMPTY) };
        this.buttons.push(button);
        this.view.addChild(button.sprite);
        void this.loadInto(button.sprite, toNumber(args[0])).then((frames) => (button.frames = frames));
        return 0;
      }
      case 'addgraphic':
        void this.loadInto(this.graphic, toNumber(args[0]));
        return 0;
      default:
        return super.send(method, args);
    }
  }

  containsPoint(): boolean {
    return this.view.visible && !this.destroyed; // modal
  }

  private buttonAt(x: number, y: number): DialogButton | null {
    return this.buttons.find((b) => {
      const s = b.sprite;
      return x >= s.x && x < s.x + s.width && y >= s.y && y < s.y + s.height;
    }) ?? null;
  }

  onPointerDown(x: number, y: number): void {
    this.pressed = this.buttonAt(x, y);
    if (this.pressed?.frames[1]) this.pressed.sprite.texture = this.pressed.frames[1];
  }

  onPointerUp(x: number, y: number): void {
    const pressed = this.pressed;
    this.pressed = null;
    if (!pressed) return;
    if (pressed.frames[0]) pressed.sprite.texture = pressed.frames[0];
    if (this.buttonAt(x, y) === pressed) {
      this.props.set('selectedbutton', pressed.value);
      this.fire('buttonPressed');
    }
  }
}

export { Container };
