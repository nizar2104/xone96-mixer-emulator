// SPDX-License-Identifier: GPL-2.0-or-later
//
// Tempo + beat-grid detection: a TypeScript port of the beat analysis used by Mixxx
// (https://github.com/mixxxdj/mixxx), which is built on the Queen Mary DSP library:
//
//  - Mixxx  src/analyzer/plugins/analyzerqueenmarybeats.cpp, buffering_utils.cpp
//           src/track/beatutils.cpp, beatfactory.cpp            (Mixxx project, GPL-2.0-or-later)
//  - qm-dsp dsp/onsets/DetectionFunction.cpp                     (Christian Landone, 2005-2006)
//           dsp/phasevocoder/PhaseVocoder.cpp
//           dsp/tempotracking/TempoTrackV2.cpp                    (Matthew Davies, Adam Stark;
//                                                                   MEPD 2012 changes)
//           dsp/tempotracking/DownBeat.cpp                        (Matthew Davies, Chris Cannam)
//           maths/MathUtilities.cpp
//           Centre for Digital Music, Queen Mary, University of London. GPL-2.0-or-later.
//
// This program is free software; you can redistribute it and/or modify it under the terms
// of the GNU General Public License as published by the Free Software Foundation; either
// version 2 of the License, or (at your option) any later version. See LICENSE.
//
// Pipeline (as in Mixxx's fixed-tempo analysis):
//  1. complex spectral difference onset function, ~11.6 ms steps (AnalyzerQueenMaryBeats)
//  2. TempoTrackV2: beat period path (comb filter bank + Viterbi), then beats (dynamic
//     programming)
//  3. BeatUtils: constant-tempo regions, one constant BPM (snapped to a "round" value
//     when the beats allow it) and a phase adjusted to the detected beats
//  4. Beat 1: qm-dsp DownBeat (spectral change between consecutive beats). Mixxx itself
//     does not detect downbeats; this step comes from the Queen Mary bar-and-beat tracker.
//
// Kept free of DOM / Web Audio dependencies so it can run in a worker (see analysis-worker.ts):
// analysing a whole track takes long enough on the main thread to starve the decks.

/** The parts of an AudioBuffer the detector reads (a worker gets a plain object). */
export interface PcmSource {
  sampleRate: number;
  numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

export interface BeatGrid {
  bpm: number;
  /** Time of a downbeat (bar line), seconds. */
  offset: number;
}

const EPS = 0.0000008; // TempoTrackV2 / DownBeat

// ---------------------------------------------------------------------------------------
// small maths helpers (MathUtilities)

/** C-style fmod (sign follows the dividend), as used by MathUtilities::mod and fmod. */
const fmod = (a: number, b: number) => a % b;

/** MathUtilities::princarg: wrap to (-π, π]. */
function princarg(ang: number) {
  const y = -2 * Math.PI;
  const x = ang + Math.PI;
  return x - y * Math.floor(x / y) + Math.PI;
}

/** MathUtilities::adaptiveThreshold: subtract a moving mean (8 before, 7 after), floor at 0. */
function adaptiveThreshold(data: Float64Array) {
  const sz = data.length;
  if (sz === 0) return;
  const smoothed = new Float64Array(sz);
  for (let i = 0; i < sz; i++) {
    const first = Math.max(0, i - 8);
    const last = Math.min(sz - 1, i + 7);
    let s = 0;
    for (let k = first; k <= last; k++) s += data[k];
    smoothed[i] = s / (last - first + 1);
  }
  for (let i = 0; i < sz; i++) {
    data[i] -= smoothed[i];
    if (data[i] < 0) data[i] = 0;
  }
}

function nextPowerOfTwo(x: number) {
  if (x >= 1 && (x & (x - 1)) === 0) return x;
  if (x < 1) return 1;
  let n = 1;
  while (x) {
    x >>= 1;
    n <<= 1;
  }
  return n;
}

/** Index of the first maximum strictly above 0 (TempoTrackV2::get_max_ind). */
function maxIndex(v: ArrayLike<number>) {
  let maxval = 0;
  let ind = 0;
  for (let i = 0; i < v.length; i++) {
    if (maxval < v[i]) {
      maxval = v[i];
      ind = i;
    }
  }
  return ind;
}

/** C++ std::round: halves away from zero. */
const roundHalfAway = (x: number) => (x < 0 ? -Math.round(-x) : Math.round(x));

// ---------------------------------------------------------------------------------------
// FFT (forward, unnormalised, e^{-i}: same convention as qm-dsp's FFTReal)

class Fft {
  private readonly n: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;
  readonly re: Float64Array;
  readonly im: Float64Array;

