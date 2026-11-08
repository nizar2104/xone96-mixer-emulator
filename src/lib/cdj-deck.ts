// CDJ-style deck engine: a variable-rate player (forward, reverse, scratch) with
// CDJ cue behaviour, manual / beat loops, hot cues, tempo range and pitch bend.
// Rendering runs on a ScriptProcessorNode so playback rate can go negative and
// follow the jog wheel sample by sample without an external worklet file.

import type { RgbWaveform } from "./waveform";

/** Hot cue pads per deck (A–H, as on CDJs). */
export const HOT_CUE_COUNT = 8;
export const HOT_CUE_NAMES = "ABCDEFGH";

export type TempoRange = 6 | 10 | 16 | 100;
export const TEMPO_RANGES: TempoRange[] = [6, 10, 16, 100];
/** One platter revolution = 1.8 s of audio (33⅓ rpm vinyl feel). */
export const SECONDS_PER_REV = 1.8;

export interface DeckTrack {
  id: string;
  title: string;
  bpm: number | null;
  /** Time of the first beat-grid line, seconds. */
  beatOffset: number;
  /** Musical key from rekordbox, when known. */
  key?: string;
  /** "analysing" while BPM detection runs on a loaded file. */
  analysis: "ready" | "analysing" | "failed";
  buffer: AudioBuffer;
  /** Peak per 1/100 s (for the zoomed waveform). */
  peaks: Float32Array;
  /** Peak per overview bin. */
  overview: Float32Array;
  /** Bass / mid / high peaks for the RGB waveform; filled in by the analysis worker. */
  rgb?: RgbWaveform;
}

export const PEAKS_PER_SECOND = 100;
const OVERVIEW_BINS = 320;

export function analyseTrack(id: string, title: string, bpm: number | null, buffer: AudioBuffer, beatOffset = 0): DeckTrack {
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const hop = Math.max(1, Math.floor(buffer.sampleRate / PEAKS_PER_SECOND));
  const peaks = new Float32Array(Math.ceil(L.length / hop));
  for (let b = 0; b < peaks.length; b++) {
    let p = 0;
    const end = Math.min(L.length, (b + 1) * hop);
    for (let i = b * hop; i < end; i += 2) {
      const v = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (v > p) p = v;
    }
    peaks[b] = p;
  }
  const overview = new Float32Array(OVERVIEW_BINS);
  const per = peaks.length / OVERVIEW_BINS;
  for (let b = 0; b < OVERVIEW_BINS; b++) {
    let p = 0;
    for (let i = Math.floor(b * per); i < Math.min(peaks.length, Math.floor((b + 1) * per)); i++) p = Math.max(p, peaks[i]);
    overview[b] = p;
  }
  return { id, title, bpm, beatOffset, analysis: "ready", buffer, peaks, overview };
}

export { detectBeat, type BeatGrid } from "./beat-detect";
export { detectBeatAsync, analyseWaveformAsync } from "./analysis-client";

export class CdjDeck {
  readonly ctx: AudioContext;
  readonly output: GainNode;
  private node: ScriptProcessorNode;
  private L: Float32Array | null = null;
  private R: Float32Array | null = null;
  track: DeckTrack | null = null;

  /** Playhead in source samples. */
  pos = 0;
  playing = false;
  /** Tempo fader as a fraction (+0.06 = +6 %). */
  tempo = 0;
  reverse = false;
  /** Jog / nudge pitch bend as a fraction. */
  bend = 0;
  /** MASTER TEMPO: keep the key when the speed changes (time-stretch). */
  masterTempo = false;
  /** SYNC: follow the other deck's tempo and beat phase. */
  sync = false;
  /** Small phase-correction speed offset applied while synced. */
  syncNudge = 0;
  /** Held nudge buttons (MIDI): ± speed offset. */
  nudge = 0;
  /** Tempo fader range in % (mirrors the on-screen range button). */
  tempoRange = 10;
  /** Bumped by external control (MIDI) so the panel re-renders. */
  rev = 0;
  /** SEARCH buttons: −1, 0 or +1. */
  search = 0;
  scratching = false;
  /** Where the hand has moved the record to (source samples). */
  scratchTarget = 0;

