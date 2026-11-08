// Web Audio engine modelled on the Xone:96 signal path:
// source → GAIN → EQ → channel fader → (X/Y crossfader on CH 1-4) → VCF 1 | VCF 2 | LR MIX
// SEND 1 (pre/post fader) → virtual delay, SEND 2 (post fader) → virtual reverb,
// each patched back into RTN A/B (channels A/B) or RTN C/D (aux returns) → master → limiter.

export const BPM = 124;
export const LOOP_BARS = 2;

export type FilterMode = "hpf" | "bpf" | "lpf";
export type XAssign = "x" | "off" | "y";
export type FilterAssign = "1" | "off" | "2";
/** XFADER curve switch: constant power / transition / fast-cut. */
export type XCurve = "power" | "transition" | "cut";
/** CHANNEL FADER curve switch (CH 1-4): constant power / dipped / fast-cut. */
export type FaderCurve = "power" | "dipped" | "cut";
export type LoopId = "kick" | "bass" | "hats" | "pad";
export type ReturnPatch = "A" | "B" | "C" | "D";
export type Division = "1/16" | "1/8" | "3/16" | "1/4" | "1/2";

export interface ChannelParams {
  send1: number; // 0..1
  send1Pre: boolean; // SEND 1 pre/post-fader switch
  send2: number; // 0..1
  trim: number; // dB, -12..+10
  hi: number; // dB, EQ_KILL..+6
  hiMid: number; // dB, -27..+10
  loMid: number; // dB, -27..+10
  lo: number; // dB, EQ_KILL..+6
  fader: number; // 0..1
  filter: FilterAssign;
  xf: XAssign;
}

/** Channels A and B: 3-band EQ with swept parametric MID, no crossfader assign. */
export interface AuxParams {
  send1: number;
  send1Pre: boolean;
  send2: number;
  trim: number;
  hi: number; // EQ_KILL..+6
  mid: number; // -24..+10
  midFreq: number; // 0..1 → 190 Hz..2.75 kHz
  lo: number; // EQ_KILL..+6
  fader: number;
  filter: FilterAssign;
}

/** RTN C / RTN D: ON switch + LEVEL, straight to the LR MIX. */
export interface ReturnParams {
  on: boolean;
  level: number; // 0..1
}

export interface FilterParams {
  on: boolean;
  /** Filter Type Select: one switch, or any combination pressed together (notch, all-pass). */
  types: FilterMode[];
  freq: number; // 0..1 → 20 Hz..20 kHz
  res: number; // 0..1
  crunch: number; // 0..1
}

export interface DelayParams {
  /** Footswitch: off mutes the pedal input so repeats ring out (trails). */
  on: boolean;
  division: Division;
  feedback: number; // 0..1
  tone: number; // 0..1
  pingPong: boolean;
  output: number; // 0..1
  patch: ReturnPatch;
}

export interface ReverbParams {
  on: boolean;
  decay: number; // 0..1
  predelay: number; // 0..1
  damp: number; // 0..1
  output: number; // 0..1
  patch: ReturnPatch;
}

export interface MixerParams {
  channels: ChannelParams[]; // CH 1-4
  aux: AuxParams[]; // CH A, CH B
  returns: ReturnParams[]; // RTN C, RTN D
  filters: FilterParams[];
  xfader: number; // -1 (X) .. 1 (Y)
  xCurve: XCurve;
  chCurve: FaderCurve;
  master: number; // 0..1
  delay: DelayParams;
  reverb: ReverbParams;
}

export const EQ_KILL = -40;
export const EQ_FREQS = { lo: 180, loMid: 350, hiMid: 1100, hi: 3000 };
export const AUX_EQ = { lo: 180, hi: 3000, midMin: 190, midMax: 2750 };
export const DIVISIONS: Division[] = ["1/16", "1/8", "3/16", "1/4", "1/2"];
const DIVISION_BEATS: Record<Division, number> = { "1/16": 0.25, "1/8": 0.5, "3/16": 0.75, "1/4": 1, "1/2": 2 };

