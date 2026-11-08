// RGB waveform analysis: per time bin, the peak level of the bass, mid and high bands
// (red / green / blue on screen). DOM-free so it runs in the analysis worker.

export interface RgbWaveform {
  /** Bins per second (matches the deck's PEAKS_PER_SECOND). */
  rate: number;
  /** Peak of each band per bin, scaled so the loudest bin of the track reaches 1. */
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
}

const LOW_HZ = 200;
const HIGH_HZ = 2500;

/** RBJ 2nd-order Butterworth section as a per-sample closure. */
function biquad(kind: "lp" | "hp", hz: number, sampleRate: number) {
  const w0 = (2 * Math.PI * hz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  const b0 = (kind === "lp" ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b1 = (kind === "lp" ? 1 - cos : -(1 + cos)) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x: number) => {
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

export function computeRgbWaveform(mono: Float32Array, sampleRate: number, rate: number): RgbWaveform {
  const bins = Math.ceil((mono.length / sampleRate) * rate);
  const hop = sampleRate / rate;
  const low = new Float32Array(bins);
  const mid = new Float32Array(bins);
  const high = new Float32Array(bins);
  // 4th-order bands (two cascaded sections) so a kick does not paint the hats
  const lp1 = biquad("lp", LOW_HZ, sampleRate);
  const lp2 = biquad("lp", LOW_HZ, sampleRate);
  const mhp1 = biquad("hp", LOW_HZ, sampleRate);
  const mhp2 = biquad("hp", LOW_HZ, sampleRate);
  const mlp1 = biquad("lp", HIGH_HZ, sampleRate);
  const mlp2 = biquad("lp", HIGH_HZ, sampleRate);
  const hp1 = biquad("hp", HIGH_HZ, sampleRate);
  const hp2 = biquad("hp", HIGH_HZ, sampleRate);
  for (let b = 0; b < bins; b++) {
    const start = Math.floor(b * hop);
    const end = Math.min(mono.length, Math.floor((b + 1) * hop));
    let l = 0;
    let m = 0;
    let h = 0;
    for (let i = start; i < end; i++) {
      const x = mono[i];
      const lv = Math.abs(lp2(lp1(x)));
      const mv = Math.abs(mlp2(mlp1(mhp2(mhp1(x)))));
      const hv = Math.abs(hp2(hp1(x)));
      if (lv > l) l = lv;
      if (mv > m) m = mv;
      if (hv > h) h = hv;
    }
    low[b] = l;
    mid[b] = m;
    high[b] = h;
  }
  // scale so the loudest bin fills the display (CDJ-style auto gain)
  let max = 0;
  for (let b = 0; b < bins; b++) max = Math.max(max, Math.hypot(low[b], mid[b], high[b]));
  if (max > 0) {
    const k = 1 / max;
    for (let b = 0; b < bins; b++) {
      low[b] *= k;
      mid[b] *= k;
      high[b] *= k;
    }
  }
  return { rate, low, mid, high };
}

// ---------------------------------------------------------------------------------------
// Drawing helpers (pure; used by the deck canvases)

/** Band weights so hats and vocals stay visible next to the bass (rekordbox-like balance). */
const W_LOW = 1;
const W_MID = 1.5;
const W_HIGH = 2.6;
const LEVELS = 16;
let colourTable: string[] | null = null;

/** 16×16×16 colour strings, built once, so per-frame drawing allocates nothing. */
function getColourTable() {
  if (colourTable) return colourTable;
  const to255 = (level: number) => Math.round((level / (LEVELS - 1)) * 255);
  const table: string[] = [];
  // index = (red * LEVELS + green) * LEVELS + blue
  for (let red = 0; red < LEVELS; red++)
    for (let green = 0; green < LEVELS; green++)
      for (let blue = 0; blue < LEVELS; blue++) table.push(`rgb(${to255(red)},${to255(green)},${to255(blue)})`);
  colourTable = table;
  return table;
}

const column = { color: "", height: 0 };
const bands = { l: 0, m: 0, h: 0, empty: true };

/**
 * Colour and height for the band peaks of one column (a shared object: read it at once). Colour: bass → red, mids → green,
 * highs → blue, normalised so the strongest band is at full brightness.
 */
export function rgbColumn(low: number, mid: number, high: number) {
  const r = low * W_LOW;
  const g = mid * W_MID;
  const b = high * W_HIGH;
  const peak = Math.max(r, g, b, 1e-9);
  // the power curve keeps colours saturated where several bands are loud at once
  const q = (v: number) => Math.min(LEVELS - 1, Math.round(Math.pow(v / peak, 1.8) * (LEVELS - 1)));
  column.color = getColourTable()[(q(r) * LEVELS + q(g)) * LEVELS + q(b)];
  column.height = Math.min(1, Math.sqrt(low * low + mid * mid + high * high));
  return column;
}

/** Max of each band over bins [from, to) (a shared object: read it at once). */
export function bandMax(wf: RgbWaveform, from: number, to: number) {
  let l = 0;
  let m = 0;
  let h = 0;
  const a = Math.max(0, from);
  const b = Math.min(wf.low.length, to); // before the start / after the end: empty
  for (let i = a; i < b; i++) {
    if (wf.low[i] > l) l = wf.low[i];
    if (wf.mid[i] > m) m = wf.mid[i];
    if (wf.high[i] > h) h = wf.high[i];
  }
  bands.l = l;
  bands.m = m;
  bands.h = h;
  bands.empty = a >= b;
  return bands;
}
