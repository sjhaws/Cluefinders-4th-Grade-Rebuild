/**
 * Virtual machine for the game's compiled scripts (.MPS), running the JSON
 * produced by extractor/disassemble_scripts.py. See extractor/MPS_FORMAT.md.
 *
 * Engine objects and global functions live outside the VM behind `ScriptHost`.
 */

export interface ScriptConstant {
  kind: number; // 0 name, 1 literal, 2 member access, 3 substring form, 4 expression
  type: number; // 0 none, 2 string, 3 integer, 4 float
  text: string;
  value?: number | string;
  extra?: string;
  refs?: number[];
}

export interface ScriptRecord {
  op: number;
  m: string;
  args?: number[];
  target?: number;
}

export interface ScriptJson {
  name: string;
  records: ScriptRecord[];
  constants: Record<string, ScriptConstant>;
}

export interface LabelRef {
  label: number;
  name: string;
}

export interface EngineObject {
  readonly className: string;
  getProp(name: string, key: Value | undefined): Value;
  setProp(name: string, key: Value | undefined, value: Value): void;
  send(method: string, args: Value[]): Value;
  destroy(): void;
  /** The variable the object was created into (its `name` property). */
  varName?: string;
}

export type Value = number | string | LabelRef | EngineObject | null;

export interface ScriptHost {
  isClass(name: string): boolean;
  createObject(className: string, args: Value[], vm: ScriptVm): EngineObject;
  callGlobal(name: string, args: Value[], vm: ScriptVm): Value;
  loadScript(name: string): void;
  exitGame(): void;
  warn(message: string): void;
}

const BUILTIN_SELF = 1;
const BUILTIN_RESULT = 2;
const MAX_STEPS_PER_RUN = 1_000_000;

export function isLabel(v: Value | undefined): v is LabelRef {
  return typeof v === 'object' && v !== null && 'label' in v;
}

export function isEngineObject(v: Value | undefined): v is EngineObject {
  return typeof v === 'object' && v !== null && 'className' in v;
}

function isNumeric(v: Value | undefined): boolean {
  if (typeof v === 'number') return true;
  return typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v);
}

export function toNumber(v: Value | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v); // leading number, like the original's string-to-number conversion
    return Number.isFinite(n) ? n : 0;
  }
  if (isLabel(v)) return v.label;
  return v ? 1 : 0;
}

export function toText(v: Value | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (isLabel(v)) return v.name;
  return v.className;
}

export function truthy(v: Value | undefined): boolean {
  if (typeof v === 'string' && !isNumeric(v)) return v !== '';
  return toNumber(v) !== 0;
}

/** Thrown to unwind every running frame when the VM switches script or exits. */
class Halt extends Error {}

export class ScriptVm {
  /** Value of the last call_global or send; also readable as RESULT. */
  result: Value = 0;
  running = true;

  private readonly records: ScriptRecord[];
  private readonly constants = new Map<number, ScriptConstant>();
  private readonly named = new Map<string, Value>();
  private readonly vars = new Map<string, Value>();
  private readonly subEnd = new Map<number, number>();
  private readonly freshLoops = new Set<number>();
  private cond = false;

  constructor(
    readonly script: ScriptJson,
    private readonly host: ScriptHost
  ) {
    this.records = script.records;
    for (const [index, c] of Object.entries(script.constants)) {
      this.constants.set(Number(index), c);
      if (c.kind === 0 && c.type !== 0) this.named.set(c.text.toLowerCase(), this.constantValue(c));
    }
    this.records.forEach((rec, i) => {
      if (rec.m !== 'sub') return;
      let j = i + 1;
      while (j < this.records.length && this.records[j].m !== 'return') j++;
      this.subEnd.set(i, j);
    });
  }

  /** Runs the script body from the first record. */
  start(): void {
    this.execute(0, null);
  }

  /** Runs an event handler (a subroutine label) with `$1` bound to the event source. */
  invoke(handler: Value, self: EngineObject | null): void {
    if (!this.running || !isLabel(handler)) return;
    this.execute(handler.label + 1, self);
  }

