import type { Value } from './ScriptVm';
import { toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject, ScriptObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';

/**
 * A group of display objects that move together (the CWS4 package with its
 * labels, the Oasis boat with the kids aboard). `addTrinket "name"[, zOffset[, tag]]`;
 * setting x/y moves every member by the change, z restacks them, and
 * `removeTrinkets tag` lets go of just the members added with that tag.
 *
 * Its x/y is the top-left of all its members together. In the EXE the members
 * are its children (addTrinket VA 0x415688 calls addChild 0x414439 with the
 * zOffset and tag), and a display object's rect is the union of its
 * children's, remade on every add. OWS4 relies on it: it starts a sentence at
 * `-sentenceWidth` and stops it at `kBoxX`, the first box's left edge, while
 * the group's first member is the mouse pulling at the other end.
 */
export class OMMultiTrinket extends ScriptObject {
  private members: { name: string; dz: number; tag: number }[] = [];
  private z = 0;

  constructor(engine: GameEngine) {
    super(engine, 'OMMultiTrinket');
  }

  private objects(): { obj: DisplayObject; dz: number }[] {
    const out: { obj: DisplayObject; dz: number }[] = [];
    for (const m of this.members) {
      const obj = this.engine.lookupVar(m.name);
      if (obj instanceof DisplayObject && !obj.destroyed) out.push({ obj, dz: m.dz });
    }
    return out;
  }

  /** Left and top of the members together; a member whose image hasn't loaded counts as its position. */
  private corner(): [number, number] {
    let left = Infinity;
    let top = Infinity;
    for (const { obj } of this.objects()) {
      const b = obj.view.getBounds();
      const loaded = Number.isFinite(b.minX) && b.maxX > b.minX;
      left = Math.min(left, loaded ? b.minX : obj.view.x);
      top = Math.min(top, loaded ? b.minY : obj.view.y);
    }
    return [Number.isFinite(left) ? left : 0, Number.isFinite(top) ? top : 0];
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'x': return Math.round(this.corner()[0]);
      case 'y': return Math.round(this.corner()[1]);
      case 'z': return this.z;
      case 'width':
      case 'height': {
        const objs = this.objects();
        if (objs.length === 0) return 0;
        const bounds = objs.map(({ obj }) => obj.view.getBounds());
        return name.toLowerCase() === 'width'
          ? Math.max(...bounds.map((b) => b.maxX)) - Math.min(...bounds.map((b) => b.minX))
          : Math.max(...bounds.map((b) => b.maxY)) - Math.min(...bounds.map((b) => b.minY));
      }
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'x': {
        const dx = toNumber(value) - this.corner()[0];
        for (const { obj } of this.objects()) obj.view.x += dx;
        return;
      }
      case 'y': {
        const dy = toNumber(value) - this.corner()[1];
        for (const { obj } of this.objects()) obj.view.y += dy;
        return;
      }
      case 'z':
        this.z = toNumber(value);
        for (const { obj, dz } of this.objects()) obj.view.zIndex = this.z + dz;
        return;
      case 'touchy':
        for (const { obj } of this.objects()) obj.touchy = truthy(value);
        super.setProp(name, key, value);
        return;
      default:
        super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'addtrinket': {
        const name = toText(args[0]);
        this.members.push({ name, dz: toNumber(args[1] ?? 0), tag: toNumber(args[2] ?? 0) });
        return 0;
      }
      case 'removetrinkets': {
        // OWS4 tags its running mice 1 and swaps them for pulling mice halfway
        // in with `removeTrinkets 1`; the boxes and words must stay in the group,
        // or they stop where the swap happens while the mice carry on.
        if (args[0] === undefined) {
          this.members = [];
        } else {
          const tag = toNumber(args[0]);
          this.members = this.members.filter((m) => m.tag !== tag);
        }
        return 0;
      }
      case 'offset': // move by dx, dy (OMA's catapult)
        for (const { obj } of this.objects()) {
          obj.view.x += toNumber(args[0]);
          obj.view.y += toNumber(args[1]);
        }
        return 0;
      default:
        return super.send(method, args);
    }
  }
}
