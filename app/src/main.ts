import { ResourceManager } from './ResourceManager';
import { AssetBrowser } from './browser/AssetBrowser';
import { GameEngine } from './engine/GameEngine';

const GAME_TEMPLATE = `
<div class="game">
  <div id="game-stage" class="game-stage"></div>
  <div class="game-bar">
    <button id="game-start">Start</button>
    <span id="game-status">Click Start to begin (audio needs a click first).</span>
    <a href="?browser">Asset browser</a>
  </div>
  <details class="game-log">
    <summary>Engine log (<span id="game-warn-count">0</span>)</summary>
    <pre id="game-log"></pre>
  </details>
</div>`;

async function main() {
  const mount = document.getElementById('app')!;
  const resources = new ResourceManager();
  try {
    await resources.load();
  } catch (err) {
    showFatal(mount, `${err}\n\nRun the extractor pipeline first -- see README.md.`);
    return;
  }
  const params = new URLSearchParams(location.search);
  if (params.has('browser')) {
    await new AssetBrowser(resources).mount(mount);
  } else {
    await startGame(mount, resources, params.get('script') ?? 'STARTUP');
  }
}

async function startGame(mount: HTMLElement, resources: ResourceManager, firstScript: string) {
  mount.innerHTML = GAME_TEMPLATE;
  const engine = new GameEngine(resources);
  await engine.mount(document.getElementById('game-stage')!);
  (window as unknown as { cf4Engine: GameEngine }).cf4Engine = engine; // debugging handle
  engine.timeScale = Math.max(1, Number(new URLSearchParams(location.search).get('turbo')) || 1);

  const status = document.getElementById('game-status')!;
  const log = document.getElementById('game-log')!;
  const count = document.getElementById('game-warn-count')!;
  engine.onWarn = (message) => {
    log.textContent += `${message}\n`;
    count.textContent = String(engine.log.length);
  };
  engine.onScriptChange = (name) => (status.textContent = `Running ${name}.MPS`);

  const start = document.getElementById('game-start') as HTMLButtonElement;
  start.addEventListener('click', () => {
    start.remove();
    void engine.boot(firstScript);
  }, { once: true });
}

function showFatal(mount: HTMLElement, message: string) {
  console.error(message);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.textContent = message;
  mount.replaceChildren(el);
}

main();
