import { Graphics, Sprite, Texture } from 'pixi.js';
import type { Value } from './ScriptVm';
import { toNumber } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';

/** The open backpack image in COMMON.RSC. */
const BAG_ID = 20;
const BAG_W = 180;
const BAG_H = 201;
const COLS = 4;
const ROWS = 3;
/** The bag's interior in that image, where the 12 slots are laid out (measured, not from game data). */
const INNER = { x: 16, y: 46, w: 148, h: 132 };
const SLOT_W = INNER.w / COLS;
const SLOT_H = INNER.h / ROWS;
const PICK_UP_SFX = 30525; // kItemPickUpSfxID

/**
 * The open backpack, showing the player's 12 item slots (WorldState).
 * An item dragged out and released outside the bag fires `objectDropped`
 * with droppedObjectID/Index/X/Y/W/H; the script takes it with
 * `removeObject index`, otherwise it goes back. Clicking the bag closes it.
 */
export class RBackPack extends DisplayObject {
  private readonly slots: Sprite[] = [];
  private readonly shown: number[] = [];
  private drag: { index: number; sprite: Sprite } | null = null;
  private pressedBag = false;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RBackPack');
    this.view.position.set(toNumber(args[0]), toNumber(args[1]));
    this.view.zIndex = toNumber(args[2]);
    const bag = new Sprite(Texture.EMPTY);
    // transparent area so the bag has its full bounds before the image loads
    this.view.addChild(new Graphics().rect(0, 0, BAG_W, BAG_H).fill({ color: 0, alpha: 0 }), bag);
    void engine.loadAseq(BAG_ID).then((loaded) => {
      if (loaded && !this.destroyed) bag.texture = loaded.frames[0];
    });
    for (let i = 0; i < COLS * ROWS; i++) {
      const sprite = new Sprite(Texture.EMPTY);
      sprite.anchor.set(0.5);
      sprite.position.set(INNER.x + SLOT_W * ((i % COLS) + 0.5), INNER.y + SLOT_H * (Math.floor(i / COLS) + 0.5));
      this.slots.push(sprite);
      this.shown.push(0);
      this.view.addChild(sprite);
    }
    this.refresh();
  }

  private refresh() {
    this.engine.world.backpack().forEach((id, i) => {
      if (this.shown[i] === id) return;
      this.shown[i] = id;
      const sprite = this.slots[i];
      sprite.texture = Texture.EMPTY;
      if (!id) return;
      void this.engine.loadAseq(toNumber(this.engine.lookupVar(`objectAOIDs.${id}`))).then((loaded) => {
        if (loaded && !this.destroyed && this.shown[i] === id) sprite.texture = loaded.frames[0];
      });
    });
  }

  /** The occupied slot under a stage point, or -1. */
  private slotAt(x: number, y: number): number {
    const lx = x - this.view.x - INNER.x;
    const ly = y - this.view.y - INNER.y;
    if (lx < 0 || ly < 0 || lx >= INNER.w || ly >= INNER.h) return -1;
    const i = Math.floor(ly / SLOT_H) * COLS + Math.floor(lx / SLOT_W);
    return this.shown[i] ? i : -1;
  }

  private insideBag(x: number, y: number): boolean {
    const lx = x - this.view.x;
    const ly = y - this.view.y;
    return lx >= 0 && ly >= 0 && lx < BAG_W && ly < BAG_H;
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'addobject': {
        const slot = this.engine.world.backpackAdd(toNumber(args[0]));
        this.refresh();
        return slot;
      }
      case 'removeobject':
        this.engine.world.backpackRemove(toNumber(args[0]));
        this.refresh();
        return 0;
      default:
        return super.send(method, args);
    }
  }

  containsPoint(x: number, y: number): boolean {
    return this.view.visible && !this.destroyed && this.insideBag(x, y);
  }

  onPointerDown(x: number, y: number): void {
    const index = this.slotAt(x, y);
    if (index < 0) {
      this.pressedBag = true;
      return;
    }
    const slot = this.slots[index];
    const sprite = new Sprite(slot.texture);
    sprite.anchor.set(0.5);
    this.view.addChild(sprite);
    slot.visible = false;
    this.drag = { index, sprite };
    this.onPointerMove(x, y);
    this.engine.playSound(PICK_UP_SFX);
  }

  onPointerMove(x: number, y: number): void {
    this.drag?.sprite.position.set(Math.round(x - this.view.x), Math.round(y - this.view.y));
  }

  onPointerUp(x: number, y: number): void {
    const drag = this.drag;
    this.drag = null;
    if (drag) {
      const { index, sprite } = drag;
      const bounds = sprite.getBounds();
      sprite.destroy();
      this.slots[index].visible = true;
      if (!this.insideBag(x, y)) {
        this.props.set('droppedobjectid', this.shown[index]);
        this.props.set('droppedobjectindex', index);
        this.props.set('droppedobjectx', Math.round(bounds.x));
        this.props.set('droppedobjecty', Math.round(bounds.y));
        this.props.set('droppedobjectw', Math.round(bounds.width));
        this.props.set('droppedobjecth', Math.round(bounds.height));
        this.fire('objectDropped');
      }
      if (!this.destroyed) this.refresh();
      return;
    }
    if (this.pressedBag && this.insideBag(x, y)) {
      this.fire('closed');
      this.destroy();
    }
    this.pressedBag = false;
  }
}
