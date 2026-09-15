import { Container, Sprite, Texture } from 'pixi.js';
import type { Value } from './ScriptVm';
import { toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';

/**
 * Piece shapes by piece number in view 0, as in 4THADV32.EXE's table (0x4c3a20,
 * 8 views x 5x5 cells per piece); the piece images match them at 14 px a cell.
 */
const SHAPES: string[][] = [
  ['##', '.#', '##'],
  ['.#.', '###', '.#.'],
  ['##.', '.##', '..#'],
  ['##.', '###'],
  ['.#.', '###', '#..'],
  ['#..', '###', '#..'],
  ['..#', '..#', '###'],
  ['##.', '.#.', '.##'],
  ['####', '...#'],
  ['..##', '###.'],
  ['#.', '##', '#.', '#.'],
  ['#####'],
];

type Cell = [number, number];

/**
 * Cells of a piece in a view: views 0-3 turn the shape clockwise 0-3 quarter
 * turns, 4-7 do the same and then mirror it left to right. Normalised to the
 * top-left. (Checked against CMA's solution data: every solution tiles exactly.)
 */
function viewCells(piece: number, view: number): Cell[] {
  let cells: Cell[] = [];
  (SHAPES[piece] ?? []).forEach((row, y) => [...row].forEach((ch, x) => ch === '#' && cells.push([x, y])));
  for (let i = 0; i < (view & 3); i++) cells = cells.map(([x, y]) => [-y, x]);
  if (view >= 4) cells = cells.map(([x, y]) => [-x, y]);
  const minX = Math.min(...cells.map((c) => c[0]));
  const minY = Math.min(...cells.map((c) => c[1]));
  return cells.map(([x, y]) => [x - minX, y - minY]);
}

/** Nearest cell for a pixel offset, rounding halves away from zero like the original. */
function nearestCell(delta: number, size: number): number {
  const half = Math.trunc(size / 2);
  return delta >= 0 ? Math.trunc((delta + half) / size) : Math.trunc((delta - half + 1) / size);
}

class PentominoPiece extends DisplayObject {
  view8 = 0;
  anchored = false;
  cell: Cell | null = null;
  home: [number, number, number, number] | null = null;
  private readonly flip = new Container();
  private readonly sprite = new Sprite(Texture.EMPTY);
  private hold: [number, number] | null = null;
  /** The tool the piece was last turned by, until it leaves both tools (one turn per visit). */
  private overTool = false;

  constructor(
    engine: GameEngine,
    private readonly game: RPentominoGame,
    readonly index: number,
    graphicId: number
  ) {
    super(engine, 'RPentominoPiece');
    this.sprite.anchor.set(0.5);
    this.flip.addChild(this.sprite);
    this.view.addChild(this.flip);
    void engine.loadAseq(graphicId).then((loaded) => {
      if (loaded && !this.destroyed) this.sprite.texture = loaded.frames[0] ?? Texture.EMPTY;
    });
    this.setView(0);
  }

  cells(): Cell[] {
    return viewCells(this.index, this.view8);
  }

  /** Size in cells in the current view. */
  size(): [number, number] {
    const cells = this.cells();
    return [Math.max(...cells.map((c) => c[0])) + 1, Math.max(...cells.map((c) => c[1])) + 1];
  }

  setView(view: number) {
    this.view8 = ((view % 8) + 8) % 8;
    const [w, h] = this.size();
    const { cellW, cellH } = this.game;
    this.sprite.rotation = ((this.view8 & 3) * Math.PI) / 2;
    this.flip.scale.x = this.view8 >= 4 ? -1 : 1;
    this.flip.position.set((w * cellW) / 2, (h * cellH) / 2);
  }

  goHome() {
    if (!this.home) return;
    const [w, h] = this.size();
    const [x1, , x2, y2] = this.home;
    this.view.position.set(x1 + Math.trunc((x2 - x1 - w * this.game.cellW) / 2), y2 - h * this.game.cellH);
  }

  onPointerDown(x: number, y: number): void {
    if (this.anchored || !this.game.piecesVisible) return;
    this.hold = [x - this.view.x, y - this.view.y];
    this.overTool = false;
    this.game.pickUp(this);
  }

  onPointerMove(x: number, y: number): void {
    if (!this.hold) return;
    this.view.position.set(Math.round(x - this.hold[0]), Math.round(y - this.hold[1]));
    const tool = this.game.toolUnder(this);
    if (tool && !this.overTool) {
      this.overTool = true;
      // turn about the piece's middle so it stays under the pointer
      const [w, h] = this.size();
      const cx = this.view.x + (w * this.game.cellW) / 2;
      const cy = this.view.y + (h * this.game.cellH) / 2;
      this.game.turn(this, tool);
      const [w2, h2] = this.size();
      this.view.position.set(Math.round(cx - (w2 * this.game.cellW) / 2), Math.round(cy - (h2 * this.game.cellH) / 2));
      this.hold = [x - this.view.x, y - this.view.y];
    } else if (!tool) {
      this.overTool = false;
    }
  }

  onPointerUp(): void {
    if (!this.hold) return;
    this.hold = null;
    this.game.drop(this);
  }
}

/**
 * CMA's pentomino board, following 4THADV32.EXE's RPentominoGame: `x, y, z`.
 * The script gives the grid (cellsH/V, cellWidth/Height), the target shape
 * (`setSolutionString row, "--XX.."`, drawn by `stamp` with solutionBoxGraphicID),
 * the twelve pieces (pieceGraphicID n, setPieceHomeBox n, x1, y1, x2, y2) and
 * optional tools: dragging a piece over flipperGraphicID mirrors it, over
 * rotaterGraphicID turns it a quarter clockwise. A dropped piece snaps to the
 * nearest cells if they are on the board and free, otherwise it goes home.
 * `solved` fires when the covered cells are exactly the target's.
 */
export class RPentominoGame extends DisplayObject {
  cellsH = 20;
  cellsV = 20;
  cellW = 14;
  cellH = 14;
  piecesVisible = true;
  private readonly board = new Container();
  private readonly stamps = new Container();
  private solution: string[] = [];
  private occupied = new Set<string>();
  private readonly pieces: (PentominoPiece | null)[] = new Array(12).fill(null);
  private readonly tools: { flipper: Sprite | null; rotater: Sprite | null } = { flipper: null, rotater: null };
  private solutionBoxId = -1;
  private readonly sounds = { goHome: -1, pickedUp: -1, snapped: -1, flipped: -1, rotated: -1 };

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RPentominoGame');
    const [x, y, z] = args.map((a) => toNumber(a));
    this.view.zIndex = z ?? 0;
    this.board.position.set(x ?? 0, y ?? 0);
    this.board.addChild(this.stamps);
    this.view.addChild(this.board);
    this.touchy = false;
  }

  containsPoint(): boolean {
    return false;
  }

  private key(x: number, y: number) {
    return `${x},${y}`;
  }

  private piece(n: Value | undefined): PentominoPiece | null {
    return this.pieces[toNumber(n) - 1] ?? null;
  }

  private play(id: number) {
    if (id > 0) this.engine.playSound(id);
  }

  /** Board cells a piece would cover at a cell, or null if it doesn't fit on the board. */
  private footprint(piece: PentominoPiece, cx: number, cy: number): string[] | null {
    const [w, h] = piece.size();
    if (cx < 0 || cy < 0 || cx + w > this.cellsH || cy + h > this.cellsV) return null;
    return piece.cells().map(([x, y]) => this.key(cx + x, cy + y));
  }

  private lift(piece: PentominoPiece) {
    if (!piece.cell) return;
    const cells = this.footprint(piece, piece.cell[0], piece.cell[1]) ?? [];
    for (const k of cells) this.occupied.delete(k);
    piece.cell = null;
  }

  private place(piece: PentominoPiece, cx: number, cy: number) {
    for (const k of this.footprint(piece, cx, cy) ?? []) this.occupied.add(k);
    piece.cell = [cx, cy];
    piece.view.position.set(this.board.x + cx * this.cellW, this.board.y + cy * this.cellH);
    piece.view.zIndex = this.view.zIndex + 1;
    if (this.isSolved()) this.fire('solved');
  }

  private isSolved(): boolean {
    for (let y = 0; y < this.cellsV; y++) {
      for (let x = 0; x < this.cellsH; x++) {
        if ((this.solution[y]?.[x] === 'X') !== this.occupied.has(this.key(x, y))) return false;
      }
    }
    return true;
  }

  pickUp(piece: PentominoPiece) {
    this.lift(piece);
    piece.view.zIndex = this.view.zIndex + 50;
    this.play(this.sounds.pickedUp);
    this.fire('piecePickedUp');
  }

  drop(piece: PentominoPiece) {
    piece.view.zIndex = this.view.zIndex + 1;
    const cx = nearestCell(piece.view.x - this.board.x, this.cellW);
    const cy = nearestCell(piece.view.y - this.board.y, this.cellH);
    const cells = this.footprint(piece, cx, cy);
    if (cells && cells.every((k) => !this.occupied.has(k))) {
      this.play(this.sounds.snapped);
      this.place(piece, cx, cy);
      return;
    }
    piece.goHome();
    this.play(this.sounds.goHome);
  }

  toolUnder(piece: PentominoPiece): 'flipper' | 'rotater' | null {
    const b = piece.view.getBounds();
    for (const name of ['flipper', 'rotater'] as const) {
      const tool = this.tools[name];
      if (!tool || !tool.visible) continue;
      const t = tool.getBounds();
      if (b.minX < t.maxX && b.maxX > t.minX && b.minY < t.maxY && b.maxY > t.minY) return name;
    }
    return null;
  }

  turn(piece: PentominoPiece, tool: 'flipper' | 'rotater') {
    if (tool === 'flipper') {
      piece.setView(piece.view8 + 4);
      this.play(this.sounds.flipped);
      return;
    }
    // quarter turn clockwise: up through 0-3, down through the mirrored 7-4
    const v = piece.view8;
    piece.setView(v < 4 ? (v + 1) % 4 : v === 4 ? 7 : v - 1);
    this.play(this.sounds.rotated);
  }

  private setTool(name: 'flipper' | 'rotater', id: number) {
    this.tools[name]?.destroy();
    this.tools[name] = null;
    if (id <= 0) return;
    const sprite = new Sprite(Texture.EMPTY);
    const [x, y] = this.engine.originOf(id) ?? [0, 0];
    sprite.position.set(x, y);
    this.view.addChild(sprite);
    this.tools[name] = sprite;
    void this.engine.loadAseq(id).then((loaded) => {
      if (loaded && !sprite.destroyed) sprite.texture = loaded.frames[0] ?? Texture.EMPTY;
    });
  }

  private stamp() {
    this.unstamp();
    if (this.solutionBoxId <= 0) return;
    void this.engine.loadAseq(this.solutionBoxId).then((loaded) => {
      if (!loaded || this.destroyed) return;
      this.unstamp();
      this.solution.forEach((row, y) =>
        [...row].forEach((ch, x) => {
          if (ch !== 'X') return;
          const box = new Sprite(loaded.frames[0] ?? Texture.EMPTY);
          box.position.set(x * this.cellW, y * this.cellH);
          this.stamps.addChild(box);
        })
      );
    });
  }

  private unstamp() {
    for (const child of this.stamps.removeChildren()) child.destroy();
  }

  getProp(name: string, key: Value | undefined): Value {
    const piece = this.piece(key);
    switch (name.toLowerCase()) {
      case 'cellsh': return this.cellsH;
      case 'cellsv': return this.cellsV;
      case 'cellwidth': return this.cellW;
      case 'cellheight': return this.cellH;
      case 'piecesvisible': return this.piecesVisible ? 1 : 0;
      case 'pieceview': return piece?.view8 ?? 0;
      case 'pieceisanchored': return piece?.anchored ? 1 : 0;
      case 'piececellx': return piece?.cell ? piece.cell[0] : ''; // "" while off the board
      case 'piececelly': return piece?.cell ? piece.cell[1] : '';
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    const n = toNumber(value);
    const piece = this.piece(key);
    switch (name.toLowerCase()) {
      case 'cellsh': this.cellsH = n; return;
      case 'cellsv': this.cellsV = n; return;
      case 'cellwidth': this.cellW = n; return;
      case 'cellheight': this.cellH = n; return;
      case 'piecegraphicid': {
        const i = toNumber(key) - 1;
        if (i < 0 || i >= 12) return;
        this.pieces[i]?.destroy();
        const created = new PentominoPiece(this.engine, this, i, n);
        created.view.zIndex = this.view.zIndex + 1;
        this.pieces[i] = created;
        return;
      }
      case 'pieceview':
        if (!piece) return;
        if (piece.cell) {
          const [cx, cy] = piece.cell;
          this.lift(piece);
          piece.setView(n);
          const cells = this.footprint(piece, cx, cy);
          if (cells && cells.every((k) => !this.occupied.has(k))) this.place(piece, cx, cy);
          else piece.goHome();
        } else {
          piece.setView(n);
          piece.goHome();
        }
        return;
      case 'pieceisanchored':
        if (piece) piece.anchored = truthy(value);
        return;
      case 'piecesvisible':
        this.piecesVisible = truthy(value);
        for (const p of this.pieces) if (p) p.view.visible = this.piecesVisible;
        return;
      case 'solutionboxgraphicid': this.solutionBoxId = n; return;
      case 'rotatergraphicid': this.setTool('rotater', n); return;
      case 'flippergraphicid': this.setTool('flipper', n); return;
      case 'piecegohomesoundid': this.sounds.goHome = n; return;
      case 'piecepickedupsoundid': this.sounds.pickedUp = n; return;
      case 'piecesnappedsoundid': this.sounds.snapped = n; return;
      case 'pieceflippedsoundid': this.sounds.flipped = n; return;
      case 'piecerotatedsoundid': this.sounds.rotated = n; return;
      case 'piecegrabaocursorid':
      case 'piecespotaocursorid':
        return;
      default:
        super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'setsolutionstring':
        this.solution[toNumber(args[0]) - 1] = toText(args[1] ?? '');
        return 0;
      case 'stamp':
        this.stamp();
        return 0;
      case 'unstamp':
        this.unstamp();
        return 0;
      case 'setpiecehomebox': {
        const piece = this.piece(args[0]);
        if (!piece) return 0;
        piece.home = [toNumber(args[1]), toNumber(args[2]), toNumber(args[3]), toNumber(args[4])];
        if (!piece.cell) piece.goHome();
        return 0;
      }
      case 'setpiececellxy': {
        const piece = this.piece(args[0]);
        if (!piece) return 0;
        this.lift(piece);
        this.place(piece, toNumber(args[1]), toNumber(args[2]));
        return 0;
      }
      case 'reset': // loose pieces go home
        for (const p of this.pieces) {
          if (!p || p.anchored) continue;
          this.lift(p);
          p.goHome();
        }
        return 0;
      default:
        return super.send(method, args);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    for (const p of this.pieces) p?.destroy();
    super.destroy();
  }
}
