import { ResourceManager } from './ResourceManager';
import { AssetBrowser } from './browser/AssetBrowser';
import { GameEngine } from './engine/GameEngine';

const GAME_TEMPLATE = `
<div class="game">
  <div id="game-stage" class="game-stage">
    <div id="game-start-screen" class="start-screen">
      <button id="game-start" class="start-button">Start</button>
      <button id="game-fullscreen" class="fullscreen-button" hidden>Play full screen</button>
      <div id="game-homescreen-hint" class="homescreen-hint" hidden>For a bigger game, tap Share, then Add to Home Screen.</div>
    </div>
  </div>
  <button id="game-fullscreen-corner" class="fullscreen-corner" title="Play full screen" aria-label="Play full screen" hidden>
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>
  </button>
  <div class="game-bar">
    <span id="game-status">Press Start to play.</span>
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

  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    engine.media.unlock(); // inside the tap: iPhones allow sound only from here on
    document.getElementById('game-start-screen')!.remove();
    fullScreen?.gameStarted();
    void engine.boot(firstScript);
  };
  const fullScreen = offerFullScreen(start);
  document.getElementById('game-start')!.addEventListener('click', start);
}

type WebkitDocument = Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null };
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => void };

/**
 * On a touch screen, full screen and sideways: with the browser's address bar
 * showing, a phone held sideways leaves the game little height. Under Start, a
 * Play full screen button starts the game full screen; once it's running, a
 * small button in the screen's corner (outside the game, which has buttons of
 * its own in its corners) gets back to full screen after leaving it. Browsers
 * only go full screen from a tap, and only lock the screen sideways once full
 * screen (Android; iPads rotate by hand). iPhones can't put a page full screen
 * at all, so they get a tip to add the game to the Home Screen, which opens it
 * without the address bar (see manifest.webmanifest).
 */
function offerFullScreen(start: () => void): { gameStarted(): void } | null {
  const doc = document as WebkitDocument;
  const installed =
    matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (!matchMedia('(pointer: coarse)').matches || installed) return null;
  if (!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled)) {
    document.getElementById('game-homescreen-hint')!.hidden = false;
    return null;
  }
  const button = document.getElementById('game-fullscreen') as HTMLButtonElement;
  const corner = document.getElementById('game-fullscreen-corner') as HTMLButtonElement;
  let started = false;
  const sync = () => {
    const full = Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
    button.hidden = full;
    corner.hidden = full || !started;
  };
  sync();
  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);
  button.addEventListener('click', () => {
    start(); // first: it wakes the sound, which needs the tap; going full screen uses the tap up
    void enterFullScreen();
  });
  corner.addEventListener('click', () => void enterFullScreen());
  return {
    gameStarted() {
      started = true;
      sync();
    },
  };
}

async function enterFullScreen() {
  const root = document.documentElement as WebkitElement;
  try {
    if (root.requestFullscreen) await root.requestFullscreen({ navigationUI: 'hide' });
    else root.webkitRequestFullscreen?.();
    const orientation = screen.orientation as ScreenOrientation & { lock?: (to: string) => Promise<void> };
    await orientation.lock?.('landscape');
  } catch {
    /* declined, or no orientation lock (iPad): full screen, if it came, stays */
  }
}

function showFatal(mount: HTMLElement, message: string) {
  console.error(message);
  const el = document.createElement('pre');
  el.className = 'fatal';
  el.textContent = message;
  mount.replaceChildren(el);
}

main();