export function freqFromNorm(n: number) {
  return 20 * Math.pow(1000, n);
}
/** RES: MILD (0.7) .. WILD (~11, just short of self-oscillation). Linear Q. */
export function qFromNorm(n: number) {
  return 0.7 * Math.pow(16, n);
}
export function faderGain(pos: number) {
  return pos * pos;
}
export function midFreqFromNorm(n: number) {
  return AUX_EQ.midMin * Math.pow(AUX_EQ.midMax / AUX_EQ.midMin, n);
}
/** Delay time for a note division at `bpm` (the playing deck's tempo; loops: 124). */
export function delaySeconds(d: Division, bpm = BPM) {
  return Math.min(1.99, (60 / bpm) * DIVISION_BEATS[d]); // DelayNode max is 2 s
}
export function delayToneHz(n: number) {
  return 600 * Math.pow(25, n); // 600 Hz .. 15 kHz
}
export function reverbDecaySeconds(n: number) {
  return 0.4 * Math.pow(20, n); // 0.4 s .. 8 s
}
export function reverbPredelayMs(n: number) {
  return n * 120;
}
export function reverbDampHz(n: number) {
  return 18000 * Math.pow(1500 / 18000, n); // 18 kHz (bright) .. 1.5 kHz (dark)
}
/** Return LEVEL: fully off .. +5 dB, unity at 3 o'clock. */
export function returnGain(pos: number) {
  return Math.pow(pos / 0.75, 2);
}
export function xfaderGains(pos: number, curve: XCurve) {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  if (curve === "cut") return { x: clamp((1 - pos) / 0.08), y: clamp((1 + pos) / 0.08) };
  if (curve === "transition") return { x: clamp((1 - pos) / 2), y: clamp((1 + pos) / 2) };
  const t = ((pos + 1) / 2) * (Math.PI / 2);
  return { x: Math.cos(t), y: Math.sin(t) };
}
export function channelFaderGain(pos: number, curve: FaderCurve) {
  if (curve === "cut") return Math.min(1, pos / 0.12);
  if (curve === "dipped") return Math.pow(pos, 3.5);
  return pos * pos;
}

function eqGain(db: number) {
  return db <= EQ_KILL + 0.5 ? -60 : db;
}

type EqKind = "4band" | "3band";

class Strip {
  trim: GainNode;
  rtnIn: GainNode;
  /** One input per deck; the channel's input selector opens one of them. */
  deckIn: GainNode[];
  bands: BiquadFilterNode[];
  eqOut: AudioNode;
  fader: GainNode;
  xf: GainNode;
  send1: GainNode;
  send2: GainNode;
  analyser: AnalyserNode;
  source: AudioBufferSourceNode | null = null;
  buffer: AudioBuffer | null = null;
  route: FilterAssign | null = null;
  send1Pre: boolean | null = null;

  constructor(ctx: BaseAudioContext, kind: EqKind) {
    this.trim = ctx.createGain();
    this.rtnIn = ctx.createGain();
    this.rtnIn.gain.value = 0;
    this.rtnIn.connect(this.trim);
    this.deckIn = [0, 1].map(() => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(this.trim);
      return g;
    });
    const mk = (type: BiquadFilterType, f: number, q = 0.9) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      b.gain.value = 0;
      return b;
    };
    this.bands =
      kind === "4band"
        ? [
            mk("lowshelf", EQ_FREQS.lo),
            mk("peaking", EQ_FREQS.loMid, 0.8),
            mk("peaking", EQ_FREQS.hiMid, 0.8),
            mk("highshelf", EQ_FREQS.hi),
          ]
        : [mk("lowshelf", AUX_EQ.lo), mk("peaking", 700, 1.1), mk("highshelf", AUX_EQ.hi)];
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.send1 = ctx.createGain();
    this.send2 = ctx.createGain();
    this.send1.gain.value = 0;
    this.send2.gain.value = 0;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    let node: AudioNode = this.trim;
    for (const b of this.bands) {
      node.connect(b);
      node = b;
    }
    this.eqOut = node;
    node.connect(this.analyser);
    node.connect(this.fader);
    this.fader.connect(this.xf);
    this.fader.connect(this.send2);
  }
}

const FILTER_TYPES: FilterMode[] = ["hpf", "bpf", "lpf"];
const BIQUAD_TYPE: Record<FilterMode, BiquadFilterType> = { hpf: "highpass", bpf: "bandpass", lpf: "lowpass" };

/** Gains for the three state-variable outputs. All three together = HP − BP + LP (true all-pass). */
export function filterMix(types: FilterMode[] | undefined): Record<FilterMode, number> {
  const sel = types && types.length > 0 ? types : (["lpf"] as FilterMode[]);
  const on = (t: FilterMode) => (sel.includes(t) ? 1 : 0);
  const all = sel.length === 3;
  return { hpf: on("hpf"), bpf: all ? -1 : on("bpf"), lpf: on("lpf") };
}

