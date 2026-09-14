import { Application, Graphics } from 'pixi.js';
import { AseqAnimation, DEFAULT_TICK_MS, sequenceBounds } from '../AseqAnimation';
import type { LoadedAseq, ResourceManager } from '../ResourceManager';
import type { AseqResourceEntry, SequenceEntry } from '../types';

const STAGE_W = 640;
const STAGE_H = 480;
const THUMB = 80;

const TEMPLATE = `
<div class="browser">
  <aside class="sidebar">
    <input id="bundle-filter" type="search" placeholder="Filter bundles" />
    <ul id="bundle-list" class="bundle-list"></ul>
  </aside>
  <main class="main">
    <div class="toolbar">
      <span id="title" class="title">—</span>
      <select id="list-select" title="Sequence list"></select>
      <button id="play">Pause</button>
      <button id="step" title="Step (→)">Step</button>
      <button id="restart">Restart</button>
      <label>Tick <input id="tick" type="number" min="10" max="2000" step="5" /> ms</label>
      <label><input id="loop" type="checkbox" checked /> Loop</label>
      <label><input id="bounds" type="checkbox" /> Frame box</label>
      <label><input id="sound" type="checkbox" checked /> Sound</label>
    </div>
    <div id="stage" class="stage"></div>
    <div id="info" class="info"></div>
    <h2>Images</h2>
    <div id="resources" class="resources"></div>
    <h2>Sounds</h2>
    <div id="sounds" class="sounds"></div>
  </main>
</div>`;

/** Developer tool: browse every bundle's animations and sounds, with sequence playback. */
export class AssetBrowser {
  private readonly app = new Application();
  private readonly frameBox = new Graphics();
  private anim: AseqAnimation | null = null;
  private loaded: LoadedAseq | null = null;
  private bundle = '';
  private resourceId: number | null = null;
  private loadToken = 0;
  private audio: HTMLAudioElement | null = null;
  private firstPass = true; // sound cues only play on a list's first pass, not every loop
  private lastInfo = '';
  private els!: {
    filter: HTMLInputElement;
    bundles: HTMLUListElement;
    title: HTMLElement;
    listSelect: HTMLSelectElement;
    play: HTMLButtonElement;
    step: HTMLButtonElement;
    restart: HTMLButtonElement;
    tick: HTMLInputElement;
    loop: HTMLInputElement;
    bounds: HTMLInputElement;
    sound: HTMLInputElement;
    stage: HTMLElement;
    info: HTMLElement;
    resources: HTMLElement;
    sounds: HTMLElement;
  };

  constructor(private readonly resources: ResourceManager) {}

  async mount(root: HTMLElement): Promise<void> {
    root.innerHTML = TEMPLATE;
    const q = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
    this.els = {
      filter: q('bundle-filter'), bundles: q('bundle-list'), title: q('title'),
      listSelect: q('list-select'), play: q('play'), step: q('step'), restart: q('restart'),
      tick: q('tick'), loop: q('loop'), bounds: q('bounds'), sound: q('sound'),
      stage: q('stage'), info: q('info'), resources: q('resources'), sounds: q('sounds'),
    };
    this.els.tick.value = String(DEFAULT_TICK_MS);

    await this.app.init({ width: STAGE_W, height: STAGE_H, background: 0x1e1e24, antialias: false });
    this.els.stage.appendChild(this.app.canvas);
    this.app.stage.addChild(this.frameBox);
    this.app.ticker.add((ticker) => {
      if (!this.anim) return;
      this.anim.update(ticker.deltaMS);
      this.refreshStatus();
    });

    this.wireControls();
    this.renderBundleList();
    window.addEventListener('hashchange', () => void this.applyHash());
    await this.applyHash();
  }

