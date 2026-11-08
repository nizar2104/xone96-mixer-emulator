import { useId, useMemo, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// ---------------- shared drag / keyboard control ----------------

export interface ControlProps {
  pos: number;
  onPos: (pos: number) => void;
  defaultPos: number;
  label: string;
  valueText: string;
}

function useControl(
  { pos, onPos, defaultPos }: Pick<ControlProps, "pos" | "onPos" | "defaultPos">,
  mode: "relative" | "vertical-track" | "horizontal-track",
  keyStep?: number,
) {
  const drag = useRef<{ y: number; pos: number } | null>(null);
  const setFromTrack = (e: ReactPointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (mode === "vertical-track") onPos(clamp01(1 - (e.clientY - r.top) / r.height));
    else onPos(clamp01((e.clientX - r.left) / r.width));
  };
  return {
    tabIndex: 0,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      e.currentTarget.focus();
      if (mode === "relative") drag.current = { y: e.clientY, pos };
      else {
        drag.current = { y: 0, pos };
        setFromTrack(e);
      }
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      if (mode === "relative") {
        const fine = e.shiftKey ? 0.25 : 1;
        onPos(clamp01(drag.current.pos + ((drag.current.y - e.clientY) / 160) * fine));
      } else setFromTrack(e);
    },
    onPointerUp: () => {
      drag.current = null;
    },
    onPointerCancel: () => {
      drag.current = null;
    },
    onDoubleClick: () => onPos(defaultPos),
    onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => {
      const step = keyStep ?? (e.shiftKey ? 0.005 : 0.02);
      let next: number | null = null;
      if (e.key === "ArrowUp" || e.key === "ArrowRight") next = pos + step;
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = pos - step;
      else if (e.key === "PageUp") next = pos + 0.1;
      else if (e.key === "PageDown") next = pos - 0.1;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = 1;
      else if (e.key === "Delete" || e.key === "Backspace") next = defaultPos;
      if (next !== null) {
        e.preventDefault();
        onPos(clamp01(next));
      }
    },
  };
}

export const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-1";

