// MIDI Learn engine on the Web MIDI API: maps incoming CC / note messages to app targets,
// learns encoders vs absolute controls, and sends LED feedback back to the device.

export type TargetKind = "absolute" | "button" | "toggle" | "relative";

export interface MidiTarget {
  id: string;
  group: string;
  label: string;
  /** absolute: value 0..1 · button: 1 press / 0 release · toggle: called on press · relative: signed steps */
  kind: TargetKind;
  apply: (v: number) => void;
  /** LED state to echo back to the controller. */
  led?: () => boolean;
  /** absolute only: glide to each new knob value with this time constant (s) instead of jumping. */
  glide?: number;
  /** absolute only: the target's current value 0..1, where a glide starts from. */
  read?: () => number;
}

export type Encoding = "abs" | "rel" | "absdelta";

export interface MidiMapping {
  input: string;
  type: "cc" | "note";
  channel: number;
  number: number;
  targetId: string;
  enc?: Encoding;
}

export interface MidiMessageInfo {
  input: string;
  type: "cc" | "note";
  channel: number;
  number: number;
  value: number;
}

const STORE_KEY = "nomad-midi-mappings-v1";
/** The filter knob used to be a one-knob LPF/HPF sweep; it is now the cutoff of the type picked on screen. */
const migrate = (m: MidiMapping): MidiMapping => (/^filter\d\.oneknob$/.test(m.targetId) ? { ...m, targetId: m.targetId.replace("oneknob", "freq") } : m);
/**
 * Port name without direction / port-number decorations, so the same controller matches
 * however the OS or browser names it ("Traktor Kontrol X1 MK2 - 1 Input", "… X1 MK2",
 * "… X1 MK2 Output"): mappings made on one machine or browser keep working on another.
 */