/**
 * Xone:VCF model: CRUNCH (pre-filter waveshaper) → state-variable style filter with
 * simultaneous HP / BP / LP outputs (matched RBJ biquads, same f and Q) summed per the
 * Filter Type Select switches. HP+LP sums to an exact notch.
 */
class Vcf {
  input: GainNode;
  dry: GainNode;
  drive: GainNode;
  shaper: WaveShaperNode;
  makeup: GainNode;
  outs: Record<FilterMode, { filter: BiquadFilterNode; gain: GainNode; probe: BiquadFilterNode }>;
  wet: GainNode;
  output: GainNode;
  lastCrunch = -1;
  /** Which feeds are connected: the drive path (filter on) and each filter type in use. */
  private linked: Record<"drive" | FilterMode, boolean> = { drive: true, hpf: true, bpf: true, lpf: true };
  private unlinkTimers: Partial<Record<"drive" | FilterMode, number>> = {};

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.dry = ctx.createGain();
    this.drive = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = "4x";
    this.makeup = ctx.createGain();
    this.wet = ctx.createGain();
    this.output = ctx.createGain();
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.drive);
    this.drive.connect(this.shaper);
    this.shaper.connect(this.makeup);
    const mk = (t: FilterMode) => {
      const filter = ctx.createBiquadFilter();
      filter.type = BIQUAD_TYPE[t];
      const probe = ctx.createBiquadFilter();
      probe.type = BIQUAD_TYPE[t];
      const gain = ctx.createGain();
      gain.gain.value = 0;
      this.makeup.connect(filter);
      filter.connect(gain);
      gain.connect(this.wet);
      return { filter, gain, probe };
    };
    this.outs = { hpf: mk("hpf"), bpf: mk("bpf"), lpf: mk("lpf") };
    this.wet.connect(this.output);
    this.wet.gain.value = 0;
  }

  /**
   * CPU: feed only the parts that can be heard. A filter that is off, or a filter type that
   * is not selected, is unplugged once its gain has faded (so it cannot click), and the
   * browser stops processing it. Plugging back in is immediate; the gain fades in.
   */
  setActive(on: boolean, mix: Record<FilterMode, number>) {
    const want: Record<"drive" | FilterMode, boolean> = {
      drive: on,
      hpf: on && mix.hpf !== 0,
      bpf: on && mix.bpf !== 0,
      lpf: on && mix.lpf !== 0,
    };
    const feed = (k: "drive" | FilterMode, connect: boolean) => {
      const [from, to] = k === "drive" ? [this.input, this.drive] : [this.makeup, this.outs[k].filter];
      if (connect) from.connect(to);
      else from.disconnect(to);
    };
    for (const k of ["drive", ...FILTER_TYPES] as const) {
      const timer = this.unlinkTimers[k];
      if (want[k]) {
        if (timer !== undefined) {
          clearTimeout(timer);
          delete this.unlinkTimers[k];
        }
        if (!this.linked[k]) {
          feed(k, true);
          this.linked[k] = true;
        }
      } else if (this.linked[k] && timer === undefined) {
        this.unlinkTimers[k] = window.setTimeout(() => {
          delete this.unlinkTimers[k];
          if (this.linked[k]) {
            feed(k, false);
            this.linked[k] = false;
          }
        }, 120);
      }
    }
  }

  /** Web Audio LP/HP take Q in dB; BP takes linear Q. Keep all three on the same linear Q. */
  static qFor(t: FilterMode, qLin: number) {
    return t === "bpf" ? qLin : 20 * Math.log10(qLin);
  }

  setCrunch(amount: number) {
    if (Math.abs(amount - this.lastCrunch) < 0.005) return;
    this.lastCrunch = amount;
    if (amount <= 0.001) {
      this.shaper.curve = null;
      this.makeup.gain.value = 1;
      return;
    }
    const d = 1 + amount * 14;
    const n = 2048;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      // asymmetric soft clip → even + odd harmonics, like an overdriven analogue stage
      curve[i] = Math.tanh(d * x + 0.15 * amount * x * x) / Math.tanh(d);
    }
    this.shaper.curve = curve;
    this.makeup.gain.value = 1 / (1 + amount * 0.6);
  }
}

