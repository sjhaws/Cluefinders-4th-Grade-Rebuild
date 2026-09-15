import type { Value } from './ScriptVm';
import { toNumber, toText, truthy } from './ScriptVm';
import { DisplayObject, ScriptObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';

/**
 * A group of display objects that move together (the CWS4 package with its
 * labels, the Oasis boat with the kids aboard). `addTrinket "name"[, zOffset]`;
 * setting x/y moves every member by the change, z restacks them.
 */
export class OMMultiTrinket extends ScriptObject {
  private members: { name: string; dz: number }[] = [];
  private x = 0;
  private y = 0;
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

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'x': return this.x;
      case 'y': return this.y;
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
        const dx = toNumber(value) - this.x;
        for (const { obj } of this.objects()) obj.view.x += dx;
        this.x = toNumber(value);
        return;
      }
      case 'y': {
        const dy = toNumber(value) - this.y;
        for (const { obj } of this.objects()) obj.view.y += dy;
        this.y = toNumber(value);
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
        const obj = this.engine.lookupVar(name);
        if (this.members.length === 0 && obj instanceof DisplayObject) {
          // the group's position is its first member's
          this.x = obj.view.x;
          this.y = obj.view.y;
        }
        this.members.push({ name, dz: toNumber(args[1] ?? 0) });
        return 0;
      }
      case 'removetrinkets':
        this.members = [];
        return 0;
      default:
        return super.send(method, args);
    }
  }
}