  constructor(n: number) {
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    const bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
  }

  /** Transform a real input; results in `re` / `im`. */
  forward(input: ArrayLike<number>) {
    const { n, re, im, rev } = this;
    for (let i = 0; i < n; i++) {
      re[rev[i]] = input[i];
      im[rev[i]] = 0;
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// 1. Onset detection function (DetectionFunction, DF_COMPLEXSD, with PhaseVocoder)

class ComplexSdDetectionFunction {
  private readonly n: number;
  private readonly half: number;
  private readonly window: Float64Array;
  private readonly time: Float64Array;
  private readonly fft: Fft;
  private readonly magHistory: Float64Array;
  private readonly phaseHistory: Float64Array;
  private readonly phaseHistoryOld: Float64Array;

  constructor(frameLength: number) {
    this.n = frameLength;
    this.half = frameLength / 2 + 1;
    this.window = new Float64Array(frameLength);
    for (let i = 0; i < frameLength; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frameLength);
    this.time = new Float64Array(frameLength);
    this.fft = new Fft(frameLength);
    this.magHistory = new Float64Array(this.half);
    this.phaseHistory = new Float64Array(this.half);
    this.phaseHistoryOld = new Float64Array(this.half);
  }

  /** One value of the detection function for a window of `n` samples starting at `src[at]`. */
  process(src: Float32Array, at: number) {
    const { n, time, window } = this;
    const hs = n / 2;
    // window, then FFTShift (swap halves)
    for (let i = 0; i < n; i++) {
      const j = at + i;
      const x = j >= 0 && j < src.length ? src[j] : 0;
      time[(i + hs) % n] = x * window[i];
    }
    this.fft.forward(time);
    const { re, im } = this.fft;
    let val = 0;
    for (let i = 0; i < this.half; i++) {
      const mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
      const theta = Math.atan2(im[i], re[i]);
      const dev = princarg(theta - 2 * this.phaseHistory[i] + this.phaseHistoryOld[i]);
      // meas = magHistory - mag * e^{j·dev}
      const mr = this.magHistory[i] - mag * Math.cos(dev);
      const mi = -mag * Math.sin(dev);
      val += Math.sqrt(mr * mr + mi * mi);
      this.phaseHistoryOld[i] = this.phaseHistory[i];
      this.phaseHistory[i] = theta;
      this.magHistory[i] = mag;
    }
    return val;
  }
}

/**
 * AnalyzerQueenMaryBeats + DownmixAndOverlapHelper: windows of `windowSize` every
 * `step` samples, the first one centred on sample 0, with Mixxx's end padding.
 */
function detectionFunction(mono: Float32Array, windowSize: number, step: number) {
  const N = mono.length;
  const pre = windowSize / 2; // silence before the first sample
  const L = pre + N;
  let writePos: number;
  if (L < windowSize) writePos = L;
  else writePos = windowSize - step + ((L - windowSize) % step);
  const pad = Math.max(windowSize - writePos, windowSize / 2 - 1);
  const streamLen = L + pad;
  const df = new ComplexSdDetectionFunction(windowSize);
  const out: number[] = [];
  for (let start = 0; start + windowSize <= streamLen; start += step) out.push(df.process(mono, start - pre));
  return out;
}

// ---------------------------------------------------------------------------------------
// 2. TempoTrackV2

function getRcf(dfframeIn: Float64Array, wv: Float64Array, rcf: Float64Array) {
  const dfframe = Float64Array.from(dfframeIn);
  adaptiveThreshold(dfframe);
  const len = dfframe.length;
  const acf = new Float64Array(len);
  for (let lag = 0; lag < len; lag++) {
    let sum = 0;
    for (let n = 0; n < len - lag; n++) sum += dfframe[n] * dfframe[n + lag];
    acf[lag] = sum / (len - lag);
  }
  // comb filter bank. Note: like qm-dsp, `rcf` is not cleared between windows.
  const numelem = 4;
  for (let i = 2; i < rcf.length; i++) {
    for (let a = 1; a <= numelem; a++) {
      for (let b = 1 - a; b <= a - 1; b++) rcf[i - 1] += (acf[a * i + b - 1] * wv[i - 1]) / (2 * a - 1);
    }
  }
  adaptiveThreshold(rcf);
  let rcfsum = 0;
  for (let i = 0; i < rcf.length; i++) {
    rcf[i] += EPS;
    rcfsum += rcf[i];
  }
  for (let i = 0; i < rcf.length; i++) rcf[i] /= rcfsum + EPS;
}

function viterbiDecode(rcfmat: Float64Array[], wv: Float64Array, beatPeriod: Int32Array) {
  if (rcfmat.length < 2) return;
  const T = rcfmat.length;
  const Q = rcfmat[0].length;
  const sigma = 8;
  const tmat: Float64Array[] = Array.from({ length: Q }, () => new Float64Array(Q));
  for (let i = 20; i < Q - 20; i++) {
    for (let j = 20; j < Q - 20; j++) tmat[i][j] = Math.exp(-((j - i) ** 2) / (2 * sigma ** 2));
  }
  const delta: Float64Array[] = Array.from({ length: T }, () => new Float64Array(Q));
  const psi: Int32Array[] = Array.from({ length: T }, () => new Int32Array(Q));
  let deltasum = 0;
  for (let j = 0; j < Q; j++) {
    delta[0][j] = wv[j] * rcfmat[0][j];
    deltasum += delta[0][j];
  }
  for (let j = 0; j < Q; j++) delta[0][j] /= deltasum + EPS;
  for (let t = 1; t < T; t++) {
    const prev = delta[t - 1];
    for (let j = 0; j < Q; j++) {
      const row = tmat[j];
      let maxval = 0;
      let ind = 0;
      for (let i = 0; i < Q; i++) {
        const v = prev[i] * row[i];
        if (maxval < v) {
          maxval = v;
          ind = i;
        }
      }
      delta[t][j] = maxval * rcfmat[t][j];
      psi[t][j] = ind;
    }
    let sum = 0;
    for (let i = 0; i < Q; i++) sum += delta[t][i];
    for (let i = 0; i < Q; i++) delta[t][i] /= sum + EPS;
  }
  beatPeriod[T - 1] = maxIndex(delta[T - 1]);
  for (let t = T - 2; t > 0; t--) beatPeriod[t] = psi[t + 1][beatPeriod[t + 1]];
  beatPeriod[0] = psi[1][beatPeriod[1]];
}

/** TempoTrackV2::calculateBeatPeriod with the defaults Mixxx uses (120 BPM, Rayleigh). */
function calculateBeatPeriod(df: Float64Array, beatPeriod: Int32Array) {
  const wvLen = 128;
  const inputTempo = 120;
  const rayparam = (60 * 44100) / 512 / inputTempo;
  const wv = new Float64Array(wvLen);
  for (let i = 0; i < wvLen; i++) wv[i] = (i / rayparam ** 2) * Math.exp(-(i ** 2) / (2 * rayparam ** 2));
  const winlen = 512;
  const hopsize = 128;
  const dfLen = df.length;
  const rcfmat: Float64Array[] = [];
  const dfframe = new Float64Array(winlen);
  const rcf = new Float64Array(wvLen);
  for (let i = -winlen / 2; i < dfLen - winlen / 2; i += hopsize) {
    let k = 0;
    let l = winlen;
    if (i < 0) {
      k = -i;
      dfframe.fill(0, 0, k);
    }
    if (i + l > dfLen) {
      l = dfLen - i;
      dfframe.fill(0, l, winlen);
    }
    for (let x = k; x < l; x++) dfframe[x] = df[i + x];
    getRcf(dfframe, wv, rcf);
    rcfmat.push(Float64Array.from(rcf));
  }
  viterbiDecode(rcfmat, wv, beatPeriod);
}

/** TempoTrackV2::calculateBeats (alpha 0.9, tightness 4); beat positions in df steps. */
function calculateBeats(df: Float64Array, beatPeriod: Int32Array) {
  const alpha = 0.9;
  const tightness = 4;
  const beats: number[] = [];
  if (df.length === 0 || beatPeriod.length === 0) return beats;
  const dfLen = df.length;
  const cumscore = new Float64Array(dfLen);
  const backlink = new Int32Array(dfLen).fill(-1);
  let oldPeriod = 0;
  let txwt: number[] = [];
  for (let i = 0; i < dfLen; i++) {
    const period = beatPeriod[Math.trunc(i / 128)];
    const prangeMin = period * -2;
    if (period !== oldPeriod) {
      oldPeriod = period;
      const prangeMax = Math.trunc(period / -2);
      const txwtLen = prangeMax - prangeMin + 1;
      txwt = [];
      for (let j = 0; j < txwtLen; j++) {
        const mu = period;
        txwt.push(Math.exp(-0.5 * (tightness * Math.log((roundHalfAway(2 * mu) - j) / mu)) ** 2));
      }
    }
    let vv = 0;
    let xx = 0;
    for (let j = 0; j < txwt.length; j++) {
      const ind = i + prangeMin + j;
      if (ind >= 0) {
        const cand = txwt[j] * cumscore[ind];
        if (cand > vv) {
          vv = cand;
          xx = ind;
        }
      }
    }
    cumscore[i] = alpha * vv + (1 - alpha) * df[i];
    backlink[i] = xx;
  }
  const lastPeriod = beatPeriod[beatPeriod.length - 1];
  const tmp: number[] = [];
  for (let i = dfLen - lastPeriod; i < dfLen; i++) tmp.push(cumscore[i]);
  let startpoint = maxIndex(tmp) + dfLen - lastPeriod;
  if (startpoint >= dfLen) startpoint = dfLen - 1;
  const ibeats = [startpoint];
  while (backlink[ibeats[ibeats.length - 1]] > 0) {
    const b = ibeats[ibeats.length - 1];
    if (backlink[b] === b) break;
    ibeats.push(backlink[b]);
  }
  for (let i = ibeats.length - 1; i >= 0; i--) beats.push(ibeats[i]);
  return beats;
}

// ---------------------------------------------------------------------------------------
// 3. BeatUtils (Mixxx): constant tempo, round BPM, phase

const kMaxSecsPhaseError = 0.025;
const kMaxSecsPhaseErrorSum = 0.1;
const kMaxOutliersCount = 1;
const kMinRegionBeatCount = 16;

interface ConstRegion {
  firstBeat: number;
  beatLength: number;
}

function retrieveConstRegions(coarseBeats: number[], sampleRate: number): ConstRegion[] {
  if (coarseBeats.length < 2) return [];
  const maxPhaseError = kMaxSecsPhaseError * sampleRate;
  const maxPhaseErrorSum = kMaxSecsPhaseErrorSum * sampleRate;
  let leftIndex = 0;
  let rightIndex = coarseBeats.length - 1;
  const regions: ConstRegion[] = [];
  while (leftIndex < coarseBeats.length - 1) {
    const meanBeatLength = (coarseBeats[rightIndex] - coarseBeats[leftIndex]) / (rightIndex - leftIndex);
    let outliersCount = 0;
    let ironedBeat = coarseBeats[leftIndex];
    let phaseErrorSum = 0;
    let i = leftIndex + 1;
    for (; i <= rightIndex; ++i) {
      ironedBeat += meanBeatLength;
      const phaseError = ironedBeat - coarseBeats[i];
      phaseErrorSum += phaseError;
      if (Math.abs(phaseError) > maxPhaseError) {
        outliersCount++;
        if (outliersCount > kMaxOutliersCount || i === leftIndex + 1) break;
      }
      if (Math.abs(phaseErrorSum) > maxPhaseErrorSum) break;
    }
    if (i > rightIndex) {
      let regionBorderError = 0;
      if (rightIndex > leftIndex + 2) {
        const firstBeatLength = coarseBeats[leftIndex + 1] - coarseBeats[leftIndex];
        const lastBeatLength = coarseBeats[rightIndex] - coarseBeats[rightIndex - 1];
        regionBorderError = Math.abs(firstBeatLength + lastBeatLength - 2 * meanBeatLength);
      }
      if (regionBorderError < maxPhaseError / 2) {
        regions.push({ firstBeat: coarseBeats[leftIndex], beatLength: meanBeatLength });
        leftIndex = rightIndex;
        rightIndex = coarseBeats.length - 1;
        continue;
      }
    }
    rightIndex--;
  }
  regions.push({ firstBeat: coarseBeats[coarseBeats.length - 1], beatLength: 0 });
  return regions;
}

function trySnap(minBpm: number, centerBpm: number, maxBpm: number, fraction: number) {
  const snap = roundHalfAway(centerBpm * fraction) / fraction;
  return snap > minBpm && snap < maxBpm ? snap : null;
}

function roundBpmWithinRange(minBpm: number, centerBpm: number, maxBpm: number) {
  if (!(minBpm > 0) || !(centerBpm > 0) || !(maxBpm > 0)) return centerBpm;
  let snap = trySnap(minBpm, centerBpm, maxBpm, 1);
  if (snap !== null) return snap;
  if (centerBpm < 85) {
    snap = trySnap(minBpm, centerBpm, maxBpm, 2);
    if (snap !== null) return snap;
  }
  if (centerBpm > 127) {
    snap = trySnap(minBpm, centerBpm, maxBpm, 2 / 3);
    if (snap !== null) return snap;
  }
  snap = trySnap(minBpm, centerBpm, maxBpm, 3);
  if (snap !== null) return snap;
  snap = trySnap(minBpm, centerBpm, maxBpm, 12);
  if (snap !== null) return snap;
  return centerBpm;
}

/** BeatUtils::makeConstBpm; returns the BPM and the first beat (frames), or null. */
function makeConstBpm(regions: ConstRegion[], sampleRate: number): { bpm: number; firstBeat: number } | null {
  let midRegionIndex = 0;
  let longestRegionLength = 0;
  let longestRegionBeatLength = 0;
  for (let i = 0; i < regions.length - 1; ++i) {
    const length = regions[i + 1].firstBeat - regions[i].firstBeat;
    if (length > longestRegionLength) {
      longestRegionLength = length;
      longestRegionBeatLength = regions[i].beatLength;
      midRegionIndex = i;
    }
  }
  if (longestRegionLength === 0) return null;
  const tol = kMaxSecsPhaseError * sampleRate;
  let longestRegionNumberOfBeats = Math.trunc(longestRegionLength / longestRegionBeatLength + 0.5);
  let longestRegionBeatLengthMin = longestRegionBeatLength - tol / longestRegionNumberOfBeats;
  let longestRegionBeatLengthMax = longestRegionBeatLength + tol / longestRegionNumberOfBeats;
  let startRegionIndex = midRegionIndex;

  // a region at the beginning of the track with a similar tempo and phase
  for (let i = 0; i < midRegionIndex; ++i) {
    const length = regions[i + 1].firstBeat - regions[i].firstBeat;
    const numberOfBeats = Math.trunc(length / regions[i].beatLength + 0.5);
    if (numberOfBeats < kMinRegionBeatCount) continue;
    const thisMin = regions[i].beatLength - tol / numberOfBeats;
    const thisMax = regions[i].beatLength + tol / numberOfBeats;
    if (longestRegionBeatLength > thisMin && longestRegionBeatLength < thisMax) {
      const newLongestRegionLength = regions[midRegionIndex + 1].firstBeat - regions[i].firstBeat;
      const beatLengthMin = Math.max(longestRegionBeatLengthMin, thisMin);
      const beatLengthMax = Math.min(longestRegionBeatLengthMax, thisMax);
      const maxNumberOfBeats = Math.trunc(roundHalfAway(newLongestRegionLength / beatLengthMin));
      const minNumberOfBeats = Math.trunc(roundHalfAway(newLongestRegionLength / beatLengthMax));
      if (minNumberOfBeats !== maxNumberOfBeats) continue;
      const newBeatLength = newLongestRegionLength / minNumberOfBeats;
      if (newBeatLength > longestRegionBeatLengthMin && newBeatLength < longestRegionBeatLengthMax) {
        longestRegionLength = newLongestRegionLength;
        longestRegionBeatLength = newBeatLength;
        longestRegionNumberOfBeats = minNumberOfBeats;
        longestRegionBeatLengthMin = longestRegionBeatLength - tol / longestRegionNumberOfBeats;
        longestRegionBeatLengthMax = longestRegionBeatLength + tol / longestRegionNumberOfBeats;
        startRegionIndex = i;
        break;
      }
    }
  }

  // a region at the end of the track with a similar tempo and phase
  for (let i = regions.length - 2; i > midRegionIndex; --i) {
    const length = regions[i + 1].firstBeat - regions[i].firstBeat;
    const numberOfBeats = Math.trunc(length / regions[i].beatLength + 0.5);
    if (numberOfBeats < kMinRegionBeatCount) continue;
    const thisMin = regions[i].beatLength - tol / numberOfBeats;
    const thisMax = regions[i].beatLength + tol / numberOfBeats;
    if (longestRegionBeatLength > thisMin && longestRegionBeatLength < thisMax) {
      const newLongestRegionLength = regions[i + 1].firstBeat - regions[startRegionIndex].firstBeat;
      const minBeatLength = Math.max(longestRegionBeatLengthMin, thisMin);
      const maxBeatLength = Math.min(longestRegionBeatLengthMax, thisMax);
      const maxNumberOfBeats = Math.trunc(roundHalfAway(newLongestRegionLength / minBeatLength));
      const minNumberOfBeats = Math.trunc(roundHalfAway(newLongestRegionLength / maxBeatLength));
      if (minNumberOfBeats !== maxNumberOfBeats) continue;
      const newBeatLength = newLongestRegionLength / minNumberOfBeats;
      if (newBeatLength > longestRegionBeatLengthMin && newBeatLength < longestRegionBeatLengthMax) {
        longestRegionLength = newLongestRegionLength;
        longestRegionBeatLength = newBeatLength;
        longestRegionNumberOfBeats = minNumberOfBeats;
        break;
      }
    }
  }

  longestRegionBeatLengthMin = longestRegionBeatLength - tol / longestRegionNumberOfBeats;
  longestRegionBeatLengthMax = longestRegionBeatLength + tol / longestRegionNumberOfBeats;
  const minRoundBpm = (60 * sampleRate) / longestRegionBeatLengthMax;
  const maxRoundBpm = (60 * sampleRate) / longestRegionBeatLengthMin;
  const centerBpm = (60 * sampleRate) / longestRegionBeatLength;
  const bpm = roundBpmWithinRange(minRoundBpm, centerBpm, maxRoundBpm);
  if (!(bpm > 0) || !Number.isFinite(bpm)) return null;
  const roundedBeatLength = (60 * sampleRate) / bpm;
  return { bpm, firstBeat: fmod(regions[startRegionIndex].firstBeat, roundedBeatLength) };
}

/** BeatUtils::adjustPhase: move the grid onto the average of the nearby detected beats. */
function adjustPhase(firstBeat: number, bpm: number, sampleRate: number, beats: number[]) {
  const beatLength = (60 * sampleRate) / bpm;
  const startOffset = fmod(firstBeat, beatLength);
  let offsetAdjust = 0;
  let count = 0;
  for (const beat of beats) {
    let offset = fmod(beat - startOffset, beatLength);
    if (offset > beatLength / 2) offset -= beatLength;
    if (Math.abs(offset) < kMaxSecsPhaseError * sampleRate) {
      offsetAdjust += offset;
      count++;
    }
  }
  return count > 0 ? firstBeat + offsetAdjust / count : firstBeat;
}

// ---------------------------------------------------------------------------------------
// 4. DownBeat (qm-dsp): beat 1 = the bar position with the most spectral change

/** Decimate by `factor` after a low-pass (two cascaded 2nd-order Butterworth sections). */
function decimate(x: Float32Array, sampleRate: number, factor: number) {
  const fc = (sampleRate / factor) * 0.45;
  const w = Math.tan((Math.PI * fc) / sampleRate);
  const q = Math.SQRT1_2;
  const norm = 1 / (1 + w / q + w * w);
  const b0 = w * w * norm;
  const b1 = 2 * b0;
  const b2 = b0;
  const a1 = 2 * (w * w - 1) * norm;
  const a2 = (1 - w / q + w * w) * norm;
  const stage = (input: Float32Array) => {
    const out = new Float32Array(input.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < input.length; i++) {
      const y = b0 * input[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = input[i];
      y2 = y1;
      y1 = y;
      out[i] = y;
    }
    return out;
  };
  const lp = stage(stage(x));
  const out = new Float32Array(Math.floor(lp.length / factor));
  for (let i = 0; i < out.length; i++) out[i] = lp[i * factor];
  return out;
}

/** DownBeat::measureSpecDiff: Jensen-Shannon divergence of the low part of two spectra. */
function measureSpecDiff(oldIn: Float64Array, newIn: Float64Array) {
  let specsize = 512;
  if (specsize > Math.trunc(oldIn.length / 4)) specsize = Math.trunc(oldIn.length / 4);
  const oldspec = Float64Array.from(oldIn);
  const newspec = Float64Array.from(newIn);
  let sumnew = 0;
  let sumold = 0;
  for (let i = 0; i < specsize; i++) {
    newspec[i] += EPS;
    oldspec[i] += EPS;
    sumnew += newspec[i];
    sumold += oldspec[i];
  }
  let sd = 0;
  for (let i = 0; i < specsize; i++) {
    newspec[i] /= sumnew;
    oldspec[i] /= sumold;
    if (newspec[i] === 0) newspec[i] = 1;
    if (oldspec[i] === 0) oldspec[i] = 1;
    const sd1 = 0.5 * oldspec[i] + 0.5 * newspec[i];
    sd += -sd1 * Math.log(sd1) + 0.5 * (oldspec[i] * Math.log(oldspec[i])) + 0.5 * (newspec[i] * Math.log(newspec[i]));
  }
  return sd;
}

/**
 * DownBeat::findDownBeats for 4/4 on decimated audio. `beats` are in df steps; returns the
 * index (0..3) of the first downbeat in `beats`.
 */
function findDownBeat(audio: Float32Array, beats: number[], increment: number, factor: number, sampleRate: number) {
  const beatframesize = Math.max(2, nextPowerOfTwo(Math.trunc((sampleRate / factor) * 1.3)));
  const fft = new Fft(beatframesize);
  const frame = new Float64Array(beatframesize);
  let oldspec = new Float64Array(beatframesize / 2);
  const beatsd: number[] = [];
  if (audio.length === 0) return 0;
  for (let i = 0; i + 1 < beats.length; ++i) {
    const beatstart = Math.trunc((beats[i] * increment) / factor);
    let beatend = Math.trunc((beats[i + 1] * increment) / factor);
    if (beatend >= audio.length) beatend = audio.length - 1;
    if (beatend < beatstart) beatend = beatstart;
    const beatlen = beatend - beatstart;
    for (let j = 0; j < beatlen && j < beatframesize; ++j) {
      const mul = 0.5 * (1 - Math.cos((2 * Math.PI * j) / beatlen));
      frame[j] = audio[beatstart + j] * mul;
    }
    frame.fill(0, Math.min(beatlen, beatframesize));
    fft.forward(frame);
    const newspec = new Float64Array(beatframesize / 2);
    for (let j = 0; j < beatframesize / 2; ++j) newspec[j] = Math.sqrt(fft.re[j] ** 2 + fft.im[j] ** 2);
    adaptiveThreshold(newspec);
    if (i > 0) beatsd.push(measureSpecDiff(oldspec, newspec));
    oldspec = newspec;
  }
  const timesig = 4;
  const dbcand = new Float64Array(timesig);
  for (let beat = 0; beat < timesig; ++beat) {
    let count = 0;
    for (let example = beat - 1; example < beatsd.length; example += timesig) {
      if (example < 0) continue;
      dbcand[beat] += beatsd[example] / timesig;
      ++count;
    }
    if (count > 0) dbcand[beat] /= count;
  }
  // MathUtilities::getMax: first maximum
  let dbind = 0;
  for (let i = 1; i < timesig; i++) if (dbcand[i] > dbcand[dbind]) dbind = i;
  return dbind;
}

// ---------------------------------------------------------------------------------------
// On-beat check (this app's addition)

/**
 * Average drop of low-band (<150 Hz) energy from just after each grid line to just before
 * the half-beat, in natural-log units. High for a kick, low for a held bass note.
 */
function offbeatScore(mono: Float32Array, sampleRate: number, phase: number, beatLength: number) {
  const a = Math.exp((-2 * Math.PI * 150) / sampleRate);
  const win = Math.round(0.01 * sampleRate);
  // low-passed energy, sampled on demand over short windows
  const lowEnergy = (from: number) => {
    let lp = 0;
    let e = 0;
    const warm = Math.round(0.02 * sampleRate); // let the filter settle
    const start = Math.max(0, from - warm);
    const end = Math.min(mono.length, from + win);
    for (let i = start; i < end; i++) {
      lp = (1 - a) * mono[i] + a * lp;
      if (i >= from) e += lp * lp;
    }
    return e / win;
  };
  let total = 0;
  let n = 0;
  const first = fmod(fmod(phase, beatLength) + beatLength, beatLength);
  for (let t = first; t + 0.5 * beatLength < mono.length; t += beatLength) {
    total += Math.log(lowEnergy(Math.round(t + 0.005 * sampleRate)) + 1e-9) - Math.log(lowEnergy(Math.round(t + 0.42 * beatLength)) + 1e-9);
    n++;
  }
  return n ? total / n : 0;
}

// ---------------------------------------------------------------------------------------

/** Detect the BPM and a downbeat of `buffer` (Mixxx fixed-tempo analysis + QM downbeat). */
export function detectBeat(buffer: PcmSource): BeatGrid | null {
  const sampleRate = buffer.sampleRate;
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const mono = L === R ? L : new Float32Array(L.length);
  if (mono !== L) for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;

  // 1. detection function (AnalyzerQueenMaryBeats::initialize / finalize)
  const kStepSecs = 0.01161;
  const kMaximumBinSizeHz = 50;
  const step = Math.trunc(sampleRate * kStepSecs);
  const windowSize = nextPowerOfTwo(Math.trunc(sampleRate / kMaximumBinSizeHz));
  const results = detectionFunction(mono, windowSize, step);
  let nonZeroCount = results.length;
  while (nonZeroCount > 0 && results[nonZeroCount - 1] <= 0) --nonZeroCount;
  const requiredSize = Math.max(2, nonZeroCount) - 2;
  // skip the first 2 results, which may hold noise taken as an onset (as Mixxx / VAMP do)
  const df = Float64Array.from(results.slice(2, nonZeroCount));
  if (df.length < 512) return null; // under ~6 s: too short to track a tempo

  // 2. TempoTrackV2
  const beatPeriod = new Int32Array(Math.trunc(requiredSize / 128) + 1);
  calculateBeatPeriod(df, beatPeriod);
  const dfBeats = calculateBeats(df, beatPeriod);
  // "we add the halve m_stepSizeFrames here, because the beat is detected between the two samples"
  const beats = dfBeats.map((b) => b * step + Math.trunc(step / 2));
  if (beats.length < 2) return null;

  // 3. constant grid (BeatFactory::makePreferredBeats, fixed tempo)
  const regions = retrieveConstRegions(beats, sampleRate);
  if (!regions.length) return null;
  const grid = makeConstBpm(regions, sampleRate);
  if (!grid) return null;
  const { bpm } = grid;
  const beatLength = (60 * sampleRate) / bpm;
  let firstBeat = Math.round(adjustPhase(grid.firstBeat, bpm, sampleRate, beats));
  // On-beat check (not part of Mixxx): in loud mixes with strong off-beat hats and bass the
  // tracker can lock half a beat late. A kick dies away within the beat while an off-beat
  // bass note holds until the next kick, so keep whichever half has the decaying low end.
  if (offbeatScore(mono, sampleRate, firstBeat + beatLength / 2, beatLength) > offbeatScore(mono, sampleRate, firstBeat, beatLength) + 0.5) {
    firstBeat = Math.round(firstBeat + beatLength / 2);
  }

  // 4. beat 1 on the constant grid
  const factor = 16;
  const decimated = decimate(mono, sampleRate, factor);
  const gridBeats: number[] = [];
  for (let pos = firstBeat; pos < mono.length; pos += beatLength) gridBeats.push(pos / step);
  const dbind = gridBeats.length > 8 ? findDownBeat(decimated, gridBeats, step, factor, sampleRate) : 0;
  const downbeat = firstBeat + dbind * beatLength;
  return { bpm, offset: fmod(downbeat, 4 * beatLength) / sampleRate };
}