/** Virtual outboard stereo delay, tempo-synced, fed from SND 1. */
class DelayUnit {
  input: GainNode;
  dL: DelayNode;
  dR: DelayNode;
  toneL: BiquadFilterNode;
  toneR: BiquadFilterNode;
  /** Low cut in the loop: repeats thin out instead of piling up bass. */
  lowCutL: BiquadFilterNode;
  lowCutR: BiquadFilterNode;
  fbL: GainNode;
  fbR: GainNode;
  /** Soft limiter in the loop (tape-like): linear at normal levels, rounds off build-ups. */
  satL: WaveShaperNode;
  satR: WaveShaperNode;
  merger: ChannelMergerNode;
  output: GainNode;
  pingPong: boolean | null = null;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.dL = ctx.createDelay(2);
    this.dR = ctx.createDelay(2);
    this.toneL = ctx.createBiquadFilter();
    this.toneR = ctx.createBiquadFilter();
    this.toneL.type = "lowpass";
    this.toneR.type = "lowpass";
    const lowCut = () => {
      const f = ctx.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = 120;
      f.Q.value = 0.6;
      return f;
    };
    this.lowCutL = lowCut();
    this.lowCutR = lowCut();
    this.fbL = ctx.createGain();
    this.fbR = ctx.createGain();
    const curve = new Float32Array(1025);
    // tanh: gain 1 for quiet repeats (so REPEAT keeps its meaning), rounds off loud build-ups
    for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / (curve.length - 1)) * 2 - 1);
    const sat = () => {
      const w = ctx.createWaveShaper();
      w.curve = curve;
      w.oversample = "2x";
      return w;
    };
    this.satL = sat();
    this.satR = sat();
    this.merger = ctx.createChannelMerger(2);
    this.output = ctx.createGain();
    this.dL.connect(this.toneL).connect(this.lowCutL);
    this.dR.connect(this.toneR).connect(this.lowCutR);
    this.lowCutL.connect(this.fbL).connect(this.satL);
    this.lowCutR.connect(this.fbR).connect(this.satR);
    this.lowCutL.connect(this.merger, 0, 0);
    this.lowCutR.connect(this.merger, 0, 1);
    this.merger.connect(this.output);
  }

  setMode(pingPong: boolean) {
    if (this.pingPong === pingPong) return;
    if (this.pingPong !== null) {
      this.input.disconnect();
      this.satL.disconnect();
      this.satR.disconnect();
    }
    if (pingPong) {
      // L repeats into R, R back into L
      this.input.connect(this.dL);
      this.satL.connect(this.dR);
      this.satR.connect(this.dL);
    } else {
      this.input.connect(this.dL);
      this.input.connect(this.dR);
      this.satL.connect(this.dL);
      this.satR.connect(this.dR);
    }
    this.pingPong = pingPong;
  }
}

/** Virtual outboard reverb (generated stereo impulse), fed from SND 2. */
class ReverbUnit {
  input: GainNode;
  pre: DelayNode;
  conv: ConvolverNode;
  damp: BiquadFilterNode;
  output: GainNode;
  lastDecay = -1;

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createGain();
    this.pre = ctx.createDelay(0.5);
    this.conv = ctx.createConvolver();
    this.conv.normalize = true;
    this.damp = ctx.createBiquadFilter();
    this.damp.type = "lowpass";
    this.output = ctx.createGain();
    this.input.connect(this.pre);
    this.pre.connect(this.conv);
    this.conv.connect(this.damp);
    this.damp.connect(this.output);
  }

  private decayTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Rebuilding the impulse (up to 8 s of stereo noise) is heavy main-thread work; doing it on
   * every knob tick starves the decks and crackles. Build the first one now, then rebuild only
   * once the DECAY control has settled.
   */
  setDecay(ctx: BaseAudioContext, seconds: number) {
    if (Math.abs(seconds - this.lastDecay) < 0.05) return;
    if (this.lastDecay < 0) {
      this.buildImpulse(ctx, seconds);
      return;
    }
    if (this.decayTimer !== null) clearTimeout(this.decayTimer);
    this.decayTimer = setTimeout(() => {
      this.decayTimer = null;
      this.buildImpulse(ctx, seconds);
    }, 180);
  }

  dispose() {
    if (this.decayTimer !== null) clearTimeout(this.decayTimer);
    this.decayTimer = null;
  }

  private buildImpulse(ctx: BaseAudioContext, seconds: number) {
    this.lastDecay = seconds;
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * seconds));
    const ir = ctx.createBuffer(2, len, sr);
    // One-pole low-pass coefficient for the band split.
    const pole = (hz: number) => Math.exp((-2 * Math.PI * hz) / sr);
    const aLo = pole(500);
    const aHi = pole(4000);
    // −60 dB times per band, as per-sample multipliers (no exp() per sample: this runs on the
    // main thread). Highs die away faster than lows, like a real room.
    const fallOf = (t: number) => Math.exp(-6.9 / (t * sr));
    const fallLo = fallOf(seconds);
    const fallMid = fallOf(seconds * 0.85);
    const fallHi = fallOf(seconds * 0.45);
    const attackLen = 0.015 * sr;
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      let seed = (987654321 + c * 7919) | 0;
      const rnd = () => {
        seed = (Math.imul(seed, 1103515245) + 12345) | 0;
        return ((seed >>> 1) / 0x7fffffff) * 2 - 1;
      };
      let lo = 0;
      let lpHi = 0;
      let eLo = 1;
      let eMid = 1;
      let eHi = 1;
      for (let i = 0; i < len; i++) {
        const n = rnd();
        lo = (1 - aLo) * n + aLo * lo;
        lpHi = (1 - aHi) * n + aHi * lpHi;
        const v = lo * 2.2 * eLo + (lpHi - lo) * eMid + (n - lpHi) * eHi;
        d[i] = v * (i < attackLen ? i / attackLen : 1);
        eLo *= fallLo;
        eMid *= fallMid;
        eHi *= fallHi;
      }
      // early reflections: a few discrete echoes in the first 60 ms, different per side
      for (let k = 0; k < 10; k++) {
        const at = Math.floor((0.007 + 0.053 * ((k + 0.5 + 0.4 * rnd()) / 10)) * sr);
        if (at < len) d[at] += (rnd() < 0 ? -1 : 1) * (0.9 - 0.06 * k);
      }
    }
    this.conv.buffer = ir;
  }
}

