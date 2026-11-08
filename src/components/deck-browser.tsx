import { memo, useMemo, useState } from "react";
import { ChevronLeft, Folder, ListMusic, Loader2, Music, Search } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { CdjDeck } from "@/lib/cdj-deck";
import type { RbPlaylist, RbTrack } from "@/lib/rekordbox";
import { loadFromUsb, type UsbMedia } from "@/lib/usb-library";

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-sky-400";
const MAX_ROWS = 300;
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export type BrowsePlace = { kind: "root" } | { kind: "folder"; id: number } | { kind: "playlist"; id: number } | { kind: "all" };
type Place = BrowsePlace;

/**
 * The player's BROWSE screen: navigate the USB and load a track onto this deck.
 * The trail (where you are in the folder tree) is owned by the deck so the browser
 * reopens where you left it, like a CDJ.
 */
function DeckBrowserView({
  deckNumber,
  deck,
  media,
  ensureAudio,
  onLoaded,
  trail,
  setTrail,
}: {
  deckNumber: number;
  deck: CdjDeck | null;
  media: UsbMedia;
  ensureAudio: () => Promise<void>;
  onLoaded: () => void;
  trail: readonly BrowsePlace[];
  setTrail: (update: (t: readonly BrowsePlace[]) => readonly BrowsePlace[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const place = trail[trail.length - 1];
  const lib = media.lib;

  const go = (p: Place) => {
    setTrail((t) => [...t, p]);
    setQuery("");
  };
  const back = () => {
    setTrail((t) => (t.length > 1 ? t.slice(0, -1) : t));
    setQuery("");
  };

  // playlist tree indexed once per library: parent id → children (already in sort order)
  const tree = useMemo(() => {
    const byParent = new Map<number, RbPlaylist[]>();
    const byId = new Map<number, RbPlaylist>();
    for (const p of lib?.playlists ?? []) {
      byId.set(p.id, p);
      const list = byParent.get(p.parentId);
      if (list) list.push(p);
      else byParent.set(p.parentId, [p]);
    }
    return { byParent, byId };
  }, [lib]);
  const children = (parent: number): RbPlaylist[] => tree.byParent.get(parent) ?? [];
  const placeName = (p: Place) => (p.kind === "root" ? media.name : p.kind === "all" ? "All tracks" : (tree.byId.get(p.id)?.name ?? "Playlist"));

  const tracks: RbTrack[] = useMemo(() => {
    if (!lib) return [];
    if (place.kind === "playlist") return (lib.entries.get(place.id) ?? []).map((id) => lib.tracks.get(id)).filter((t): t is RbTrack => !!t);
    if (place.kind === "all") return Array.from(lib.tracks.values()).sort((a, b) => a.title.localeCompare(b.title));
    return [];
  }, [lib, place]);

  const q = query.trim().toLowerCase();
  const shownTracks = q ? tracks.filter((t) => `${t.title} ${t.artist} ${t.album} ${t.key}`.toLowerCase().includes(q)) : tracks;
  const shownFiles = !lib ? media.plain.filter((f) => !q || f.name.toLowerCase().includes(q)) : [];

  const load = async (file: File | null, meta: RbTrack | null, key: string) => {
    if (!deck) return;
    if (!file) {
      toast.error(`Audio file not found on the USB${meta ? `: ${meta.filePath}` : ""}. Pick the drive's top folder, not just PIONEER.`);
      return;
    }
    setBusy(key);
    try {
      await ensureAudio();
      const r = await loadFromUsb(deck, media, file, meta);
      toast.success(
        `Deck ${deckNumber}: ${r.title}${r.bpm ? ` · ${r.bpm.toFixed(2)} BPM` : ""}${meta ? ` · grid ${r.gridFrom === "rekordbox" ? "from rekordbox" : r.gridFrom} · ${r.memoryCues} memory / ${r.hotCues} hot cues` : ""}`,
      );
      onLoaded();
    } catch {
      toast.error(`${meta?.title ?? file.name} could not be loaded. It may be in a format this browser can't decode.`);
    } finally {
      setBusy(null);
    }
  };

  const rowCls = cn("flex w-full items-center gap-2 border-b border-slate-800 px-2 py-1.5 text-left text-[11px] hover:bg-sky-900/60", FOCUS);
  const listing = place.kind === "playlist" || place.kind === "all" || !lib;

  return (
    <div role="region" aria-label={`Deck ${deckNumber} USB browser`} className="flex h-[172px] flex-col font-mono text-sky-100">
      <div className="flex items-center gap-1 border-b border-sky-900 pb-1">
        <button type="button" onClick={back} disabled={trail.length === 1} aria-label="Back" className={cn("rounded p-0.5 text-sky-300 hover:bg-slate-800 disabled:opacity-30", FOCUS)}>
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <span className="min-w-0 truncate text-[11px] text-sky-300">{trail.map(placeName).join(" › ")}</span>
        {listing && (
          <label className="ml-auto flex items-center gap-1 rounded bg-slate-900 px-1.5">
            <Search className="size-3 text-sky-400" aria-hidden="true" />
            <span className="sr-only">Search</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-6 w-24 bg-transparent text-[11px] text-sky-100 outline-none placeholder:text-sky-700" />
          </label>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {lib && (place.kind === "root" || place.kind === "folder") && (
          <ul className="m-0 list-none p-0">
            {place.kind === "root" && (
              <li>
                <button type="button" className={rowCls} onClick={() => go({ kind: "all" })}>
                  <Music className="size-3.5 shrink-0 text-sky-300" aria-hidden="true" />
                  All tracks
                  <span className="ml-auto text-sky-500 tabular-nums">{lib.tracks.size}</span>
                </button>
              </li>
            )}
            {children(place.kind === "root" ? 0 : place.id).map((p) => (
              <li key={p.id}>
                <button type="button" className={rowCls} onClick={() => go(p.isFolder ? { kind: "folder", id: p.id } : { kind: "playlist", id: p.id })}>
                  {p.isFolder ? <Folder className="size-3.5 shrink-0 text-amber-300" aria-hidden="true" /> : <ListMusic className="size-3.5 shrink-0 text-sky-300" aria-hidden="true" />}
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-sky-500 tabular-nums">{p.isFolder ? children(p.id).length : (lib.entries.get(p.id)?.length ?? 0)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {lib && listing && (
          <ul className="m-0 list-none p-0">
            {shownTracks.slice(0, MAX_ROWS).map((t, i) => (
              // a playlist may hold the same track more than once, so the row key is its position
              <li key={`${i}-${t.id}`}>
                <button type="button" disabled={busy !== null} className={rowCls} onClick={() => void load(media.folder.resolve(t.filePath), t, `${i}-${t.id}`)} aria-label={`Load ${t.title} by ${t.artist || "unknown artist"} on deck ${deckNumber}`}>
                  {busy === `${i}-${t.id}` ? <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-300" aria-hidden="true" /> : <Music className="size-3.5 shrink-0 text-sky-500" aria-hidden="true" />}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sky-50">{t.title}</span>
                    <span className="block truncate text-[10px] text-sky-400">{t.artist}</span>
                  </span>
                  <span className="shrink-0 text-right text-[10px] text-sky-300 tabular-nums">
                    {t.bpm ? t.bpm.toFixed(1) : ""}
                    {t.key && <span className="ml-1 text-sky-500">{t.key}</span>}
                    <span className="block text-sky-500">{fmtDur(t.duration)}</span>
                  </span>
                </button>
              </li>
            ))}
            {shownTracks.length === 0 && <li className="p-2 text-[11px] text-sky-500">No tracks{q ? " match" : ""}.</li>}
            {shownTracks.length > MAX_ROWS && <li className="p-2 text-[10px] text-sky-500">Showing {MAX_ROWS} of {shownTracks.length}; search to narrow down.</li>}
          </ul>
        )}

        {!lib && (
          <ul className="m-0 list-none p-0">
            {shownFiles.slice(0, MAX_ROWS).map((f) => {
              const key = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
              return (
                <li key={key}>
                  <button type="button" disabled={busy !== null} className={rowCls} onClick={() => void load(f, null, key)} aria-label={`Load ${f.name} on deck ${deckNumber}`}>
                    {busy === key ? <Loader2 className="size-3.5 shrink-0 animate-spin text-sky-300" aria-hidden="true" /> : <Music className="size-3.5 shrink-0 text-sky-500" aria-hidden="true" />}
                    <span className="truncate">{f.name}</span>
                  </button>
                </li>
              );
            })}
            {shownFiles.length === 0 && <li className="p-2 text-[11px] text-sky-500">No audio files found on this media.</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

export const DeckBrowser = memo(DeckBrowserView);
