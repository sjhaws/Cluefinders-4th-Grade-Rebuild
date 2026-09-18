window.cf = (() => {
  const E = () => window.cf4Engine;
  const canvas = () => E().app.canvas;
  const W = 640, H = 480;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  function toClient(x, y) {
    const r = canvas().getBoundingClientRect();
    return { x: r.left + x * r.width / W, y: r.top + y * r.height / H };
  }
  function ev(type, x, y) {
    const p = toClient(x, y);
    const e = new PointerEvent(type, {
      clientX: p.x, clientY: p.y, bubbles: true, cancelable: true,
      pointerId: 1, isPrimary: true, pointerType: 'mouse',
      button: 0, buttons: type === 'pointerup' ? 0 : 1,
    });
    (type === 'pointerdown' ? canvas() : window).dispatchEvent(e);
  }
  async function click(x, y) { ev('pointerdown', x, y); await sleep(70); ev('pointerup', x, y); await sleep(200); }
  async function drag(x1, y1, x2, y2, steps = 8) {
    ev('pointerdown', x1, y1); await sleep(60);
    for (let i = 1; i <= steps; i++) { ev('pointermove', x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); await sleep(25); }
    ev('pointerup', x2, y2); await sleep(250);
  }
  async function key(k) { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await sleep(120); }
  async function type(s) { for (const ch of s) await key(ch); }
  function all() {
    const out = [];
    for (const b of E().objects) {
      if (!b || !b.className) continue;
      const rec = { o: b, cls: b.className, name: b.varName || '', vis: true, x: 0, y: 0, w: 0, h: 0, cx: 0, cy: 0 };
      if (b.view) {
        const r = b.view.getBounds();
        Object.assign(rec, {
          x: Math.round(r.minX), y: Math.round(r.minY),
          w: Math.round(r.maxX - r.minX), h: Math.round(r.maxY - r.minY),
          cx: Math.round((r.minX + r.maxX) / 2), cy: Math.round((r.minY + r.maxY) / 2),
          vis: b.view.visible, alpha: Math.round(b.view.worldAlpha * 100) / 100, touchy: b.touchy !== false,
        });
      }
      out.push(rec);
    }
    return out;
  }
  const slim = (r) => ({ cls: r.cls, name: r.name, x: r.x, y: r.y, w: r.w, h: r.h, cx: r.cx, cy: r.cy, vis: r.vis, touchy: r.touchy });
  function find(re) { return all().filter(r => new RegExp(re, 'i').test(r.cls)); }
  function script() {
    const el = document.getElementById('game-status');
    const m = el && /Running (\S+)\.MPS/.exec(el.textContent || '');
    return m ? m[1] : '?';
  }
  function state() {
    const e = E();
    return { script: script(), log: e.log.length, warns: e.log.slice(0, 5),
             objs: all().filter(r => r.vis && r.w > 0).map(slim) };
  }
  function brief() { const s = state(); return { script: s.script, log: s.log, warns: s.warns, n: s.objs.length }; }
  return { E, click, drag, key, type, all, find, slim, state, brief, script, sleep, toClient };
})();

window.cfx = (() => {
  const E = () => window.cf4Engine;
  const SCRIPT = /^(C|O|P)(LOC|WS|HUB|BA|MA)[0-9A-B]*$/;
  function vars(re) {
    const out = {};
    for (const [k, v] of E().vm.vars) if (!re || new RegExp(re, 'i').test(k)) out[k] = v;
    return out;
  }
  function dests() {
    const out = {};
    for (const [k, v] of E().vm.vars) if (typeof v === 'string' && SCRIPT.test(v)) out[k] = v;
    return out;
  }
  function hotspots() {
    return cf.all().filter(r => /HotSpot/i.test(r.cls)).map(r => ({
      name: r.name, cx: r.cx, cy: r.cy, w: r.w, h: r.h, vis: r.vis,
      ud: r.o.getProp ? r.o.getProp('userData') : undefined,
    }));
  }
  /** Click the nav hotspot whose userData picks `name` out of the location table. */
  async function goto(name) {
    const table = dests();
    const hs = hotspots().filter(h => /nav/i.test(h.name) && h.vis);
    for (const h of hs) {
      const key = Object.keys(table).find(k => k.endsWith('.' + h.ud) && table[k] === name);
      if (key) { await cf.click(h.cx, h.cy); return { clicked: h.name, via: key, to: name }; }
    }
    return { clicked: null, table, hs };
  }
  async function until(pred, ms = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (pred()) return true; await cf.sleep(200); }
    return false;
  }
  async function leave(from, ms = 30000) { return until(() => cf.script() !== from, ms); }
  async function skipMovies(n = 25) {
    for (let i = 0; i < n; i++) { if (!cf.find('Movie').filter(r => r.vis).length) break; await cf.click(320, 240); await cf.sleep(600); }
  }
  return { vars, dests, hotspots, goto, until, leave, skipMovies };
})();
'cfx ready'

