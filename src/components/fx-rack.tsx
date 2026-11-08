import { memo, useId } from "react";
import type { ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FOCUS, Knob } from "@/components/mixer-controls";
import { cn } from "@/lib/utils";
import logoWhite from "@/assets/nomad-logo-white.png";
import {
  DIVISIONS,
  delaySeconds,
  delayToneHz,
  reverbDampHz,
  reverbDecaySeconds,
  reverbPredelayMs,
  type DelayParams,
  type ReturnPatch,
  type ReverbParams,
} from "@/lib/mixer-engine";

const fmtHz = (hz: number) => (hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`);
const PATCHES: { value: ReturnPatch; label: string }[] = [
  { value: "A", label: "RTN A" },
  { value: "B", label: "RTN B" },
  { value: "C", label: "RTN C" },
  { value: "D", label: "RTN D" },
];

export interface PatchStatus {
  heard: boolean;
  text: string;
}

type PedalColour = "green" | "blue";
const ENCLOSURE: Record<PedalColour, string> = {
  green: "from-emerald-700 via-emerald-800 to-emerald-900 border-emerald-950",
  blue: "from-indigo-700 via-indigo-800 to-indigo-900 border-indigo-950",
};

/** Side jack with a plugged cable and its legend. */
function Jack({ side, label }: { side: "left" | "right"; label: string }) {
  return (
    <div className={cn("absolute top-10 flex items-center", side === "left" ? "-left-7 flex-row" : "-right-7 flex-row-reverse")} aria-hidden="true">
      <span className={cn("h-2.5 w-5 bg-zinc-900", side === "left" ? "rounded-l-full" : "rounded-r-full")} />
      <span className="h-4 w-2.5 rounded-sm bg-gradient-to-b from-zinc-300 to-zinc-500" />
      <span className={cn("absolute top-5 text-[8px] font-bold text-zinc-300 uppercase", side === "left" ? "left-0" : "right-0")}>{label}</span>
    </div>
  );
}

function Pedal({
  name,
  colour,
  on,
  onToggle,
  send,
  patch,
  onPatch,
  status,
  screen,
  knobs,
  extra,
}: {
  name: string;
  colour: PedalColour;
  on: boolean;
  onToggle: () => void;
  send: string;
  patch: ReturnPatch;
  onPatch: (p: ReturnPatch) => void;
  status: PatchStatus;
  screen: ReactNode;
  knobs: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative px-7">
        <Jack side="right" label={`In · ${send}`} />
        <Jack side="left" label="Out" />
        <section
          aria-label={`${name} pedal`}
          className={cn(
            "relative flex w-[248px] flex-col items-center gap-3 rounded-[18px] border-2 bg-gradient-to-b px-4 pt-3 pb-4 text-white shadow-[0_12px_24px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.25)]",
            ENCLOSURE[colour],
          )}
        >
          {/* corner screws */}
          {["top-2 left-2", "top-2 right-2", "bottom-2 left-2", "bottom-2 right-2"].map((p) => (
            <span key={p} aria-hidden="true" className={`absolute ${p} size-2 rounded-full bg-zinc-300/70 ring-1 ring-black/40`} />
          ))}
          <div className="flex w-full items-center gap-2 px-2">
            <img src={logoWhite} alt="" aria-hidden="true" className="mr-auto h-3.5 w-auto select-none drop-shadow-[0_1px_0_rgba(0,0,0,0.35)]" draggable={false} />
            <span
              aria-hidden="true"
              className={cn("size-3 rounded-full ring-1 ring-black/50", on ? "bg-red-500 shadow-[0_0_10px_3px_rgba(239,68,68,0.8)]" : "bg-red-950")}
            />
            <span className="text-[9px] font-bold tracking-widest uppercase">{on ? "On" : "Bypass"}</span>
          </div>
          <div className="flex w-full justify-between">{knobs}</div>
          {extra}
          <div className="w-full rounded-md border-2 border-black/60 bg-slate-950 p-1.5 shadow-inner">{screen}</div>
          <div className="flex w-full items-center justify-between gap-2">
            <span className="text-2xl font-black tracking-tight italic drop-shadow-[0_2px_0_rgba(0,0,0,0.4)]">{name}</span>
            <Select value={patch} onValueChange={(v) => onPatch(v as ReturnPatch)}>
              <SelectTrigger
                size="sm"
                aria-label={`${name} output patch`}
                className="h-7 w-[92px] border-black/40 bg-black/30 px-2 text-xs text-white [&_svg]:text-white/80"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PATCHES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    Out → {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {/* footswitch zone */}
          <div className="flex w-full flex-col items-center gap-1 rounded-xl bg-black/25 py-3 shadow-inner">
            <button
              type="button"
              aria-pressed={on}
              aria-label={`${name} footswitch`}
              onClick={onToggle}
              className={cn(
                "size-14 rounded-full border-4 border-zinc-400 bg-gradient-to-br from-zinc-100 via-zinc-300 to-zinc-500 shadow-[0_4px_0_rgba(0,0,0,0.5)] transition-transform active:translate-y-0.5 active:shadow-[0_1px_0_rgba(0,0,0,0.5)]",
                FOCUS,
              )}
            >
              <span aria-hidden="true" className="mx-auto block size-8 rounded-full bg-gradient-to-br from-zinc-200 to-zinc-400 ring-1 ring-zinc-500" />
            </button>
          </div>
        </section>
      </div>
      <span className="flex items-center gap-1.5 text-xs text-zinc-200">
        <span aria-hidden="true" className={status.heard ? "size-2 rounded-full bg-green-600" : "size-2 rounded-full bg-amber-500"} />
        {status.text}
      </span>
    </div>
  );
}

const VIS_W = 212;
const VIS_H = 48;

function EchoTaps({ d, bpm }: { d: DelayParams; bpm: number }) {
  const id = useId();
  const t = delaySeconds(d.division, bpm);
  const fb = d.feedback * 0.92;
  const window = 2.4;
  const taps: { time: number; amp: number; side: "L" | "R" | "LR" }[] = [];
  for (let n = 0; n < 40; n++) {
    const amp = Math.pow(fb, n);
    const time = t * (n + 1);
    if (amp < 0.03 || time > window) break;
    taps.push({ time, amp, side: d.pingPong ? (n % 2 === 0 ? "L" : "R") : "LR" });
  }
  const caption = `${d.division} @ ${bpm.toFixed(1)} BPM · ${Math.round(t * 1000)} ms · ${taps.length} repeat${taps.length === 1 ? "" : "s"}${d.pingPong ? " · ping-pong" : ""}`;
  const mid = VIS_H / 2;
  return (
    <figure className="m-0">
      <svg width={VIS_W} height={VIS_H} viewBox={`0 0 ${VIS_W} ${VIS_H}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="block max-w-full">
        <title id={`${id}-t`}>Delay repeats</title>
        <desc id={`${id}-d`}>{caption}</desc>
        <line x1={0} x2={VIS_W} y1={mid} y2={mid} className="stroke-slate-800" />
        {taps.map((tap, i) => {
          const x = 6 + (tap.time / window) * (VIS_W - 12);
          const h = tap.amp * (mid - 3);
          return <rect key={i} x={x - 1.5} y={tap.side === "R" ? mid : mid - h} width={3} height={Math.max(1, tap.side === "LR" ? h * 2 : h)} rx={1} className="fill-emerald-300" />;
        })}
      </svg>
      <figcaption className="text-[10px] text-emerald-200 tabular-nums">{caption}</figcaption>
    </figure>
  );
}

