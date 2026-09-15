import { Container, Sprite, Texture } from 'pixi.js';
import type { Value } from './ScriptVm';
import { toNumber, toText } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';

/** Cell steps by direction id: N, S, E, W, NE, NW, SE, SW. */
const STEPS: [number, number][] = [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]];

/** moveDelay is in ticks; assumed 60 per second (the EXE's default delay is 60). */
const TICK_MS = 1000 / 60;

interface MapRun {
  x: number;
  y: number;
  move: number;
  left: number;
  elapsed: number;
  done: (() => void) | null;
}

/**
 * A grid map a path is walked on (OWS3), following 4THADV32.EXE's RMap: `RMap z`.
 * Scripts give the grid (cellsH/V, cellSizeH/V), terrain rows (`setTerrain row,
 * "0011..."`: 0 is open ground, 1-9 a trap), start and finish cells, and moves
 * (`addMove direction, cells`). `move` (or MapAction) steps one cell every
 * moveDelay ticks, dropping the direction's footprint on each cell. A step off
 * the map or onto a trap plays offMapSoundID / trapSoundID n and stops; after
 * the last move the path stops too, leaving the finish cell's marker
 * uncovered. Either way `finished` fires.
 */
export class RMap extends DisplayObject {
  private cellsH = 0;
  private cellsV = 0;
  private cellW = 0;
  private cellH = 0;
  private moveDelay = 60;
  private offMapSound = -1;
  private readonly directionGraphics = new Map<number, number>();
  private readonly trapSounds = new Map<number, number>();
  private readonly terrain: string[] = [];
  private moves: [number, number][] = [];
  private readonly cells = { startX: 0, startY: 0, finishX: 0, finishY: 0 };
  private readonly graphics = { map: -1, start: -1, finish: -1 };
  private readonly mapSprite = new Sprite(Texture.EMPTY);
  private readonly startSprite = new Sprite(Texture.EMPTY);
  private readonly finishSprite = new Sprite(Texture.EMPTY);
  private readonly trail = new Container();
  private run: MapRun | null = null;
  private paused = false;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RMap');
    this.view.zIndex = toNumber(args[0] ?? 0);
    this.view.sortableChildren = false;
    this.view.addChild(this.mapSprite, this.startSprite, this.finishSprite, this.trail);
  }

  /** Top-left of the grid: the map image's position. */
  private origin(): [number, number] {
    return this.graphics.map > 0 ? (this.engine.originOf(this.graphics.map) ?? [0, 0]) : [0, 0];
  }

  /** Shows image `id` (frame 0) in a sprite, centred in a cell, or at the image's own position. */
  private show(sprite: Sprite, id: number, cell: [number, number] | null) {
    if (id <= 0) {
      sprite.visible = false;
      return;
    }
    sprite.visible = true;
    if (cell) {
      const [ox, oy] = this.origin();
      const [w, h] = this.engine.frameSize(id) ?? [this.cellW, this.cellH];
      sprite.position.set(
        Math.round(ox + cell[0] * this.cellW + (this.cellW - w) / 2),
        Math.round(oy + cell[1] * this.cellH + (this.cellH - h) / 2)
      );
    } else {
      const [x, y] = this.engine.originOf(id) ?? [0, 0];
      sprite.position.set(x, y);
    }
    void this.engine.loadAseq(id).then((loaded) => {
      if (loaded && !this.destroyed) sprite.texture = loaded.frames[0] ?? Texture.EMPTY;
    });
  }

  private refresh() {
    this.show(this.mapSprite, this.graphics.map, null);
    this.show(this.startSprite, this.graphics.start, [this.cells.startX, this.cells.startY]);
    this.show(this.finishSprite, this.graphics.finish, [this.cells.finishX, this.cells.finishY]);
  }

  private clearTrail() {
    for (const child of this.trail.removeChildren()) child.destroy();
  }

  private footprint(direction: number, x: number, y: number) {
    const sprite = new Sprite(Texture.EMPTY);
    this.trail.addChild(sprite);
    this.show(sprite, this.directionGraphics.get(direction) ?? -1, [x, y]);
  }

  /** Starts walking the moves; `done` runs when the walk finishes. */
  startMove(done: (() => void) | null): void {
    this.clearTrail();
    if (this.moves.length === 0) {
      this.fire('finished');
      done?.();
      return;
    }
    this.run = { x: this.cells.startX, y: this.cells.startY, move: 0, left: this.moves[0][1], elapsed: 0, done };
  }

  /** Forgets the pending completion callback (a halted MapAction); the walk carries on. */
  detach(): void {
    if (this.run) this.run.done = null;
  }

  /** One cell along the current move; false once the walk has ended. */
  private step(notify: boolean): boolean {
    const run = this.run;
    if (!run) return false;
    const direction = this.moves[run.move][0];
    const [dx, dy] = STEPS[direction] ?? [0, 0];
    run.x += dx;
    run.y += dy;
    if (run.x < 0 || run.x >= this.cellsH || run.y < 0 || run.y >= this.cellsV) {
      this.engine.playSound(this.offMapSound);
      this.end(notify);
      return false;
    }
    const ground = (this.terrain[run.y] ?? '').charCodeAt(run.x) - 48;
    if (ground > 0 && ground <= 9) {
      this.engine.playSound(this.trapSounds.get(ground) ?? -1);
      this.end(notify);
      return false;
    }
    run.left--;
    if (run.left > 0) {
      this.footprint(direction, run.x, run.y);
      return true;
    }
    run.move++;
    if (run.move < this.moves.length) {
      this.footprint(direction, run.x, run.y);
      run.left = this.moves[run.move][1];
      return true;
    }
    if (run.x !== this.cells.finishX || run.y !== this.cells.finishY) this.footprint(direction, run.x, run.y);
    this.end(notify);
    return false;
  }

  private end(notify: boolean) {
    const done = this.run?.done ?? null;
    this.run = null;
    if (!notify) return;
    this.fire('finished');
    done?.();
  }

  tick(deltaMs: number): void {
    const run = this.run;
    if (!run || this.paused) return;
    const delay = Math.max(1, this.moveDelay) * TICK_MS;
    run.elapsed += deltaMs;
    while (this.run === run && run.elapsed >= delay) {
      run.elapsed -= delay;
      this.step(true);
    }
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'cellsh': return this.cellsH;
      case 'cellsv': return this.cellsV;
      case 'cellsizeh': return this.cellW;
      case 'cellsizev': return this.cellH;
      case 'movedelay': return this.moveDelay;
      case 'offmapsoundid': return this.offMapSound;
      case 'mapgraphicid': return this.graphics.map;
      case 'startgraphicid': return this.graphics.start;
      case 'finishgraphicid': return this.graphics.finish;
      case 'startx': return this.cells.startX;
      case 'starty': return this.cells.startY;
      case 'finishx': return this.cells.finishX;
      case 'finishy': return this.cells.finishY;
      case 'directiongraphicid': return this.directionGraphics.get(toNumber(key)) ?? -1;
      case 'trapsoundid': return this.trapSounds.get(toNumber(key)) ?? -1;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    const n = toNumber(value);
    switch (name.toLowerCase()) {
      case 'cellsh': this.cellsH = n; return;
      case 'cellsv': this.cellsV = n; return;
      case 'cellsizeh': this.cellW = n; this.refresh(); return;
      case 'cellsizev': this.cellH = n; this.refresh(); return;
      case 'movedelay': this.moveDelay = n; return;
      case 'offmapsoundid': this.offMapSound = n; return;
      case 'directiongraphicid': this.directionGraphics.set(toNumber(key), n); return;
      case 'trapsoundid': this.trapSounds.set(toNumber(key), n); return;
      case 'mapgraphicid': this.graphics.map = n; this.refresh(); return;
      case 'startgraphicid': this.graphics.start = n; this.refresh(); return;
      case 'finishgraphicid': this.graphics.finish = n; this.refresh(); return;
      case 'startx': this.cells.startX = n; this.refresh(); return;
      case 'starty': this.cells.startY = n; this.refresh(); return;
      case 'finishx': this.cells.finishX = n; this.refresh(); return;
      case 'finishy': this.cells.finishY = n; this.refresh(); return;
      default: super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'addmove':
        this.moves.push([toNumber(args[0]), toNumber(args[1])]);
        return 0;
      case 'clearmoves':
        this.moves = [];
        this.clearTrail();
        return 0;
      case 'setterrain':
        this.terrain[Math.max(0, toNumber(args[0]) - 1)] = toText(args[1] ?? '');
        return 0;
      case 'move':
        this.startMove(null);
        return 0;
      case 'interruptmove': // finish the walk at once, without `finished`
        while (this.step(false));
        return 0;
      case 'pause':
        this.paused = true;
        return 0;
      case 'resume':
        this.paused = false;
        return 0;
      default:
        return super.send(method, args);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.run = null;
    super.destroy();
  }
}