window.cfs = (() => {
  const objs = (re) => cf.all().filter(r => new RegExp(re).test(r.cls) && !r.o.destroyed);
  const containers = () => objs('Container');
  const answers = () => objs('Answer');
  const rectOf = (o) => { const r = o.rect; return { x: r.x, y: r.y, w: r.w, h: r.h, cx: Math.round(r.x + r.w / 2), cy: Math.round(r.y + r.h / 2) }; };
  /** The smallest subset of `pool` summing to `target` -- fewest pieces first, as a player would. */
  function subset(pool, target, max = 4) {
    for (let size = 1; size <= max; size++) {
      const out = [];
      const walk = (i, chosen, sum) => {
        if (out.length) return;
        if (chosen.length === size) { if (sum === target) out.push([...chosen]); return; }
        if (i >= pool.length || sum > target) return;
        chosen.push(pool[i]); walk(i + 1, chosen, sum + Number(pool[i].o.value)); chosen.pop();
        walk(i + 1, chosen, sum);
      };
      walk(0, [], 0);
      if (out.length) return out[0];
    }
    return null;
  }
  /**
   * Where to take hold of an answer: the middle of its own graphic, not of its
   * bounds -- a wrapped phrase's two boxes sit diagonally, so the middle of the
   * pair is the empty corner between them and grabs nothing.
   */
  function grip(a) {
    const g = a.o.graphic;
    if (g && g.texture && g.texture.width > 1) {
      const b = g.getBounds();
      return { x: Math.round((b.minX + b.maxX) / 2), y: Math.round((b.minY + b.maxY) / 2) };
    }
    return { x: a.cx, y: a.cy };
  }
  /** Drop `a` onto container rect `t`, nudged by `slot` so several fit side by side. */
  async function put(a, t, slot = 0, of = 1) {
    const step = of > 1 ? Math.min(40, t.w / (of + 1)) : 0;
    const x = Math.round(t.cx + (slot - (of - 1) / 2) * step);
    const g = grip(a);
    await cf.drag(g.x, g.y, x, t.cy);
    await cf.sleep(400);
  }
  /** One pass: fill every unsolved container from the unused answers. */
  async function pass() {
    const done = [];
    for (const cr of containers()) {
      const c = cr.o;
      if (c.destroyed || c.isSolved()) continue;
      const t = rectOf(c);
      const free = answers().filter(a => !a.o.used && !a.o.destroyed);
      if (!free.length) continue;
      let pick = null;
      if (c.attribute !== undefined && String(c.attribute) !== '' && String(c.attribute) !== '0') {
        pick = free.filter(a => String(a.o.attribute) === String(c.attribute));
      } else {
        pick = subset(free, Number(c.value));
      }
      if (!pick || !pick.length) continue;
      for (let i = 0; i < pick.length; i++) await put(pick[i], t, i, pick.length);
      done.push({ container: cr.name, put: pick.map(p => p.name), solved: c.isSolved() });
    }
    return done;
  }
  /** Keep solving while the script stays put. */
  async function run(script, rounds = 12) {
    const log = [];
    for (let i = 0; i < rounds; i++) {
      if (cf.script() !== script) break;
      const r = await pass();
      log.push(r);
      if (!r.length) { await cf.sleep(1500); continue; }
      await cf.sleep(3500);
      await cfx.skipMovies(6);
      await cf.sleep(2000);
    }
    return { script: cf.script(), log, engineLog: cf.E().log.length };
  }
  return { containers, answers, rectOf, subset, grip, put, pass, run };
})();
'cfs ready'

/** Runs `once` up to `n` times in the background while `script` stays loaded; result lands in window.__L. */
window.loop = (script, n, once) => {
  window.__L = null;
  (async () => {
    const out = [];
    for (let i = 0; i < n; i++) {
      if (cf.script() !== script) { out.push('left:' + cf.script()); break; }
      await cf.sleep(1500); await cfx.skipMovies(4);
      out.push(await once());
      await cf.sleep(4500);
    }
    return out;
  })().then(r => window.__L = r).catch(e => window.__L = { error: String(e) });
  return 'started';
};
/** Fills the first open value container with the fewest pieces that sum to its value. */
window.valueOnce = async () => {
  const cr = cfs.containers().find(r => r.o.enabled && !r.o.isSolved());
  if (!cr) return 'no-target';
  const c = cr.o, t = cfs.rectOf(c);
  const free = cfs.answers().filter(a => !a.o.used && !a.o.destroyed);
  const pick = cfs.subset(free, Number(c.value));
  if (!pick) return { target: Number(c.value), have: free.map(a => Number(a.o.value)), pick: null };
  for (let i = 0; i < pick.length; i++) { const g = cfs.grip(pick[i]); await cf.drag(g.x, g.y, t.cx, t.cy); await cf.sleep(i < pick.length - 1 ? 350 : 100); }
  return { target: Number(c.value), put: pick.map(p => Number(p.o.value)), inC: c.answers.length, solved: c.isSolved() };
};
'driver ready'
