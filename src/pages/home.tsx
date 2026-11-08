import { startTransition, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Pause, Play, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AmountLed,
  Crossfader,
  FOCUS,
  Fader,
  Knob,
  MainMeter,
  Meter,
  MiniSwitch,
  PLOT_FREQS,
  ResponsePlot,
  RoundButton,
  SigLed,
  Toggle3,
  paintMeter,
  paintSig,
  peakToMeterDb,
} from "@/components/mixer-controls";
import { FxRack, type PatchStatus } from "@/components/fx-rack";
import { CdjDeckPanel } from "@/components/cdj-deck";
import { openUsbMedia, type UsbMedia } from "@/lib/usb-library";
import logoBlack from "@/assets/nomad-logo-black.png";
import { CdjDeck, DEMO_TRACKS, HOT_CUE_COUNT, HOT_CUE_NAMES, renderDemoTrack, type DeckTrack } from "@/lib/cdj-deck";
import { MidiPanel } from "@/components/midi-panel";
import { MidiController, type MidiTarget } from "@/lib/midi";
import {
  AUX_EQ,
  BPM,
  EQ_FREQS,
  EQ_KILL,
  LOOP_LABELS,
  MixerEngine,
  freqFromNorm,
  midFreqFromNorm,
  qFromNorm,
  renderLoop,
  type AuxParams,
  type ChannelParams,
  type DelayParams,
  type FaderCurve,
  type FilterAssign,
  type FilterMode,
  type FilterParams,
  type LoopId,
  type MixerParams,
  type ReturnParams,
  type ReturnPatch,
  type ReverbParams,
  type XAssign,
  type XCurve,
} from "@/lib/mixer-engine";
import { DIVISIONS } from "@/lib/mixer-engine";

/** FX knobs from MIDI glide to the hardware position (time constant, s) instead of jumping. */
const FX_GLIDE = 0.12;

// ---------------- value mappings ----------------

