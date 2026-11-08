import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Cable, Download, Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { GUIDED_SETUPS, type MidiController, type MidiMapping, type MidiTarget } from "@/lib/midi";

const describe = (m: { input: string; type: string; channel: number; number: number }) =>
  `${m.input} · ${m.type === "cc" ? "CC" : "Note"} ${m.number} · ch ${m.channel + 1}`;

export function MidiPanel({
  midi,
  targets,
  onEnable,
  onGuidedSetup,
}: {
  midi: MidiController;
  targets: MidiTarget[];
  onEnable: () => Promise<void>;
  /** Called when a guided setup starts (e.g. to set the matching channel/filter routing). */
  onGuidedSetup: (setupId: string) => void;
}) {
  useSyncExternalStore(midi.subscribe, midi.getVersion);
  const [enabling, setEnabling] = useState(false);
  const [target, setTarget] = useState<string>("");
  const [guided, setGuided] = useState<{ id: string; step: number } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const importRef = useRef<HTMLInputElement | null>(null);

  const byId = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);
  const groups = useMemo(() => {
    const g = new Map<string, MidiTarget[]>();
    targets.forEach((t) => g.set(t.group, [...(g.get(t.group) ?? []), t]));
    return Array.from(g.entries());
  }, [targets]);

  const enable = async () => {
    setEnabling(true);
    try {
      await onEnable();
    } finally {
      setEnabling(false);
    }
  };

  const setup = guided ? GUIDED_SETUPS.find((s) => s.id === guided.id) : null;
  const runStep = (id: string, step: number) => {
    const s = GUIDED_SETUPS.find((x) => x.id === id);
    if (!s) return;
    if (step >= s.steps.length) {
      midi.cancelLearn();
      setGuided(null);
      toast.success(`${s.name} mapped.`);
      return;
    }
    setGuided({ id, step });
    // chained: the control just mapped keeps sending (rest of the turn, the release) and must
    // not be taken as the next step
    midi.learn(s.steps[step].targetId, () => runStep(id, step + 1), true);
  };
  const startGuided = (id: string) => {
    onGuidedSetup(id);
    runStep(id, 0);
  };
  const stopGuided = () => {
    midi.cancelLearn();
    setGuided(null);
  };

  const download = () => {
    const blob = new Blob([midi.exportJson()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "nomad-midi-mapping.json";
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const on = midi.status === "on";
  const learningLabel = midi.learning ? (byId.get(midi.learning)?.label ?? midi.learning) : null;

  return (
    <section aria-label="MIDI controllers" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Cable className="size-5 text-primary" aria-hidden="true" />
        <h2 className="m-0 text-sm font-bold">MIDI</h2>
        {!on ? (
          <Button size="sm" onClick={() => void enable()} disabled={enabling}>
            {enabling && <Loader2 className="animate-spin" aria-hidden="true" />}
            Connect MIDI controllers
          </Button>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {midi.inputs.length === 0 && <span className="text-xs text-muted-foreground">No MIDI devices found. Check the controller is in MIDI mode.</span>}
            {midi.inputs.map((i) => (
              <span key={i} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-green-600" />
                {i}
              </span>
            ))}
          </div>
        )}
        {midi.status === "unsupported" && <span className="text-xs text-destructive">This browser has no MIDI support. Use Chrome or Edge.</span>}
        {midi.status === "denied" && <span className="text-xs text-destructive">MIDI access was blocked by the browser or this page's host.</span>}
        {on && midi.last && (
          <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums" aria-live="off">
            {describe(midi.last)} = {midi.last.value}
          </span>
        )}
      </div>

      {on && (
        <Tabs defaultValue="guided">
          <TabsList>
            <TabsTrigger value="guided">Guided setup</TabsTrigger>
            <TabsTrigger value="learn">Learn</TabsTrigger>
            <TabsTrigger value="mappings">Mappings ({midi.mappings.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="guided" className="pt-2">
            {!setup ? (
              <div className="flex flex-wrap gap-2">
                {GUIDED_SETUPS.map((s) => (
                  <Button key={s.id} variant="outline" onClick={() => startGuided(s.id)}>
                    Map {s.name}
                  </Button>
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{setup.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    Step {guided!.step + 1} of {setup.steps.length}
                  </span>
                </div>
                <p className="m-0 text-xs text-muted-foreground">{setup.before}</p>
                <div className="flex items-center gap-3 rounded-md bg-muted px-3 py-3" aria-live="polite">
                  <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                  <span className="text-base font-semibold">{setup.steps[guided!.step].prompt}</span>
                  <span className="text-xs text-muted-foreground">→ {byId.get(setup.steps[guided!.step].targetId)?.label}</span>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={guided!.step === 0} onClick={() => runStep(setup.id, guided!.step - 1)}>
                    Back
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => runStep(setup.id, guided!.step + 1)}>
                    Skip
                  </Button>
                  <Button size="sm" variant="ghost" onClick={stopGuided}>
                    Stop
                  </Button>
                </div>
              </div>
            )}
          </TabsContent>

          <TabsContent value="learn" className="pt-2">
            <div className="flex flex-wrap items-center gap-2">
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger aria-label="Control to map" className="w-72">
                  <SelectValue placeholder="Choose what to control" />
                </SelectTrigger>
                <SelectContent>
                  {groups.map(([g, list]) => (
                    <SelectGroup key={g}>
                      <SelectLabel>{g}</SelectLabel>
                      {list.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {midi.learning && !guided ? (
                <Button variant="outline" onClick={() => midi.cancelLearn()}>
                  Cancel
                </Button>
              ) : (
                <Button
                  disabled={!target || !!guided}
                  onClick={() => midi.learn(target, (m) => toast.success(`${byId.get(m.targetId)?.label ?? m.targetId} ← ${describe(m)}`))}
                >
                  Learn
                </Button>
              )}
              {learningLabel && !guided && (
                <span className="flex items-center gap-2 text-sm" aria-live="polite">
                  <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                  Move or press a control for <strong>{learningLabel}</strong>
                </span>
              )}
            </div>
          </TabsContent>

          <TabsContent value="mappings" className="pt-2">
            <div className="mb-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!midi.mappings.length} onClick={download}>
                <Download aria-hidden="true" />
                Export
              </Button>
              <Button size="sm" variant="outline" onClick={() => importRef.current?.click()}>
                <Upload aria-hidden="true" />
                Import
              </Button>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-hidden="true"
                tabIndex={-1}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  try {
                    toast.success(`Imported ${midi.importJson(await f.text())} mappings.`);
                  } catch {
                    toast.error("That file is not a mapping export.");
                  }
                }}
              />
              {midi.mappings.length > 0 &&
                (confirmClear ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      midi.clear();
                      setConfirmClear(false);
                    }}
                  >
                    Confirm: remove all {midi.mappings.length}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => setConfirmClear(true)}>
                    Remove all
                  </Button>
                ))}
            </div>
            {midi.mappings.length === 0 ? (
              <p className="m-0 text-sm text-muted-foreground">No mappings yet.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto rounded-md border border-border">
                <table className="w-full border-collapse text-xs">
                  <caption className="sr-only">MIDI mappings</caption>
                  <thead className="sticky top-0 bg-card text-left text-[10px] text-muted-foreground uppercase">
                    <tr>
                      <th className="px-2 py-1.5 font-semibold">Hardware control</th>
                      <th className="px-2 py-1.5 font-semibold">Controls</th>
                      <th className="px-2 py-1.5 font-semibold">Type</th>
                      <th className="px-2 py-1.5">
                        <span className="sr-only">Remove</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {midi.mappings.map((m: MidiMapping) => {
                      const t = byId.get(m.targetId);
                      return (
                        <tr key={`${describe(m)}-${m.targetId}`} className="border-t border-border">
                          <td className="px-2 py-1 font-mono">{describe(m)}</td>
                          <td className="px-2 py-1">{t ? `${t.group}: ${t.label}` : m.targetId}</td>
                          <td className="px-2 py-1 text-muted-foreground">
                            {t?.kind === "relative" ? (m.enc === "rel" ? "Encoder" : "Strip / absolute") : t?.kind === "absolute" ? "Knob / fader" : "Button"}
                          </td>
                          <td className="px-2 py-1 text-right">
                            <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove mapping for ${t?.label ?? m.targetId}`} onClick={() => midi.remove(m)}>
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}
