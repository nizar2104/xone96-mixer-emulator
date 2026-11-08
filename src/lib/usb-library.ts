// Shared USB media for the players (like Pro DJ Link: a USB in either player is
// visible to both). Opening reads the rekordbox database; loading decodes audio and
// applies rekordbox's beat grid and cues to the target deck.

import { HOT_CUE_COUNT, analyseTrack, detectBeatAsync, type CdjDeck } from "@/lib/cdj-deck";
import { UsbFolder, parseAnlz, parseExportPdb, type RbAnalysis, type RbLibrary, type RbTrack } from "@/lib/rekordbox";

export interface UsbMedia {
  folder: UsbFolder;
  /** rekordbox library, or null when the media has no export.pdb */
  lib: RbLibrary | null;
  /** plain audio files (used when there is no rekordbox library) */
  plain: File[];
  name: string;
  /** set when the database exists but could not be read */
  readError: boolean;
}

export async function openUsbMedia(files: FileList | File[]): Promise<UsbMedia> {
  const list = Array.from(files);
  const folder = new UsbFolder(list);
  const first = list[0] as (File & { webkitRelativePath?: string }) | undefined;
  const name = first?.webkitRelativePath?.split("/")[0] || "USB";
  const pdb = folder.resolve("/PIONEER/rekordbox/export.pdb");
  if (!pdb) return { folder, lib: null, plain: folder.audioFiles(), name, readError: false };
  try {
    const lib = parseExportPdb(await pdb.arrayBuffer());
    return { folder, lib, plain: [], name, readError: false };
  } catch {
    return { folder, lib: null, plain: folder.audioFiles(), name, readError: true };
  }
}

export interface LoadResult {
  title: string;
  bpm: number | null;
  gridFrom: "rekordbox" | "detected" | "none";
  memoryCues: number;
  hotCues: number;
}

/** Decode a track from the media and load it on `deck` with its rekordbox grid and cues. */
export async function loadFromUsb(deck: CdjDeck, media: UsbMedia, file: File, meta: RbTrack | null): Promise<LoadResult> {
  const buffer = await deck.ctx.decodeAudioData(await file.arrayBuffer());
  let analysis: RbAnalysis | null = null;
  if (meta?.analyzePath) {
    const merged: RbAnalysis = { beats: [], cues: [], path: null };
    for (const path of [meta.analyzePath.replace(/\.DAT$/i, ".EXT"), meta.analyzePath]) {
      const f = media.folder.resolve(path);
      if (!f) continue;
      try {
        const a = parseAnlz(await f.arrayBuffer());
        if (!merged.beats.length) merged.beats = a.beats;
        if (!merged.cues.length) merged.cues = a.cues;
      } catch {
        /* unreadable analysis file: fall back to our own detection */
      }
    }
    analysis = merged;
  }
  const beats = analysis?.beats ?? [];
  let bpm = beats[0]?.bpm || meta?.bpm || null;
  let offset = 0;
  if (beats.length) offset = (beats.find((b) => b.beatNumber === 1) ?? beats[0]).timeMs / 1000;
  const title = meta ? [meta.artist, meta.title].filter(Boolean).join(" – ") : file.name;
  const t = analyseTrack(`usb-${meta?.id ?? file.name}`, title, bpm, buffer, offset);
  if (meta?.key) t.key = meta.key;
  let gridFrom: LoadResult["gridFrom"] = beats.length ? "rekordbox" : "none";
  if (!beats.length) {
    // no rekordbox grid: detect our own (a database BPM alone has no beat position)
    const beat = await detectBeatAsync(buffer);
    if (beat) {
      bpm = beat.bpm;
      t.bpm = beat.bpm;
      t.beatOffset = beat.offset;
      gridFrom = "detected";
    }
  }
  deck.load(t);
  const sr = buffer.sampleRate;
  const cues = analysis?.cues ?? [];
  const memory = cues.filter((c) => c.hotCue === 0);
  if (memory.length) {
    deck.cue = (memory[0].timeMs / 1000) * sr; // CDJ auto-cue to the first memory point
    deck.pos = deck.cue;
    const loop = memory.find((c) => c.isLoop && c.loopEndMs);
    if (loop?.loopEndMs) {
      deck.loopIn = (loop.timeMs / 1000) * sr;
      deck.loopOut = (loop.loopEndMs / 1000) * sr;
    }
  }
  const hot = cues.filter((c) => c.hotCue >= 1 && c.hotCue <= HOT_CUE_COUNT);
  hot.forEach((c) => (deck.hotCues[c.hotCue - 1] = (c.timeMs / 1000) * sr));
  deck.rev++;
  return { title, bpm, gridFrom, memoryCues: memory.length, hotCues: hot.length };
}
