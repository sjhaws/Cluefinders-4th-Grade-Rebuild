import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { AseqAnimation } from '../AseqAnimation';
import type { LoadedAseq } from '../ResourceManager';
import type { SequenceEntry } from '../types';
import type { Value } from './ScriptVm';
import { toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import { STAGE_H, STAGE_W } from './constants';

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

/** Stand-ins for FONT.RSC until it's decoded, keyed by the font ids scripts use. */
export function fontFor(id: number): FontSpec {
  switch (id) {
    case 40: return { family: SERIF, size: 16 };
    case 50: return { family: SERIF, size: 17 };
    default: return { family: 'Verdana, sans-serif', size: 14 };
  }
}

export class RAnimation extends DisplayObject {
  private anim: AseqAnimation | null = null;
  private onceDone: (() => void) | null = null;

  /** `RAnimation id` (at its stored position) or `RAnimation x, y, id`. */
  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RAnimation');
    this.movable = true; // scripts switch this off for scenery
    // position known up front so scripts can read x/y before the image loads
    const origin = args.length < 3 ? engine.originOf(toNumber(args[0])) : null;
    if (origin) this.view.position.set(origin[0], origin[1]);
    if (args.length < 3) void this.init(USE_AO_COORDS, USE_AO_COORDS, toNumber(args[0]));
    else void this.init(toNumber(args[0]), toNumber(args[1]), toNumber(args[2]));
  }

  /** Plays the animation once and calls `done` at the end. */
  playOnce(done: () => void): void {
    this.onceDone = done;
    if (this.anim) {
      this.anim.restart();
      this.anim.playing = true;
    }
  }

  private async init(x: number, y: number, aoid: number) {
    const loaded = await this.engine.loadAseq(aoid);
    if (!loaded || this.destroyed) return;
    this.anim = new AseqAnimation(loaded.frames, {
      onResource: (id) => this.engine.playSound(id),
      onEnd: () => {
        const done = this.onceDone;
        this.onceDone = null;
        this.fire('finished');
        done?.();
      },
    });
    if (this.onceDone) queueMicrotask(() => this.anim && (this.anim.playing = true));
    this.anim.loop = false;
    this.anim.playing = false;
    this.anim.setList(sequenceList(loaded));
    this.view.addChild(this.anim);
    const [px, py] = x === USE_AO_COORDS ? aoPosition(loaded) : [x, y];
    this.view.position.set(px, py);
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'play':
        if (this.anim) {
          if (!this.anim.playing) this.anim.restart();
          this.anim.playing = true;
        }
        return 0;
      case 'stop':
        if (this.anim) this.anim.playing = false;
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
    void this.init(toNumber(args[0]), toNumber(args[1]), toNumber(args[2]));
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
  private readonly colorIndex: number;
  private fontId = 0;
  private readonly unsubscribe: () => void;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RText');
    this.colorIndex = toNumber(args[1]);
    this.label = new Text({ text: toText(args[0]), style: { fill: 0xffffff } });
    this.view.addChild(this.label);
    this.view.position.set(toNumber(args[2]), toNumber(args[3]));
    this.restyle();
    this.unsubscribe = engine.onPalette(() => this.restyle());
  }

  private restyle() {
    const font = fontFor(this.fontId);
    this.label.style.fontFamily = font.family;
    this.label.style.fontSize = font.size;
    this.label.style.fill = this.engine.paletteColor(this.colorIndex);
  }

  getProp(name: string, key: Value | undefined): Value {
    if (name.toLowerCase() === 'text') return this.label.text;
    return super.getProp(name, key);
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    if (name.toLowerCase() === 'text') {
      this.label.text = toText(value);
      return;
    }
    super.setProp(name, key, value);
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'setfont':
        this.fontId = toNumber(args[0]);
        this.restyle();
        return 0;
      case 'settext':
        this.label.text = toText(args[0]);
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
    const [x1, y1, x2, y2] = args.map(toNumber);
    const area = new Graphics().rect(0, 0, Math.max(1, x2 - x1), Math.max(1, y2 - y1)).fill({ color: 0, alpha: 0.001 });
    this.view.addChild(area);
    this.view.position.set(x1, y1);
    if (args.length > 4) this.view.zIndex = toNumber(args[4]);
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

  constructor(engine: GameEngine, id: number, z: number, repeat: number, private readonly done: () => void) {
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
    this.anim.position.set(...aoPosition(loaded));
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
 * `RSmackerMovie name[, x, y, bufferSize]`. It plays in a <video> element laid
 * exactly over the canvas (native decoding, no per-frame texture uploads).
 * `start` plays it and fires `finished` at the end; clicks fire `mouseDown`,
 * which scripts use to skip. A movie without a converted file shows a card.
 */
export class RSmackerMovie extends DisplayObject {
  private readonly name: string;
  private video: HTMLVideoElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private onDone: (() => void) | null = null;
  private started = false;
  private over = false;
  private musicSuspended = false;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RSmackerMovie');
    this.name = toText(args[0]);
    this.view.zIndex = 50000;
    this.view.visible = false;
    // black backdrop: covers the scene while the video loads
    this.view.addChild(new Graphics().rect(0, 0, STAGE_W, STAGE_H).fill(0x000000));
    const url = engine.resources.getVideoUrl(this.name);
    const root = engine.overlayRoot;
    if (!url || !root) {
      const caption = new Text({
        text: `Movie ${this.name}\n(not converted yet — click to skip)`,
        style: { fill: 0x9aa4b2, fontFamily: 'Verdana, sans-serif', fontSize: 14, align: 'center' },
      });
      caption.anchor.set(0.5);
      caption.position.set(STAGE_W / 2, STAGE_H / 2);
      this.view.addChild(caption);
      return;
    }
    const video = document.createElement('video');
    video.preload = 'auto';
    video.playsInline = true;
    video.src = url;
    Object.assign(video.style, {
      position: 'absolute',
      display: 'none',
      objectFit: 'fill',
      imageRendering: 'pixelated',
      background: '#000',
    });
    video.addEventListener('ended', () => this.finish());
    video.addEventListener('error', () => {
      if (this.video !== video) return; // destroy() clears the source, which also raises 'error'
      engine.warn(`movie ${this.name} failed to load`);
      this.finish();
    });
    video.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (this.onDone) this.finish();
      else this.fire('mouseDown');
    });
    root.appendChild(video);
    this.video = video;
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(engine.app.canvas);
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

  /** Lays the video exactly over the canvas's drawing area (inside its border). */
  private fit() {
    const video = this.video;
    if (!video) return;
    const canvas = this.engine.app.canvas;
    Object.assign(video.style, {
      left: `${canvas.offsetLeft + canvas.clientLeft}px`,
      top: `${canvas.offsetTop + canvas.clientTop}px`,
      width: `${canvas.clientWidth}px`,
      height: `${canvas.clientHeight}px`,
    });
  }

  private suspendMusic(suspend: boolean) {
    if (this.musicSuspended === suspend) return;
    this.musicSuspended = suspend;
    this.engine.scene.suspendMusic(suspend);
  }

  private finish() {
    if (this.over || this.destroyed) return;
    this.over = true;
    this.video?.pause();
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
      if (this.destroyed || this.video !== video) return;
      if (err?.name === 'NotAllowedError') {
        // sound blocked until the page has had a click: play muted rather than not at all
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
        if (this.video) {
          if (this.started) this.video.currentTime = 0;
          this.started = true;
          this.fit();
          this.video.style.display = 'block';
          this.play(this.video);
        } else {
          clearTimeout(this.timer);
          this.timer = setTimeout(() => this.finish(), MOVIE_PLACEHOLDER_MS);
        }
        return 0;
      case 'stop':
        clearTimeout(this.timer);
        this.video?.pause();
        return 0;
      default:
        return super.send(method, args);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    clearTimeout(this.timer);
    this.suspendMusic(false);
    this.resizeObserver?.disconnect();
    const video = this.video;
    this.video = null;
    if (video) {
      video.pause();
      video.remove();
      video.removeAttribute('src');
      video.load(); // releases the media resource
    }
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

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RDialog');
    this.view.zIndex = Math.max(toNumber(args[1]), 20000);
    const shade = new Graphics().rect(0, 0, STAGE_W, STAGE_H).fill({ color: 0x000000, alpha: 0.35 });
    this.view.addChild(shade, this.box, this.graphic);
    void this.loadInto(this.box, toNumber(args[0]));
  }

  private async loadInto(sprite: Sprite, id: number): Promise<Texture[]> {
    const loaded = await this.engine.loadAseq(id);
    if (!loaded || this.destroyed) return [];
    sprite.texture = loaded.frames[0];
    this.layout();
    return loaded.frames;
  }

  private layout() {
    const { box, graphic } = this;
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
