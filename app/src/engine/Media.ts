import { Texture, VideoSource } from 'pixi.js';
import { STAGE_H, STAGE_W } from './constants';

/**
 * Sound and movie playback, unlocked by the player's first tap.
 *
 * Safari on iPhone and iPad only lets a page start sound from inside a tap,
 * but the game starts most of its sounds from timers and queues. So sounds
 * play through one Web Audio context, which the Start tap wakes once and for
 * all, and every movie plays in one shared <video>, which the same tap plays
 * once. Other browsers need no unlocking; they just get the same paths.
 */
export class Media {
  readonly context = new AudioContext();
  /** The movie player every RSmackerMovie takes its turn with. */
  readonly video = document.createElement('video');
  /** The movie's picture, drawn into the canvas; updated as each new frame is presented. */
  readonly videoFrames: Texture;
  private readonly videoSource: VideoSource;
  private videoOwner: VideoOwner | null = null;
  private videoUrl = '';
  private videoReady = false;
  /** Recently decoded sounds (a click or a line of speech replays often); decoding is cheap, keeping them all is not. */
  private readonly decoded = new Map<string, Promise<AudioBuffer | null>>();

  constructor() {
    const video = this.video;
    video.preload = 'auto';
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    this.videoSource = new VideoSource({
      resource: video, autoLoad: false, autoPlay: false, scaleMode: 'nearest', width: STAGE_W, height: STAGE_H,
    });
    this.videoFrames = new Texture({ source: this.videoSource });
    video.addEventListener('loadeddata', () => {
      if (!this.videoUrl) return;
      this.videoReady = true;
      if (video.videoWidth && video.videoHeight) this.videoSource.resize(video.videoWidth, video.videoHeight);
      this.videoSource.update();
      this.videoOwner?.videoReady();
    });
    video.addEventListener('ended', () => this.videoOwner?.videoEnded());
    video.addEventListener('error', () => {
      if (this.videoUrl) this.videoOwner?.videoFailed(); // releasing clears the source, which raises 'error' too
    });
    if (HAS_VIDEO_FRAME_CALLBACK) {
      const upload = () => {
        if (this.videoReady) this.videoSource.update();
        video.requestVideoFrameCallback(upload);
      };
      video.requestVideoFrameCallback(upload);
    }
  }

  /**
   * Call from inside the player's tap (the Start button): wakes the sound and
   * the movie player so the game can start them later, from timers.
   */
  unlock(): void {
    // iOS: play through the ring/silent switch, as the original's sound and the movies do
    const session = (navigator as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    void this.context.resume().catch(() => {});
    const blip = this.context.createBufferSource();
    blip.buffer = this.context.createBuffer(1, 1, 22050);
    blip.connect(this.context.destination);
    blip.start();
    if (!this.videoUrl) {
      this.video.src = SILENT_MOVIE;
      this.video.play().catch(() => {});
    }
  }

  /** Wakes sound again after the system took it away (a call, the app in the background). Call from a tap. */
  resumeAfterInterruption(): void {
    if (this.context.state !== 'running') void this.context.resume().catch(() => {});
  }

  sound(url: string): GameSound {
    return new GameSound(this, url);
  }

  decode(url: string): Promise<AudioBuffer | null> {
    let pending = this.decoded.get(url);
    if (pending) {
      this.decoded.delete(url); // most recently used goes last
    } else {
      pending = fetch(url)
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.arrayBuffer();
        })
        .then((bytes) => this.context.decodeAudioData(bytes))
        .catch(() => null);
    }
    this.decoded.set(url, pending);
    if (this.decoded.size > DECODED_KEPT) this.decoded.delete(this.decoded.keys().next().value!);
    return pending;
  }

  /** Gives the movie player to `owner`, loading `url` unless it already has it; the previous owner loses it. */
  claimVideo(owner: VideoOwner, url: string): HTMLVideoElement {
    const previous = this.videoOwner;
    this.videoOwner = owner;
    if (previous && previous !== owner) previous.videoLost();
    this.video.muted = false;
    if (this.videoUrl !== url) {
      this.videoUrl = url;
      this.videoReady = false;
      this.video.src = url;
    } else if (this.videoReady) {
      queueMicrotask(() => this.videoOwner === owner && owner.videoReady());
    }
    return this.video;
  }

  ownsVideo(owner: VideoOwner): boolean {
    return this.videoOwner === owner;
  }

  releaseVideo(owner: VideoOwner): void {
    if (this.videoOwner !== owner) return;
    this.videoOwner = null;
    this.videoUrl = '';
    this.videoReady = false;
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load(); // lets go of the file
  }

  /** For browsers without requestVideoFrameCallback: upload the movie's current frame. */
  updateVideoFrame(): void {
    if (!HAS_VIDEO_FRAME_CALLBACK && this.videoReady && !this.video.paused) this.videoSource.update();
  }
}