function polar(cx: number, cy: number, r: number, a: number) {
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)] as const;
}
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number) {
  if (Math.abs(a1 - a0) < 0.001) return "";
  const [s, e] = a0 < a1 ? [a0, a1] : [a1, a0];
  const [x0, y0] = polar(cx, cy, r, s);
  const [x1, y1] = polar(cx, cy, r, e);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${e - s > Math.PI ? 1 : 0} 1 ${x1} ${y1}`;
}
const SWEEP = (135 * Math.PI) / 180;

export interface KnobExtras {
  caption?: string;
  size?: number;
  bipolar?: boolean;
  tone?: "amber" | "sky" | "rose" | "violet";
  /** Panel scale: number of printed tick marks around the knob. */
  ticks?: number;
  /** Printed legends at the two ends of the scale (e.g. MILD / WILD). */
  ends?: [string, string];
  /** Large soft-touch rubber cap with a knurled rim (Xone:VCF FREQ). */
  knurled?: boolean;
  /** "panel": black cap + printed scale on the silver top panel (no value arc). */
  variant?: "dark" | "panel" | "pedal";
  /** Pointer colour; input-select rotaries carry a red pointer. */
  pointer?: "white" | "red";
  /** Keyboard step (stepped selectors). */
  keyStep?: number;
  /** Numerals printed around the scale (e.g. CRUNCH 0..10). */
  numerals?: string[];
}

export function Knob({
  label,
  caption,
  size = 44,
  bipolar = false,
  tone = "amber",
  ticks,
  ends,
  knurled = false,
  variant = "dark",
  pointer = "white",
  keyStep,
  numerals,
  ...props
}: ControlProps & KnobExtras) {
  const ctl = useControl(props, "relative", keyStep);
  const panel = variant === "panel" || variant === "pedal";
  const pedal = variant === "pedal";
  const angle = -SWEEP + props.pos * 2 * SWEEP;
  const origin = bipolar ? 0 : -SWEEP;
  const pad = numerals ? 11 : ticks ? (knurled ? 10 : 7) : 0;
  const total = size + pad * 2;
  const c = total / 2;
  const r = size / 2 - 4;
  const stroke = tone === "sky" ? "stroke-sky-400" : tone === "rose" ? "stroke-rose-400" : tone === "violet" ? "stroke-violet-400" : "stroke-amber-400";
  const [px, py] = polar(c, c, r - (knurled ? 12 : 9), angle);
  const capR = r - 6;
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(props.pos * 100)}
        aria-valuetext={props.valueText}
        title={`${label}: ${props.valueText}`}
        className={cn("cursor-ns-resize touch-none rounded-full", FOCUS)}
        {...ctl}
      >
        <svg width={total} height={total} aria-hidden="true" className="block">
          {ticks &&
            Array.from({ length: ticks }, (_, i) => {
              const a = -SWEEP + (i / (ticks - 1)) * 2 * SWEEP;
              const major = i === 0 || i === ticks - 1 || i === (ticks - 1) / 2;
              const [x0, y0] = polar(c, c, r + 3, a);
              const [x1, y1] = polar(c, c, r + (major ? 7 : 5.5), a);
              if (panel && knurled) {
                const [dx, dy] = polar(c, c, r + 5 + i * 0.4, a);
                return <circle key={i} cx={dx} cy={dy} r={1.6 + i * 0.75} className="fill-zinc-900" />;
              }
              return panel ? (
                <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className={pedal ? "stroke-white/80" : "stroke-zinc-800"} strokeWidth={major ? 1.4 : 0.9} />
              ) : (
                <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} className="stroke-zinc-400" strokeWidth={major ? 1.5 : 1} />
              );
            })}
          {numerals &&
            numerals.map((t, i) => {
              const a = -SWEEP + (i / (numerals.length - 1)) * 2 * SWEEP;
              const [tx, ty] = polar(c, c, r + 8, a);
              return (
                <text key={i} x={tx} y={ty + 2} textAnchor="middle" className="fill-zinc-800 text-[6px] font-semibold">
                  {t}
                </text>
              );
            })}
          {!panel && <path d={arcPath(c, c, r, -SWEEP, SWEEP)} className="fill-none stroke-zinc-700" strokeWidth={3} strokeLinecap="round" />}
          {!panel && <path d={arcPath(c, c, r, origin, angle)} className={cn("fill-none", stroke)} strokeWidth={3} strokeLinecap="round" />}
          {panel ? (
            <>
              <circle cx={c} cy={c + 1} r={r} className="fill-zinc-500/40" />
              <circle cx={c} cy={c} r={r} className={cn("fill-zinc-900 stroke-zinc-950", knurled && "stroke-zinc-700")} strokeWidth={knurled ? 3 : 1} strokeDasharray={knurled ? "2 2" : undefined} />
              <circle cx={c} cy={c} r={r - (knurled ? 5 : 3)} className="fill-zinc-800" />
            </>
          ) : knurled ? (
            <>
              <circle cx={c} cy={c} r={capR} className="fill-zinc-950 stroke-zinc-700" strokeWidth={4} strokeDasharray="2 2" />
              <circle cx={c} cy={c} r={capR - 4} className="fill-zinc-800" />
              <circle cx={c} cy={c} r={capR - 9} className="fill-zinc-700" />
            </>
          ) : (
            <>
              <circle cx={c} cy={c} r={capR} className="fill-zinc-800 stroke-zinc-600" strokeWidth={1} />
              <circle cx={c} cy={c} r={r - 8} className="fill-zinc-700" />
            </>
          )}
          {panel ? (
            <line x1={polar(c, c, r * 0.25, angle)[0]} y1={polar(c, c, r * 0.25, angle)[1]} x2={polar(c, c, r - 1.5, angle)[0]} y2={polar(c, c, r - 1.5, angle)[1]} className={pointer === "red" ? "stroke-red-500" : "stroke-zinc-50"} strokeWidth={knurled ? 3 : 2.2} strokeLinecap="round" />
          ) : (
            <line x1={c} y1={c} x2={px} y2={py} className="stroke-zinc-50" strokeWidth={knurled ? 3 : 2} strokeLinecap="round" />
          )}
        </svg>
      </div>
      {ends && (
        <div className={cn("-mt-1 flex justify-between text-[9px] font-semibold uppercase", pedal ? "text-white" : panel ? "text-zinc-700" : "text-zinc-300")} style={{ width: total }} aria-hidden="true">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </div>
      )}
      {caption && <span className={cn("text-[10px] font-semibold tracking-wide uppercase", pedal ? "text-white" : panel ? "text-zinc-800" : "text-zinc-300")}>{caption}</span>}
    </div>
  );
}

/** Round rubber push button with an illuminated ring (CUE = red, filter type = yellow, FILTER ON = blue). */
export function RoundButton({
  lit,
  ring,
  label,
  size = 34,
  onClick,
  onPointerDown,
  onPointerUp,
}: {
  lit: boolean;
  ring: "red" | "yellow" | "blue" | "white" | "green";
  label: string;
  size?: number;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
}) {
  const ringOn = {
    red: "border-red-500 shadow-[0_0_10px_2px_rgba(239,68,68,0.65)]",
    yellow: "border-amber-400 shadow-[0_0_10px_2px_rgba(251,191,36,0.7)]",
    blue: "border-sky-500 shadow-[0_0_10px_2px_rgba(14,165,233,0.7)]",
    white: "border-zinc-50 shadow-[0_0_8px_2px_rgba(255,255,255,0.9)]",
    green: "border-zinc-300 shadow-[0_0_8px_2px_rgba(74,222,128,0.6)]",
  }[ring];
  return (
    <button
      type="button"
      aria-pressed={lit}
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{ width: size, height: size }}
      className={cn(
        "relative flex shrink-0 items-center justify-center rounded-full border-[3px] bg-gradient-to-b from-zinc-800 to-zinc-950 transition-shadow",
        FOCUS,
        lit ? ringOn : "border-zinc-500",
      )}
    >
      {ring === "green" && (
        <span aria-hidden="true" className={cn("size-1/3 rounded-full border-2", lit ? "border-green-400 bg-green-500 shadow-[0_0_6px_rgba(74,222,128,0.9)]" : "border-zinc-300 bg-transparent")} />
      )}
    </button>
  );
}

/** Small 3-position panel toggle (FILTER 1/OFF/2, X/OFF/Y, fader curves). */
export function Toggle3<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [{ value: T; text: string; name: string }, { value: T; text: string; name: string }, { value: T; text: string; name: string }];
  onChange: (v: T) => void;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="group" aria-label={label} className="flex items-center gap-1 text-[9px] font-bold text-zinc-800">
      <span aria-hidden="true" className="w-3 text-right">{options[0].text}</span>
      <div className="relative h-3.5 w-9 rounded-full bg-zinc-800 shadow-inner">
        <span
          aria-hidden="true"
          className="absolute top-0.5 size-2.5 rounded-full bg-zinc-200 transition-[left]"
          style={{ left: `${2 + idx * 12}px` }}
        />
        <div className="absolute inset-0 flex">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={o.value === value}
              aria-label={`${label}: ${o.name}`}
              title={`${label}: ${o.name}`}
              onClick={() => onChange(o.value)}
              className={cn("h-full flex-1 rounded-full", FOCUS)}
            />
          ))}
        </div>
      </div>
      <span aria-hidden="true" className="w-3">{options[2].text}</span>
    </div>
  );
}

/** Small round latching switch (per-channel SEND 1 PRE). */
export function MiniSwitch({ on, label, onClick }: { on: boolean; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "size-3.5 rounded-full border border-zinc-600 shadow-sm",
        FOCUS,
        on ? "bg-amber-300 shadow-[0_0_6px_rgba(251,191,36,0.9)]" : "bg-zinc-700",
      )}
    />
  );
}

/** Panel LED whose brightness follows a 0..1 amount (e.g. the CRUNCH LED: unlit at 0, full red at 10). */
export function AmountLed({ amount, label }: { amount: number; label: string }) {
  return (
    <span
      aria-hidden="true"
      title={label}
      className="inline-block size-2.5 rounded-full bg-zinc-700"
      style={amount > 0.001 ? { backgroundColor: `rgba(239, 68, 68, ${0.25 + 0.75 * amount})`, boxShadow: `0 0 ${2 + amount * 8}px rgba(239, 68, 68, ${amount})` } : undefined}
    />
  );
}

/** Large square illuminated push switch (Xone:VCF ON / Filter Type Select). */
export function PanelSwitch({
  lit,
  color,
  label,
  children,
  onClick,
  onPointerDown,
  onPointerUp,
  className,
}: {
  lit: boolean;
  color: "blue" | "white";
  label: string;
  children: ReactNode;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: () => void;
  onPointerUp?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={lit}
      aria-label={label}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerCancel={onPointerUp}
      className={cn(
        "flex h-10 min-w-12 items-center justify-center rounded-md border-2 px-2 text-xs font-bold tracking-wide shadow-inner transition-colors",
        FOCUS,
        lit
          ? color === "blue"
            ? "border-sky-300 bg-sky-600 text-white shadow-[0_0_14px_rgba(56,189,248,0.6)]"
            : "border-zinc-100 bg-zinc-100 text-zinc-950 shadow-[0_0_12px_rgba(255,255,255,0.45)]"
          : "border-zinc-600 bg-zinc-800 text-zinc-200 hover:bg-zinc-700",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Fader(props: ControlProps & { height?: number }) {
  const ctl = useControl(props, "vertical-track");
  return (
    <div
      role="slider"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.pos * 100)}
      aria-valuetext={props.valueText}
      title={`${props.label}: ${props.valueText}`}
      className={cn("relative w-9 cursor-ns-resize touch-none rounded-sm", FOCUS)}
      style={{ height: props.height ?? 160 }}
      {...ctl}
    >
      <div className="absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full bg-zinc-950 ring-1 ring-zinc-700" />
      {[0, 0.25, 0.5, 0.75, 1].map((t) => (
        <div key={t} className="absolute left-0 h-px w-1.5 bg-zinc-500" style={{ bottom: `${t * 100}%` }} aria-hidden="true" />
      ))}
      <div
        className="absolute left-1/2 h-7 w-8 -translate-x-1/2 translate-y-1/2 rounded-sm border border-zinc-500 bg-gradient-to-b from-zinc-300 to-zinc-500 shadow-md"
        style={{ bottom: `${props.pos * 100}%` }}
      >
        <div className="mx-auto mt-[13px] h-0.5 w-6 bg-zinc-900" />
      </div>
    </div>
  );
}

export function Crossfader(props: ControlProps) {
  const ctl = useControl(props, "horizontal-track");
  return (
    <div
      role="slider"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.pos * 100)}
      aria-valuetext={props.valueText}
      className={cn("relative h-10 w-full max-w-sm cursor-ew-resize touch-none rounded-sm", FOCUS)}
      {...ctl}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-950 ring-1 ring-zinc-700" />
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-zinc-600" aria-hidden="true" />
      <div
        className="absolute top-1/2 h-8 w-6 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-zinc-500 bg-gradient-to-r from-zinc-300 to-zinc-500 shadow-md"
        style={{ left: `${props.pos * 100}%` }}
      >
        <div className="mx-auto mt-1 h-6 w-0.5 bg-zinc-900" />
      </div>
    </div>
  );
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  tone = "amber",
}: {
  label: string;
  value: T;
  options: { value: T; text: string; name: string }[];
  onChange: (v: T) => void;
  tone?: "amber" | "sky" | "violet";
}) {
  return (
    <div role="group" aria-label={label} className="flex overflow-hidden rounded-md border border-zinc-700">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            aria-label={`${label}: ${o.name}`}
            onClick={() => onChange(o.value)}
            className={cn(
              "min-w-7 px-1.5 py-1 text-[11px] font-bold",
              FOCUS,
              on
                ? tone === "sky"
                  ? "bg-sky-300 text-zinc-950"
                  : tone === "violet"
                    ? "bg-violet-300 text-zinc-950"
                    : "bg-amber-300 text-zinc-950"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700",
            )}
          >
            {o.text}
          </button>
        );
      })}
    </div>
  );
}

// LED ladder meters: round LEDs with printed dB legends, lit imperatively from the rAF loop.
/** Meter 0 dB = −14 dBFS (headroom above it up to PK!). */
export const METER_REF_DBFS = -14;
export const CH_SCALE = [10, 6, 3, 0, -3, -6, -10, -15, -20];
export const MAIN_SCALE = [10, 6, 3, 0, -3, -6, -10, -15, -20, -25, -35];
const ledColor = (db: number) => (db >= 10 ? "#ef4444" : db >= 6 ? "#f59e0b" : db >= 0 ? "#38bdf8" : "#4ade80");
const scaleText = (db: number, main: boolean) => (main && db >= 10 ? "PK!" : db > 0 ? `+${db}` : `${db}`);

function LedColumn({ meterRef, scale }: { meterRef: (el: HTMLDivElement | null) => void; scale: number[] }) {
  return (
    <div ref={meterRef} className="flex flex-col justify-between" style={{ height: "100%" }}>
      {scale.map((db) => (
        <span key={db} data-led data-db={db} data-color={ledColor(db)} className="block size-[7px] rounded-full bg-zinc-900" />
      ))}
    </div>
  );
}

/** Channel meter: one LED column with its legend on the left (as printed beside each fader). */
export function Meter({ meterRef, label, height = 160 }: { meterRef: (el: HTMLDivElement | null) => void; label: string; height?: number }) {
  return (
    <div className="flex gap-1" style={{ height }} aria-hidden="true" title={label}>
      <div className="flex flex-col justify-between text-right text-[7px] leading-[7px] font-semibold text-zinc-800">
        {CH_SCALE.map((db) => (
          <span key={db}>{scaleText(db, false)}</span>
        ))}
      </div>
      <LedColumn meterRef={meterRef} scale={CH_SCALE} />
    </div>
  );
}

/** Main L/R meter: two LED columns with the legend printed between them. */
export function MainMeter({
  leftRef,
  rightRef,
  label,
  height = 190,
}: {
  leftRef: (el: HTMLDivElement | null) => void;
  rightRef: (el: HTMLDivElement | null) => void;
  label: string;
  height?: number;
}) {
  return (
    <div className="flex gap-2" style={{ height }} aria-hidden="true" title={label}>
      <LedColumn meterRef={leftRef} scale={MAIN_SCALE} />
      <div className="flex w-6 flex-col justify-between text-center text-[7px] leading-[7px] font-bold text-zinc-800">
        {MAIN_SCALE.map((db) => (
          <span key={db}>{scaleText(db, true)}</span>
        ))}
      </div>
      <LedColumn meterRef={rightRef} scale={MAIN_SCALE} />
    </div>
  );
}

export function peakToMeterDb(peak: number) {
  return 20 * Math.log10(Math.max(peak, 1e-6)) - METER_REF_DBFS;
}

export function paintMeter(el: HTMLDivElement | null, peak: number) {
  if (!el) return;
  const db = peakToMeterDb(peak);
  el.querySelectorAll<HTMLElement>("[data-led]").forEach((led) => {
    const lit = db >= Number(led.dataset.db);
    led.style.backgroundColor = lit ? (led.dataset.color ?? "") : "";
    led.style.boxShadow = lit ? `0 0 5px ${led.dataset.color}` : "";
  });
}

// ---------------- filter response plot ----------------

const PLOT_W = 232;
const PLOT_H = 84;
export const PLOT_FREQS = (() => {
  const n = 96;
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = 20 * Math.pow(1000, i / (n - 1));
  return f;
})();
const DB_TOP = 24;
const DB_BOTTOM = -36;

export function ResponsePlot({ mag, on, caption }: { mag: Float32Array | null; on: boolean; caption: string }) {
  const id = useId();
  const path = useMemo(() => {
    if (!mag) return "";
    let d = "";
    mag.forEach((m, i) => {
      const db = Math.max(DB_BOTTOM, Math.min(DB_TOP, 20 * Math.log10(Math.max(m, 1e-6))));
      const x = (i / (mag.length - 1)) * PLOT_W;
      const y = ((DB_TOP - db) / (DB_TOP - DB_BOTTOM)) * PLOT_H;
      d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)} `;
    });
    return d;
  }, [mag]);
  const zeroY = (DB_TOP / (DB_TOP - DB_BOTTOM)) * PLOT_H;
  const gx = (hz: number) => (Math.log10(hz / 20) / 3) * PLOT_W;
  return (
    <figure className="m-0">
      <svg
        width={PLOT_W}
        height={PLOT_H}
        role="img"
        aria-labelledby={`${id}-t ${id}-d`}
        className="block max-w-full rounded-sm bg-zinc-950 ring-1 ring-zinc-700"
        viewBox={`0 0 ${PLOT_W} ${PLOT_H}`}
      >
        <title id={`${id}-t`}>Filter response</title>
        <desc id={`${id}-d`}>{caption}</desc>
        {[100, 1000, 10000].map((hz) => (
          <g key={hz}>
            <line x1={gx(hz)} x2={gx(hz)} y1={0} y2={PLOT_H} className="stroke-zinc-800" />
            <text x={gx(hz) + 2} y={PLOT_H - 3} className="fill-zinc-400 text-[8px]">
              {hz >= 1000 ? `${hz / 1000}k` : hz}
            </text>
          </g>
        ))}
        <line x1={0} x2={PLOT_W} y1={zeroY} y2={zeroY} className="stroke-zinc-700" strokeDasharray="2 3" />
        <path d={path} className={cn("fill-none", on ? "stroke-sky-300" : "stroke-zinc-500")} strokeWidth={2} />
      </svg>
      <figcaption className="mt-1 text-[11px] text-zinc-300 tabular-nums">{caption}</figcaption>
    </figure>
  );
}


/** Single bi-colour SIG LED (RTN C/D): green with signal, red near clipping. */
export function paintSig(el: HTMLElement | null, peak: number) {
  if (!el) return;
  const db = 20 * Math.log10(Math.max(peak, 1e-6));
  el.dataset.sig = db > -1 ? "clip" : db > -45 ? "on" : "off";
}
export function SigLed({ sigRef, label }: { sigRef: (el: HTMLSpanElement | null) => void; label: string }) {
  return (
    <span
      ref={sigRef}
      title={label}
      aria-hidden="true"
      data-sig="off"
      className="inline-block size-2.5 rounded-full bg-zinc-700 data-[sig=clip]:bg-red-500 data-[sig=on]:bg-lime-400"
    />
  );
}

export function Caption({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-semibold tracking-wide text-zinc-300 uppercase">{children}</span>;
}