export class MixerEngine {
  ctx: AudioContext;
  strips: Strip[]; // 0-3 = CH 1-4, 4 = CH A, 5 = CH B
  vcfs: Vcf[];
  bus: GainNode;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  send1Bus: GainNode;
  send2Bus: GainNode;
  delay: DelayUnit;
  reverb: ReverbUnit;
  returns: Record<ReturnPatch, GainNode>;
  retOn: GainNode[]; // RTN C, D
  retLevel: GainNode[];
  retAnalyser: AnalyserNode[];
  delayPatch: ReturnPatch | null = null;
  /** Tempo the delay is synced to: the playing deck (or the loops). */
  fxBpm = BPM;
  private delayDivision: Division = "1/4";
  reverbPatch: ReturnPatch | null = null;
  loops: Partial<Record<LoopId, AudioBuffer>> = {};
  playing = false;
  t0 = 0;
  private scratch = new Float32Array(1024);

  constructor() {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: "interactive" });
    const ctx = this.ctx;
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.5; // LR MIX headroom
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.08;
    const split = ctx.createChannelSplitter(2);
    this.analyserL = ctx.createAnalyser();
    this.analyserR = ctx.createAnalyser();
    this.analyserL.fftSize = 1024;
    this.analyserR.fftSize = 1024;
    this.bus.connect(this.master);
    this.master.connect(this.limiter);
    this.limiter.connect(ctx.destination);
    this.limiter.connect(split);
    split.connect(this.analyserL, 0);
    split.connect(this.analyserR, 1);

    this.vcfs = [new Vcf(ctx), new Vcf(ctx)];
    this.vcfs.forEach((v) => v.output.connect(this.bus));
    this.strips = [
      ...[0, 1, 2, 3].map(() => new Strip(ctx, "4band")),
      new Strip(ctx, "3band"),
      new Strip(ctx, "3band"),
    ];

    // FX sends → virtual outboard → returns
    this.send1Bus = ctx.createGain();
    this.send2Bus = ctx.createGain();
    this.strips.forEach((s) => s.send2.connect(this.send2Bus));
    this.delay = new DelayUnit(ctx);
    this.reverb = new ReverbUnit(ctx);
    this.send1Bus.connect(this.delay.input);
    this.send2Bus.connect(this.reverb.input);
    this.returns = { A: ctx.createGain(), B: ctx.createGain(), C: ctx.createGain(), D: ctx.createGain() };
    this.returns.A.connect(this.strips[4].rtnIn);
    this.returns.B.connect(this.strips[5].rtnIn);
    this.retOn = [ctx.createGain(), ctx.createGain()];
    this.retLevel = [ctx.createGain(), ctx.createGain()];
    this.retAnalyser = [ctx.createAnalyser(), ctx.createAnalyser()];
    (["C", "D"] as const).forEach((k, i) => {
      this.retAnalyser[i].fftSize = 1024;
      this.returns[k].connect(this.retOn[i]);
      this.retOn[i].connect(this.retLevel[i]);
      this.retLevel[i].connect(this.retAnalyser[i]);
      this.retLevel[i].connect(this.bus);
    });
  }

  private route(s: Strip, filter: FilterAssign) {
    if (s.route === filter) return;
    if (s.route !== null) s.xf.disconnect();
    s.xf.connect(filter === "off" ? this.bus : this.vcfs[filter === "1" ? 0 : 1].input);
    s.route = filter;
  }

  private tapSend1(s: Strip, pre: boolean) {
    if (s.send1Pre === pre) return;
    if (s.send1Pre !== null) (s.send1Pre ? s.eqOut : s.fader).disconnect(s.send1);
    (pre ? s.eqOut : s.fader).connect(s.send1);
    if (s.send1Pre === null) s.send1.connect(this.send1Bus);
    s.send1Pre = pre;
  }

  private patch(out: AudioNode, prev: ReturnPatch | null, next: ReturnPatch) {
    if (prev === next) return next;
    if (prev !== null) out.disconnect();
    out.connect(this.returns[next]);
    return next;
  }

  /** Plug the deck outputs into every channel's deck inputs (each input starts closed). */
  attachDecks(outputs: AudioNode[]) {
    outputs.forEach((out, d) => this.strips.forEach((s) => out.connect(s.deckIn[d])));
  }

  /** Channel input select: open the input for `deck` (or none). */
  setDeckInput(stripIndex: number, deck: number | null) {
    this.strips[stripIndex].deckIn.forEach((g, d) => g.gain.setTargetAtTime(d === deck ? 1 : 0, this.ctx.currentTime, 0.01));
  }

  /** Channel A/B input select: RTN (from the FX patch) vs a playback source. */
  setReturnInput(auxIndex: number, rtn: boolean) {
    this.strips[4 + auxIndex].rtnIn.gain.setTargetAtTime(rtn ? 1 : 0, this.ctx.currentTime, 0.01);
  }

  apply(p: MixerParams) {
    const now = this.ctx.currentTime;
    const tc = 0.012;
    const set = (a: AudioParam, v: number, t = tc) => a.setTargetAtTime(v, now, t);
    const xg = xfaderGains(p.xfader, p.xCurve);
    p.channels.forEach((c, i) => {
      const s = this.strips[i];
      set(s.trim.gain, Math.pow(10, c.trim / 20));
      set(s.bands[0].gain, eqGain(c.lo));
      set(s.bands[1].gain, c.loMid);
      set(s.bands[2].gain, c.hiMid);
      set(s.bands[3].gain, eqGain(c.hi));
      set(s.fader.gain, channelFaderGain(c.fader, p.chCurve), 0.004);
      set(s.xf.gain, c.xf === "x" ? xg.x : c.xf === "y" ? xg.y : 1, 0.004);
      set(s.send1.gain, faderGain(c.send1));
      set(s.send2.gain, faderGain(c.send2));
      this.tapSend1(s, c.send1Pre);
      this.route(s, c.filter);
    });
    p.aux.forEach((a, i) => {
      const s = this.strips[4 + i];
      set(s.trim.gain, Math.pow(10, a.trim / 20));
      set(s.bands[0].gain, eqGain(a.lo));
      set(s.bands[1].gain, a.mid);
      set(s.bands[1].frequency, midFreqFromNorm(a.midFreq));
      set(s.bands[2].gain, eqGain(a.hi));
      set(s.fader.gain, faderGain(a.fader));
      set(s.send1.gain, faderGain(a.send1));
      set(s.send2.gain, faderGain(a.send2));
      this.tapSend1(s, a.send1Pre);
      this.route(s, a.filter);
    });
    p.returns.forEach((r, i) => {
      set(this.retOn[i].gain, r.on ? 1 : 0, 0.01);
      set(this.retLevel[i].gain, returnGain(r.level));
    });
    p.filters.forEach((f, i) => {
      const v = this.vcfs[i];
      const hz = freqFromNorm(f.freq);
      const q = qFromNorm(f.res);
      const mix = filterMix(f.types);
      for (const t of FILTER_TYPES) {
        const o = v.outs[t];
        set(o.filter.frequency, hz);
        set(o.filter.Q, Vcf.qFor(t, q));
        set(o.gain.gain, mix[t], 0.006);
        o.probe.frequency.value = hz;
        o.probe.Q.value = Vcf.qFor(t, q);
      }
      v.setCrunch(f.crunch);
      v.setActive(f.on, mix);
      set(v.wet.gain, f.on ? 1 : 0, 0.01);
      set(v.dry.gain, f.on ? 0 : 1, 0.01);
    });

    const d = p.delay;
    set(this.delay.input.gain, d.on === false ? 0 : 1, 0.01);
    this.delayDivision = d.division;
    const t = delaySeconds(d.division, this.fxBpm);
    set(this.delay.dL.delayTime, t, 0.03);
    set(this.delay.dR.delayTime, t, 0.03);
    const fb = d.feedback * 0.92;
    set(this.delay.fbL.gain, fb);
    set(this.delay.fbR.gain, fb);
    set(this.delay.toneL.frequency, delayToneHz(d.tone));
    set(this.delay.toneR.frequency, delayToneHz(d.tone));
    set(this.delay.output.gain, faderGain(d.output) * 1.6);
    this.delay.setMode(d.pingPong);
    this.delayPatch = this.patch(this.delay.output, this.delayPatch, d.patch);

    const r = p.reverb;
    set(this.reverb.input.gain, r.on === false ? 0 : 1, 0.01);
    this.reverb.setDecay(this.ctx, reverbDecaySeconds(r.decay));
    set(this.reverb.pre.delayTime, reverbPredelayMs(r.predelay) / 1000, 0.03);
    set(this.reverb.damp.frequency, reverbDampHz(r.damp));
    set(this.reverb.output.gain, faderGain(r.output) * 2.2);
    this.reverbPatch = this.patch(this.reverb.output, this.reverbPatch, r.patch);

    set(this.master.gain, faderGain(p.master) * 1.4);
  }

  /** Follow a new tempo: the delay glides to the new beat length (no clicks). */
  setFxTempo(bpm: number) {
    if (!(bpm > 0) || Math.abs(bpm - this.fxBpm) < 0.01) return;
    this.fxBpm = bpm;
    const t = delaySeconds(this.delayDivision, bpm);
    const now = this.ctx.currentTime;
    this.delay.dL.delayTime.setTargetAtTime(t, now, 0.05);
    this.delay.dR.delayTime.setTargetAtTime(t, now, 0.05);
  }

  /** Magnitude response of the selected type combination (complex sum of the three outputs). */
  filterResponse(i: number, freqs: Float32Array, types: FilterMode[]) {
    const n = freqs.length;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const mag = new Float32Array(n);
    const phase = new Float32Array(n);
    const mix = filterMix(types);
    for (const t of FILTER_TYPES) {
      if (mix[t] === 0) continue;
      this.vcfs[i].outs[t].probe.getFrequencyResponse(freqs, mag, phase);
      for (let k = 0; k < n; k++) {
        re[k] += mix[t] * mag[k] * Math.cos(phase[k]);
        im[k] += mix[t] * mag[k] * Math.sin(phase[k]);
      }
    }
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = Math.hypot(re[k], im[k]);
    return out;
  }

  private startStrip(i: number, when: number) {
    const s = this.strips[i];
    if (!s.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = s.buffer;
    src.loop = true;
    src.connect(s.trim);
    const offset = Math.max(0, when - this.t0) % s.buffer.duration;
    src.start(when, offset);
    s.source = src;
  }

  private stopStrip(i: number) {
    const s = this.strips[i];
    if (s.source) {
      try {
        s.source.stop();
      } catch {
        /* already stopped */
      }
      s.source.disconnect();
      s.source = null;
    }
  }

  setBuffer(i: number, buffer: AudioBuffer | null) {
    this.stopStrip(i);
    this.strips[i].buffer = buffer;
    if (this.playing) this.startStrip(i, this.ctx.currentTime + 0.02);
  }

  async play() {
    await this.ctx.resume();
    this.t0 = this.ctx.currentTime + 0.06;
    this.strips.forEach((_, i) => {
      this.stopStrip(i);
      this.startStrip(i, this.t0);
    });
    this.playing = true;
  }

  stop() {
    this.strips.forEach((_, i) => this.stopStrip(i));
    this.playing = false;
  }

  private peak(a: AnalyserNode) {
    const buf = this.scratch;
    a.getFloatTimeDomainData(buf);
    let p = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i]);
      if (v > p) p = v;
    }
    return p;
  }

  levels() {
    return {
      channels: this.strips.map((s) => this.peak(s.analyser)),
      returns: this.retAnalyser.map((a) => this.peak(a)),
      l: this.peak(this.analyserL),
      r: this.peak(this.analyserR),
    };
  }

  async decode(data: ArrayBuffer) {
    return this.ctx.decodeAudioData(data);
  }

  dispose() {
    this.stop();
    this.reverb.dispose();
    void this.ctx.close();
  }
}

