// Track analysis (beat grid, RGB waveform) in a worker, so it never blocks the decks'
// audio callback, which shares the main thread. Falls back to running inline when workers
// are unavailable.
import type { AnalysisRequest, AnalysisResponse } from "./analysis-worker";
import { detectBeat, type BeatGrid } from "./beat-detect";
import { computeRgbWaveform, type RgbWaveform } from "./waveform";

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, (r: AnalysisResponse["result"]) => void>();

function getWorker() {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./analysis-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<AnalysisResponse>) => {
      pending.get(e.data.id)?.(e.data.result);
      pending.delete(e.data.id);
    };
    worker.onerror = () => {
      // the worker could not start or crashed: answer what is waiting, then work inline
      workerBroken = true;
      worker?.terminate();
      worker = null;
      pending.forEach((resolve) => resolve(null));
      pending.clear();
    };
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** The mono mix both analyses work on, as one transferable copy. */
function monoOf(buffer: AudioBuffer) {
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const mono = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
  return mono;
}

function run<T extends AnalysisResponse["result"]>(buffer: AudioBuffer, kind: AnalysisRequest["kind"], inline: () => T, rate?: number): Promise<T> {
  const w = getWorker();
  if (!w) return Promise.resolve(inline());
  const mono = monoOf(buffer);
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, (r) => resolve((r as T) ?? (workerBroken ? inline() : (null as T))));
    const req: AnalysisRequest = { id, kind, sampleRate: buffer.sampleRate, mono, rate };
    w.postMessage(req, [mono.buffer]);
  });
}

/** Detect BPM and a downbeat for `buffer` without blocking the main thread. */
export function detectBeatAsync(buffer: AudioBuffer): Promise<BeatGrid | null> {
  return run(buffer, "beat", () => detectBeat(buffer));
}

/** Bass / mid / high peaks per bin (`rate` bins per second) for the RGB waveform. */
export function analyseWaveformAsync(buffer: AudioBuffer, rate: number): Promise<RgbWaveform | null> {
  return run(buffer, "wave", () => {
    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
    const mono = new Float32Array(L.length);
    for (let i = 0; i < L.length; i++) mono[i] = (L[i] + R[i]) * 0.5;
    return computeRgbWaveform(mono, buffer.sampleRate, rate);
  }, rate);
}
