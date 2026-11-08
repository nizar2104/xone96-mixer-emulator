// Track analysis off the main thread (see analysis-client.ts): beat grid and RGB waveform.
import { detectBeat, type BeatGrid } from "./beat-detect";
import { computeRgbWaveform, type RgbWaveform } from "./waveform";

export type AnalysisRequest = { id: number; kind: "beat" | "wave"; sampleRate: number; mono: Float32Array; rate?: number };
export type AnalysisResponse = { id: number; result: BeatGrid | RgbWaveform | null };

self.onmessage = (e: MessageEvent<AnalysisRequest>) => {
  const { id, kind, sampleRate, mono, rate } = e.data;
  let result: BeatGrid | RgbWaveform | null = null;
  const transfer: Transferable[] = [];
  try {
    if (kind === "beat") {
      result = detectBeat({ sampleRate, numberOfChannels: 1, getChannelData: () => mono });
    } else {
      const wf = computeRgbWaveform(mono, sampleRate, rate ?? 100);
      transfer.push(wf.low.buffer, wf.mid.buffer, wf.high.buffer);
      result = wf;
    }
  } catch {
    result = null;
  }
  const msg: AnalysisResponse = { id, result };
  self.postMessage(msg, { transfer });
};