  /**
   * A variable name given as a string may still name keys by variable:
   * `addAnswer "answers.i"` means answers.<current i>. Non-numeric parts after
   * the first are replaced by the value of a variable of that name, if set.
   */
  resolveName(name: string): string {
    if (!name.includes('.')) return name;
    const [base, ...keys] = name.split('.');
    const resolved = keys.map((key) => {
      if (/^-?\d+$/.test(key)) return key;
      const k = key.toLowerCase();
      return this.vars.has(k) ? toText(this.vars.get(k)!) : key;
    });
    return [base, ...resolved].join('.');
  }

  getVar(name: string): Value {
    const key = name.toLowerCase();
    if (key === 'result') return this.result;
    if (key === 'system') return 'WIN';
    if (this.vars.has(key)) return this.vars.get(key)!;
    if (this.named.has(key)) return this.named.get(key)!;
    if (this.host.isClass(name)) return name; // e.g. `send sQueue, add, SoundAction, ...`
    // Unquoted literals: OWS2 passes the period's attribute as `Z` and fonts as `Chicago`.
    // Script variables are camelCase, so only capitalised names read as their own text.
    if (/^[A-Z]/.test(name)) return name;
    return 0;
  }

  /**
   * Object variables are counted references (OMLinkToObj in the EXE): an
   * object no variable holds any more is deleted, e.g. `set openBackpack, 0`
   * closes the backpack.
   */
  setVar(name: string, value: Value): void {
    const key = name.toLowerCase();
    const old = this.vars.get(key);
    this.vars.set(key, value);
    if (isEngineObject(old) && old !== value) {
      for (const v of this.vars.values()) if (v === old) return;
      old.destroy();
    }
  }

  /** Stops all execution, e.g. before switching to another script. */
  halt(): void {
    this.running = false;
  }

  private execute(pc: number, self: EngineObject | null): void {
    const stack: number[] = [];
    let steps = 0;
    try {
      while (this.running && pc >= 0 && pc < this.records.length) {
        if (++steps > MAX_STEPS_PER_RUN) {
          this.host.warn(`${this.script.name}: gave up after ${MAX_STEPS_PER_RUN} steps (infinite loop?) at ${pc}`);
          return;
        }
        const rec = this.records[pc];
        const args = rec.args ?? [];
        const ctx = { self };
        let next = pc + 1;
        switch (rec.m) {
          case 'start':
          case 'end':
            break;
          case 'sub':
            next = (this.subEnd.get(pc) ?? pc) + 1; // skip the body when reached in sequence
            break;
          case 'return':
            if (stack.length === 0) return;
            next = stack.pop()!;
            break;
          case 'call': {
            let target = this.value(args[0], ctx);
            // `set finishedEvent, "eWalkIn"` then `call finishedEvent`: a label by name
            if (typeof target === 'string') target = this.named.get(target.toLowerCase()) ?? target;
            if (!isLabel(target)) {
              this.host.warn(`${this.script.name}:${pc} call to non-label ${toText(target)}`);
              break;
            }
            const params = this.records[target.label]?.args?.slice(1) ?? [];
            const values = args.slice(1).map((a) => this.value(a, ctx));
            params.forEach((p, i) => this.assign(p, values[i] ?? 0, ctx));
            stack.push(pc + 1);
            next = target.label + 1;
            break;
          }
          case 'if':
            this.cond = truthy(this.value(args[0], ctx));
            break;
          case 'jump_if_false':
            if (!this.cond) next = rec.target!;
            break;
          case 'jump':
            next = rec.target!;
            break;
          case 'loop':
            if (args.length >= 3) {
              this.assign(args[0], toNumber(this.value(args[1], ctx)), ctx);
              this.freshLoops.add(pc);
            }
            break;
          case 'loop_test':
            if (args.length >= 3) {
              // `loop var, from, to[, step]`: a negative step counts down
              const name = this.nameOf(args[0]);
              const step = args.length >= 4 ? toNumber(this.value(args[3], ctx)) : 1;
              if (this.freshLoops.has(pc - 1)) this.freshLoops.delete(pc - 1);
              else this.setVar(name, toNumber(this.getVar(name)) + step);
              const value = toNumber(this.getVar(name));
              const end = toNumber(this.value(args[2], ctx));
              this.cond = step < 0 ? value >= end : value <= end;
            } else {
              this.cond = truthy(this.value(args[0], ctx));
            }
            break;
          case 'set':
            this.doSet(args, ctx);
            break;
          case 'delete': {
            const obj = this.value(args[0], ctx);
            if (isEngineObject(obj)) obj.destroy();
            this.assign(args[0], 0, ctx);
            break;
          }
          case 'call_global':
            this.result = this.host.callGlobal(
              this.nameOf(args[0]),
              args.slice(1).map((a) => this.value(a, ctx)),
              this
            );
            break;
          case 'send': {
            const obj = this.value(args[0], ctx);
            const method = this.nameOf(args[1]);
            if (isEngineObject(obj)) {
              this.result = obj.send(method, args.slice(2).map((a) => this.value(a, ctx))) ?? 0;
            } else {
              this.host.warn(`${this.script.name}:${pc} send ${method} to non-object ${this.nameOf(args[0])}`);
              this.result = 0;
            }
            break;
          }
          case 'set_prop':
          case 'get_prop': {
            const obj = this.value(args[0], ctx);
            const prop = this.nameOf(args[1]);
            // keys sit between the property name and the value: `currentDataset, "CWS1", level, var`
            const keys = args.slice(2, -1).map((a) => this.value(a, ctx));
            const key = keys.length === 0 ? undefined : keys.length === 1 ? keys[0] : keys.map(toText).join('.');
            const last = args[args.length - 1];
            if (!isEngineObject(obj)) {
              this.host.warn(`${this.script.name}:${pc} ${rec.m} ${prop} on non-object ${this.nameOf(args[0])}`);
              if (rec.m === 'get_prop') this.assign(last, 0, ctx);
              break;
            }
            if (rec.m === 'set_prop') obj.setProp(prop, key, this.value(last, ctx));
            else this.assign(last, obj.getProp(prop, key) ?? 0, ctx);
            break;
          }
          case 'load_script':
            this.running = false;
            this.host.loadScript(toText(this.value(args[0], ctx)));
            throw new Halt();
          case 'exit':
            this.running = false;
            this.host.exitGame();
            throw new Halt();
          default:
            this.host.warn(`${this.script.name}:${pc} unhandled ${rec.m}`);
        }
        pc = next;
      }
    } catch (err) {
      if (!(err instanceof Halt)) throw err;
    }
  }

