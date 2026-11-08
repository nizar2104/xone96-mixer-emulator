import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { FolderOpen, Pause, Play, Rewind, FastForward, Usb, X } from "lucide-react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Fader } from "@/components/mixer-controls";
import { cn } from "@/lib/utils";
import logoWhite from "@/assets/nomad-logo-white.png";
import { DeckBrowser, type BrowsePlace } from "@/components/deck-browser";
import type { UsbMedia } from "@/lib/usb-library";
import { HOT_CUE_COUNT, HOT_CUE_NAMES, PEAKS_PER_SECOND, SECONDS_PER_REV, TEMPO_RANGES, analyseTrack, analyseWaveformAsync, detectBeatAsync, type CdjDeck, type DeckTrack, type TempoRange } from "@/lib/cdj-deck";
import { bandMax, rgbColumn } from "@/lib/waveform";

/** Jog centre display: radius and circumference of the track-position ring. */
const JOG_RING_R = 64;
const JOG_RING_C = 2 * Math.PI * JOG_RING_R;

/** Tracks whose RGB waveform is being analysed (shared by both decks). */
const rgbPending = new WeakSet<DeckTrack>();

const wrapPhase = (e: number) => e - Math.round(e);

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-1 focus-visible:ring-offset-zinc-900";
const fmtTime = (s: number) => {
  const neg = s < 0;
  s = Math.abs(s);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const f = Math.floor((s % 1) * 10);
  return `${neg ? "−" : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${f}`;
};
const fmtPct = (f: number) => `${f >= 0 ? "+" : "−"}${Math.abs(f * 100).toFixed(2)}%`;

/** LED colours: the strip on lit keys, its glow, and the tinted label. */
const LED = {
  amber: { strip: "bg-amber-400 shadow-[0_0_8px_2px_rgba(251,191,36,0.6)]", text: "text-amber-100" },
  green: { strip: "bg-green-400 shadow-[0_0_8px_2px_rgba(74,222,128,0.6)]", text: "text-green-100" },
  red: { strip: "bg-red-400 shadow-[0_0_8px_2px_rgba(248,113,113,0.6)]", text: "text-red-100" },
  sky: { strip: "bg-sky-400 shadow-[0_0_8px_2px_rgba(56,189,248,0.6)]", text: "text-sky-100" },
} as const;

