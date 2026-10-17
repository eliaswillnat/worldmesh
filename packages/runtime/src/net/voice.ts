import { sharedAudio } from '../audio/footsteps.js';
import { Downsampler, VOICE_FRAME, VOICE_KIND, VOICE_RATE, decodeMuLaw, encodeMuLaw } from './voiceCodec.js';

/**
 * Where push-to-talk stands, for the button that drives it: 'live' while the
 * voice is going out, 'starting' while the browser opens the microphone
 * (and asks for permission the first time), 'denied' when the visitor or the
 * browser said no, 'unavailable' when this page or relay cannot carry voice.
 */
export type MicState = 'off' | 'starting' | 'live' | 'denied' | 'unavailable';

/**
 * After letting go, the microphone stays open this long, so the next press
 * starts at once. Then it is closed and the browser's recording light goes off.
 */
const KEEP_OPEN_MS = 20_000;
/** Keep sending this long after letting go, in seconds: the last word is still on its way through the microphone. */
const TAIL_S = 0.18;
/** A press longer than this is a stuck key or finger: let go. */
const MAX_TALK_MS = 60_000;
/** Samples the audio thread gathers before handing them over: about 43 ms at 48 kHz. */
const CAPTURE_BLOCK = 2048;
/** A leftover shorter than this (10 ms) is not worth a frame of its own. */
const MIN_FLUSH = 160;

/**
 * Copies the microphone off the audio thread in blocks, each with the audio
 * clock time it starts at. Loaded from a blob, so no file has to be served
 * next to the runtime.
 */
const WORKLET = `class WorldMeshMic extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(${CAPTURE_BLOCK}); this.length = 0; }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i++) {
        this.block[this.length++] = input[i];
        if (this.length === this.block.length) {
          const at = currentTime + (i + 1 - this.block.length) / sampleRate;
          this.port.postMessage({ samples: this.block, at }, [this.block.buffer]);
          this.block = new Float32Array(${CAPTURE_BLOCK});
          this.length = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('worldmesh-mic', WorldMeshMic);`;

const worklets = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Whether the capture worklet is ready on this context. False where worklets or blob URLs are not allowed. */
function loadWorklet(context: AudioContext): Promise<boolean> {
  let ready = worklets.get(context);
  if (!ready) {
    ready = (async () => {
      if (!context.audioWorklet || typeof AudioWorkletNode === 'undefined') return false;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(url);
        return true;
      } catch {
        return false;
      } finally {
        URL.revokeObjectURL(url);
      }
    })();
    worklets.set(context, ready);
  }
  return ready;
}

/**
 * The visitor's microphone, cut into voice frames while the talk button is
 * held. It opens on the first press and closes a while after the last one,
 * so the browser is not recording while nobody is talking.
 */
export class Microphone {
  private held = false;
  private heldAt = 0;
  /**
   * When on the audio clock the voice goes out from and until. Blocks are
   * judged by when they were recorded, not when the page gets round to
   * them: on a busy phone they arrive late, and words said while the button
   * was down still go out.
   */
  private onAirFrom = Infinity;
  private onAirUntil = -Infinity;
  private context: AudioContext | null = null;
  private state: MicState = 'off';
  private stream: MediaStream | null = null;
  private nodes: AudioNode[] = [];
  private opening = false;
  private closeTimer = 0;
  private disposed = false;
  private downsampler: Downsampler | null = null;
  /** The frame being filled: the kind byte, then samples. */
  private frame = new Uint8Array(1 + VOICE_FRAME);
  private filled = 0;

  constructor(
    private readonly send: (frame: Uint8Array) => void,
    private readonly onState: (state: MicState) => void,
  ) {
    this.frame[0] = VOICE_KIND;
  }

  /** Press (true) and let go of (false) the talk button. */
  hold(held: boolean): void {
    if (this.disposed || held === this.held) return;
    this.held = held;
    window.clearTimeout(this.closeTimer);
    if (held) {
      this.heldAt = performance.now();
      // Inside the press: browsers let audio start only from a gesture.
      const audio = sharedAudio();
      // Before the microphone is open, everything it records once it is counts.
      this.onAirFrom = this.context ? this.context.currentTime : audio ? audio.context.currentTime : 0;
      this.onAirUntil = Infinity;
      if (this.stream) this.set('live');
      else void this.open();
      return;
    }
    this.onAirUntil = (this.context?.currentTime ?? 0) + TAIL_S;
    if (this.state === 'live' || this.state === 'starting') this.set('off');
    this.closeTimer = window.setTimeout(() => this.close(), KEEP_OPEN_MS);
  }

  /** Let go and close the microphone for good. */
  dispose(): void {
    this.held = false;
    this.disposed = true;
    window.clearTimeout(this.closeTimer);
    this.close();
  }

  private async open(): Promise<void> {
    if (this.opening) return;
    const audio = sharedAudio();
    if (!audio || !navigator.mediaDevices?.getUserMedia) {
      this.set('unavailable');
      return;
    }
    this.opening = true;
    this.set('starting');
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (this.disposed) return;
      await this.connect(audio.context, stream);
      if (this.disposed) return;
      this.stream = stream;
      stream = null;
      for (const track of this.stream.getAudioTracks()) track.addEventListener('ended', () => this.close(), { once: true });
      if (this.held) {
        this.set('live');
      } else {
        // Let go while the browser was asking: ready for the next press.
        this.set('off');
        window.clearTimeout(this.closeTimer);
        this.closeTimer = window.setTimeout(() => this.close(), KEEP_OPEN_MS);
      }
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      this.set(name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable');
    } finally {
      this.opening = false;
      // Not handed over: the page went away or something failed after the browser said yes.
      stream?.getTracks().forEach((track) => track.stop());
      if (!this.stream) this.disconnect();
    }
  }

