import { AseqAnimation, SEQ_RESOURCE } from '../AseqAnimation';
import type { LoadedAseq } from '../ResourceManager';
import type { SequenceEntry } from '../types';
import type { Value } from './ScriptVm';
import { toInt, toNumber, truthy } from './ScriptVm';
import { DisplayObject } from './ScriptObject';
import type { GameEngine } from './GameEngine';
import type { GameSound } from './Media';
import { aoPosition, sequenceList } from './DisplayObjects';

interface FidgetGroup {
  minMs: number;
  maxMs: number;
  ids: number[];
  timer?: ReturnType<typeof setTimeout>;
}

interface ClipEvents {
  onEnd?: () => void;
  onResource?: (id: number) => void;
}

/**
 * A scene character: an idle ("settle") pose, random fidgets, animations
 * (walk in/out) and lip-synced speech. Every resource carries its own screen
 * position, so clips are drawn at their origin.
 *
 * Speech: each speech animation holds one list per dialogue line, and the
 * list for a line references its sound (-101 entry). Playing speech N plays
 * the list that references sound N.
 */
export class RCharacter extends DisplayObject {
  private settlePose: LoadedAseq | null = null;
  private settleId = 0;
  /** Showing the idle pose, rather than a held animation frame or speech. */
  private clip: AseqAnimation | null = null;
  private busy = false;
  private paused = false;
  private animateSettled = false;
  private readonly fidgets = new Map<number, FidgetGroup>();
  private readonly speechAnims: Promise<LoadedAseq | null>[] = [];
  private audio: GameSound | null = null;
  private cancelActivity: (() => void) | null = null;

  constructor(engine: GameEngine, args: Value[]) {
    super(engine, 'RCharacter');
    this.view.zIndex = toInt(args[1]);
    void this.loadSettlePose(toNumber(args[0]));
  }

  private async loadSettlePose(id: number) {
    this.settleId = id;
    const loaded = await this.engine.loadAseq(id);
    if (this.destroyed) return;
    this.settlePose = loaded;
    if (!this.busy) this.showSettle();
  }

  private showClip(loaded: LoadedAseq, list: SequenceEntry[], loop: boolean, events: ClipEvents = {}): AseqAnimation {
    this.clip?.destroy();
    const anim = new AseqAnimation(loaded.frames, events);
    anim.loop = loop;
    const [x, y] = aoPosition(loaded);
    anim.position.set(x, y);
    this.view.addChild(anim);
    this.clip = anim;
    anim.setList(list);
    return anim;
  }

  private showSettle() {
    if (this.settlePose && !this.destroyed) {
      this.showClip(this.settlePose, sequenceList(this.settlePose), this.animateSettled);
    }
  }

  /** Stops the current animation or speech; its promise resolves. */
  interrupt(): void {
    this.cancelActivity?.();
  }

  /**
   * Plays an animation `repeat` times, then goes back to the idle pose -- hidden when
   * `visibleAfter` is false. That is CharacterAnimAction's fourth argument (default 1): the
   * EXE keeps it at +0xf8 and, as the animation ends (0x41f540), drops the clip, shows the
   * idle pose and hides the character if it is 0. So a walk-out ends with the character
   * gone, not held on its last frame: CBA1's kids climb into a jeep and vanish, and the
   * jeep's drive-out animation, which draws them, carries them off; back from the garage,
   * `visible` brings them back at their spots.
   */
  playAnim(id: number, repeat = 1, visibleAfter = true): Promise<void> {
    this.interrupt();
    return new Promise((resolve) => {
      this.busy = true;
      let over = false;
      const finish = () => {
        if (over) return;
        over = true;
        this.cancelActivity = null;
        this.busy = false;
        if (!visibleAfter) this.view.visible = false;
        queueMicrotask(() => !this.busy && this.showSettle());
        resolve();
      };
      this.cancelActivity = finish;
      void this.engine.loadAseq(id).then((loaded) => {
        if (over || this.destroyed) return finish();
        if (!loaded) return finish();
        let plays = 0;
        let anim: AseqAnimation | null = null;
        anim = this.showClip(loaded, sequenceList(loaded), true, {
          onEnd: () => {
            plays++;
            if (plays >= Math.max(1, repeat)) {
              if (anim) anim.loop = false;
              finish();
            }
          },
        });
      });
    });
  }