// ---------- Built-in loops, rendered offline so all four stay sample-locked ----------

const SR = 44100;
const BEAT = 60 / BPM;
const LOOP_SECONDS = BEAT * 4 * LOOP_BARS;

function noiseBuffer(ctx: BaseAudioContext, seconds: number) {
  const b = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  const d = b.getChannelData(0);
  let seed = 1234567;
  for (let i = 0; i < d.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (seed / 0x7fffffff) * 2 - 1;
  }
  return b;
}

function env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

type Renderer = (ctx: OfflineAudioContext, out: AudioNode) => void;

const renderKick: Renderer = (ctx, out) => {
  for (let b = 0; b < 4 * LOOP_BARS; b++) {
    const t = b * BEAT;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.11);
    env(g, t, 1, 0.002, 0.42);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + 0.5);
  }
};

const renderBass: Renderer = (ctx, out) => {
  const notes = [55, 55, 65.41, 49, 55, 55, 73.42, 65.41];
  for (let b = 0; b < 4 * LOOP_BARS; b++) {
    const t = b * BEAT + BEAT / 2;
    const f = notes[b % notes.length];
    const o = ctx.createOscillator();
    o.type = "sawtooth";
    o.frequency.value = f;
    const sub = ctx.createOscillator();
    sub.type = "square";
    sub.frequency.value = f / 2;
    const subG = ctx.createGain();
    subG.gain.value = 0.35;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(1400, t);
    lp.frequency.exponentialRampToValueAtTime(140, t + 0.2);
    const g = ctx.createGain();
    env(g, t, 0.8, 0.004, 0.26);
    o.connect(lp);
    sub.connect(subG).connect(lp);
    lp.connect(g).connect(out);
    o.start(t);
    sub.start(t);
    o.stop(t + 0.32);
    sub.stop(t + 0.32);
  }
};