const dbToPos = (db: number, min: number, max: number) => (db < 0 ? 0.5 * (1 - db / min) : 0.5 + 0.5 * (db / max));
const posToDb = (pos: number, min: number, max: number) => (pos < 0.5 ? min * (1 - pos / 0.5) : max * ((pos - 0.5) / 0.5));
const fmtDb = (db: number, killAt?: number) =>
  killAt !== undefined && db <= killAt + 0.5 ? "Kill" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)} kHz` : `${Math.round(hz)} Hz`);
const fmtPct = (v: number) => `${Math.round(v * 100)}%`;
const fmtFader = (v: number) => (v <= 0.001 ? "Off" : `${Math.round(v * 100)}%`);

// ---------------- state ----------------

type Action =
  | { type: "channel"; index: number; patch: Partial<ChannelParams> }
  | { type: "aux"; index: number; patch: Partial<AuxParams> }
  | { type: "return"; index: number; patch: Partial<ReturnParams> }
  | { type: "filter"; index: number; patch: Partial<FilterParams> }
  | { type: "delay"; patch: Partial<DelayParams> }
  | { type: "reverb"; patch: Partial<ReverbParams> }
  | { type: "xfader"; value: number }
  | { type: "xCurve"; value: XCurve }
  | { type: "chCurve"; value: FaderCurve }
  | { type: "master"; value: number };

const ch = (filter: FilterAssign, xf: XAssign, fader: number, send1 = 0, send2 = 0): ChannelParams => ({
  send1,
  send1Pre: false,
  send2,
  trim: 0,
  hi: 0,
  hiMid: 0,
  loMid: 0,
  lo: 0,
  fader,
  filter,
  xf,
});
const aux = (): AuxParams => ({ send1: 0, send1Pre: false, send2: 0, trim: 0, hi: 0, mid: 0, midFreq: 0.5, lo: 0, fader: 0.75, filter: "off" });

const INITIAL: MixerParams = {
  channels: [ch("off", "x", 0.8), ch("1", "x", 0.75), ch("off", "y", 0.7, 0.45), ch("2", "y", 0.65, 0, 0.5)],
  aux: [aux(), aux()],
  returns: [
    { on: false, level: 0.75 },
    { on: false, level: 0.75 },
  ],
  filters: [
    { on: true, types: ["lpf"], freq: 0.62, res: 0.45, crunch: 0 },
    { on: false, types: ["hpf"], freq: 0.3, res: 0.35, crunch: 0.25 },
  ],
  xfader: 0,
  xCurve: "power",
  chCurve: "power",
  master: 0.75,
  delay: { on: true, division: "3/16", feedback: 0.45, tone: 0.6, pingPong: true, output: 0.8, patch: "A" },
  reverb: { on: true, decay: 0.5, predelay: 0.2, damp: 0.4, output: 0.8, patch: "B" },
};

const patchAt = <T,>(arr: T[], i: number, patch: Partial<T>) => arr.map((x, k) => (k === i ? { ...x, ...patch } : x));

function reducer(s: MixerParams, a: Action): MixerParams {
  switch (a.type) {
    case "channel":
      return { ...s, channels: patchAt(s.channels, a.index, a.patch) };
    case "aux":
      return { ...s, aux: patchAt(s.aux, a.index, a.patch) };
    case "return":
      return { ...s, returns: patchAt(s.returns, a.index, a.patch) };
    case "filter":
      return { ...s, filters: patchAt(s.filters, a.index, a.patch) };
    case "delay":
      return { ...s, delay: { ...s.delay, ...a.patch } };
    case "reverb":
      return { ...s, reverb: { ...s.reverb, ...a.patch } };
    case "xfader":
      return { ...s, xfader: a.value };
    case "xCurve":
      return { ...s, xCurve: a.value };
    case "chCurve":
      return { ...s, chCurve: a.value };
    case "master":
      return { ...s, master: a.value };
  }
}

type SourceChoice = LoopId | "file" | "none" | "rtn" | "deck1" | "deck2";
const deckOf = (c: SourceChoice) => (c === "deck1" ? 0 : c === "deck2" ? 1 : null);
interface ChannelSource {
  choice: SourceChoice;
  fileName?: string;
  fileBuffer?: AudioBuffer;
}
const LOOP_IDS: LoopId[] = ["kick", "bass", "hats", "pad"];
const AUX_NAMES = ["A", "B"] as const;
const MODES: { value: FilterMode; text: string }[] = [
  { value: "hpf", text: "HPF" },
  { value: "bpf", text: "BPF" },
  { value: "lpf", text: "LPF" },
];
const typeName = (types: FilterMode[]) =>
  types.length === 3
    ? "All-pass"
    : types.length === 2 && types.includes("hpf") && types.includes("lpf")
      ? "Notch"
      : MODES.filter((m) => types.includes(m.value)).map((m) => m.text).join("+");

type CueKey = "A" | "B" | "1" | "2" | "3" | "4" | "C" | "D";
// strip order on the engine: 0-3 = CH 1-4, 4 = CH A, 5 = CH B
const CUE_STRIP: Partial<Record<CueKey, number>> = { "1": 0, "2": 1, "3": 2, "4": 3, A: 4, B: 5 };

// ---------------- panel geometry (rows line up across every column, like the top panel) ----------------

const CH_W = 86;
const FX_W = 96;
const ROW = {
  send: 52,
  pre: 16,
  input: 70,
  gain: 54,
  eq: 58,
  toggle: 24,
  cue: 48,
  fader: 196,
  number: 20,
};
const FADER_H = 176;
const TOP_H = ROW.send * 2 + ROW.pre + ROW.input + ROW.gain + ROW.eq * 2; // RTN C/D + master meters zone
const LOWER_H = ROW.eq * 2 + ROW.toggle * 2 + ROW.cue + ROW.fader + ROW.number; // filter zone

function Row({ h, children, className, label }: { h: number; children?: ReactNode; className?: string; label?: ReactNode }) {
  return (
    <div className={cn("relative flex w-full items-center justify-center", label !== undefined && "pl-4", className)} style={{ height: h }}>
      {label !== undefined && <div className="absolute top-0.5 left-1.5 flex items-center gap-1">{label}</div>}
      {children}
    </div>
  );
}
function Boxed({ children, inverse = false }: { children: ReactNode; inverse?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-3.5 min-w-3.5 items-center justify-center px-0.5 text-[9px] leading-none font-bold uppercase",
        inverse ? "bg-zinc-900 text-zinc-50" : "border border-zinc-800 text-zinc-900",
      )}
    >
      {children}
    </span>
  );
}
function TwoLine({ a, b }: { a: string; b: string }) {
  return (
    <span className="flex flex-col text-[8px] leading-[9px] font-bold text-zinc-800 uppercase">
      <span>{a}</span>
      <span>{b}</span>
    </span>
  );
}
const PkLed = ({ elRef }: { elRef: (el: HTMLSpanElement | null) => void }) => (
  <span ref={elRef} aria-hidden="true" data-pk="off" className="inline-block size-2 rounded-full bg-zinc-900 data-[pk=on]:bg-red-500 data-[pk=on]:shadow-[0_0_6px_rgba(239,68,68,0.9)]" />
);
const FILTER_ICON: Record<FilterMode, string> = {
  hpf: "M1 9 L5 3 L13 3",
  bpf: "M1 9 L4 9 L7 2 L10 9 L13 9",
  lpf: "M1 3 L9 3 L13 9",
};
function Legend({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <span className={cn("text-[9px] font-bold tracking-wide text-zinc-800 uppercase", className)} style={style}>
      {children}
    </span>
  );
}

function InputSelect({
  name,
  source,
  withRtn,
  onChoice,
  onLoad,
}: {
  name: string;
  source: ChannelSource;
  withRtn: boolean;
  onChoice: (c: SourceChoice) => void;
  onLoad: (f: File | undefined) => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const options: { value: SourceChoice; label: string }[] = [
    ...(withRtn ? [{ value: "rtn" as const, label: `RTN ${name}` }] : []),
    { value: "deck1", label: "Deck 1" },
    { value: "deck2", label: "Deck 2" },
    ...LOOP_IDS.map((id) => ({ value: id as SourceChoice, label: LOOP_LABELS[id] })),
    ...(source.fileName ? [{ value: "file" as const, label: source.fileName }] : []),
    { value: "none", label: "Off" },
  ];
  const idx = Math.max(0, options.findIndex((o) => o.value === source.choice));
  const n = options.length;
  return (
    <div className="flex items-center gap-1">
      <div className="flex flex-col items-center">
        <Knob
          variant="panel"
          pointer="red"
          size={30}
          ticks={n}
          label={`Channel ${name} input select`}
          pos={idx / (n - 1)}
          defaultPos={0}
          keyStep={1 / (n - 1)}
          onPos={(p) => onChoice(options[Math.round(p * (n - 1))].value)}
          valueText={options[idx].label}
        />
        <button
          type="button"
          aria-label={`Load audio file on channel ${name}`}
          title="Load audio file"
          onClick={() => fileRef.current?.click()}
          className={cn("rounded p-0.5 text-zinc-700 hover:bg-zinc-400/50 hover:text-zinc-950", FOCUS)}
        >
          <Upload className="size-3" aria-hidden="true" />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="audio/*"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            onLoad(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <ul aria-hidden="true" className="m-0 flex list-none flex-col p-0 text-[7.5px] leading-[9px] font-bold uppercase">
        {options.map((o, k) => (
          <li key={o.value} className={cn("max-w-[34px] truncate", k === idx ? "text-red-700" : "text-zinc-700")}>
            {o.value === "file" ? "File" : o.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

const FILTER_T: [{ value: FilterAssign; text: string; name: string }, { value: FilterAssign; text: string; name: string }, { value: FilterAssign; text: string; name: string }] = [
  { value: "1", text: "1", name: "filter 1" },
  { value: "off", text: "", name: "off (LR mix)" },
  { value: "2", text: "2", name: "filter 2" },
];
const XF_T: [{ value: XAssign; text: string; name: string }, { value: XAssign; text: string; name: string }, { value: XAssign; text: string; name: string }] = [
  { value: "x", text: "X", name: "side X" },
  { value: "off", text: "", name: "off (LR mix)" },
  { value: "y", text: "Y", name: "side Y" },
];

const STRIP_NAMES = ["1", "2", "3", "4", "A", "B"];

/** The tempo the FX follow: the playing deck, the sync master when both play, else the loops. */
function fxMasterBpm(decks: CdjDeck[], loopsPlaying: boolean): number | null {
  const playing = decks.filter((d) => d.playing && d.bpmNow);
  if (playing.length === 1) return playing[0].bpmNow;
  if (playing.length > 1) return (playing.find((d) => !d.sync) ?? playing[0]).bpmNow;
  return loopsPlaying ? BPM : null;
}

export function HomePage() {
  const [params, dispatch] = useReducer(reducer, INITIAL);
  // Mixer state as the audio engine hears it: runs ahead of `params` while a MIDI-driven
  // re-render is still pending (see `midiDispatch`).
  const liveParams = useRef(params);
  const [sources, setSources] = useState<ChannelSource[]>([
    { choice: "kick" },
    { choice: "deck1" },
    { choice: "deck2" },
    { choice: "pad" },
    { choice: "rtn" },
    { choice: "rtn" },
  ]);
  const [decks, setDecks] = useState<CdjDeck[]>([]);
  const [demos, setDemos] = useState<DeckTrack[]>([]);
  const [cue, setCue] = useState<CueKey | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [fxTempo, setFxTempo] = useState(BPM);
  const [responses, setResponses] = useState<(Float32Array | null)[]>([null, null]);
  const engineRef = useRef<MixerEngine | null>(null);
  const meterEls = useRef<(HTMLDivElement | null)[]>([]);
  const sigEls = useRef<(HTMLSpanElement | null)[]>([]);
  const pkEls = useRef<(HTMLSpanElement | null)[]>([]);
  const cueRef = useRef<CueKey | null>(null);
  const heldTypes = useRef<Set<FilterMode>[]>([new Set(), new Set()]);
  const comboPress = useRef<boolean[]>([false, false]);

  useEffect(() => {
    cueRef.current = cue;
  }, [cue]);

  // Engine lifecycle + loop rendering
  useEffect(() => {
    let cancelled = false;
    let engine: MixerEngine;
    try {
      engine = new MixerEngine();
    } catch {
      toast.error("This browser does not support Web Audio.");
      return;
    }
    engineRef.current = engine;
    const deckPair = [new CdjDeck(engine.ctx), new CdjDeck(engine.ctx)];
    engine.attachDecks(deckPair.map((d) => d.output));
    setDecks(deckPair);
    Promise.all(DEMO_TRACKS.map((spec) => renderDemoTrack(spec)))
      .then((tracks) => {
        if (!cancelled) setDemos(tracks);
      })
      .catch(() => toast.error("Could not prepare the deck demo tracks."));
    Promise.all(LOOP_IDS.map((id) => renderLoop(id).then((b) => [id, b] as const)))
      .then((pairs) => {
        if (cancelled) return;
        pairs.forEach(([id, b]) => (engine.loops[id] = b));
        setReady(true);
      })
      .catch(() => toast.error("Could not prepare the built-in loops."));
    return () => {
      cancelled = true;
      deckPair.forEach((d) => d.dispose());
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    const e = engineRef.current;
    if (!e) return;
    liveParams.current = params;
    e.apply(params);
    const next = [e.filterResponse(0, PLOT_FREQS, params.filters[0].types), e.filterResponse(1, PLOT_FREQS, params.filters[1].types)];
    // a plain update here would re-render the whole console in one blocking pass
    startTransition(() => setResponses(next));
  }, [params, ready]);

  useEffect(() => {
    const e = engineRef.current;
    if (!e || !ready) return;
    sources.forEach((s, i) => {
      const deck = deckOf(s.choice);
      const buf =
        s.choice === "none" || s.choice === "rtn" || deck !== null ? null : s.choice === "file" ? (s.fileBuffer ?? null) : (e.loops[s.choice as LoopId] ?? null);
      if (e.strips[i].buffer !== buf) e.setBuffer(i, buf);
      e.setDeckInput(i, deck);
      if (i >= 4) e.setReturnInput(i - 4, s.choice === "rtn");
    });
  }, [sources, ready]);

  // Meters: channel meters are post-GAIN/post-EQ/pre-FADER; the main meters show the
  // LR MIX, or the CUE'd channel when a CUE switch is active (as the user guide describes).
  useEffect(() => {
    let raf = 0;
    const held = new Array(8).fill(0);
    let shownTempo = BPM;
    const loop = () => {
      const e = engineRef.current;
      if (e) {
        // FX tempo follows the playing deck (the sync master when both play), else the loops
        const bpm = fxMasterBpm(decksRef.current, e.playing);
        if (bpm !== null) {
          e.setFxTempo(bpm);
          if (Math.abs(bpm - shownTempo) >= 0.05) {
            shownTempo = bpm;
            setFxTempo(Math.round(bpm * 10) / 10);
          }
        }
        const lv = e.levels();
        const c = cueRef.current;
        let l = lv.l;
        let r = lv.r;
        if (c) {
          const v = c === "C" || c === "D" ? lv.returns[c === "C" ? 0 : 1] : lv.channels[CUE_STRIP[c]!];
          l = v;
          r = v;
        }
        [...lv.channels, l, r].forEach((v, i) => {
          held[i] = Math.max(v, held[i] * 0.86);
          paintMeter(meterEls.current[i], held[i]);
        });
        lv.returns.forEach((v, i) => paintSig(sigEls.current[i], v));
        lv.channels.forEach((v, i) => {
          const el = pkEls.current[i];
          if (el) el.dataset.pk = peakToMeterDb(v) >= 10 ? "on" : "off";
        });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const togglePlay = useCallback(async () => {
    const e = engineRef.current;
    if (!e) return;
    if (e.playing) {
      e.stop();
      setPlaying(false);
    } else {
      try {
        await e.play();
        setPlaying(true);
      } catch {
        toast.error("Audio could not start. Click Play again.");
      }
    }
  }, []);

  const loadFile = async (index: number, name: string, file: File | undefined) => {
    const e = engineRef.current;
    if (!file || !e) return;
    try {
      const buffer = await e.decode(await file.arrayBuffer());
      setSources((prev) => patchAt(prev, index, { choice: "file", fileName: file.name, fileBuffer: buffer }));
      toast.success(`Loaded ${file.name} on channel ${name}`);
    } catch {
      toast.error(`${file.name} is not an audio format this browser can decode.`);
    }
  };
  const setChoice = (index: number, choice: SourceChoice) => setSources((prev) => patchAt(prev, index, { choice }));
  const ensureAudio = useCallback(async () => {
    await engineRef.current?.ctx.resume();
  }, []);
  const routed = useMemo(
    () => [0, 1].map((d) => sources.map((s, i) => (deckOf(s.choice) === d ? STRIP_NAMES[i] : null)).filter((x): x is string => x !== null)),
    [sources],
  );
  const onDelay = useCallback((patch: Partial<DelayParams>) => dispatch({ type: "delay", patch }), []);
  const onReverb = useCallback((patch: Partial<ReverbParams>) => dispatch({ type: "reverb", patch }), []);
  // AUTO-CUE: pressing a CUE selects it and releases any other; pressing it again turns it off.
  const pressCue = (k: CueKey) => setCue((cur) => (cur === k ? null : k));

  // ---------- MIDI: every controllable target, read against the latest state ----------
  const paramsRef = useRef(params);
  const decksRef = useRef(decks);
  useEffect(() => {
    paramsRef.current = params;
    decksRef.current = decks;
  }, [params, decks]);
  const knob = (v: number) => (Math.abs(v - 0.5) < 0.025 ? 0.5 : v); // centre detent for hardware knobs
  /**
   * MIDI mixer changes reach the audio engine at once, while the on-screen redraw runs as a
   * transition. Re-rendering the whole console takes 40–90 ms (much more in dev); done
   * synchronously it blocks the decks' ScriptProcessor (~21 ms of buffer) and the audio
   * crackles on every knob move. A transition renders in small slices that leave the
   * audio callback room to run, and drops intermediate states when a newer value arrives.
   */
  const midiDispatch = (a: Action) => {
    liveParams.current = reducer(liveParams.current, a);
    engineRef.current?.apply(liveParams.current);
    startTransition(() => dispatch(a));
  };
  const buildTargets = (): MidiTarget[] => {
    const T: MidiTarget[] = [];
    const dispatch = midiDispatch;
    const P = () => liveParams.current;
    const chName = ["1", "2", "3", "4"];
    chName.forEach((name, i) => {
      const g = `Mixer CH ${name}`;
      const set = (patch: Partial<ChannelParams>) => dispatch({ type: "channel", index: i, patch });
      T.push(
        { id: `ch${name}.fader`, group: g, label: "Fader", kind: "absolute", apply: (v) => set({ fader: v }) },
        { id: `ch${name}.gain`, group: g, label: "Gain", kind: "absolute", apply: (v) => set({ trim: posToDb(knob(v), -12, 10) }) },
        { id: `ch${name}.hi`, group: g, label: "EQ Hi", kind: "absolute", apply: (v) => set({ hi: posToDb(knob(v), EQ_KILL, 6) }) },
        { id: `ch${name}.himid`, group: g, label: "EQ Hi mid", kind: "absolute", apply: (v) => set({ hiMid: posToDb(knob(v), -27, 10) }) },
        { id: `ch${name}.lomid`, group: g, label: "EQ Lo mid", kind: "absolute", apply: (v) => set({ loMid: posToDb(knob(v), -27, 10) }) },
        {
          id: `ch${name}.mid`,
          group: g,
          label: "EQ Mid (both mids, for 3-band controllers)",
          kind: "absolute",
          apply: (v) => {
            const db = posToDb(knob(v), -27, 10);
            set({ hiMid: db, loMid: db });
          },
        },
        { id: `ch${name}.lo`, group: g, label: "EQ Lo", kind: "absolute", apply: (v) => set({ lo: posToDb(knob(v), EQ_KILL, 6) }) },
        { id: `ch${name}.send1`, group: g, label: "Send 1", kind: "absolute", apply: (v) => set({ send1: v }) },
        { id: `ch${name}.send2`, group: g, label: "Send 2", kind: "absolute", apply: (v) => set({ send2: v }) },
        { id: `ch${name}.cue`, group: g, label: "Cue", kind: "toggle", apply: () => pressCue(name as CueKey), led: () => cueRef.current === name },
      );
    });
    AUX_NAMES.forEach((name, i) => {
      const g = `Mixer CH ${name}`;
      const set = (patch: Partial<AuxParams>) => dispatch({ type: "aux", index: i, patch });
      T.push(
        { id: `ch${name}.fader`, group: g, label: "Fader", kind: "absolute", apply: (v) => set({ fader: v }) },
        { id: `ch${name}.gain`, group: g, label: "Gain", kind: "absolute", apply: (v) => set({ trim: posToDb(knob(v), -12, 10) }) },
        { id: `ch${name}.hi`, group: g, label: "EQ Hi", kind: "absolute", apply: (v) => set({ hi: posToDb(knob(v), EQ_KILL, 6) }) },
        { id: `ch${name}.mid`, group: g, label: "EQ Mid", kind: "absolute", apply: (v) => set({ mid: posToDb(knob(v), -24, 10) }) },
        { id: `ch${name}.midfreq`, group: g, label: "EQ Mid freq", kind: "absolute", apply: (v) => set({ midFreq: v }) },
        { id: `ch${name}.lo`, group: g, label: "EQ Lo", kind: "absolute", apply: (v) => set({ lo: posToDb(knob(v), EQ_KILL, 6) }) },
        { id: `ch${name}.send1`, group: g, label: "Send 1", kind: "absolute", apply: (v) => set({ send1: v }) },
        { id: `ch${name}.send2`, group: g, label: "Send 2", kind: "absolute", apply: (v) => set({ send2: v }) },
        { id: `ch${name}.cue`, group: g, label: "Cue", kind: "toggle", apply: () => pressCue(name), led: () => cueRef.current === name },
      );
    });
    T.push(
      { id: "xfader", group: "Mixer master", label: "Crossfader", kind: "absolute", apply: (v) => dispatch({ type: "xfader", value: v * 2 - 1 }) },
      { id: "master", group: "Mixer master", label: "Master 1 level", kind: "absolute", apply: (v) => dispatch({ type: "master", value: v }) },
    );
    [0, 1].forEach((i) => {
      const n = i + 1;
      const g = `Filter ${n}`;
      const set = (patch: Partial<FilterParams>) => dispatch({ type: "filter", index: i, patch });
      T.push(
        { id: `filter${n}.freq`, group: g, label: "Freq", kind: "absolute", apply: (v) => set({ freq: v }) },
        { id: `filter${n}.res`, group: g, label: "Res", kind: "absolute", apply: (v) => set({ res: v }) },
        { id: `filter${n}.crunch`, group: g, label: "Crunch", kind: "absolute", apply: (v) => set({ crunch: v }) },
        { id: `filter${n}.on`, group: g, label: "On / off", kind: "toggle", apply: () => set({ on: !P().filters[i].on }), led: () => paramsRef.current.filters[i].on },
        {
          id: `filter${n}.oneknob`,
          group: g,
          label: "One-knob sweep (LPF ← off → HPF)",
          kind: "absolute",
          apply: (v) => {
            if (v < 0.47) set({ on: true, types: ["lpf"], freq: 0.15 + (v / 0.47) * 0.85 });
            else if (v > 0.53) set({ on: true, types: ["hpf"], freq: ((v - 0.53) / 0.47) * 0.85 });
            else set({ on: false });
          },
        },
        ...(["hpf", "bpf", "lpf"] as FilterMode[]).map(
          (t): MidiTarget => ({ id: `filter${n}.${t}`, group: g, label: t.toUpperCase(), kind: "toggle", apply: () => set({ types: [t] }), led: () => (paramsRef.current.filters[i].types ?? []).includes(t) }),
        ),
      );
    });
    const dl = (patch: Partial<DelayParams>) => dispatch({ type: "delay", patch });
    const rv = (patch: Partial<ReverbParams>) => dispatch({ type: "reverb", patch });
    T.push(
      { id: "delay.on", group: "Delay pedal", label: "Footswitch", kind: "toggle", apply: () => dl({ on: P().delay.on === false }), led: () => paramsRef.current.delay.on !== false },
      { id: "delay.time", group: "Delay pedal", label: "Time", kind: "absolute", apply: (v) => dl({ division: DIVISIONS[Math.round(v * (DIVISIONS.length - 1))] }) },
      { id: "delay.repeat", group: "Delay pedal", label: "Repeat", kind: "absolute", glide: FX_GLIDE, read: () => P().delay.feedback, apply: (v) => dl({ feedback: v }) },
      { id: "delay.tone", group: "Delay pedal", label: "Tone", kind: "absolute", glide: FX_GLIDE, read: () => P().delay.tone, apply: (v) => dl({ tone: v }) },
      { id: "delay.level", group: "Delay pedal", label: "Level", kind: "absolute", glide: FX_GLIDE, read: () => P().delay.output, apply: (v) => dl({ output: v }) },
      { id: "reverb.on", group: "Reverb pedal", label: "Footswitch", kind: "toggle", apply: () => rv({ on: P().reverb.on === false }), led: () => paramsRef.current.reverb.on !== false },
      { id: "reverb.decay", group: "Reverb pedal", label: "Decay", kind: "absolute", glide: FX_GLIDE, read: () => P().reverb.decay, apply: (v) => rv({ decay: v }) },
      { id: "reverb.predelay", group: "Reverb pedal", label: "Pre-delay", kind: "absolute", glide: FX_GLIDE, read: () => P().reverb.predelay, apply: (v) => rv({ predelay: v }) },
      { id: "reverb.tone", group: "Reverb pedal", label: "Tone", kind: "absolute", glide: FX_GLIDE, read: () => 1 - P().reverb.damp, apply: (v) => rv({ damp: 1 - v }) },
      { id: "reverb.level", group: "Reverb pedal", label: "Level", kind: "absolute", glide: FX_GLIDE, read: () => P().reverb.output, apply: (v) => rv({ output: v }) },
    );
    [0, 1].forEach((d) => {
      const n = d + 1;
      const g = `Deck ${n}`;
      const deck = () => decksRef.current[d];
      const act = (fn: (k: CdjDeck) => void) => () => {
        const k = deck();
        if (!k) return;
        fn(k);
        k.rev++;
      };
      const btn = (fn: (k: CdjDeck, v: number) => void) => (v: number) => {
        const k = deck();
        if (!k) return;
        fn(k, v);
        k.rev++;
      };
      T.push(
        { id: `deck${n}.play`, group: g, label: "Play / pause", kind: "toggle", apply: act((k) => k.togglePlay()), led: () => !!deck()?.playing },
        { id: `deck${n}.cue`, group: g, label: "Cue", kind: "button", apply: btn((k, v) => (v ? k.cueDown() : k.cueUp())), led: () => { const k = deck(); return !!k && !k.playing && Math.abs(k.pos - k.cue) < k.sampleRate * 0.01; } },
        {
          id: `deck${n}.sync`,
          group: g,
          label: "Sync",
          kind: "toggle",
          apply: act((k) => {
            if (k.sync) {
              k.sync = false;
              k.syncNudge = 0;
            } else {
              const err = k.syncTo(decksRef.current[1 - d] ?? null);
              if (err) toast.error(`Deck ${n}: ${err}`);
            }
          }),
          led: () => !!deck()?.sync,
        },
        { id: `deck${n}.mt`, group: g, label: "Master tempo", kind: "toggle", apply: act((k) => (k.masterTempo = !k.masterTempo)), led: () => !!deck()?.masterTempo },
        ...Array.from({ length: HOT_CUE_COUNT }, (_, h): MidiTarget => ({ id: `deck${n}.hot${h}`, group: g, label: `Hot cue ${HOT_CUE_NAMES[h]}`, kind: "toggle", apply: act((k) => k.hotCue(h, false)), led: () => deck()?.hotCues[h] != null })),
        { id: `deck${n}.loopin`, group: g, label: "Loop in / cue", kind: "toggle", apply: act((k) => k.loopInPress()) },
        { id: `deck${n}.loopout`, group: g, label: "Loop out", kind: "toggle", apply: act((k) => k.loopOutPress()), led: () => !!deck()?.loopActive },
        { id: `deck${n}.reloop`, group: g, label: "Reloop / exit", kind: "toggle", apply: act((k) => k.reloopExit()), led: () => !!deck()?.loopActive },
        { id: `deck${n}.loop4`, group: g, label: "4-beat loop / exit", kind: "toggle", apply: act((k) => (k.loopActive ? k.reloopExit() : k.beatLoop(4))), led: () => !!deck()?.loopActive },
        { id: `deck${n}.tempo`, group: g, label: "Tempo fader", kind: "absolute", apply: btn((k, v) => { k.sync = false; k.tempo = (0.5 - knob(v)) * ((2 * k.tempoRange) / 100); }) },
        { id: `deck${n}.jog`, group: g, label: "Jog (bend while playing, search while paused)", kind: "relative", apply: btn((k, v) => k.jogSteps(v)) },
        { id: `deck${n}.nudgedown`, group: g, label: "Nudge − (hold)", kind: "button", apply: btn((k, v) => (k.nudge = v ? -0.04 : 0)) },
        { id: `deck${n}.nudgeup`, group: g, label: "Nudge + (hold)", kind: "button", apply: btn((k, v) => (k.nudge = v ? 0.04 : 0)) },
        { id: `deck${n}.searchback`, group: g, label: "Search ◀◀ (hold)", kind: "button", apply: btn((k, v) => (k.search = v ? -1 : 0)) },
        { id: `deck${n}.searchfwd`, group: g, label: "Search ▶▶ (hold)", kind: "button", apply: btn((k, v) => (k.search = v ? 1 : 0)) },
      );
    });
    return T;
  };
  const midiTargets = buildTargets();
  const targetsRef = useRef<Map<string, MidiTarget>>(new Map());
  useEffect(() => {
    targetsRef.current = new Map(midiTargets.map((t) => [t.id, t]));
  });
  const [midi] = useState(() => new MidiController(() => targetsRef.current));
  useEffect(() => () => midi.dispose(), [midi]);
  const enableMidi = async () => {
    await ensureAudio(); // a click is needed before audio may start; MIDI presses then work
    await midi.enable();
  };
  // ---------- USB media shared by both players ----------
  const [usb, setUsb] = useState<UsbMedia | null>(null);
  const usbInputRef = useRef<HTMLInputElement | null>(null);
  const insertUsb = useCallback(() => usbInputRef.current?.click(), []);
  const ejectUsb = useCallback(() => setUsb(null), []);
  const onUsbPicked = async (files: FileList | null) => {
    if (!files?.length) return;
    const media = await openUsbMedia(files);
    setUsb(media);
    if (media.lib) {
      toast.success(`USB "${media.name}": ${media.lib.tracks.size} tracks, ${media.lib.playlists.filter((p) => !p.isFolder).length} playlists. Press BROWSE on a player.`);
      if (media.lib.skippedRows > 0) toast.warning(`${media.lib.skippedRows} database rows could not be read and were skipped.`);
    } else if (media.readError) {
      toast.error(`The rekordbox database on "${media.name}" could not be read; showing its ${media.plain.length} audio files instead.`);
    } else {
      toast.message(`"${media.name}" has no rekordbox library; ${media.plain.length} audio files available. Press BROWSE on a player.`);
    }
  };

  const onGuidedSetup = (id: string) => {
    if (id === "z1") {
      // Z1 FX knobs: left → Filter 1 on CH 2, right → Filter 2 on CH 3
      dispatch({ type: "channel", index: 1, patch: { filter: "1" } });
      dispatch({ type: "channel", index: 2, patch: { filter: "2" } });
      toast.message("CH 2 is now on Filter 1 and CH 3 on Filter 2, for the Z1 FX knobs.");
    }
  };

  const patchStatus = (patch: ReturnPatch, sendLevels: number[]): PatchStatus => {
    if (sendLevels.every((v) => v <= 0.001)) return { heard: false, text: "No channel sending" };
    if (patch === "A" || patch === "B") {
      const i = patch === "A" ? 0 : 1;
      if (sources[4 + i].choice !== "rtn") return { heard: false, text: `CH ${patch} input not on RTN` };
      if (params.aux[i].fader <= 0.001) return { heard: false, text: `CH ${patch} fader down` };
      return { heard: true, text: `Heard on CH ${patch}` };
    }
    const r = params.returns[patch === "C" ? 0 : 1];
    if (!r.on) return { heard: false, text: `RTN ${patch} off` };
    if (r.level <= 0.001) return { heard: false, text: `RTN ${patch} level down` };
    return { heard: true, text: `Heard on RTN ${patch}` };
  };
  const send1Levels = [...params.channels.map((c) => c.send1), ...params.aux.map((a) => a.send1)];
  const send2Levels = [...params.channels.map((c) => c.send2), ...params.aux.map((a) => a.send2)];

  const pressType = (i: number, t: FilterMode, combine: boolean) => {
    const cur = params.filters[i].types ?? [];
    let next: FilterMode[] = [t];
    if (combine) {
      next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t];
      if (next.length === 0) next = [t];
    }
    dispatch({ type: "filter", index: i, patch: { types: MODES.map((m) => m.value).filter((v) => next.includes(v)) } });
  };

  // ---------- strip pieces ----------

  const sendRows = (name: string, v: { send1: number; send1Pre: boolean; send2: number }, set: (p: { send1?: number; send1Pre?: boolean; send2?: number }) => void) => (
    <>
      <Row h={ROW.send} label={<><Boxed>{name}</Boxed><TwoLine a="Send" b="1" /></>}>
        <Knob variant="panel" size={28} ticks={11} ends={["∞", "+6"]} label={`Channel ${name} send 1`} pos={v.send1} defaultPos={0} onPos={(p) => set({ send1: p })} valueText={fmtPct(v.send1)} />
      </Row>
      <Row h={ROW.pre} className="justify-start gap-1 pl-6">
        <MiniSwitch on={v.send1Pre} label={`Channel ${name} send 1 pre-fader`} onClick={() => set({ send1Pre: !v.send1Pre })} />
        <Legend>Pre</Legend>
      </Row>
      <Row h={ROW.send} label={<TwoLine a="Send" b="2" />}>
        <Knob variant="panel" size={28} ticks={11} ends={["∞", "+6"]} label={`Channel ${name} send 2`} pos={v.send2} defaultPos={0} onPos={(p) => set({ send2: p })} valueText={fmtPct(v.send2)} />
      </Row>
    </>
  );

  const cueRow = (k: CueKey) => (
    <Row h={ROW.cue} label={<Legend>Cue</Legend>}>
      <RoundButton lit={cue === k} ring="red" size={34} label={`Cue ${k}`} onClick={() => pressCue(k)} />
    </Row>
  );

  const faderRow = (name: string, stripIndex: number, pos: number, onPos: (v: number) => void) => (
    <Row h={ROW.fader + ROW.number} className="items-end gap-1 pb-1">
      <div className="flex flex-col items-end justify-between self-stretch py-2">
        <Meter height={92} label={`Channel ${name} level`} meterRef={(el) => (meterEls.current[stripIndex] = el)} />
        <div className="flex flex-col items-center leading-none">
          <span className="text-base font-bold text-zinc-900">{name}</span>
          <span aria-hidden="true" className="text-[10px] font-bold text-zinc-800">∞</span>
        </div>
      </div>
      <Fader height={FADER_H + 10} label={`Channel ${name} fader`} pos={pos} defaultPos={0.75} onPos={onPos} valueText={fmtFader(pos)} />
    </Row>
  );

  const auxStrip = (i: number) => {
    const a = params.aux[i];
    const name = AUX_NAMES[i];
    const set = (patch: Partial<AuxParams>) => dispatch({ type: "aux", index: i, patch });
    const si = 4 + i;
    return (
      <div role="group" aria-label={`Channel ${name}`} className="flex flex-col items-center border-r border-zinc-400/80" style={{ width: CH_W }}>
        {sendRows(name, a, set)}
        <Row h={ROW.input}>
          <InputSelect name={name} source={sources[si]} withRtn onChoice={(c) => setChoice(si, c)} onLoad={(f) => void loadFile(si, name, f)} />
        </Row>
        <Row h={ROW.gain} label={<><PkLed elRef={(el) => (pkEls.current[si] = el)} /><Legend>Gain</Legend></>}>
          <Knob variant="panel" size={30} ticks={11} ends={["∞", "+10"]} bipolar label={`Channel ${name} gain`} pos={dbToPos(a.trim, -12, 10)} defaultPos={0.5} onPos={(p) => set({ trim: posToDb(p, -12, 10) })} valueText={fmtDb(a.trim)} />
        </Row>
        <Row h={ROW.eq} label={<Legend>Hi</Legend>}>
          <Knob variant="panel" size={34} ticks={11} ends={["∞", "+6"]} bipolar label={`Channel ${name} HI EQ, ${fmtHz(AUX_EQ.hi)}`} pos={dbToPos(a.hi, EQ_KILL, 6)} defaultPos={0.5} onPos={(p) => set({ hi: posToDb(p, EQ_KILL, 6) })} valueText={fmtDb(a.hi, EQ_KILL)} />
        </Row>
        <Row h={ROW.eq} label={<Boxed inverse>Freq</Boxed>}>
          <Knob variant="panel" size={28} ticks={11} ends={["190", "2.75k"]} label={`Channel ${name} MID frequency`} pos={a.midFreq} defaultPos={0.5} onPos={(p) => set({ midFreq: p })} valueText={fmtHz(midFreqFromNorm(a.midFreq))} />
        </Row>
        <Row h={ROW.eq} label={<Boxed inverse>Mid</Boxed>}>
          <Knob variant="panel" size={34} ticks={11} ends={["-24", "+10"]} bipolar label={`Channel ${name} MID EQ`} pos={dbToPos(a.mid, -24, 10)} defaultPos={0.5} onPos={(p) => set({ mid: posToDb(p, -24, 10) })} valueText={fmtDb(a.mid)} />
        </Row>
        <Row h={ROW.eq} label={<Legend>Lo</Legend>}>
          <Knob variant="panel" size={34} ticks={11} ends={["∞", "+6"]} bipolar label={`Channel ${name} LO EQ, ${fmtHz(AUX_EQ.lo)}`} pos={dbToPos(a.lo, EQ_KILL, 6)} defaultPos={0.5} onPos={(p) => set({ lo: posToDb(p, EQ_KILL, 6) })} valueText={fmtDb(a.lo, EQ_KILL)} />
        </Row>
        <Row h={ROW.toggle}>
          <Toggle3 label={`Channel ${name} filter assign`} value={a.filter} onChange={(v) => set({ filter: v })} options={FILTER_T} />
        </Row>
        <Row h={ROW.toggle} />
        {cueRow(name)}
        {faderRow(name, si, a.fader, (p) => set({ fader: p }))}
      </div>
    );
  };

  const mainStrip = (i: number) => {
    const c = params.channels[i];
    const name = String(i + 1) as CueKey;
    const set = (patch: Partial<ChannelParams>) => dispatch({ type: "channel", index: i, patch });
    return (
      <div role="group" aria-label={`Channel ${name}`} className="flex flex-col items-center border-r border-zinc-400/80" style={{ width: CH_W }}>
        {sendRows(name, c, set)}
        <Row h={ROW.input}>
          <InputSelect name={name} source={sources[i]} withRtn={false} onChoice={(v) => setChoice(i, v)} onLoad={(f) => void loadFile(i, name, f)} />
        </Row>
        <Row h={ROW.gain} label={<><PkLed elRef={(el) => (pkEls.current[i] = el)} /><Legend>Gain</Legend></>}>
          <Knob variant="panel" size={30} ticks={11} ends={["∞", "+10"]} bipolar label={`Channel ${name} gain`} pos={dbToPos(c.trim, -12, 10)} defaultPos={0.5} onPos={(p) => set({ trim: posToDb(p, -12, 10) })} valueText={fmtDb(c.trim)} />
        </Row>
        <Row h={ROW.eq} label={<Legend>Hi</Legend>}>
          <Knob variant="panel" size={34} ticks={11} ends={["∞", "+6"]} bipolar label={`Channel ${name} HI EQ, ${fmtHz(EQ_FREQS.hi)}`} pos={dbToPos(c.hi, EQ_KILL, 6)} defaultPos={0.5} onPos={(p) => set({ hi: posToDb(p, EQ_KILL, 6) })} valueText={fmtDb(c.hi, EQ_KILL)} />
        </Row>
        <Row h={ROW.eq} label={<TwoLine a="Hi" b="Mid" />}>
          <Knob variant="panel" size={34} ticks={11} ends={["-27", "+10"]} bipolar label={`Channel ${name} HI MID EQ, ${fmtHz(EQ_FREQS.hiMid)}`} pos={dbToPos(c.hiMid, -27, 10)} defaultPos={0.5} onPos={(p) => set({ hiMid: posToDb(p, -27, 10) })} valueText={fmtDb(c.hiMid)} />
        </Row>
        <Row h={ROW.eq} label={<TwoLine a="Lo" b="Mid" />}>
          <Knob variant="panel" size={34} ticks={11} ends={["-27", "+10"]} bipolar label={`Channel ${name} LO MID EQ, ${fmtHz(EQ_FREQS.loMid)}`} pos={dbToPos(c.loMid, -27, 10)} defaultPos={0.5} onPos={(p) => set({ loMid: posToDb(p, -27, 10) })} valueText={fmtDb(c.loMid)} />
        </Row>
        <Row h={ROW.eq} label={<Legend>Lo</Legend>}>
          <Knob variant="panel" size={34} ticks={11} ends={["∞", "+6"]} bipolar label={`Channel ${name} LO EQ, ${fmtHz(EQ_FREQS.lo)}`} pos={dbToPos(c.lo, EQ_KILL, 6)} defaultPos={0.5} onPos={(p) => set({ lo: posToDb(p, EQ_KILL, 6) })} valueText={fmtDb(c.lo, EQ_KILL)} />
        </Row>
        <Row h={ROW.toggle}>
          <Toggle3 label={`Channel ${name} filter assign`} value={c.filter} onChange={(v) => set({ filter: v })} options={FILTER_T} />
        </Row>
        <Row h={ROW.toggle}>
          <Toggle3 label={`Channel ${name} crossfader assign`} value={c.xf} onChange={(v) => set({ xf: v })} options={XF_T} />
        </Row>
        {cueRow(name)}
        {faderRow(name, i, c.fader, (p) => set({ fader: p }))}
      </div>
    );
  };

  const filterSection = (i: number) => {
    const f = { ...params.filters[i], types: params.filters[i].types ?? ["lpf"] };
    const n = i + 1;
    const set = (patch: Partial<FilterParams>) => dispatch({ type: "filter", index: i, patch });
    const hz = freqFromNorm(f.freq);
    const resWord = f.res < 0.34 ? "Mild" : f.res > 0.66 ? "Wild" : "Mid";
    return (
      <div role="group" aria-label={`Filter ${n}`} className="flex flex-col items-center justify-between py-1" style={{ height: LOWER_H }}>
        <div className="flex flex-col items-center">
          <div className="flex items-center gap-1.5">
            <AmountLed amount={f.crunch} label={`Filter ${n} crunch LED`} />
            <span className="text-[11px] font-bold text-zinc-900 uppercase">Crunch</span>
          </div>
          <Knob
            variant="panel"
            size={26}
            numerals={["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]}
            label={`Filter ${n} crunch`}
            pos={f.crunch}
            defaultPos={0}
            onPos={(p) => set({ crunch: p })}
            valueText={`${(f.crunch * 10).toFixed(1)} of 10`}
          />
        </div>
        <div className="relative flex flex-col items-center">
          <span className="absolute -top-1 -right-3 text-[9px] font-bold text-zinc-900 uppercase">Res</span>
          <Knob variant="panel" size={36} ticks={11} ends={["Mild", "Wild"]} label={`Filter ${n} resonance`} pos={f.res} defaultPos={0.35} onPos={(p) => set({ res: p })} valueText={`${resWord}, Q ${qFromNorm(f.res).toFixed(1)}`} />
        </div>
        <div role="group" aria-label={`Filter ${n} type select`} className="flex flex-col items-center gap-1">
          {MODES.map((m) => (
            <div key={m.value} className="relative flex flex-col items-center pt-3">
              <span className="absolute top-0 -left-5 flex flex-col items-start leading-none">
                <span className="text-[9px] font-bold text-zinc-900">{m.text}</span>
                <svg width="14" height="10" viewBox="0 0 14 11" aria-hidden="true">
                  <path d={FILTER_ICON[m.value]} className="fill-none stroke-zinc-900" strokeWidth={1.2} />
                </svg>
              </span>
              <RoundButton
                lit={f.types.includes(m.value)}
                ring="yellow"
                size={40}
                label={`Filter ${n} ${m.text}`}
                onPointerDown={() => {
                  const held = heldTypes.current[i];
                  comboPress.current[i] = held.size > 0;
                  held.add(m.value);
                }}
                onPointerUp={() => heldTypes.current[i].delete(m.value)}
                onClick={(e) => {
                  pressType(i, m.value, e.shiftKey || comboPress.current[i]);
                  comboPress.current[i] = false;
                }}
              />
            </div>
          ))}
        </div>
        <div className="relative flex flex-col items-center">
          <span className="absolute -top-1 -left-4 text-[9px] font-bold text-zinc-900 uppercase">Freq</span>
          <Knob variant="panel" size={40} knurled ticks={5} label={`Filter ${n} frequency`} pos={f.freq} defaultPos={0.5} onPos={(p) => set({ freq: p })} valueText={fmtHz(hz)} />
        </div>
        <div className="flex flex-col items-center gap-1">
          <RoundButton lit={f.on} ring="blue" size={40} label={`Filter ${n} on`} onClick={() => set({ on: !f.on })} />
          <span className="text-[10px] font-bold text-zinc-900 uppercase">Filter {n}</span>
        </div>
      </div>
    );
  };

  const returnBlock = (k: "C" | "D", i: number) => {
    const r = params.returns[i];
    return (
      <div role="group" aria-label={`Return ${k}`} className="relative flex w-full flex-col items-center gap-1 pt-1">
        <span className="absolute top-1 left-1.5">
          <Boxed>{k}</Boxed>
        </span>
        <span className="text-[8px] font-bold text-zinc-900 uppercase">On/Off</span>
        <RoundButton lit={r.on} ring="green" size={34} label={`Return ${k} on`} onClick={() => dispatch({ type: "return", index: i, patch: { on: !r.on } })} />
        <div className="flex w-full items-center justify-between px-2 pt-1">
          <span className="flex items-center gap-1">
            <SigLed label={`RTN ${k} signal`} sigRef={(el) => (sigEls.current[i] = el)} />
            <span className="text-[8px] font-bold text-zinc-900 uppercase">Sig</span>
          </span>
          <span className="text-[9px] font-bold text-zinc-900 uppercase">Level</span>
        </div>
        <Knob variant="panel" size={28} ticks={11} ends={["∞", "+10"]} label={`Return ${k} level`} pos={r.level} defaultPos={0.75} onPos={(p) => dispatch({ type: "return", index: i, patch: { level: p } })} valueText={r.level <= 0.001 ? "Off" : fmtPct(r.level)} />
        <div className="flex w-full items-center gap-2 px-1.5">
          <Legend>Cue</Legend>
          <RoundButton lit={cue === k} ring="red" size={36} label={`Cue ${k}`} onClick={() => pressCue(k)} />
        </div>
      </div>
    );
  };

  const fResponse = (i: number) => {
    const f = params.filters[i];
    const assigned = [
      ...params.aux.map((a, k) => (a.filter === String(i + 1) ? AUX_NAMES[k] : null)),
      ...params.channels.map((c, k) => (c.filter === String(i + 1) ? String(k + 1) : null)),
    ].filter(Boolean);
    return (
      // a small screen set into the panel, under its filter column
      <div className="flex shrink-0 flex-col gap-1 rounded-lg bg-zinc-950 p-2 shadow-[inset_0_2px_4px_rgba(0,0,0,0.6),0_1px_0_rgba(255,255,255,0.6)] ring-1 ring-zinc-500">
        <span className={cn("text-[10px] font-bold tracking-wider uppercase", f.on ? "text-sky-300" : "text-zinc-400")}>Filter {i + 1}</span>
        <ResponsePlot
          mag={responses[i]}
          on={f.on}
          caption={`${f.on ? typeName(f.types ?? ["lpf"]) : "Off"} · ${fmtHz(freqFromNorm(f.freq))} · Q ${qFromNorm(f.res).toFixed(1)} · ch ${assigned.length ? assigned.join(", ") : "none"}`}
        />
      </div>
    );
  };

  const cueActive = cue !== null;

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-4 px-4 py-5">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={togglePlay} disabled={!ready} className="min-w-28">
          {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          {!ready ? "Preparing" : playing ? "Stop loops" : "Play loops"}
        </Button>
        <span className="text-sm font-medium tabular-nums">Loops {BPM} BPM</span>
      </div>

      <div className="overflow-x-auto pb-2">
      <div
        className="mx-auto grid w-max items-start justify-center gap-4"
        style={{ gridTemplateColumns: "auto auto", gridTemplateAreas: '"decks decks" "fx mx"' }}
      >
        {/* CD players centred on top */}
        <div style={{ gridArea: "decks" }} className="flex items-start justify-center gap-4">
          <CdjDeckPanel index={0} deck={decks[0] ?? null} other={decks[1] ?? null} demos={demos} ensureAudio={ensureAudio} routedTo={routed[0]} usb={usb} onInsertUsb={insertUsb} onEjectUsb={ejectUsb} />
          <CdjDeckPanel index={1} deck={decks[1] ?? null} other={decks[0] ?? null} demos={demos} ensureAudio={ensureAudio} routedTo={routed[1]} usb={usb} onInsertUsb={insertUsb} onEjectUsb={ejectUsb} />
        </div>
        {/* FX section on the left of the mixer */}
        <div style={{ gridArea: "fx" }}>
          <FxRack
            vertical
            delay={params.delay}
            reverb={params.reverb}
            onDelay={onDelay}
            onReverb={onReverb}
            delayStatus={patchStatus(params.delay.patch, send1Levels)}
            reverbStatus={patchStatus(params.reverb.patch, send2Levels)}
            tempo={fxTempo}
          />
        </div>
        <section
          style={{ gridArea: "mx" }}
          id="mixer"
          tabIndex={-1}
          aria-label="Mixer top panel"
          className="mx-auto w-max rounded-xl border border-zinc-400 bg-gradient-to-b from-zinc-200 via-zinc-200 to-zinc-300 px-4 pt-4 pb-3 text-zinc-900 shadow-[0_10px_30px_rgba(0,0,0,0.35)] outline-none"
        >
          <div className="flex h-8 items-start justify-center">
            <img src={logoBlack} alt="NO-MAD" className="h-6 w-auto select-none" draggable={false} />
          </div>
          <div className="flex">
            {/* CH A · CH B */}
            {auxStrip(0)}
            {auxStrip(1)}

            {/* RTN C/D over FILTER 1 */}
            <div className="flex flex-col border-r border-zinc-400/80" style={{ width: FX_W }}>
              <div className="flex flex-col items-center justify-around" style={{ height: TOP_H }}>
                {returnBlock("C", 0)}
                {returnBlock("D", 1)}
              </div>
              {filterSection(0)}
            </div>

            {/* CH 1-4 with the crossfader underneath */}
            <div className="flex flex-col">
              <div className="flex">{[0, 1, 2, 3].map((i) => <div key={i}>{mainStrip(i)}</div>)}</div>
              <div className="flex items-center justify-center gap-2 pt-3">
                <span className="text-xs font-bold">X</span>
                <div className="w-56">
                  <Crossfader
                    label="Crossfader"
                    pos={(params.xfader + 1) / 2}
                    defaultPos={0.5}
                    onPos={(p) => dispatch({ type: "xfader", value: p * 2 - 1 })}
                    valueText={Math.abs(params.xfader) < 0.02 ? "Centre" : params.xfader < 0 ? `${Math.round(-params.xfader * 100)}% to X` : `${Math.round(params.xfader * 100)}% to Y`}
                  />
                </div>
                <span className="text-xs font-bold">Y</span>
              </div>
            </div>

            {/* Main meters over FILTER 2 */}
            <div className="flex flex-col border-r border-zinc-400/80" style={{ width: FX_W }}>
              <div className="flex flex-col items-center justify-end gap-1 pb-4" style={{ height: TOP_H }}>
                <MainMeter
                  height={200}
                  label={cueActive ? "Cue level" : "LR mix"}
                  leftRef={(el) => (meterEls.current[6] = el)}
                  rightRef={(el) => (meterEls.current[7] = el)}
                />
                <div className="flex w-[66px] justify-between text-[8px] font-bold text-zinc-900 uppercase">
                  <span>L</span>
                  <span className={cueActive ? "text-red-700" : "text-zinc-600"}>{cueActive ? "Cue" : "Mix"}</span>
                  <span>R</span>
                </div>
              </div>
              {filterSection(1)}
            </div>

            {/* Master section */}
            <div role="group" aria-label="Master section" className="flex flex-col items-center" style={{ width: FX_W }}>
              <div className="flex flex-col items-center pt-1" style={{ height: TOP_H + ROW.eq * 2 - 12 }}>
                <span className="text-[9px] font-bold text-zinc-900 uppercase">Master 1</span>
                <Knob
                  variant="panel"
                  size={30}
                  numerals={["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]}
                  label="Master 1 level"
                  pos={params.master}
                  defaultPos={0.75}
                  onPos={(p) => dispatch({ type: "master", value: p })}
                  valueText={params.master <= 0.001 ? "Off" : `${(params.master * 10).toFixed(1)} of 10`}
                />
              </div>
              <div className="flex flex-col items-center gap-0.5" style={{ height: ROW.toggle * 2 + 12 }}>
                <Toggle3
                  label="Channel fader curve"
                  value={params.chCurve}
                  onChange={(v) => dispatch({ type: "chCurve", value: v })}
                  options={[
                    { value: "power", text: "", name: "constant power" },
                    { value: "dipped", text: "", name: "dipped" },
                    { value: "cut", text: "", name: "fast-cut" },
                  ]}
                />
                <span className="text-[8px] font-bold text-zinc-900 uppercase">Channel fader</span>
                <Toggle3
                  label="Crossfader curve"
                  value={params.xCurve}
                  onChange={(v) => dispatch({ type: "xCurve", value: v })}
                  options={[
                    { value: "power", text: "", name: "constant power" },
                    { value: "transition", text: "", name: "transition" },
                    { value: "cut", text: "", name: "fast-cut" },
                  ]}
                />
                <span className="text-[8px] font-bold text-zinc-900 uppercase">Xfader</span>
              </div>
              <div className="flex flex-col items-center gap-0.5 pt-2">
                <span
                  aria-hidden="true"
                  className={cn("size-2.5 rounded-full border border-red-900", cueActive ? "bg-red-500 shadow-[0_0_6px_rgba(239,68,68,0.9)]" : "bg-red-950/60")}
                />
                <span className="text-[8px] font-bold text-zinc-900 uppercase">Active</span>
                <span className="sr-only">{cueActive ? `Cue ${cue} active` : "No cue active"}</span>
              </div>
            </div>
          </div>
          {/* filter response screens, each centred under its filter column */}
          <div role="group" aria-label="Filter response" className="mt-3 flex border-t border-zinc-400/80 pt-3">
            <div aria-hidden="true" style={{ width: CH_W * 2 }} />
            <div className="flex justify-center" style={{ width: FX_W }}>
              {fResponse(0)}
            </div>
            <div aria-hidden="true" style={{ width: CH_W * 4 }} />
            <div className="flex justify-center" style={{ width: FX_W }}>
              {fResponse(1)}
            </div>
            <div aria-hidden="true" style={{ width: FX_W }} />
          </div>
        </section>
      </div>
      </div>

      <input
        ref={(el) => {
          usbInputRef.current = el;
          if (el) el.setAttribute("webkitdirectory", "");
        }}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          void onUsbPicked(e.target.files);
          e.target.value = "";
        }}
      />

      <MidiPanel midi={midi} targets={midiTargets} onEnable={enableMidi} onGuidedSetup={onGuidedSetup} />

    </div>
  );
}