export interface VideoOwner {
  /** The owner's movie has its first frame. */
  videoReady(): void;
  videoEnded(): void;
  videoFailed(): void;
  /** Another movie took the player. */
  videoLost(): void;
}

const DECODED_KEPT = 24;
const HAS_VIDEO_FRAME_CALLBACK = typeof HTMLVideoElement !== 'undefined' && 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
/** A 0.1 s silent movie: played inside the Start tap to unlock the movie player on iOS. */
const SILENT_MOVIE = '/silence.mp4';

/**
 * One playing sound, with the parts of HTMLAudioElement the engine uses:
 * play/pause/resume, loop, volume, rate, duration and an 'ended' event.
 */
export class GameSound extends EventTarget {
  readonly src: string;
  paused = true;
  duration = NaN;
  playbackRate = 1;
  private _loop = false;
  private buffer: AudioBuffer | null = null;
  private readonly loading: Promise<AudioBuffer | null>;
  private readonly gain: GainNode;
  private node: AudioBufferSourceNode | null = null;
  /** Seconds into the sound where playing (re)starts. */
  private offset = 0;
  private startedAt = 0;
  private wanted = false;

  constructor(private readonly media: Media, url: string) {
    super();
    this.src = url;
    this.gain = media.context.createGain();
    this.loading = media.decode(url).then((buffer) => {
      this.buffer = buffer;
      if (buffer) {
        this.duration = buffer.duration;
        this.dispatchEvent(new Event('loadedmetadata'));
      } else {
        this.dispatchEvent(new Event('error'));
      }
      return buffer;
    });
  }

  get loop(): boolean {
    return this._loop;
  }

  set loop(value: boolean) {
    this._loop = value;
    if (this.node) this.node.loop = value;
  }

  get volume(): number {
    return this.gain.gain.value;
  }

  set volume(value: number) {
    this.gain.gain.value = value;
  }

  /** Rejects with NotAllowedError, as a blocked <audio> does, when sound hasn't been unlocked. */
  play(): Promise<void> {
    const context = this.media.context;
    if (context.state !== 'running') {
      void context.resume().catch(() => {});
      return Promise.reject(new DOMException('sound is not unlocked yet', 'NotAllowedError'));
    }
    this.wanted = true;
    this.paused = false;
    return this.loading.then((buffer) => {
      if (buffer && this.wanted && !this.node) this.start(buffer);
    });
  }

  pause(): void {
    this.wanted = false;
    this.paused = true;
    const node = this.node;
    if (!node) return;
    this.node = null;
    const played = (this.media.context.currentTime - this.startedAt) * node.playbackRate.value;
    const length = this.buffer?.duration ?? 0;
    this.offset = this._loop && length ? (this.offset + played) % length : Math.min(length, this.offset + played);
    node.onended = null;
    node.stop();
    node.disconnect();
  }

  private start(buffer: AudioBuffer) {
    const context = this.media.context;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.loop = this._loop;
    node.playbackRate.value = this.playbackRate;
    node.connect(this.gain);
    this.gain.connect(context.destination);
    node.onended = () => {
      if (this.node !== node) return;
      this.node = null;
      this.paused = true;
      this.wanted = false;
      this.offset = 0;
      node.disconnect();
      this.gain.disconnect();
      this.dispatchEvent(new Event('ended'));
    };
    this.startedAt = context.currentTime;
    node.start(0, Math.min(this.offset, buffer.duration));
    this.node = node;
  }
}