  private async connect(context: AudioContext, stream: MediaStream): Promise<void> {
    const source = context.createMediaStreamSource(stream);
    // Capture nodes only run when they lead somewhere; this leads nowhere audible.
    const sink = context.createGain();
    sink.gain.value = 0;
    sink.connect(context.destination);
    this.downsampler = new Downsampler(context.sampleRate, VOICE_RATE);
    this.filled = 0;
    let tap: AudioNode;
    if (await loadWorklet(context)) {
      const node = new AudioWorkletNode(context, 'worldmesh-mic', { channelCount: 1, channelCountMode: 'explicit' });
      node.port.onmessage = (event: MessageEvent<{ samples: Float32Array; at: number }>) => this.capture(event.data.samples, event.data.at);
      tap = node;
    } else {
      // Older browsers, and pages whose content policy blocks blob worklets.
      const node = context.createScriptProcessor(CAPTURE_BLOCK, 1, 1);
      node.onaudioprocess = (event) => this.capture(event.inputBuffer.getChannelData(0), event.playbackTime);
      tap = node;
    }
    source.connect(tap);
    tap.connect(sink);
    this.nodes = [source, tap, sink];
    this.context = context;
  }

  /** A block of microphone samples, recorded from `at` on the audio clock. */
  private capture(samples: Float32Array, at: number): void {
    const downsampler = this.downsampler;
    const context = this.context;
    if (!downsampler || !context) return;
    if (this.held && performance.now() - this.heldAt > MAX_TALK_MS) this.hold(false);
    const end = at + samples.length / context.sampleRate;
    if (at >= this.onAirUntil) {
      this.flush();
      return;
    }
    if (end <= this.onAirFrom) return;
    downsampler.push(samples, (sample) => {
      this.frame[1 + this.filled++] = encodeMuLaw(sample);
      if (this.filled === VOICE_FRAME) {
        this.send(this.frame.slice());
        this.filled = 0;
      }
    });
  }

  /** Send what is left of the last frame, and start the next burst clean. */
  private flush(): void {
    if (this.filled >= MIN_FLUSH) this.send(this.frame.slice(0, 1 + this.filled));
    this.filled = 0;
    this.downsampler?.reset();
  }

  private close(): void {
    // Also when the microphone goes away mid-press (unplugged): the next press opens it again.
    this.held = false;
    this.onAirUntil = -Infinity;
    this.flush();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.disconnect();
    if (this.state === 'live' || this.state === 'starting') this.set('off');
  }

  private disconnect(): void {
    for (const node of this.nodes) {
      if (node instanceof AudioWorkletNode) node.port.onmessage = null;
      if (node instanceof ScriptProcessorNode) node.onaudioprocess = null;
      node.disconnect();
    }
    this.nodes = [];
    this.downsampler = null;
    this.context = null;
  }

  private set(state: MicState): void {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }
}

/** How far ahead the first frame of a burst is scheduled, to ride out frames arriving unevenly. */
const JITTER_S = 0.12;
/** Frames queued further ahead than this are dropped, so a voice that fell behind catches up instead of lagging. */
const MAX_AHEAD_S = 0.8;

/** Someone else's voice, played as their frames arrive, from where they stand. */
export class VoiceStream {
  /** How loud their latest frame was, 0 to 1, for a talking indicator. */
  level = 0;
  /** performance.now() of their latest frame. */
  heardAt = -Infinity;
  /** Muted by this visitor: frames still count as talking, but are not played. */
  muted = false;
  private readonly gain: GainNode;
  private readonly pan: StereoPannerNode | null;
  private nextAt = 0;

  constructor(private readonly context: AudioContext) {
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    this.pan = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;
    if (this.pan) this.gain.connect(this.pan).connect(context.destination);
    else this.gain.connect(context.destination);
  }

  /** One frame of their μ-law samples. */
  play(samples: Uint8Array): void {
    this.heardAt = performance.now();
    const data = decodeMuLaw(samples);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    this.level = Math.min(1, Math.sqrt(sum / Math.max(1, data.length)) * 5);
    const context = this.context;
    if (this.muted || context.state !== 'running' || data.length === 0) return;
    const now = context.currentTime;
    if (this.nextAt < now + 0.02) this.nextAt = now + JITTER_S;
    else if (this.nextAt > now + MAX_AHEAD_S) return;
    const buffer = context.createBuffer(1, data.length, VOICE_RATE);
    buffer.getChannelData(0).set(data);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);
    source.start(this.nextAt);
    this.nextAt += buffer.duration;
  }

  /** How loud they are here (0 to 1), and from which side (-1 left to 1 right). */
  place(loudness: number, pan: number): void {
    const now = this.context.currentTime;
    this.gain.gain.setTargetAtTime(this.muted ? 0 : loudness, now, 0.05);
    this.pan?.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, 0.05);
  }

  dispose(): void {
    this.gain.disconnect();
    this.pan?.disconnect();
  }
}