  cue = 0;
  /** CUE held at the cue point: plays until release. */
  cuePreview = false;
  hotCues: (number | null)[] = new Array<number | null>(HOT_CUE_COUNT).fill(null);
  loopIn: number | null = null;
  loopOut: number | null = null;
  loopActive = false;

  private rate = 0;
  // master-tempo (WSOLA) state
  private win: Float32Array | null = null;
  private tailL: Float32Array | null = null;
  private tailR: Float32Array | null = null;
  private nextNatural: number | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    // 2048 frames (~43 ms at 48 kHz): this callback shares the main thread with the UI, and
    // 1024 (~21 ms) is shorter than a console redraw, so knob moves made the decks crackle.
    this.node = ctx.createScriptProcessor(2048, 1, 2);
    this.output = ctx.createGain();
    this.node.onaudioprocess = this.process;
    this.node.connect(this.output);
  }

  get sampleRate() {
    return this.track?.buffer.sampleRate ?? this.ctx.sampleRate;
  }
  get length() {
    return this.L?.length ?? 0;
  }
  get seconds() {
    return this.pos / this.sampleRate;
  }
  get duration() {
    return this.length / this.sampleRate;
  }
  /** Current effective playback speed (1 = original). */
  get speed() {
    return (1 + this.tempo) * (1 + this.bend + this.syncNudge + this.nudge);
  }
  /** Tempo-adjusted BPM (null when unknown). */
  get bpmNow() {
    const b = this.track?.bpm;
    return b ? b * (1 + this.tempo) : null;
  }
  /** Position within the current beat, 0..1 (null when there is no grid). */
  get beatPhase() {
    const t = this.track;
    if (!t?.bpm) return null;
    const beats = ((this.seconds - t.beatOffset) * t.bpm) / 60;
    return beats - Math.floor(beats);
  }

  load(track: DeckTrack) {
    this.track = track;
    this.L = track.buffer.getChannelData(0);
    this.R = track.buffer.numberOfChannels > 1 ? track.buffer.getChannelData(1) : this.L;
    this.pos = 0;
    this.cue = 0;
    this.playing = false;
    this.cuePreview = false;
    this.hotCues = new Array<number | null>(HOT_CUE_COUNT).fill(null);
    this.loopIn = this.loopOut = null;
    this.loopActive = false;
    this.sync = false;
    this.syncNudge = 0;
    this.nudge = 0;
    this.rate = 0;
    this.nextNatural = null;
  }

  seekSeconds(t: number) {
    this.pos = Math.max(0, Math.min(this.length - 2, t * this.sampleRate));
    this.scratchTarget = this.pos;
  }

  /** CDJ CUE (press). Returns nothing; read `playing` / `cue` afterwards. */
  cueDown() {
    if (!this.L) return;
    if (this.playing) {
      this.playing = false;
      this.pos = this.cue;
      return;
    }
    if (Math.abs(this.pos - this.cue) > this.sampleRate * 0.01) {
      this.cue = this.pos; // paused elsewhere → set a new cue point here
      return;
    }
    this.cuePreview = true; // paused at the cue point → play while held
    this.playing = true;
  }

  /** CDJ CUE (release): ends a cue preview unless PLAY took over. */
  cueUp() {
    if (this.cuePreview) {
      this.cuePreview = false;
      this.playing = false;
      this.pos = this.cue;
    }
  }

  togglePlay() {
    if (!this.L) return;
    if (this.cuePreview) {
      this.cuePreview = false; // PLAY during a cue preview keeps it playing
      this.playing = true;
      return;
    }
    this.playing = !this.playing;
  }

  /** SYNC on: follow `other`'s tempo and snap to its beat phase. Returns an error message or null. */
  syncTo(other: CdjDeck | null): string | null {
    if (!this.track?.bpm) return "This deck has no BPM yet.";
    if (!other?.bpmNow) return "Load a track with a BPM on the other deck first.";
    other.sync = false; // the other deck becomes the tempo master
    this.sync = true;
    this.tempo = Math.max(-1, Math.min(1, other.bpmNow / this.track.bpm - 1));
    const mine = this.beatPhase;
    const theirs = other.beatPhase;
    if (mine !== null && theirs !== null) {
      const e = theirs - mine - Math.round(theirs - mine);
      this.seekSeconds(this.seconds + (e * 60) / this.track.bpm);
    }
    return null;
  }

  /** Jog from a controller: bends while playing, frame-searches while paused. */
  jogSteps(delta: number) {
    if (!this.L) return;
    if (this.playing) this.bend = Math.max(-0.3, Math.min(0.3, this.bend + delta * 0.006));
    else this.seekSeconds(this.seconds + delta * 0.012);
  }

  hotCue(i: number, erase: boolean) {
    if (!this.L) return;
    if (erase) {
      this.hotCues[i] = null;
      return;
    }
    const at = this.hotCues[i];
    if (at === null) {
      this.hotCues[i] = this.pos;
    } else {
      this.pos = at;
      this.playing = true;
    }
  }

  loopInPress() {
    if (!this.L) return;
    this.loopIn = this.pos;
    this.cue = this.pos;
    if (this.loopOut !== null && this.loopOut <= this.loopIn) this.loopOut = null;
    this.loopActive = false;
  }

  loopOutPress() {
    if (!this.L || this.loopIn === null || this.pos <= this.loopIn + this.sampleRate * 0.02) return;
    this.loopOut = this.pos;
    this.loopActive = true;
    this.pos = this.loopIn;
  }

  reloopExit() {
    if (this.loopActive) {
      this.loopActive = false;
    } else if (this.loopIn !== null && this.loopOut !== null) {
      this.loopActive = true;
      this.pos = this.loopIn;
    }
  }

  /** Move the beat grid by `seconds` (positive = later), keeping the tempo. */
  shiftGrid(seconds: number) {
    const t = this.track;
    if (!t?.bpm) return;
    const bar = (4 * 60) / t.bpm;
    t.beatOffset = (((t.beatOffset + seconds) % bar) + bar) % bar;
  }

  /** Make the playhead position a bar line (beat 1), keeping the tempo. */
  setDownbeatHere() {
    const t = this.track;
    if (!t?.bpm) return;
    const bar = (4 * 60) / t.bpm;
    t.beatOffset = ((this.seconds % bar) + bar) % bar;
  }

  beatLoop(beats: number) {
    const bpm = this.track?.bpm;
    if (!this.L || !bpm) return;
    this.loopIn = this.pos;
    this.loopOut = this.pos + (beats * 60 * this.sampleRate) / bpm;
    this.loopActive = true;
  }

  private process = (e: AudioProcessingEvent) => {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const n = outL.length;
    const L = this.L;
    const R = this.R;
    if (!L || !R) {
      outL.fill(0);
      outR.fill(0);
      return;
    }
    const ratio = this.sampleRate / this.ctx.sampleRate;
    const last = L.length - 2;
    if (this.masterTempo && this.playing && !this.scratching && this.search === 0 && !this.reverse) {
      this.processStretch(outL, outR, n, ratio, last);
      return;
    }
    if (this.nextNatural !== null) {
      this.nextNatural = null;
      this.tailL?.fill(0);
      this.tailR?.fill(0);
    }
    let target: number;
    let k: number;
    if (this.scratching) {
      // follow the hand: cover the distance to the target over this block
      target = Math.max(-12 * ratio, Math.min(12 * ratio, (this.scratchTarget - this.pos) / n));
      k = 0.02;
    } else if (this.search !== 0) {
      target = this.search * 4 * ratio;
      k = 0.01;
    } else if (this.playing) {
      target = this.speed * (this.reverse ? -1 : 1) * ratio;
      k = 0.05;
    } else {
      target = 0;
      k = 0.08;
    }
    let pos = this.pos;
    let rate = this.rate;
    for (let i = 0; i < n; i++) {
      rate += (target - rate) * k;
      pos += rate;
      if (this.loopActive && this.loopIn !== null && this.loopOut !== null && rate > 0 && pos >= this.loopOut) {
        pos = this.loopIn + (pos - this.loopOut);
      }
      if (pos < 0) {
        pos = 0;
        rate = 0;
      } else if (pos > last) {
        pos = last;
        rate = 0;
        if (!this.scratching) this.playing = false;
      }
      const idx = pos | 0;
      const f = pos - idx;
      outL[i] = L[idx] + (L[idx + 1] - L[idx]) * f;
      outR[i] = R[idx] + (R[idx + 1] - R[idx]) * f;
    }
    this.pos = pos;
    this.rate = rate;
  };

  /**
   * MASTER TEMPO: WSOLA time-stretch. Each block emits one Hann-windowed grain read at the
   * original pitch; grains overlap 50 % and each is shifted (±~8 ms) to line up with the
   * natural continuation of the previous one, while the playhead advances at `speed`.
   */
  private processStretch(outL: Float32Array, outR: Float32Array, n: number, ratio: number, last: number) {
    const L = this.L!;
    const R = this.R!;
    const N = 2 * n;
    if (!this.win || this.win.length !== N) {
      this.win = new Float32Array(N);
      for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
      this.tailL = new Float32Array(n);
      this.tailR = new Float32Array(n);
    }
    const win = this.win;
    const tailL = this.tailL!;
    const tailR = this.tailR!;
    const at = (buf: Float32Array, p: number) => {
      if (p <= 0) return buf[0];
      if (p >= last) return buf[last];
      const i = p | 0;
      return buf[i] + (buf[i + 1] - buf[i]) * (p - i);
    };
    let start = this.pos;
    if (this.nextNatural !== null) {
      const span = Math.round(384 * ratio);
      let best = 0;
      let bestScore = -Infinity;
      for (let d = -span; d <= span; d += 8) {
        let sc = 0;
        for (let j = 0; j < n; j += 8) {
          const a = at(L, start + d + j * ratio) + at(R, start + d + j * ratio);
          const b = at(L, this.nextNatural + j * ratio) + at(R, this.nextNatural + j * ratio);
          sc += a * b;
        }
        if (sc > bestScore) {
          bestScore = sc;
          best = d;
        }
      }
      start += best;
    }
    for (let i = 0; i < N; i++) {
      const p = start + i * ratio;
      const w = win[i];
      const l = at(L, p) * w;
      const r = at(R, p) * w;
      if (i < n) {
        outL[i] = tailL[i] + l;
        outR[i] = tailR[i] + r;
      } else {
        tailL[i - n] = l;
        tailR[i - n] = r;
      }
    }
    this.nextNatural = start + n * ratio;
    const speed = this.speed;
    let pos = this.pos + n * ratio * speed;
    if (this.loopActive && this.loopIn !== null && this.loopOut !== null && pos >= this.loopOut) {
      pos = this.loopIn + (pos - this.loopOut);
      this.nextNatural = null;
    }
    if (pos >= last - N * ratio) {
      pos = Math.min(pos, last);
      this.playing = false;
    }
    this.pos = pos;
    this.rate = speed * ratio;
  }

  dispose() {
    this.node.onaudioprocess = null;
    this.node.disconnect();
    this.output.disconnect();
  }
}