  /** Plays dialogue sound `soundId` with its lip-sync list; resolves when both are done. */
  playSpeech(soundId: number): Promise<void> {
    this.interrupt();
    return new Promise((resolve) => {
      this.busy = true;
      let over = false;
      let soundDone = false;
      let listDone = false;
      let soundStarted = false;
      const finish = (force = false) => {
        if (over || (!force && !(soundDone && listDone))) return;
        over = true;
        this.cancelActivity = null;
        this.audio?.pause();
        this.audio = null;
        this.busy = false;
        queueMicrotask(() => !this.busy && this.showSettle());
        resolve();
      };
      const startSound = () => {
        if (soundStarted) return;
        soundStarted = true;
        this.audio = this.engine.playSound(soundId, () => {
          soundDone = true;
          finish();
        });
        if (!this.audio) soundDone = true;
      };
      this.cancelActivity = () => finish(true);

      void Promise.all(this.speechAnims).then((anims) => {
        if (over || this.destroyed) return;
        for (const loaded of anims) {
          const list = loaded?.sequence.lists?.find((l) =>
            l.some(([, , tag, value]) => tag === SEQ_RESOURCE && value === soundId)
          );
          if (loaded && list) {
            this.showClip(loaded, list, false, {
              onResource: (id) => id === soundId && startSound(),
              onEnd: () => {
                listDone = true;
                startSound();
                finish();
              },
            });
            return;
          }
        }
        listDone = true;
        startSound();
        finish();
      });
    });
  }

  private scheduleFidget(group: number) {
    const g = this.fidgets.get(group);
    if (!g) return;
    clearTimeout(g.timer);
    const delay = (g.minMs + Math.random() * Math.max(0, g.maxMs - g.minMs)) / this.engine.timeScale;
    g.timer = setTimeout(() => {
      if (this.destroyed || !this.fidgets.has(group)) return;
      // Only an idle, visible character fidgets: a walk-out ends with the character
      // hidden (see playAnim), and a fidget would draw it back at its idle spot.
      if (!this.busy && !this.paused && this.view.visible && g.ids.length) {
        void this.playAnim(g.ids[Math.floor(Math.random() * g.ids.length)]);
      }
      this.scheduleFidget(group);
    }, delay);
  }

  getProp(name: string, key: Value | undefined): Value {
    switch (name.toLowerCase()) {
      case 'animatesettled': return this.animateSettled ? 1 : 0;
      // a character's position is its idle pose's stored position (e.g. CWS1 puts the tray on the waiter),
      // plus however far it has been moved since
      case 'x': return (this.engine.originOf(this.settleId)?.[0] ?? 0) + this.view.x;
      case 'y': return (this.engine.originOf(this.settleId)?.[1] ?? 0) + this.view.y;
      default: return super.getProp(name, key);
    }
  }

  setProp(name: string, key: Value | undefined, value: Value): void {
    switch (name.toLowerCase()) {
      case 'animatesettled':
        this.animateSettled = truthy(value);
        if (!this.busy) this.showSettle();
        return;
      case 'settleposeid':
        void this.loadSettlePose(toNumber(value));
        return;
      // Every clip is drawn at its own stored screen position, so the view only
      // carries the shift from there: setting x puts the idle pose's stored
      // position at x, the inverse of reading it. OWS4 stands its two mice at
      // the end of each sentence this way; taking x as a plain offset added the
      // pose's own position again and put them some 500px off the right edge.
      case 'x':
        this.view.x = toInt(value) - (this.engine.originOf(this.settleId)?.[0] ?? 0);
        return;
      case 'y':
        this.view.y = toInt(value) - (this.engine.originOf(this.settleId)?.[1] ?? 0);
        return;
      default:
        super.setProp(name, key, value);
    }
  }

  send(method: string, args: Value[]): Value {
    switch (method.toLowerCase()) {
      case 'addfidgetgroup': {
        const group = toNumber(args[0]);
        const ids = this.fidgets.get(group)?.ids ?? [];
        clearTimeout(this.fidgets.get(group)?.timer);
        this.fidgets.set(group, { minMs: toNumber(args[1]) * 1000, maxMs: toNumber(args[2]) * 1000, ids });
        this.scheduleFidget(group);
        return 0;
      }
      case 'addfidget':
        this.fidgets.get(toNumber(args[0]))?.ids.push(toNumber(args[1]));
        return 0;
      case 'removefidgetgroup':
        clearTimeout(this.fidgets.get(toNumber(args[0]))?.timer);
        this.fidgets.delete(toNumber(args[0]));
        return 0;
      case 'addspeechanim':
        this.speechAnims.push(this.engine.loadAseq(toNumber(args[0])));
        return 0;
      case 'playanim':
        void this.playAnim(toNumber(args[0]));
        return 0;
      case 'playspeech':
        void this.playSpeech(toNumber(args[0]));
        return 0;
      case 'pause':
        this.paused = true;
        this.audio?.pause();
        return 0;
      case 'resume':
        this.paused = false;
        if (this.audio) this.engine.playAudio(this.audio);
        return 0;
      case 'stop':
        this.interrupt();
        return 0;
      case 'setaocursor':
        return 0;
      default:
        return super.send(method, args);
    }
  }

  tick(deltaMs: number): void {
    if (!this.paused) this.clip?.update(deltaMs);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.interrupt();
    for (const g of this.fidgets.values()) clearTimeout(g.timer);
    this.fidgets.clear();
    super.destroy();
  }
}