function DecayCurve({ r }: { r: ReverbParams }) {
  const id = useId();
  const decay = reverbDecaySeconds(r.decay);
  const pre = reverbPredelayMs(r.predelay) / 1000;
  const window = 8.5;
  const pts: string[] = [];
  for (let i = 0; i <= 80; i++) {
    const t = (i / 80) * window;
    const amp = t < pre ? 0 : Math.exp((-6.9 * (t - pre)) / decay);
    pts.push(`${i === 0 ? "M" : "L"}${((t / window) * VIS_W).toFixed(1)} ${(VIS_H - 3 - amp * (VIS_H - 8)).toFixed(1)}`);
  }
  const caption = `${decay.toFixed(1)} s · pre ${Math.round(pre * 1000)} ms · damp ${fmtHz(reverbDampHz(r.damp))}`;
  return (
    <figure className="m-0">
      <svg width={VIS_W} height={VIS_H} viewBox={`0 0 ${VIS_W} ${VIS_H}`} role="img" aria-labelledby={`${id}-t ${id}-d`} className="block max-w-full">
        <title id={`${id}-t`}>Reverb decay</title>
        <desc id={`${id}-d`}>{caption}</desc>
        <path d={`${pts.join(" ")} L${VIS_W} ${VIS_H} L0 ${VIS_H} Z`} className="fill-indigo-400/25" />
        <path d={pts.join(" ")} className="fill-none stroke-indigo-300" strokeWidth={2} />
      </svg>
      <figcaption className="text-[10px] text-indigo-200 tabular-nums">{caption}</figcaption>
    </figure>
  );
}

