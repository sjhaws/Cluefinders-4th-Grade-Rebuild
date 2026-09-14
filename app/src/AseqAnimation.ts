import { Container, Sprite, Texture } from 'pixi.js';
import type { SequenceEntry } from './types';

export const SEQ_LIST_START = -4;
export const SEQ_LIST_END = -2;
export const SEQ_TERMINATOR = -1;
export const SEQ_RESOURCE = -101;

/** Lip-synced sequences put one entry at ~115 ms (measured against their sound lengths). */
export const DEFAULT_TICK_MS = 115;

export interface AnimationEvents {
  /** A -101 entry: usually a sound to start at this point. */
  onResource?: (resourceId: number) => void;
  onEnd?: () => void;
}

export interface CurrentEntry {
  index: number;
  frame: number;
  x: number;
  y: number;
}

/**
 * Plays one sequence list of an ASEQ resource: one frame entry per tick,
 * each frame drawn with its top-left at the entry's (x, y) relative to this
 * container. Commands between frame entries run without taking a tick.
 */
export class AseqAnimation extends Container {
  tickMs = DEFAULT_TICK_MS;
  loop = true;
  playing = true;
  current: CurrentEntry | null = null;

  private readonly sprite = new Sprite(Texture.EMPTY);
  private list: SequenceEntry[] = [];
  private nextEntry = 0; // not `cursor`: Container already has one
  private elapsed = 0;

  constructor(
    private readonly frames: Texture[],
    private readonly events: AnimationEvents = {}
  ) {
    super();
    this.addChild(this.sprite);
  }

  setList(list: SequenceEntry[]): void {
    this.list = list;
    this.restart();
  }

  restart(): void {
    this.nextEntry = 0;
    this.elapsed = 0;
    this.current = null;
    this.step();
  }

  /** Shows the next frame entry, running commands on the way. False at the end of a non-looping list. */
  step(): boolean {
    for (let visited = 0; visited <= this.list.length; visited++) {
      if (this.nextEntry >= this.list.length) {
        if (!this.endOfList()) return false;
        continue;
      }
      const index = this.nextEntry++;
      const [x, y, tag, value] = this.list[index];
      if (tag >= 0 && tag < this.frames.length) {
        this.sprite.texture = this.frames[tag];
        this.sprite.position.set(x, y);
        this.current = { index, frame: tag, x, y };
        return true;
      }
      if (tag === SEQ_RESOURCE) {
        this.events.onResource?.(value);
      } else if ((tag === SEQ_LIST_END || tag === SEQ_TERMINATOR) && !this.endOfList()) {
        return false;
      }
    }
    return false; // a list with no frame entries
  }

  update(deltaMs: number): void {
    if (!this.playing) return;
    this.elapsed += deltaMs;
    while (this.elapsed >= this.tickMs) {
      this.elapsed -= this.tickMs;
      if (!this.step()) {
        this.playing = false;
        break;
      }
    }
  }

  private endOfList(): boolean {
    this.events.onEnd?.();
    if (!this.loop) return false;
    this.nextEntry = 0;
    return true;
  }
}

/** Bounding box of every frame a list shows, in the animation's coordinates. */
export function sequenceBounds(list: SequenceEntry[], frames: Texture[]) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y, tag] of list) {
    if (tag < 0 || tag >= frames.length) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + frames[tag].width);
    maxY = Math.max(maxY, y + frames[tag].height);
  }
  return minX === Infinity ? null : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