export const portId = (name: string) =>
  name
    .toLowerCase()
    .replace(/\b(input|output|in|out|port)\b/g, " ")
    .replace(/\s-\s*\d+\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const keyOf = (m: { input: string; type: string; channel: number; number: number }) => `${portId(m.input)}|${m.type}|${m.channel}|${m.number}`;
const REL_VALUES = new Set([1, 2, 3, 4, 5, 6, 7, 121, 122, 123, 124, 125, 126, 127, 63, 65]);

export type MidiStatus = "off" | "unsupported" | "denied" | "on";

export class MidiController {
  status: MidiStatus = "off";
  inputs: string[] = [];
  mappings: MidiMapping[] = [];
  learning: string | null = null;
  last: MidiMessageInfo | null = null;
  version = 0;

  private access: MIDIAccess | null = null;
  private listeners = new Set<() => void>();
  private targets: () => Map<string, MidiTarget>;
  private learnSamples: MidiMessageInfo[] = [];
  private learnTimer: number | null = null;
  private learnDone: ((m: MidiMapping) => void) | null = null;
  /** The control mapped last: ignored by the next chained learn (see `learn`). */
  private ignoreKey: string | null = null;
  /** Ignore everything until then: lets a knob turn or button release finish. */
  private ignoreUntil = 0;
  private lastAbs = new Map<string, { v: number; t: number }>();
  private sentLed = new Map<string, boolean>();
  private ledTimer: number | null = null;
  // Knobs/faders/jogs send dozens of messages per second. Applying each one re-renders the
  // whole app and re-applies the mixer on the main thread, which starves the decks'
  // ScriptProcessor and makes the audio crackle. Continuous controls are therefore coalesced
  // and applied at most once per frame (absolute: latest value wins, relative: deltas summed).
  private pendingAbs = new Map<string, { t: MidiTarget; v: number }>();
  private pendingRel = new Map<string, { t: MidiTarget; v: number }>();
  private flushHandle: number | null = null;
  private flushIsRaf = false;
  private dirty = false;
  private glides = new Map<string, { t: MidiTarget; cur: number; to: number }>();
  private lastFlush = 0;

  constructor(targets: () => Map<string, MidiTarget>) {
    this.targets = targets;
    try {
      const raw = window.localStorage.getItem(STORE_KEY);
      if (raw) this.mappings = (JSON.parse(raw) as MidiMapping[]).map(migrate);
    } catch {
      /* storage unavailable in this context: mappings stay in memory */
    }
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private changed() {
    this.version++;
    this.listeners.forEach((l) => l());
  }
  private save() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify(this.mappings));
    } catch {
      /* ignore */
    }
  }

  async enable() {
    if (this.access) return;
    if (!("requestMIDIAccess" in navigator)) {
      this.status = "unsupported";
      this.changed();
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      this.status = "denied";
      this.changed();
      return;
    }
    this.status = "on";
    const bind = () => {
      if (!this.access) return;
      this.inputs = [];
      this.access.inputs.forEach((inp) => {
        this.inputs.push(inp.name ?? inp.id);
        inp.onmidimessage = (e) => this.onMessage(inp.name ?? inp.id, e.data);
      });
      this.sentLed.clear();
      this.changed();
    };
    this.access.onstatechange = bind;
    bind();
    this.ledTimer = window.setInterval(() => this.tickLeds(), 80);
  }

  dispose() {
    this.glides.clear();
    if (this.ledTimer) window.clearInterval(this.ledTimer);
    this.cancelFlush();
    this.access?.inputs.forEach((i) => (i.onmidimessage = null));
    if (this.access) this.access.onstatechange = null;
  }

  /**
   * Arm learn for a target; the next control moved on any input gets mapped.
   * `chained` (guided setup): keep ignoring the control mapped in the previous step, whose
   * remaining messages (the rest of a knob turn, a button release) are still arriving.
   */
  learn(targetId: string, done?: (m: MidiMapping) => void, chained = false) {
    this.learning = targetId;
    this.learnSamples = [];
    this.learnDone = done ?? null;
    this.clearLearnTimer();
    if (!chained) {
      this.ignoreKey = null;
      this.ignoreUntil = 0;
    }
    this.changed();
  }
  cancelLearn() {
    this.learning = null;
    this.learnDone = null;
    this.learnSamples = [];
    this.clearLearnTimer();
    this.ignoreKey = null;
    this.ignoreUntil = 0;
    this.changed();
  }
  private clearLearnTimer() {
    // reset the handle too: a stale handle made later jog / encoder learns wait forever
    if (this.learnTimer) window.clearTimeout(this.learnTimer);
    this.learnTimer = null;
  }

  remove(m: MidiMapping) {
    this.mappings = this.mappings.filter((x) => x !== m);
    this.save();
    this.changed();
  }
  clear() {
    this.mappings = [];
    this.save();
    this.changed();
  }
  exportJson() {
    return JSON.stringify({ app: "nomad-mixer", version: 1, mappings: this.mappings }, null, 2);
  }
  importJson(text: string) {
    const data = JSON.parse(text) as { mappings?: MidiMapping[] };
    const ok = (data.mappings ?? []).filter(
      (m) => typeof m.input === "string" && (m.type === "cc" || m.type === "note") && Number.isInteger(m.channel) && Number.isInteger(m.number) && typeof m.targetId === "string",
    );
    this.mappings = ok.map(migrate);
    this.save();
    this.changed();
    return ok.length;
  }

  private onMessage(input: string, data: Uint8Array | null) {
    if (!data || data.length < 2) return;
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    let msg: MidiMessageInfo | null = null;
    if (status === 0xb0) msg = { input, type: "cc", channel, number: data[1], value: data[2] ?? 0 };
    else if (status === 0x90) msg = { input, type: "note", channel, number: data[1], value: data[2] ?? 0 };
    else if (status === 0x80) msg = { input, type: "note", channel, number: data[1], value: 0 };
    if (!msg) return;
    this.last = msg;

    if (this.learning) {
      this.captureLearn(msg);
      this.changed();
      return;
    }
    const key = keyOf(msg);
    const targets = this.targets();
    for (const m of this.mappings) {
      if (keyOf(m) !== key) continue;
      const t = targets.get(m.targetId);
      if (t) this.dispatch(t, m, msg);
    }
    this.dirty = true;
    this.scheduleFlush();
  }

  private dispatch(t: MidiTarget, m: MidiMapping, msg: MidiMessageInfo) {
    const press = msg.value > 0 && (msg.type === "note" || msg.value >= 64);
    const slot = `${keyOf(m)}>${m.targetId}`;
    switch (t.kind) {
      case "absolute":
        if (t.glide) {
          const g = this.glides.get(slot);
          if (g) g.to = msg.value / 127;
          else {
            if (!this.glides.size) this.lastFlush = performance.now() - 16; // first frame of a new glide
            this.glides.set(slot, { t, cur: t.read?.() ?? msg.value / 127, to: msg.value / 127 });
          }
        } else this.pendingAbs.set(slot, { t, v: msg.value / 127 });
        break;
      case "button":
      case "toggle":
        // buttons act immediately, after any knob moves that came before them
        this.flushPending();
        if (t.kind === "button") t.apply(press ? 1 : 0);
        else if (press) t.apply(1);
        break;
      case "relative": {
        if (m.enc === "absdelta") {
          const k = keyOf(m);
          const prev = this.lastAbs.get(k);
          const now = performance.now();
          if (prev && now - prev.t < 250 && Math.abs(msg.value - prev.v) < 40) this.addRel(slot, t, msg.value - prev.v);
          this.lastAbs.set(k, { v: msg.value, t: now });
        } else if (m.enc === "abs") {
          this.pendingAbs.set(slot, { t, v: msg.value / 127 });
        } else {
          this.addRel(slot, t, msg.value >= 64 ? msg.value - 128 : msg.value);
        }
        break;
      }
    }
  }

  private addRel(slot: string, t: MidiTarget, d: number) {
    const p = this.pendingRel.get(slot);
    if (p) p.v += d;
    else this.pendingRel.set(slot, { t, v: d });
  }

  private flushPending() {
    if (this.pendingAbs.size) {
      const abs = [...this.pendingAbs.values()];
      this.pendingAbs.clear();
      abs.forEach(({ t, v }) => t.apply(v));
    }
    if (this.pendingRel.size) {
      const rel = [...this.pendingRel.values()];
      this.pendingRel.clear();
      rel.forEach(({ t, v }) => v !== 0 && t.apply(v));
    }
    this.stepGlides();
  }

  /** Move gliding knobs one frame toward where the hardware knob is. */
  private stepGlides() {
    const now = performance.now();
    const dt = Math.min(0.1, Math.max(0.001, (now - this.lastFlush) / 1000));
    this.lastFlush = now;
    if (!this.glides.size) return;
    this.glides.forEach((g, slot) => {
      g.cur += (g.to - g.cur) * (1 - Math.exp(-dt / (g.t.glide ?? 0.1)));
      if (Math.abs(g.to - g.cur) < 0.002) {
        g.cur = g.to;
        this.glides.delete(slot);
      }
      g.t.apply(g.cur);
    });
    this.dirty = true;
    if (this.glides.size) this.scheduleFlush(); // keep gliding next frame
  }

  private scheduleFlush() {
    if (this.flushHandle !== null) return;
    const run = () => {
      this.flushHandle = null;
      this.flushPending();
      if (this.dirty) {
        this.dirty = false;
        this.changed();
      }
    };
    // rAF pauses in background tabs; fall back to a ~60 Hz timer there
    this.flushIsRaf = typeof document !== "undefined" && !document.hidden;
    this.flushHandle = this.flushIsRaf ? window.requestAnimationFrame(run) : window.setTimeout(run, 16);
  }

  private cancelFlush() {
    if (this.flushHandle === null) return;
    if (this.flushIsRaf) window.cancelAnimationFrame(this.flushHandle);
    else window.clearTimeout(this.flushHandle);
    this.flushHandle = null;
  }

  private captureLearn(msg: MidiMessageInfo) {
    const target = this.targets().get(this.learning ?? "");
    if (!target) return;
    if (performance.now() < this.ignoreUntil) return;
    if (this.ignoreKey !== null && keyOf(msg) === this.ignoreKey) return; // still the last control
    if ((target.kind === "button" || target.kind === "toggle") && msg.value === 0) return; // wait for a press
    if (target.kind !== "relative") {
      this.commitLearn(msg, "abs");
      return;
    }
    // jog / encoder: watch a few messages to tell an endless encoder from an absolute strip.
    // Only CCs: a touch strip also sends a touch / release note (X1 MK2: note 29), which
    // must not become the jog.
    if (msg.type !== "cc") return;
    const first = this.learnSamples[0];
    if (first && keyOf(first) !== keyOf(msg)) return;
    this.learnSamples.push(msg);
    if (this.learnTimer) return;
    this.learnTimer = window.setTimeout(() => {
      this.learnTimer = null;
      const s = this.learnSamples;
      if (!s.length) return;
      const rel = s.every((x) => REL_VALUES.has(x.value));
      this.commitLearn(s[0], rel ? "rel" : "absdelta");
    }, 450);
  }

  private commitLearn(msg: MidiMessageInfo, enc: Encoding) {
    if (!this.learning) return;
    const mapping: MidiMapping = { input: msg.input, type: msg.type, channel: msg.channel, number: msg.number, targetId: this.learning, enc };
    // one control drives one target: replace any previous use of this control
    this.mappings = [...this.mappings.filter((m) => keyOf(m) !== keyOf(mapping)), mapping];
    this.save();
    const done = this.learnDone;
    this.learning = null;
    this.learnDone = null;
    this.learnSamples = [];
    this.ignoreKey = keyOf(mapping);
    this.ignoreUntil = performance.now() + 150;
    this.changed();
    done?.(mapping);
  }

  private outputFor(input: string): MIDIOutput | null {
    if (!this.access) return null;
    let found: MIDIOutput | null = null;
    const want = portId(input);
    this.access.outputs.forEach((o) => {
      if (!found && portId(o.name ?? "") === want) found = o;
    });
    return found;
  }

  private tickLeds() {
    if (!this.access || this.status !== "on") return;
    const targets = this.targets();
    for (const m of this.mappings) {
      const t = targets.get(m.targetId);
      if (!t?.led) continue;
      const on = t.led();
      const k = keyOf(m);
      if (this.sentLed.get(k) === on) continue;
      const out = this.outputFor(m.input);
      if (!out) continue;
      try {
        out.send([(m.type === "note" ? 0x90 : 0xb0) | m.channel, m.number, on ? 127 : 0]);
        this.sentLed.set(k, on);
      } catch {
        /* device gone */
      }
    }
  }
}