  private doSet(args: number[], ctx: { self: EngineObject | null }): void {
    const second = this.constants.get(args[1]);
    if (second && second.kind === 0 && second.type === 0 && this.host.isClass(second.text)) {
      const ctorArgs = args.slice(2).map((a) => this.value(a, ctx));
      const obj = this.host.createObject(second.text, ctorArgs, this);
      const target = this.constants.get(args[0]);
      if (target?.kind === 0) obj.varName = target.text;
      else if (target?.kind === 2) obj.varName = this.memberName(target, ctx);
      this.assign(args[0], obj, ctx);
      return;
    }
    this.assign(args[0], this.value(args[1], ctx), ctx);
  }

  /** Identifier text for name positions (property, method, function names); other constants evaluate. */
  private nameOf(index: number): string {
    const c = this.constants.get(index);
    if (c && c.kind === 0 && c.type === 0) return c.text;
    return toText(this.value(index, { self: null }));
  }

  private assign(index: number, value: Value, ctx: { self: EngineObject | null }): void {
    const c = this.constants.get(index);
    if (!c) return;
    if (c.kind === 0) this.setVar(c.text, value);
    else if (c.kind === 2) this.setVar(this.memberName(c, ctx), value);
    else this.host.warn(`${this.script.name}: cannot assign to ${c.text}`);
  }

  /**
   * `base.key1.key2` names a variable by value: "button.buttonNumber" with
   * buttonNumber = 3 is the variable "button.3". The base is literal text;
   * refs hold only the keys.
   */
  private memberName(c: ScriptConstant, ctx: { self: EngineObject | null }): string {
    const base = c.text.split('.')[0];
    return [base, ...(c.refs ?? []).map((k) => toText(this.value(k, ctx)))].join('.');
  }