  private wireControls(): void {
    const { els } = this;
    els.filter.addEventListener('input', () => this.renderBundleList());
    els.listSelect.addEventListener('change', () => this.showList(Number(els.listSelect.value)));
    els.play.addEventListener('click', () => this.togglePlay());
    els.step.addEventListener('click', () => this.stepOnce());
    els.restart.addEventListener('click', () => {
      if (!this.anim) return;
      this.stopSound();
      this.firstPass = true;
      this.anim.playing = true;
      this.anim.restart();
    });
    els.sound.addEventListener('change', () => {
      if (!els.sound.checked) this.stopSound();
    });
    els.tick.addEventListener('input', () => {
      if (this.anim) this.anim.tickMs = Math.max(10, Number(els.tick.value) || DEFAULT_TICK_MS);
    });
    els.loop.addEventListener('change', () => {
      if (this.anim) this.anim.loop = els.loop.checked;
    });
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.stepOnce(); }
    });
  }

  private async applyHash(): Promise<void> {
    const [bundle, id] = decodeURIComponent(location.hash.slice(1)).split('/');
    const names = this.resources.bundleNames();
    const target = names.includes(bundle) ? bundle : names.includes('cloc01o1') ? 'cloc01o1' : names[0];
    if (target !== this.bundle) this.showBundle(target);
    const entries = this.resources.listAseqForBundle(target);
    const wanted = entries.find((r) => r.resource_id === Number(id)) ?? entries.find((r) => r.decoded);
    if (wanted && wanted.resource_id !== this.resourceId) await this.showResource(wanted);
  }

  private renderBundleList(): void {
    const filter = this.els.filter.value.trim().toLowerCase();
    this.els.bundles.replaceChildren(
      ...this.resources
        .bundleNames()
        .filter((name) => name.includes(filter))
        .map((name) => {
          const li = document.createElement('li');
          const button = document.createElement('button');
          button.textContent = name;
          button.classList.toggle('active', name === this.bundle);
          button.addEventListener('click', () => (location.hash = name));
          li.appendChild(button);
          return li;
        })
    );
  }

  private showBundle(bundle: string): void {
    this.bundle = bundle;
    this.resourceId = null;
    this.renderBundleList();

    this.els.resources.replaceChildren(
      ...this.resources.listAseqForBundle(bundle).map((entry) => this.resourceCard(entry))
    );
    const sounds = this.resources.listSoundsForBundle(bundle);
    this.els.sounds.replaceChildren(
      ...sounds.map((sound) => {
        const button = document.createElement('button');
        button.textContent = `▶ ${sound.id}`;
        button.addEventListener('click', () => this.playSound(sound.id));
        return button;
      })
    );
    if (!sounds.length) this.els.sounds.textContent = 'No sounds in this bundle.';
  }

  private resourceCard(entry: AseqResourceEntry): HTMLElement {
    const card = document.createElement('button');
    card.className = 'res';
    card.dataset.id = String(entry.resource_id);
    const box = document.createElement('div');
    box.className = 'thumb-box';
    const meta = document.createElement('div');
    meta.className = 'meta';

    const frame = entry.frames?.[0];
    if (entry.decoded && entry.sheets && frame) {
      const scale = Math.min(1, THUMB / frame.w, THUMB / frame.h);
      const holder = document.createElement('div');
      holder.style.cssText = `width:${frame.w * scale}px;height:${frame.h * scale}px;overflow:hidden`;
      const inner = document.createElement('div');
      inner.className = 'thumb';
      inner.style.cssText =
        `width:${frame.w}px;height:${frame.h}px;transform:scale(${scale});` +
        `background:url("${this.resources.getImageUrl(entry.sheets[frame.sheet])}") -${frame.x}px -${frame.y}px`;
      holder.appendChild(inner);
      box.appendChild(holder);
      const palette = entry.palette ?? 'placeholder';
      meta.innerHTML = `#${entry.resource_id} · ${entry.frame_count}f<br><span class="${
        entry.palette ? '' : 'bad'
      }">${palette}</span>`;
      card.addEventListener('click', () => (location.hash = `${entry.bundle}/${entry.resource_id}`));
    } else {
      box.textContent = '—';
      meta.innerHTML = `#${entry.resource_id}<br><span class="bad">not decoded</span>`;
      card.disabled = true;
    }
    card.append(box, meta);
    return card;
  }

  private async showResource(entry: AseqResourceEntry): Promise<void> {
    const token = ++this.loadToken;
    this.resourceId = entry.resource_id;
    for (const card of this.els.resources.querySelectorAll<HTMLElement>('.res')) {
      card.classList.toggle('active', card.dataset.id === String(entry.resource_id));
    }
    this.els.title.textContent = `${entry.bundle}/${entry.resource_id}`;
    this.els.info.textContent = 'Loading…';

    let loaded: LoadedAseq;
    try {
      loaded = await this.resources.loadAseq(entry);
    } catch (err) {
      if (token === this.loadToken) this.els.info.textContent = String(err);
      return;
    }
    if (token !== this.loadToken) return;

    this.stopSound();
    this.anim?.destroy();
    this.loaded = loaded;
    this.anim = new AseqAnimation(loaded.frames, {
      onResource: (id) => {
        if (this.els.sound.checked && this.firstPass) this.playSound(id);
      },
      onEnd: () => {
        this.firstPass = false;
      },
    });
    this.anim.tickMs = Math.max(10, Number(this.els.tick.value) || DEFAULT_TICK_MS);
    this.anim.loop = this.els.loop.checked;
    this.app.stage.addChildAt(this.anim, 0);

    const lists = this.listsOf(loaded);
    this.els.listSelect.replaceChildren(
      ...lists.map((list, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = `List ${i + 1} (${list.filter((e) => e[2] >= 0).length} frames)`;
        return option;
      })
    );
    this.els.listSelect.disabled = lists.length < 2;
    this.showList(0);
  }

  /** Sequence lists, or one list showing every frame in order if they didn't parse. */
  private listsOf(loaded: LoadedAseq): SequenceEntry[][] {
    return loaded.sequence.lists ?? [loaded.frames.map((_, i): SequenceEntry => [0, 0, i, 0])];
  }

  private showList(index: number): void {
    if (!this.anim || !this.loaded) return;
    this.stopSound();
    const list = this.listsOf(this.loaded)[index] ?? [];
    this.firstPass = true;
    this.anim.playing = true;
    this.anim.setList(list);
    this.els.play.textContent = 'Pause';

    // Centre the area the list covers; anything larger than the stage starts at its top-left.
    const b = sequenceBounds(list, this.loaded.frames);
    if (b) {
      this.anim.x = b.w <= STAGE_W ? Math.round((STAGE_W - b.w) / 2 - b.x) : -b.x;
      this.anim.y = b.h <= STAGE_H ? Math.round((STAGE_H - b.h) / 2 - b.y) : -b.y;
    }
    this.refreshStatus();
  }

  private togglePlay(): void {
    if (!this.anim) return;
    this.anim.playing = !this.anim.playing;
    if (!this.anim.playing) this.stopSound();
    this.els.play.textContent = this.anim.playing ? 'Pause' : 'Play';
  }

  private stepOnce(): void {
    if (!this.anim) return;
    this.anim.playing = false;
    this.els.play.textContent = 'Play';
    this.anim.step();
    this.refreshStatus();
  }

  private refreshStatus(): void {
    const { anim, loaded } = this;
    if (!anim || !loaded) return;
    this.frameBox.clear();
    const cur = anim.current;
    if (cur && this.els.bounds.checked) {
      const tex = loaded.frames[cur.frame];
      this.frameBox.rect(anim.x + cur.x - 0.5, anim.y + cur.y - 0.5, tex.width + 1, tex.height + 1).stroke({
        color: 0xff40ff,
        width: 1,
      });
    }
    if (this.els.play.textContent === 'Pause' && !anim.playing) this.els.play.textContent = 'Play';
    const list = this.listsOf(loaded)[Number(this.els.listSelect.value) || 0] ?? [];
    const info = cur
      ? `entry ${cur.index + 1}/${list.length} · frame ${cur.frame} · at (${cur.x}, ${cur.y}) · ` +
        `${loaded.frames[cur.frame].width}×${loaded.frames[cur.frame].height} · palette ${loaded.entry.palette ?? 'placeholder'}`
      : 'no frames in this list';
    if (info !== this.lastInfo) {
      this.els.info.textContent = info;
      this.lastInfo = info;
    }
  }

  private playSound(id: number): void {
    const url = this.resources.getSoundUrl(id);
    if (!url) return;
    this.stopSound();
    this.audio = new Audio(url);
    this.audio.play().catch(() => {
      /* autoplay can be blocked until the page gets a click */
    });
  }

  private stopSound(): void {
    this.audio?.pause();
    this.audio = null;
  }
}