/** CDJ-style rubber key: raised, with an LED strip along the top edge that lights up. */
function Key({
  label,
  lit,
  led = "amber",
  children,
  onPress,
  disabled,
  className,
  blink,
}: {
  label: string;
  lit?: boolean;
  led?: keyof typeof LED;
  children: ReactNode;
  onPress: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  className?: string;
  blink?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={lit}
      title={label}
      disabled={disabled}
      onClick={onPress}
      className={cn(
        "relative flex h-9 min-w-11 items-center justify-center rounded-md border border-black/70 bg-gradient-to-b from-zinc-700 to-zinc-800 px-2 pt-1.5 text-[10px] leading-tight font-bold tracking-wide text-zinc-300 uppercase",
        "shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_2px_0_rgba(0,0,0,0.55)] transition-transform hover:from-zinc-600 active:translate-y-px active:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] disabled:opacity-40",
        FOCUS,
        lit && LED[led].text,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-x-2 top-1 h-[3px] rounded-full", lit ? LED[led].strip : "bg-zinc-950/80", lit && blink && "animate-pulse")}
      />
      {children}
    </button>
  );
}

/** Small section caption, as printed on the deck's top panel. */
const Caption = ({ children }: { children: ReactNode }) => (
  <span className="text-[9px] font-bold tracking-[0.12em] text-zinc-400 uppercase">{children}</span>
);

export interface DeckProps {
  index: number;
  deck: CdjDeck | null;
  /** The other deck (SYNC follows it). */
  other: CdjDeck | null;
  demos: DeckTrack[];
  ensureAudio: () => Promise<void>;
  /** Mixer channels whose input selector is on this deck. */
  routedTo: string[];
  /** USB media shared by both players (Link). */
  usb: UsbMedia | null;
  onInsertUsb: () => void;
  onEjectUsb: () => void;
}

const BROWSE_ROOT: readonly BrowsePlace[] = [{ kind: "root" }];

function CdjDeckView({ index, deck, other, demos, ensureAudio, routedTo, usb, onInsertUsb, onEjectUsb }: DeckProps) {
  const n = index + 1;
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [range, setRange] = useState<TempoRange>(10);
  const [vinyl, setVinyl] = useState(true);
  const [remain, setRemain] = useState(false);
  const [eraseHot, setEraseHot] = useState(false);
  const [userTracks, setUserTracks] = useState<DeckTrack[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const showBrowser = browsing && !!usb;
  // browse position survives closing the browser (as on a CDJ) but resets for new media
  const [browse, setBrowse] = useState<{ media: UsbMedia | null; trail: readonly BrowsePlace[] }>({ media: null, trail: BROWSE_ROOT });
  const browseTrail = browse.media === usb ? browse.trail : BROWSE_ROOT;
  const setBrowseTrail = useCallback(
    (update: (t: readonly BrowsePlace[]) => readonly BrowsePlace[]) => setBrowse((b) => ({ media: usb, trail: update(b.media === usb ? b.trail : BROWSE_ROOT) })),
    [usb],
  );
  const closeBrowser = useCallback(() => {
    setBrowsing(false);
    bump();
  }, [bump]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const zoomRef = useRef<HTMLCanvasElement | null>(null);
  const overviewRef = useRef<HTMLCanvasElement | null>(null);
  const headRef = useRef<HTMLDivElement | null>(null);
  const timeRef = useRef<HTMLSpanElement | null>(null);
  const platterRef = useRef<SVGGElement | null>(null);
  const ringRef = useRef<SVGCircleElement | null>(null);
  const cueBtnRef = useRef<HTMLButtonElement | null>(null);
  const playBtnRef = useRef<HTMLButtonElement | null>(null);
  const jogRef = useRef<HTMLDivElement | null>(null);
  const jogDrag = useRef<{ angle: number; mode: "scratch" | "bend"; lastT: number } | null>(null);
  const lastPlaying = useRef(false);
  const lastTrack = useRef<DeckTrack | null>(null);
  const bendKey = useRef(false);
  const lastTempo = useRef(0);
  const lastSyncState = useRef("");
  const lastRev = useRef(0);
  const rangeRef = useRef<TempoRange>(10);
  const remainRef = useRef(remain);
  const titleId = useId();

  useEffect(() => {
    remainRef.current = remain;
  }, [remain]);
  useEffect(() => {
    rangeRef.current = range;
    if (deck) deck.tempoRange = range;
  }, [range, deck]);

  const track = deck?.track ?? null;
  const allTracks = [...demos, ...userTracks];

  // Load the deck's default demo once it is available
  useEffect(() => {
    if (deck && !deck.track && demos[index]) {
      deck.load(demos[index]);
      bump();
    }
  }, [deck, demos, index, bump]);

  // Overview waveform (static per track)
  useEffect(() => {
    const c = overviewRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    c.width = w * dpr;
    c.height = h * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    if (!track) return;
    const wf = track.rgb;
    if (wf) {
      // RGB overview: each pixel column takes the band peaks of the bins it covers
      const per = wf.low.length / w;
      for (let x = 0; x < w; x++) {
        const from = Math.floor(x * per);
        const m = bandMax(wf, from, Math.max(from + 1, Math.floor((x + 1) * per)));
        if (m.empty) continue;
        const col = rgbColumn(m.l, m.m, m.h);
        const bh = Math.max(1, col.height * h);
        g.fillStyle = col.color;
        g.fillRect(x, (h - bh) / 2, 1, bh);
      }
      return;
    }
    g.fillStyle = "#7dd3fc";
    const ov = track.overview;
    for (let x = 0; x < w; x++) {
      const p = ov[Math.floor((x / w) * ov.length)] ?? 0;
      const bh = Math.max(1, p * h);
      g.fillRect(x, (h - bh) / 2, 1, bh);
    }
  }, [track, track?.rgb, showBrowser]);

  // RGB waveform analysis (worker), once per track
  useEffect(() => {
    if (!track || track.rgb || rgbPending.has(track)) return;
    rgbPending.add(track);
    void analyseWaveformAsync(track.buffer, PEAKS_PER_SECOND).then((wf) => {
      rgbPending.delete(track);
      if (wf) {
        track.rgb = wf;
        bump();
      }
    });
  }, [track, bump]);

  // Per-frame display: time, platter, zoomed waveform, playhead, CUE / PLAY LEDs
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (!deck) return;
      // SYNC: follow the other deck's tempo continuously and pull the beats into phase
      if (deck.sync && other?.bpmNow && deck.track?.bpm) {
        deck.tempo = Math.max(-1, Math.min(1, other.bpmNow / deck.track.bpm - 1));
        const mine = deck.beatPhase;
        const theirs = other.beatPhase;
        deck.syncNudge =
          deck.playing && other.playing && mine !== null && theirs !== null ? Math.max(-0.02, Math.min(0.02, wrapPhase(theirs - mine) * 0.12)) : 0;
        if (Math.abs(deck.tempo) * 100 > rangeRef.current) setRange(100);
      } else {
        deck.syncNudge = 0;
      }
      if (deck.rev !== lastRev.current) {
        lastRev.current = deck.rev;
        setVersion((v) => v + 1);
      }
      const syncState = `${deck.sync}|${other?.sync ?? false}`;
      if (Math.abs(deck.tempo - lastTempo.current) > 0.0001 || syncState !== lastSyncState.current) {
        lastTempo.current = deck.tempo;
        lastSyncState.current = syncState;
        setVersion((v) => v + 1);
      }
      const t = deck.track;
      // a track loaded from outside this panel (USB browser): list it and refresh
      if (t !== lastTrack.current) {
        lastTrack.current = t;
        if (t && !t.id.startsWith("demo-")) setUserTracks((prev) => (prev.some((x) => x.id === t.id) ? prev.map((x) => (x.id === t.id ? t : x)) : [...prev, t]));
        setVersion((v) => v + 1);
      }
      const sec = deck.seconds;
      if (timeRef.current) timeRef.current.textContent = t ? fmtTime(remainRef.current ? -(deck.duration - sec) : sec) : "--:--.-";
      if (platterRef.current) platterRef.current.setAttribute("transform", `rotate(${((sec / SECONDS_PER_REV) * 360) % 360} 150 150)`);
      if (ringRef.current) ringRef.current.setAttribute("stroke-dashoffset", String(JOG_RING_C * (1 - (t && deck.duration ? Math.min(1, sec / deck.duration) : 0))));
      if (headRef.current && t) headRef.current.style.left = `${(sec / deck.duration) * 100}%`;
      if (deck.playing !== lastPlaying.current) {
        lastPlaying.current = deck.playing;
        setVersion((v) => v + 1);
      }
      if (cueBtnRef.current) {
        const atCue = Math.abs(deck.pos - deck.cue) < deck.sampleRate * 0.01;
        cueBtnRef.current.dataset.led = deck.playing && !deck.cuePreview ? "off" : atCue ? "on" : "blink";
      }
      if (playBtnRef.current) playBtnRef.current.dataset.led = deck.playing ? "on" : t ? "blink" : "off";
      // decay jog bend after the hand stops
      if (!jogDrag.current && deck.bend !== 0 && !bendKey.current) {
        deck.bend *= 0.85;
        if (Math.abs(deck.bend) < 0.001) deck.bend = 0;
      }
      const c = zoomRef.current;
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== w * dpr) {
        c.width = w * dpr;
        c.height = h * dpr;
      }
      const g = c.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = "#020617";
      g.fillRect(0, 0, w, h);
      if (!t) return;
      const pxPerSec = 70;
      const t0 = sec - w / 2 / pxPerSec;
      // loop region
      if (deck.loopIn !== null) {
        const a = deck.loopIn / deck.sampleRate;
        const b = deck.loopOut !== null ? deck.loopOut / deck.sampleRate : sec;
        g.fillStyle = deck.loopActive ? "rgba(251,191,36,0.22)" : "rgba(251,191,36,0.1)";
        g.fillRect((a - t0) * pxPerSec, 0, (b - a) * pxPerSec, h);
      }
      // waveform: one column per CSS pixel, each the peak of all bins it covers
      const wf = t.rgb;
      const binsPerPx = PEAKS_PER_SECOND / pxPerSec;
      const waveH = h - 12; // leave room for the beat ticks
      for (let x = 0; x < w; x++) {
        const b0 = Math.floor((t0 + x / pxPerSec) * PEAKS_PER_SECOND);
        const b1 = Math.floor(b0 + binsPerPx + 0.999);
        let bh: number;
        if (wf) {
          const m = bandMax(wf, b0, b1);
          if (m.empty) continue;
          const col = rgbColumn(m.l, m.m, m.h);
          g.fillStyle = col.color;
          bh = col.height * waveH;
        } else {
          let p = 0;
          for (let b = Math.max(0, b0); b < Math.min(t.peaks.length, b1); b++) p = Math.max(p, t.peaks[b]);
          if (b0 >= t.peaks.length || b1 <= 0) continue;
          g.fillStyle = "#38bdf8";
          bh = p * waveH;
        }
        bh = Math.max(1, bh);
        g.fillRect(x, (h - bh) / 2, 1, bh);
      }
      // beat grid on top: beat ticks at the edges, full bar lines, phrase (4 bars) in red,
      // bar numbers counted from the first downbeat of the track
      if (t.bpm) {
        const beat = 60 / t.bpm;
        const off = t.beatOffset;
        const firstBar = Math.ceil(-off / (4 * beat)); // bar index of the first downbeat at ≥ 0 s
        g.font = "bold 9px ui-sans-serif, system-ui, sans-serif";
        g.textBaseline = "top";
        for (let k = Math.floor((t0 - off) / beat); k * beat + off < t0 + w / pxPerSec; k++) {
          const x = Math.round((k * beat + off - t0) * pxPerSec);
          const isBar = ((k % 4) + 4) % 4 === 0;
          if (!isBar) {
            g.fillStyle = "rgba(255,255,255,0.75)";
            g.fillRect(x, 0, 1, 5);
            g.fillRect(x, h - 5, 1, 5);
            continue;
          }
          const bar = k / 4 - firstBar + 1; // 1-based bar number
          const phrase = ((bar - 1) % 4 + 4) % 4 === 0;
          // dark outline so the line reads on top of any waveform colour
          g.fillStyle = "rgba(2,6,23,0.85)";
          g.fillRect(x - 2, 0, 5, h);
          g.fillStyle = phrase ? "#f87171" : "#f8fafc";
          g.fillRect(x - 1, 0, 2, h);
          // CDJ-style markers top and bottom (small stepped triangles)
          for (let row = 0; row < 4; row++) {
            const half = 4 - row;
            g.fillRect(x - half, row, half * 2, 1);
            g.fillRect(x - half, h - 1 - row, half * 2, 1);
          }
          if (bar >= 1) {
            const label = String(bar);
            const tw = g.measureText(label).width;
            g.fillStyle = "rgba(2,6,23,0.85)";
            g.fillRect(x + 3, 1, tw + 4, 11);
            g.fillStyle = phrase ? "#fca5a5" : "#f8fafc";
            g.fillText(label, x + 5, 2);
          }
        }
      }
      const cueX = (deck.cue / deck.sampleRate - t0) * pxPerSec;
      g.fillStyle = "#f59e0b";
      g.fillRect(cueX - 1, 0, 2, h);
      deck.hotCues.forEach((hc) => {
        if (hc === null) return;
        g.fillStyle = "#4ade80";
        g.fillRect((hc / deck.sampleRate - t0) * pxPerSec - 1, 0, 2, h);
      });
      g.fillStyle = "#f8fafc";
      g.fillRect(w / 2 - 1, 0, 2, h);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deck, other]);

  const act = async (fn: (d: CdjDeck) => void) => {
    if (!deck) return;
    await ensureAudio();
    fn(deck);
    bump();
  };

  const loadTrack = (id: string) => {
    const t = allTracks.find((x) => x.id === id);
    if (!deck || !t) return;
    deck.load(t); // the tempo fader keeps its position
    bump();
  };

  const onFile = async (file: File | undefined) => {
    if (!file || !deck) return;
    try {
      const buffer = await deck.ctx.decodeAudioData(await file.arrayBuffer());
      const t = analyseTrack(`file-${Date.now()}`, file.name, null, buffer);
      t.analysis = "analysing";
      setUserTracks((prev) => [...prev, t]);
      deck.load(t);
      bump();
      void detectBeatAsync(buffer).then((beat) => {
        if (beat) {
          t.bpm = beat.bpm;
          t.beatOffset = beat.offset;
          t.analysis = "ready";
          toast.success(`${file.name}: ${beat.bpm.toFixed(2)} BPM`);
        } else {
          t.analysis = "failed";
          toast.error(`Could not find a steady beat in ${file.name}.`);
        }
        bump();
      });
    } catch {
      toast.error(`${file.name} is not an audio format this browser can decode.`);
    }
  };

  // ---------- jog wheel ----------
  const angleOf = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2));
  };
  const onJogDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!deck?.track) return;
    // capture synchronously: React clears currentTarget once the handler yields
    e.currentTarget.setPointerCapture(e.pointerId);
    void ensureAudio();
    const r = e.currentTarget.getBoundingClientRect();
    const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / (r.width / 2);
    // top plate scratches in VINYL mode, and searches when paused in CDJ mode; the outer ring bends
    const scratch = dist < 0.8 && (vinyl || !deck.playing);
    jogDrag.current = { angle: angleOf(e), mode: scratch ? "scratch" : "bend", lastT: performance.now() };
    if (scratch) {
      deck.scratchTarget = deck.pos;
      deck.scratching = true;
    }
  };
  const onJogMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = jogDrag.current;
    if (!d || !deck) return;
    const a = angleOf(e);
    let da = a - d.angle;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    d.angle = a;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT);
    d.lastT = now;
    if (d.mode === "scratch") {
      deck.scratchTarget += (da / (2 * Math.PI)) * SECONDS_PER_REV * deck.sampleRate;
    } else {
      deck.bend = Math.max(-0.4, Math.min(0.4, (da / dt) * 6));
    }
  };
  const onJogUp = () => {
    const d = jogDrag.current;
    jogDrag.current = null;
    if (deck && d?.mode === "scratch") deck.scratching = false;
  };
  const onJogKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!deck?.track) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const dir = e.key === "ArrowRight" ? 1 : -1;
      if (deck.playing) {
        bendKey.current = true;
        deck.bend = 0.04 * dir;
      } else {
        deck.seekSeconds(deck.seconds + dir * (e.shiftKey ? 0.01 : 0.1));
      }
    }
  };
  const onJogKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      bendKey.current = false;
      if (deck) deck.bend = 0;
    }
  };

  const toggleSync = async () => {
    if (!deck) return;
    if (deck.sync) {
      deck.sync = false;
      deck.syncNudge = 0;
      bump();
      return;
    }
    await ensureAudio();
    const err = deck.syncTo(other);
    if (err) {
      toast.error(`Deck ${n}: ${err}`);
      return;
    }
    if (Math.abs(deck.tempo) * 100 > range) setRange(100);
    bump();
  };
  const isMaster = !!other?.sync && !!deck?.track?.bpm;
  const tempoPos = deck ? 0.5 - deck.tempo / ((2 * range) / 100) : 0.5;
  const bpmNow = track?.bpm ? track.bpm * (deck ? 1 + deck.tempo : 1) : null;
  const playing = deck?.playing ?? false;

  return (
    <section
      aria-labelledby={titleId}
      className="flex w-[560px] shrink-0 flex-col gap-3 rounded-2xl border border-zinc-700 bg-gradient-to-b from-zinc-800 to-zinc-900 p-4 text-zinc-100 shadow-[0_10px_30px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]"
    >
      {/* header: brand, deck number, routing */}
      <div className="flex items-center gap-2">
        <img src={logoWhite} alt="" aria-hidden="true" className="h-3.5 w-auto select-none" draggable={false} />
        <h2 id={titleId} className="m-0 text-sm font-bold tracking-wide">
          Deck {n}
        </h2>
        <span className="ml-auto rounded border border-zinc-600 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300">
          {routedTo.length ? `→ CH ${routedTo.join(", ")}` : "Not on a channel"}
        </span>
      </div>

      {/* media: USB slot, BROWSE, track select, single file */}
      <div className="flex items-center gap-1.5">
        <div className="flex items-center overflow-hidden rounded-md border-2 border-zinc-600 bg-zinc-800">
          <button
            type="button"
            onClick={() => (usb ? setBrowsing(true) : onInsertUsb())}
            aria-label={usb ? `USB ${usb.name}: browse on deck ${n}` : "Insert USB"}
            title={usb ? `USB: ${usb.name}` : "Insert USB"}
            className={cn("flex h-7 items-center gap-1.5 px-2 text-[10px] font-bold text-zinc-100 uppercase hover:bg-zinc-700", FOCUS)}
          >
            <span aria-hidden="true" className={cn("size-2 rounded-full", usb ? "bg-green-400 shadow-[0_0_6px_rgba(74,222,128,0.9)]" : "bg-zinc-600")} />
            <Usb className="size-3.5" aria-hidden="true" />
            {usb ? "USB" : "Insert USB"}
          </button>
          {usb && (
            <button type="button" onClick={onEjectUsb} aria-label="Eject USB" title="Eject USB" className={cn("flex h-7 items-center border-l border-zinc-600 px-1.5 text-zinc-300 hover:bg-zinc-700", FOCUS)}>
              <X className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </div>
        <Key label={`Deck ${n} browse`} led="sky" lit={showBrowser} disabled={!usb} onPress={() => setBrowsing((b) => !b)}>
          Browse
        </Key>
        <div className="ml-auto flex items-center gap-1">
          <Select value={track?.id ?? ""} onValueChange={loadTrack}>
            <SelectTrigger size="sm" aria-label={`Deck ${n} track`} className="h-7 w-32 border-zinc-600 bg-zinc-800 px-2 text-xs text-zinc-100 [&_svg]:text-zinc-300">
              <SelectValue placeholder="No track" />
            </SelectTrigger>
            <SelectContent>
              {allTracks.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button
            type="button"
            aria-label={`Load a single audio file on deck ${n}`}
            title="Load a single audio file"
            onClick={() => fileRef.current?.click()}
            className={cn("rounded-md border border-zinc-600 p-1.5 text-zinc-200 hover:bg-zinc-700", FOCUS)}
          >
            <FolderOpen className="size-3.5" aria-hidden="true" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*"
            className="hidden"
            aria-hidden="true"
            tabIndex={-1}
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
      </div>

      {/* LCD */}
      <div className="rounded-md border border-zinc-950 bg-slate-950 p-2 font-mono text-sky-200 shadow-inner">
      {showBrowser && usb && (
        <DeckBrowser
          deckNumber={n}
          deck={deck}
          media={usb}
          ensureAudio={ensureAudio}
          onLoaded={closeBrowser}
          trail={browseTrail}
          setTrail={setBrowseTrail}
        />
      )}
      <div className={cn("flex min-h-[172px] flex-col gap-1.5", showBrowser && "hidden")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[11px] text-sky-100">
            {track?.title ?? "No track"}
            {track?.key && <span className="ml-1.5 rounded-sm bg-sky-900 px-1 text-[9px] text-sky-100">{track.key}</span>}
          </span>
          <button type="button" onClick={() => setRemain((r) => !r)} className={cn("shrink-0 rounded px-1 text-[9px] text-sky-300 uppercase hover:bg-slate-800", FOCUS)}>
            {remain ? "Remain" : "Elapsed"}
          </button>
        </div>
        <div className="flex items-end justify-between">
          <span ref={timeRef} className="text-2xl leading-none font-bold tabular-nums">
            --:--.-
          </span>
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[9px] text-sky-400 uppercase">BPM</span>
            <span className="text-lg font-bold tabular-nums">{track?.analysis === "analysing" ? "…" : bpmNow ? bpmNow.toFixed(1) : "--.-"}</span>
          </div>
          <div className="flex flex-col items-end leading-tight">
            <span className="text-[9px] text-sky-400 uppercase">
              {deck?.masterTempo && <span className="mr-1 rounded-sm bg-red-500 px-0.5 text-[8px] text-white">MT</span>}
              {deck?.sync && <span className="mr-1 rounded-sm bg-sky-500 px-0.5 text-[8px] text-slate-950">SYNC</span>}
              {isMaster && <span className="mr-1 rounded-sm bg-amber-400 px-0.5 text-[8px] text-slate-950">MASTER</span>}
              Tempo ±{range === 100 ? "W" : range}
            </span>
            <span className="text-sm font-bold tabular-nums">{fmtPct(deck?.tempo ?? 0)}</span>
          </div>
        </div>
        <canvas ref={zoomRef} data-aether-canvas-purpose="non-drawing" className="h-24 w-full rounded-sm" aria-hidden="true" />
        <div
          className="relative h-8 w-full cursor-pointer rounded-sm bg-slate-900"
          role="slider"
          tabIndex={0}
          aria-label={`Deck ${n} needle search`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={deck && deck.duration ? Math.round((deck.seconds / deck.duration) * 100) : 0}
          onPointerDown={(e) => {
            if (!deck?.track) return;
            const r = e.currentTarget.getBoundingClientRect();
            deck.seekSeconds(((e.clientX - r.left) / r.width) * deck.duration);
            bump();
          }}
          {...{
            onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
              if (!deck?.track) return;
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                deck.seekSeconds(deck.seconds + (e.key === "ArrowRight" ? 5 : -5));
                bump();
              }
            },
          }}
        >
          <canvas ref={overviewRef} data-aether-canvas-purpose="non-drawing" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />
          {deck?.track && (
            <>
              {deck.loopIn !== null && deck.loopOut !== null && (
                <span
                  aria-hidden="true"
                  className={cn("pointer-events-none absolute inset-y-0 bg-amber-400/30", !deck.loopActive && "bg-amber-400/15")}
                  style={{ left: `${(deck.loopIn / deck.length) * 100}%`, width: `${((deck.loopOut - deck.loopIn) / deck.length) * 100}%` }}
                />
              )}
              <span aria-hidden="true" className="pointer-events-none absolute -top-0.5 size-0 -translate-x-1/2 border-x-4 border-t-[6px] border-x-transparent border-t-amber-400" style={{ left: `${(deck.cue / deck.length) * 100}%` }} />
              {deck.hotCues.map((hc, i) =>
                hc === null ? null : (
                  <span key={i} aria-hidden="true" className="pointer-events-none absolute bottom-0 -translate-x-1/2 text-[8px] leading-none font-bold text-green-300" style={{ left: `${(hc / deck.length) * 100}%` }}>
                    {HOT_CUE_NAMES[i]}
                  </span>
                ),
              )}
            </>
          )}
          <div ref={headRef} aria-hidden="true" className="pointer-events-none absolute inset-y-0 w-0.5 bg-white" style={{ left: 0 }} />
        </div>
        <div className="flex items-center gap-1 text-[9px] text-sky-300 uppercase">
          <span className="mr-auto text-sky-400">Grid</span>
          {(
            [
              ["◀", `Deck ${n} beat grid 5 ms earlier`, -0.005],
              ["▶", `Deck ${n} beat grid 5 ms later`, 0.005],
            ] as const
          ).map(([glyph, label, dt]) => (
            <button
              key={glyph}
              type="button"
              aria-label={label}
              title={label}
              disabled={!track?.bpm}
              onClick={() => void act((d) => d.shiftGrid(dt))}
              className={cn("rounded border border-slate-700 px-1.5 py-0.5 hover:bg-slate-800 disabled:opacity-40", FOCUS)}
            >
              {glyph}
            </button>
          ))}
          <button
            type="button"
            aria-label={`Deck ${n} set beat 1 at the playhead`}
            title="Make the playhead position beat 1 of a bar (pause on the kick first)"
            disabled={!track?.bpm}
            onClick={() => void act((d) => d.setDownbeatHere())}
            className={cn("rounded border border-slate-700 px-1.5 py-0.5 hover:bg-slate-800 disabled:opacity-40", FOCUS)}
          >
            Beat 1 here
          </button>
        </div>
      </div>
      </div>

      {/* hot cue pads A–H under the screen */}
      <div role="group" aria-label={`Deck ${n} hot cues`} className="flex items-stretch gap-1.5">
        {Array.from({ length: HOT_CUE_COUNT }, (_, i) => (
          <Key
            key={i}
            label={`Deck ${n} hot cue ${HOT_CUE_NAMES[i]}${eraseHot ? " (delete)" : ""}`}
            led={eraseHot ? "red" : "green"}
            lit={deck?.hotCues[i] !== null && deck?.hotCues[i] !== undefined}
            className="h-10 min-w-0 flex-1 px-0 text-xs"
            onPress={() =>
              void act((d) => {
                d.hotCue(i, eraseHot);
                if (eraseHot) setEraseHot(false);
              })
            }
          >
            {HOT_CUE_NAMES[i]}
          </Key>
        ))}
        <Key label={`Deck ${n} hot cue delete`} led="red" lit={eraseHot} className="h-10 px-2 text-[9px]" onPress={() => setEraseHot((v) => !v)}>
          Delete
        </Key>
      </div>

      {/* main section: loop / search / CUE + PLAY · jog · sync / tempo */}
      <div className="grid grid-cols-[108px_1fr_84px] gap-3">
        {/* left column */}
        <div className="flex flex-col justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <Caption>Loop</Caption>
            <div className="grid grid-cols-2 gap-1.5">
              <Key label={`Deck ${n} loop in / cue`} lit={deck?.loopIn !== null && deck?.loopIn !== undefined} className="min-w-0 px-0" onPress={() => void act((d) => d.loopInPress())}>
                In
              </Key>
              <Key label={`Deck ${n} loop out`} lit={deck?.loopActive} blink className="min-w-0 px-0" onPress={() => void act((d) => d.loopOutPress())}>
                Out
              </Key>
              <Key label={`Deck ${n} reloop / exit`} lit={deck?.loopActive} className="col-span-2" onPress={() => void act((d) => d.reloopExit())}>
                Reloop / Exit
              </Key>
              <Key label={`Deck ${n} 4-beat loop`} disabled={!track?.bpm} className="col-span-2" onPress={() => void act((d) => d.beatLoop(4))}>
                4 Beat Loop
              </Key>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Caption>Search</Caption>
            <div className="grid grid-cols-2 gap-1.5">
              {([-1, 1] as const).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  aria-label={`Deck ${n} search ${dir < 0 ? "backward" : "forward"} (hold)`}
                  disabled={!track}
                  onPointerDown={() => void act((d) => (d.search = dir))}
                  onPointerUp={() => void act((d) => (d.search = 0))}
                  onPointerLeave={() => deck && deck.search !== 0 && void act((d) => (d.search = 0))}
                  {...{
                    onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
                      if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                        e.preventDefault();
                        void act((d) => (d.search = dir));
                      }
                    },
                    onKeyUp: () => void act((d) => (d.search = 0)),
                  }}
                  className={cn(
                    "flex h-9 items-center justify-center rounded-md border border-black/70 bg-gradient-to-b from-zinc-700 to-zinc-800 text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.09),0_2px_0_rgba(0,0,0,0.55)] hover:from-zinc-600 active:translate-y-px disabled:opacity-40",
                    FOCUS,
                  )}
                >
                  {dir < 0 ? <Rewind className="size-4" aria-hidden="true" /> : <FastForward className="size-4" aria-hidden="true" />}
                </button>
              ))}
            </div>
          </div>
          {/* CUE above PLAY/PAUSE, bottom left of the jog, as on CDJs */}
          <div className="flex flex-col items-center gap-3">
            <div className="flex flex-col items-center gap-1">
              <Caption>Cue</Caption>
              <button
                ref={cueBtnRef}
                type="button"
                data-led="off"
                aria-label={`Deck ${n} cue`}
                disabled={!track}
                onPointerDown={() => void act((d) => d.cueDown())}
                onPointerUp={() => void act((d) => d.cueUp())}
                onPointerLeave={() => deck?.cuePreview && void act((d) => d.cueUp())}
                {...{
                  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
                    if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                      e.preventDefault();
                      void act((d) => d.cueDown());
                    }
                  },
                  onKeyUp: (e: ReactKeyboardEvent<HTMLButtonElement>) => {
                    if (e.key === " " || e.key === "Enter") void act((d) => d.cueUp());
                  },
                }}
                className={cn(
                  "size-[76px] rounded-full border-[5px] border-zinc-600 bg-gradient-to-b from-zinc-600 to-zinc-900 text-sm font-black tracking-wider text-zinc-100 shadow-[0_3px_0_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.15)] active:translate-y-px disabled:opacity-40",
                  "data-[led=on]:border-amber-400 data-[led=on]:shadow-[0_0_16px_rgba(251,191,36,0.75)]",
                  "data-[led=blink]:animate-pulse data-[led=blink]:border-amber-400",
                  FOCUS,
                )}
              >
                CUE
              </button>
            </div>
            <div className="flex flex-col items-center gap-1">
              <Caption>Play / Pause</Caption>
              <button
                ref={playBtnRef}
                type="button"
                data-led="off"
                aria-label={`Deck ${n} play / pause`}
                aria-pressed={playing}
                disabled={!track}
                onClick={() => void act((d) => d.togglePlay())}
                className={cn(
                  "flex size-[76px] items-center justify-center gap-0.5 rounded-full border-[5px] border-zinc-600 bg-gradient-to-b from-zinc-600 to-zinc-900 text-zinc-100 shadow-[0_3px_0_rgba(0,0,0,0.6),inset_0_1px_0_rgba(255,255,255,0.15)] active:translate-y-px disabled:opacity-40",
                  "data-[led=on]:border-green-400 data-[led=on]:shadow-[0_0_16px_rgba(74,222,128,0.75)]",
                  "data-[led=blink]:animate-pulse data-[led=blink]:border-green-500",
                  FOCUS,
                )}
              >
                <Play className="size-5" aria-hidden="true" />
                <Pause className="size-5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

        {/* jog wheel */}
        <div className="flex flex-col items-center justify-between gap-3">
          <div
            ref={jogRef}
            role="slider"
            tabIndex={0}
            aria-label={`Deck ${n} jog wheel`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={deck && deck.duration ? Math.round((deck.seconds / deck.duration) * 100) : 0}
            aria-valuetext={vinyl ? "Vinyl mode: top scratches, ring bends" : "CDJ mode: bends while playing, searches when paused"}
            onPointerDown={onJogDown}
            onPointerMove={onJogMove}
            onPointerUp={onJogUp}
            onPointerCancel={onJogUp}
            {...{ onKeyDown: onJogKey, onKeyUp: onJogKeyUp }}
            className={cn("size-[300px] cursor-grab touch-none rounded-full active:cursor-grabbing", FOCUS)}
          >
            <svg viewBox="0 0 300 300" className="block size-full" aria-hidden="true">
              <defs>
                <radialGradient id={`plate-${index}`} cx="50%" cy="32%" r="72%">
                  <stop offset="0%" stopColor="#71717a" />
                  <stop offset="55%" stopColor="#3f3f46" />
                  <stop offset="100%" stopColor="#18181b" />
                </radialGradient>
                <radialGradient id={`shine-${index}`} cx="50%" cy="20%" r="55%">
                  <stop offset="0%" stopColor="rgba(255,255,255,0.18)" />
                  <stop offset="100%" stopColor="rgba(255,255,255,0)" />
                </radialGradient>
              </defs>
              {/* base and gripped outer ring (pitch bend) */}
              <circle cx="150" cy="150" r="149" className="fill-black" />
              <circle cx="150" cy="150" r="138" className="fill-none stroke-zinc-800" strokeWidth={20} />
              {Array.from({ length: 120 }, (_, i) => (
                <line key={i} x1="150" y1="3" x2="150" y2="21" className="stroke-zinc-700" strokeWidth={1.2} transform={`rotate(${i * 3} 150 150)`} />
              ))}
              <circle cx="150" cy="150" r="127" className="fill-none stroke-black" strokeWidth={2} />
              {/* top plate (scratch / search) */}
              <circle cx="150" cy="150" r="125" fill={`url(#plate-${index})`} />
              <g ref={platterRef}>
                {Array.from({ length: 48 }, (_, i) => (
                  <line key={i} x1="150" y1="30" x2="150" y2={i % 12 === 0 ? 46 : 38} className={i === 0 ? "stroke-amber-400" : "stroke-zinc-400/50"} strokeWidth={i === 0 ? 4 : 1.2} transform={`rotate(${i * 7.5} 150 150)`} />
                ))}
              </g>
              <circle cx="150" cy="150" r="125" fill={`url(#shine-${index})`} />
              {/* centre display: track position ring with the cue point */}
              <circle cx="150" cy="150" r="72" className="fill-slate-950 stroke-zinc-900" strokeWidth={3} />
              <circle cx="150" cy="150" r={JOG_RING_R} className="fill-none stroke-slate-800" strokeWidth={5} />
              <circle
                ref={ringRef}
                cx="150"
                cy="150"
                r={JOG_RING_R}
                className={cn("fill-none", playing ? "stroke-sky-400" : "stroke-sky-700")}
                strokeWidth={5}
                strokeDasharray={JOG_RING_C}
                strokeDashoffset={JOG_RING_C}
                transform="rotate(-90 150 150)"
              />
              {deck?.track && deck.length > 0 && (
                <circle
                  cx={150 + JOG_RING_R * Math.sin((deck.cue / deck.length) * 2 * Math.PI)}
                  cy={150 - JOG_RING_R * Math.cos((deck.cue / deck.length) * 2 * Math.PI)}
                  r={4}
                  className="fill-amber-400"
                />
              )}
              <text x="150" y="142" textAnchor="middle" className="fill-sky-200 text-[15px] font-bold tracking-widest">
                {vinyl ? "VINYL" : "CDJ"}
              </text>
              <text x="150" y="164" textAnchor="middle" className={cn("text-[12px] font-semibold tracking-wider", playing ? "fill-green-400" : "fill-sky-500")}>
                {playing ? "PLAY" : "PAUSE"}
              </text>
              {deck?.reverse && (
                <text x="150" y="182" textAnchor="middle" className="fill-red-400 text-[10px] font-bold tracking-wider">
                  REV
                </text>
              )}
            </svg>
          </div>
          <div className="flex w-full justify-center gap-1.5">
            <Key label={`Deck ${n} jog mode`} led="sky" lit={vinyl} className="w-20" onPress={() => setVinyl((v) => !v)}>
              {vinyl ? "Vinyl" : "CDJ"}
            </Key>
            <Key label={`Deck ${n} direction reverse`} led="red" lit={deck?.reverse} className="w-20" onPress={() => void act((d) => (d.reverse = !d.reverse))}>
              Rev
            </Key>
            <Key label={`Deck ${n} time mode`} lit={remain} className="w-20" onPress={() => setRemain((r) => !r)}>
              Time
            </Key>
          </div>
        </div>

        {/* right column: sync, tempo */}
        <div className="flex flex-col items-stretch gap-1.5">
          <Key label={`Deck ${n} beat sync`} led="sky" lit={deck?.sync} className="h-10" onPress={() => void toggleSync()}>
            Beat Sync
          </Key>
          <span
            aria-hidden={!isMaster}
            className={cn(
              "rounded-md border px-1 py-1 text-center text-[9px] font-bold tracking-wider uppercase",
              isMaster ? "border-amber-400 text-amber-200 shadow-[0_0_8px_rgba(251,191,36,0.45)]" : "border-zinc-700 text-zinc-500",
            )}
          >
            Master
          </span>
          <Caption>Tempo</Caption>
          <button
            type="button"
            aria-label={`Deck ${n} tempo range`}
            title="Tempo range"
            onClick={() => {
              const next = TEMPO_RANGES[(TEMPO_RANGES.indexOf(range) + 1) % TEMPO_RANGES.length];
              if (deck) deck.tempo = Math.max(-next / 100, Math.min(next / 100, deck.tempo));
              setRange(next);
            }}
            className={cn("rounded-md border border-black/70 bg-zinc-950 px-1 py-1 font-mono text-[11px] font-bold text-sky-200 shadow-inner hover:bg-zinc-900", FOCUS)}
          >
            ±{range === 100 ? "Wide" : `${range}%`}
          </button>
          <Key label={`Deck ${n} master tempo`} led="red" lit={deck?.masterTempo} className="min-w-0 px-0.5 text-[9px]" onPress={() => void act((d) => (d.masterTempo = !d.masterTempo))}>
            Master Tempo
          </Key>
          <div className="flex flex-1 justify-center py-1">
            <Fader
              height={232}
              label={`Deck ${n} tempo`}
              pos={tempoPos}
              defaultPos={0.5}
              onPos={(p) => {
                if (!deck) return;
                deck.sync = false; // moving the fader by hand releases SYNC
                deck.tempo = (0.5 - p) * ((2 * range) / 100);
                if (Math.abs(deck.tempo) < 0.0005) deck.tempo = 0;
                bump();
              }}
              valueText={fmtPct(deck?.tempo ?? 0)}
            />
          </div>
          <Key
            label={`Deck ${n} tempo reset`}
            lit={(deck?.tempo ?? 0) === 0}
            led="green"
            onPress={() => {
              if (deck) deck.tempo = 0;
              bump();
            }}
          >
            Reset
          </Key>
        </div>
      </div>
    </section>
  );
}

/**
 * Memoised: a deck panel redraws itself from its own animation loop, so it should not
 * re-render on every mixer change (whole-console redraws starve the deck audio).
 * Callback props must be stable and `routedTo` memoised by the parent.
 */
export const CdjDeckPanel = memo(CdjDeckView);