const renderHats: Renderer = (ctx, out) => {
  const noise = noiseBuffer(ctx, LOOP_SECONDS + 1);
  const hit = (t: number, type: BiquadFilterType, f: number, peak: number, decay: number, q = 0.7) => {
    const s = ctx.createBufferSource();
    s.buffer = noise;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const g = ctx.createGain();
    env(g, t, peak, 0.001, decay);
    s.connect(flt).connect(g).connect(out);
    s.start(t, (t * 7.3) % 0.9);
    s.stop(t + decay + 0.05);
  };
  const steps = 16 * LOOP_BARS;
  for (let i = 0; i < steps; i++) {
    const t = (i * BEAT) / 4;
    const pos = i % 4;
    if (pos === 2) hit(t, "highpass", 7000, 0.55, 0.16);
    else hit(t, "highpass", 9000, pos === 0 ? 0.22 : 0.14, 0.035);
    if (pos === 0 && Math.floor(i / 4) % 2 === 1) {
      for (let k = 0; k < 3; k++) hit(t + k * 0.011, "bandpass", 1500, 0.9, k === 2 ? 0.14 : 0.012, 1.4);
    }
  }
};

const renderPad: Renderer = (ctx, out) => {
  const chords = [
    [220, 261.63, 329.63, 392],
    [174.61, 220, 261.63, 329.63],
  ];
  const barLen = BEAT * 4;
  for (let bar = 0; bar < LOOP_BARS; bar++) {
    const t = bar * barLen;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 2200;
    lp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.22, t + 0.25);
    g.gain.setValueAtTime(0.22, t + barLen - 0.12);
    g.gain.linearRampToValueAtTime(0.0001, t + barLen - 0.005);
    lp.connect(g).connect(out);
    chords[bar % chords.length].forEach((f) => {
      [-8, 8].forEach((cents) => {
        const o = ctx.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = f;
        o.detune.value = cents;
        o.connect(lp);
        o.start(t);
        o.stop(t + barLen);
      });
    });
  }
};

const RENDERERS: Record<LoopId, Renderer> = {
  kick: renderKick,
  bass: renderBass,
  hats: renderHats,
  pad: renderPad,
};

export const LOOP_LABELS: Record<LoopId, string> = {
  kick: "Kick",
  bass: "Bass",
  hats: "Hats",
  pad: "Pads",
};

export async function renderLoop(id: LoopId): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.round(LOOP_SECONDS * SR), SR);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  RENDERERS[id](ctx, out);
  const buf = await ctx.startRendering();
  let peak = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  }
  if (peak > 0) {
    const k = 0.8 / peak;
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < d.length; i++) d[i] *= k;
    }
  }
  return buf;
}