function FxRackView({
  delay,
  reverb,
  onDelay,
  onReverb,
  delayStatus,
  reverbStatus,
  tempo,
  vertical = false,
}: {
  delay: DelayParams;
  reverb: ReverbParams;
  onDelay: (p: Partial<DelayParams>) => void;
  onReverb: (p: Partial<ReverbParams>) => void;
  delayStatus: PatchStatus;
  reverbStatus: PatchStatus;
  /** BPM the delay follows (shown on its screen). */
  tempo: number;
  /** Stack the pedals in one column (pedalboard beside the mixer). */
  vertical?: boolean;
}) {
  const divIdx = DIVISIONS.indexOf(delay.division);
  const nDiv = DIVISIONS.length;
  return (
    <div
      role="group"
      aria-label="Pedalboard"
      className={`flex ${vertical ? "flex-col items-center px-4" : "flex-wrap items-start justify-center gap-x-12 px-6"} gap-y-6 rounded-xl border border-zinc-700 bg-[repeating-linear-gradient(135deg,#27272a_0px,#27272a_6px,#202023_6px,#202023_12px)] pt-6 pb-4 shadow-inner`}
    >
      <Pedal
        name="Delay"
        colour="green"
        on={delay.on !== false}
        onToggle={() => onDelay({ on: delay.on === false })}
        send="SND 1"
        patch={delay.patch}
        onPatch={(patch) => onDelay({ patch })}
        status={delayStatus}
        screen={<EchoTaps d={delay} bpm={tempo} />}
        knobs={
          <>
            <Knob
              variant="pedal"
              size={34}
              ticks={nDiv}
              label="Delay time"
              caption="Time"
              pos={divIdx / (nDiv - 1)}
              defaultPos={2 / (nDiv - 1)}
              keyStep={1 / (nDiv - 1)}
              onPos={(p) => onDelay({ division: DIVISIONS[Math.round(p * (nDiv - 1))] })}
              valueText={`${delay.division} note`}
            />
            <Knob variant="pedal" size={34} ticks={11} label="Delay repeats" caption="Repeat" pos={delay.feedback} defaultPos={0.45} onPos={(feedback) => onDelay({ feedback })} valueText={`${Math.round(delay.feedback * 100)}%`} />
            <Knob variant="pedal" size={34} ticks={11} label="Delay tone" caption="Tone" pos={delay.tone} defaultPos={0.6} onPos={(tone) => onDelay({ tone })} valueText={fmtHz(delayToneHz(delay.tone))} />
            <Knob variant="pedal" size={34} ticks={11} label="Delay level" caption="Level" pos={delay.output} defaultPos={0.8} onPos={(output) => onDelay({ output })} valueText={`${Math.round(delay.output * 100)}%`} />
          </>
        }
        extra={
          <div role="group" aria-label="Delay mode" className="flex items-center gap-2 text-[9px] font-bold uppercase">
            <span>Echo</span>
            <div className="relative h-4 w-9 rounded-full bg-black/50 shadow-inner">
              <span aria-hidden="true" className="absolute top-0.5 size-3 rounded-full bg-zinc-200 transition-[left]" style={{ left: delay.pingPong ? 22 : 2 }} />
              <div className="absolute inset-0 flex">
                <button type="button" aria-label="Delay mode: echo" aria-pressed={!delay.pingPong} onClick={() => onDelay({ pingPong: false })} className={cn("h-full flex-1 rounded-full", FOCUS)} />
                <button type="button" aria-label="Delay mode: ping-pong" aria-pressed={delay.pingPong} onClick={() => onDelay({ pingPong: true })} className={cn("h-full flex-1 rounded-full", FOCUS)} />
              </div>
            </div>
            <span>Ping-pong</span>
          </div>
        }
      />
      <Pedal
        name="Reverb"
        colour="blue"
        on={reverb.on !== false}
        onToggle={() => onReverb({ on: reverb.on === false })}
        send="SND 2"
        patch={reverb.patch}
        onPatch={(patch) => onReverb({ patch })}
        status={reverbStatus}
        screen={<DecayCurve r={reverb} />}
        knobs={
          <>
            <Knob variant="pedal" size={34} ticks={11} label="Reverb decay" caption="Decay" pos={reverb.decay} defaultPos={0.5} onPos={(decay) => onReverb({ decay })} valueText={`${reverbDecaySeconds(reverb.decay).toFixed(1)} s`} />
            <Knob variant="pedal" size={34} ticks={11} label="Reverb pre-delay" caption="Pre-dly" pos={reverb.predelay} defaultPos={0.2} onPos={(predelay) => onReverb({ predelay })} valueText={`${Math.round(reverbPredelayMs(reverb.predelay))} ms`} />
            <Knob variant="pedal" size={34} ticks={11} label="Reverb tone (damping)" caption="Tone" pos={1 - reverb.damp} defaultPos={0.6} onPos={(p) => onReverb({ damp: 1 - p })} valueText={fmtHz(reverbDampHz(reverb.damp))} />
            <Knob variant="pedal" size={34} ticks={11} label="Reverb level" caption="Level" pos={reverb.output} defaultPos={0.8} onPos={(output) => onReverb({ output })} valueText={`${Math.round(reverb.output * 100)}%`} />
          </>
        }
        extra={<div className="h-4" aria-hidden="true" />}
      />
    </div>
  );
}

const sameStatus = (a: PatchStatus, b: PatchStatus) => a.heard === b.heard && a.text === b.text;

/**
 * Memoised: the rack only redraws when its own pedal state changes, not on every mixer move
 * (whole-console redraws starve the deck audio). `onDelay` / `onReverb` must be stable.
 */
export const FxRack = memo(
  FxRackView,
  (a, b) =>
    a.delay === b.delay &&
    a.reverb === b.reverb &&
    a.onDelay === b.onDelay &&
    a.onReverb === b.onReverb &&
    a.vertical === b.vertical &&
    a.tempo === b.tempo &&
    sameStatus(a.delayStatus, b.delayStatus) &&
    sameStatus(a.reverbStatus, b.reverbStatus),
);