export interface GuidedStep {
  prompt: string;
  targetId: string;
}

/** Guided setups: the app names each physical control in turn; touching it maps it. */
export const GUIDED_SETUPS: { id: string; name: string; before: string; steps: GuidedStep[] }[] = [
  {
    id: "z1",
    name: "Traktor Kontrol Z1 (MK1)",
    before: "Switch the Z1 to MIDI mode: hold MODE and press both headphone CUE buttons (A and B). Left side → CH 2 (Deck 1), right side → CH 3 (Deck 2); the FX knobs become one-knob filters (Filter 1 / Filter 2).",
    steps: [
      { prompt: "Left GAIN knob", targetId: "ch2.gain" },
      { prompt: "Left HI knob", targetId: "ch2.hi" },
      { prompt: "Left MID knob", targetId: "ch2.mid" },
      { prompt: "Left LOW knob", targetId: "ch2.lo" },
      { prompt: "Left FILTER FX knob", targetId: "filter1.freq" },
      { prompt: "Left FILTER FX ON button", targetId: "filter1.on" },
      { prompt: "Headphone CUE A button", targetId: "ch2.cue" },
      { prompt: "Left channel fader", targetId: "ch2.fader" },
      { prompt: "Right GAIN knob", targetId: "ch3.gain" },
      { prompt: "Right HI knob", targetId: "ch3.hi" },
      { prompt: "Right MID knob", targetId: "ch3.mid" },
      { prompt: "Right LOW knob", targetId: "ch3.lo" },
      { prompt: "Right FILTER FX knob", targetId: "filter2.freq" },
      { prompt: "Right FILTER FX ON button", targetId: "filter2.on" },
      { prompt: "Headphone CUE B button", targetId: "ch3.cue" },
      { prompt: "Right channel fader", targetId: "ch3.fader" },
    ],
  },
  {
    id: "x1mk2",
    name: "Traktor Kontrol X1 MK2",
    before:
      "Switch the X1 MK2 to MIDI mode: hold SHIFT and press both LOAD (arrow) buttons. FX: the left FX unit drives the Delay pedal, the right FX unit the Reverb pedal. Players: the left side controls Deck 1 and the right side Deck 2 (each LOOP encoder turns as that deck's jog, its push sets a 4-beat loop); HOTCUE 1–2 are Deck 1 hot cues A–B and HOTCUE 3–4 Deck 2 hot cues A–B. No SHIFT combinations: in MIDI mode SHIFT does not change what the other buttons send (unless set up in NI Controller Editor), so a SHIFT step would take over the plain button's mapping.",
    steps: [
      { prompt: "Left FX: DRY/WET knob", targetId: "delay.level" },
      { prompt: "Left FX: knob 1", targetId: "delay.repeat" },
      { prompt: "Left FX: knob 2", targetId: "delay.tone" },
      { prompt: "Left FX: knob 3", targetId: "delay.time" },
      { prompt: "Left FX: ON button (under DRY/WET)", targetId: "delay.on" },
      { prompt: "Right FX: DRY/WET knob", targetId: "reverb.level" },
      { prompt: "Right FX: knob 1", targetId: "reverb.decay" },
      { prompt: "Right FX: knob 2", targetId: "reverb.predelay" },
      { prompt: "Right FX: knob 3", targetId: "reverb.tone" },
      { prompt: "Right FX: ON button (under DRY/WET)", targetId: "reverb.on" },
      { prompt: "Left LOOP encoder: turn it (Deck 1 jog)", targetId: "deck1.jog" },
      { prompt: "Left LOOP encoder: push (Deck 1 4-beat loop)", targetId: "deck1.loop4" },
      { prompt: "Right LOOP encoder: turn it (Deck 2 jog)", targetId: "deck2.jog" },
      { prompt: "Right LOOP encoder: push (Deck 2 4-beat loop)", targetId: "deck2.loop4" },
      { prompt: "HOTCUE 1 (Deck 1 hot cue A)", targetId: "deck1.hot0" },
      { prompt: "HOTCUE 2 (Deck 1 hot cue B)", targetId: "deck1.hot1" },
      { prompt: "HOTCUE 3 (Deck 2 hot cue A)", targetId: "deck2.hot0" },
      { prompt: "HOTCUE 4 (Deck 2 hot cue B)", targetId: "deck2.hot1" },
      { prompt: "Left FLUX button (→ Master Tempo)", targetId: "deck1.mt" },
      { prompt: "Left SYNC button", targetId: "deck1.sync" },
      { prompt: "Left CUE button", targetId: "deck1.cue" },
      { prompt: "Left PLAY button", targetId: "deck1.play" },
      { prompt: "Right FLUX button (→ Master Tempo)", targetId: "deck2.mt" },
      { prompt: "Right SYNC button", targetId: "deck2.sync" },
      { prompt: "Right CUE button", targetId: "deck2.cue" },
      { prompt: "Right PLAY button", targetId: "deck2.play" },
    ],
  },
];