  private constantValue(c: ScriptConstant): Value {
    if (c.type === 3) {
      if (c.kind === 0 && c.extra?.startsWith('+')) return { label: Number(c.value), name: c.text };
      // A number with text after it stays text, e.g. OWS3's answer "8 miles S" (value 8).
      if (c.kind === 0 && c.extra !== undefined && !/^\s*-?\d+(\.\d+)?\s*$/.test(c.extra)) return c.extra;
      return Number(c.value);
    }
    if (c.type === 4) return parseFloat(String(c.kind === 0 ? c.extra : c.value));
    if (c.type === 2) {
      if (c.kind === 0) return c.extra ?? '';
      return c.text.replace(/^"(.*)"$/s, '$1');
    }
    return 0;
  }

  value(index: number, ctx: { self: EngineObject | null }): Value {
    if (index === BUILTIN_SELF) return ctx.self;
    if (index === BUILTIN_RESULT) return this.result;
    const c = this.constants.get(index);
    if (!c) return 0;
    switch (c.kind) {
      case 0:
        return c.type === 0 ? this.getVar(c.text) : this.constantValue(c);
      case 1:
        return this.constantValue(c);
      case 2:
        return this.getVar(this.memberName(c, ctx));
      case 3: {
        const [s, start, length] = (c.refs ?? []).map((r) => this.value(r, ctx));
        const text = toText(s);
        const from = Math.max(0, toNumber(start) - 1);
        return length === undefined ? text.slice(from) : text.substr(from, Math.max(0, toNumber(length)));
      }
      case 4:
        return this.evalCompiled(c, ctx);
      default:
        return 0;
    }
  }

  /**
   * Evaluates a compiled expression. Read right-to-left it is a postfix
   * program: `t` pushes the next ref (refs in order), `z` pushes "none",
   * an operator pops right then left, `s` is a no-op marker.
   * e.g. "(key@chars)-1" compiles to "s-ts@tt" with refs [key, chars, 1].
   */
  private evalCompiled(c: ScriptConstant, ctx: { self: EngineObject | null }): Value {
    const code = c.extra ?? '';
    const refs = c.refs ?? [];
    const stack: (Value | undefined)[] = [];
    let ref = 0;
    for (let i = code.length - 1; i >= 0; i--) {
      const ch = code[i];
      if (ch === 's') continue;
      if (ch === 't') {
        stack.push(this.value(refs[ref++], ctx));
      } else if (ch === 'z') {
        stack.push(undefined);
      } else if (ch === '~') { // length of the text, e.g. OWS3's `(~answerText)`, OWS1's `(~t1)`
        stack.push(toText(stack.pop()).length);
      } else {
        const right = stack.pop();
        const left = stack.pop();
        stack.push(applyOperator(ch, left, right));
      }
    }
    if (stack.length !== 1) this.host.warn(`${this.script.name}: bad compiled expression ${code} for ${c.text}`);
    return stack[stack.length - 1] ?? 0;
  }
}

function applyOperator(op: string, a: Value | undefined, b: Value | undefined): Value {
  if (a === undefined) return op === '-' ? -toNumber(b) : toNumber(b); // unary: left operand is "none"
  switch (op) {
    case '+':
      return isNumeric(a) && isNumeric(b) ? toNumber(a) + toNumber(b) : toText(a) + toText(b);
    case '-':
      return toNumber(a) - toNumber(b);
    case '*':
      return toNumber(a) * toNumber(b);
    case '/': { // real division: OWS1 shows v/100 as "3.5 in."; scripts write \ for whole numbers
      const d = toNumber(b);
      return d === 0 ? 0 : toNumber(a) / d;
    }
    case '\\': {
      const d = toNumber(b);
      return d === 0 ? 0 : Math.trunc(toNumber(a) / d);
    }
    case '%': {
      const d = toNumber(b);
      return d === 0 ? 0 : toNumber(a) % d;
    }
    case '=':
      return equal(a, b) ? 1 : 0;
    case '#':
      return equal(a, b) ? 0 : 1;
    case '<':
      return toNumber(a) < toNumber(b) ? 1 : 0;
    case '>':
      return toNumber(a) > toNumber(b) ? 1 : 0;
    case '@': // 1-based position of a within b, 0 if absent
      return toText(b).indexOf(toText(a)) + 1;
    default:
      return 0;
  }
}

function equal(a: Value | undefined, b: Value | undefined): boolean {
  if (isEngineObject(a) || isEngineObject(b)) return a === b;
  if (isNumeric(a) && isNumeric(b)) return toNumber(a) === toNumber(b);
  return toText(a).toLowerCase() === toText(b).toLowerCase();
}