// ---------------- built-in demo tracks (synthesized, no audio files) ----------------

interface DemoSpec {
  id: string;
  title: string;
  bpm: number;
  root: number; // bass root in Hz
  chords: number[][];
  bars: number;
}

export const DEMO_TRACKS: DemoSpec[] = [
  { id: "demo-124", title: "Demo track 124 · A minor", bpm: 124, root: 55, chords: [[220, 261.63, 329.63, 392], [174.61, 220, 261.63, 329.63]], bars: 32 },
  { id: "demo-128", title: "Demo track 128 · D minor", bpm: 128, root: 73.42, chords: [[293.66, 349.23, 440, 523.25], [233.08, 293.66, 349.23, 440]], bars: 32 },
];

function noise(ctx: BaseAudioContext, seconds: number, seed: number) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  let s = seed;
  for (let i = 0; i < d.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return b;
}

/** Arrangement (by bar): intro drums → bass → full → breakdown → full. */
export async function renderDemoTrack(spec: DemoSpec): Promise<DeckTrack> {
  const sr = 44100;
  const beat = 60 / spec.bpm;
  const total = spec.bars * 4 * beat;
  const ctx = new OfflineAudioContext(2, Math.ceil((total + 0.5) * sr), sr);
  const out = ctx.createGain();
  out.gain.value = 0.7;
  out.connect(ctx.destination);
  const nz = noise(ctx, 2, spec.bpm * 977);
  const section = (bar: number) => (bar < 8 ? "intro" : bar < 12 ? "build" : bar < 20 ? "full" : bar < 24 ? "break" : "full");
  const env = (g: GainNode, t: number, peak: number, a: number, d: number) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  // Notes are scheduled one bar ahead of the render (suspend/resume) instead of all up front:
  // every node scheduled in advance stays live for the whole render, which made the render
  // time grow with the square of the track length (over a minute per demo track).
  const scheduleBar = (bar: number) => {
    const sec = section(bar);
    for (let b = 0; b < 4; b++) {
      const t = (bar * 4 + b) * beat;
      if (sec !== "break") {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.setValueAtTime(155, t);
        o.frequency.exponentialRampToValueAtTime(45, t + 0.11);
        env(g, t, 1, 0.002, 0.4);
        o.connect(g).connect(out);
        o.start(t);
        o.stop(t + 0.45);
      }
      // hats: closed 16ths + open off-beat
      for (let s = 0; s < 4; s++) {
        const ht = t + (s * beat) / 4;
        const open = s === 2;
        if (sec === "break" && !open) continue;
        const src = ctx.createBufferSource();
        src.buffer = nz;
        const hp = ctx.createBiquadFilter();
        hp.type = "highpass";
        hp.frequency.value = open ? 7000 : 9500;
        const g = ctx.createGain();
        env(g, ht, open ? 0.35 : 0.12, 0.001, open ? 0.14 : 0.03);
        src.connect(hp).connect(g).connect(out);
        src.start(ht, (ht * 3.1) % 1.5);
        src.stop(ht + 0.2);
      }
      if (b % 2 === 1 && (sec === "full" || sec === "build")) {
        const src = ctx.createBufferSource();
        src.buffer = nz;
        const bp = ctx.createBiquadFilter();
        bp.type = "bandpass";
        bp.frequency.value = 1700;
        bp.Q.value = 1.3;
        const g = ctx.createGain();
        env(g, t, 0.6, 0.001, 0.13);
        src.connect(bp).connect(g).connect(out);
        src.start(t, 0.3);
        src.stop(t + 0.2);
      }
      if (sec === "build" || sec === "full") {
        const bt = t + beat / 2;
        const f = spec.root * (b === 3 ? 1.189 : 1);
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        const lp = ctx.createBiquadFilter();
        lp.type = "lowpass";
        lp.Q.value = 6;
        lp.frequency.setValueAtTime(1200, bt);
        lp.frequency.exponentialRampToValueAtTime(130, bt + 0.2);
        const g = ctx.createGain();
        env(g, bt, 0.5, 0.004, 0.25);
        o.connect(lp).connect(g).connect(out);
        o.start(bt);
        o.stop(bt + 0.3);
      }
    }
    if (sec === "full" || sec === "break") {
      const t = bar * 4 * beat;
      const len = 4 * beat;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = sec === "break" ? 3200 : 2000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(sec === "break" ? 0.16 : 0.09, t + 0.2);
      g.gain.setValueAtTime(sec === "break" ? 0.16 : 0.09, t + len - 0.1);
      g.gain.linearRampToValueAtTime(0.0001, t + len - 0.005);
      lp.connect(g).connect(out);
      spec.chords[bar % spec.chords.length].forEach((f) =>
        [-7, 7].forEach((cents) => {
          const o = ctx.createOscillator();
          o.type = "sawtooth";
          o.frequency.value = f;
          o.detune.value = cents;
          o.connect(lp);
          o.start(t);
          o.stop(t + len);
        }),
      );
    }
  };
  const barLen = 4 * beat;
  for (let bar = 0; bar < Math.min(2, spec.bars); bar++) scheduleBar(bar);
  for (let bar = 2; bar < spec.bars; bar++) {
    void ctx.suspend((bar - 1) * barLen).then(() => {
      scheduleBar(bar);
      void ctx.resume();
    });
  }
  const buffer = await ctx.startRendering();
  return analyseTrack(spec.id, spec.title, spec.bpm, buffer);
}
