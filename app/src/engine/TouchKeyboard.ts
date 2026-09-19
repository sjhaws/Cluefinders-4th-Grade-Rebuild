import type { GameEngine } from './GameEngine';
import { STAGE_H, STAGE_W } from './constants';

/**
 * Brings up a phone's or tablet's on-screen keyboard for the sign-in list. A
 * browser only shows one for a focused text box, so an invisible one lies over
 * the list; what the player types into it reaches the game as ordinary key
 * presses, and the list draws the name as it always does. Mouse players never
 * see it: their keys come straight from the window.
 */
export class TouchKeyboard {
  private readonly input = document.createElement('input');
  private readonly resizeObserver: ResizeObserver | null = null;
  private composing = false;
  /** Set by open(); the tap's `click` retries the focus if the tap itself couldn't give it (iOS). */
  private wanted = false;
  private readonly onClick = () => {
    if (this.wanted && document.activeElement !== this.input) this.input.focus();
    this.wanted = false;
  };

  constructor(
    private readonly engine: GameEngine,
    private readonly area: { x: number; y: number; width: number; height: number },
    /** The name as the game holds it: what the text box is kept in step with. */
    private readonly typed: () => string,
    maxLength: number
  ) {
    const input = this.input;
    input.type = 'text';
    input.maxLength = maxLength;
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'words');
    input.setAttribute('autocorrect', 'off');
    input.setAttribute('enterkeyhint', 'go');
    input.setAttribute('aria-label', 'Your name');
    Object.assign(input.style, {
      position: 'absolute',
      opacity: '0',
      pointerEvents: 'none', // taps go to the game underneath
      border: '0',
      padding: '0',
      background: 'transparent',
      color: 'transparent',
      caretColor: 'transparent',
      fontSize: '16px', // any smaller and iOS zooms the page in when it takes focus
    });
    input.addEventListener('compositionstart', () => (this.composing = true));
    input.addEventListener('compositionend', () => {
      this.composing = false;
      this.apply();
    });
    input.addEventListener('input', () => this.apply());
    input.addEventListener('keydown', (e) => {
      // letters and Backspace arrive as 'input' (on-screen keyboards often send no usable key for them)
      const key = e.key === 'Enter' ? 'Return' : e.key === 'ArrowUp' ? 'Up' : e.key === 'ArrowDown' ? 'Down' : null;
      if (!key) return;
      e.preventDefault();
      engine.pressKey(key);
    });
    const root = engine.overlayRoot;
    if (!root) return;
    root.appendChild(input);
    engine.app.canvas.addEventListener('click', this.onClick);
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(engine.app.canvas);
    this.fit();
  }

  /** Shows the on-screen keyboard, if the player is using a touch screen. Call it from a tap's handler. */
  open(): void {
    if (this.engine.lastPointerType === 'mouse') return;
    this.sync();
    this.wanted = true;
    this.input.focus({ preventScroll: true });
  }

  /** Hides the on-screen keyboard. */
  close(): void {
    this.wanted = false;
    this.input.blur();
  }

  /** Keeps the text box holding the name the game has, e.g. after it turned a character down. */
  sync(): void {
    if (!this.composing && this.input.value !== this.typed()) this.input.value = this.typed();
  }

  /** Sends the game the key presses that turn its name into the text box's. */
  private apply() {
    const want = this.input.value;
    const have = this.typed();
    let same = 0;
    while (same < want.length && same < have.length && want[same] === have[same]) same++;
    for (let i = same; i < have.length; i++) this.engine.pressKey('Backspace');
    for (const ch of want.slice(same)) this.engine.pressKey(ch);
    this.sync();
  }

  /** Lays the text box over the list, wherever the canvas is scaled to. */
  private fit() {
    const canvas = this.engine.app.canvas;
    const sx = canvas.clientWidth / STAGE_W;
    const sy = canvas.clientHeight / STAGE_H;
    Object.assign(this.input.style, {
      left: `${canvas.offsetLeft + canvas.clientLeft + this.area.x * sx}px`,
      top: `${canvas.offsetTop + canvas.clientTop + this.area.y * sy}px`,
      width: `${this.area.width * sx}px`,
      height: `${this.area.height * sy}px`,
    });
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    this.engine.app.canvas.removeEventListener('click', this.onClick);
    this.input.remove();
  }
}
