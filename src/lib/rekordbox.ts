// Reader for rekordbox USB/SD exports, written from the public format analysis by
// Deep Symmetry (https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/):
//  - PIONEER/rekordbox/export.pdb : DeviceSQL database (little-endian, fixed-size pages)
//  - PIONEER/USBANLZ/…/ANLZ0000.DAT / .EXT : analysis (big-endian tagged sections)
// Read-only: nothing is ever written back to the media.

export interface RbTrack {
  id: number;
  title: string;
  artist: string;
  album: string;
  key: string;
  bpm: number | null;
  duration: number;
  filePath: string;
  analyzePath: string;
}

export interface RbPlaylist {
  id: number;
  parentId: number;
  name: string;
  isFolder: boolean;
  sortOrder: number;
}

export interface RbLibrary {
  tracks: Map<number, RbTrack>;
  playlists: RbPlaylist[];
  /** playlist id → track ids in playlist order */
  entries: Map<number, number[]>;
  skippedRows: number;
}

export interface RbBeat {
  beatNumber: number; // 1..4 within the bar
  bpm: number;
  timeMs: number;
}

export interface RbCue {
  /** 0 = memory point / loop, 1 = hot cue A, 2 = B, … */
  hotCue: number;
  isLoop: boolean;
  timeMs: number;
  loopEndMs: number | null;
  comment: string;
}

export interface RbAnalysis {
  beats: RbBeat[];
  cues: RbCue[];
  path: string | null;
}

const TABLE = { tracks: 0, genres: 1, artists: 2, albums: 3, keys: 5, playlistTree: 7, playlistEntries: 8 } as const;

/** DeviceSQL string at `at` (short ASCII, long ASCII or UTF-16LE). */
export function readDeviceSqlString(dv: DataView, at: number): string {
  const flag = dv.getUint8(at);
  if (flag & 1) {
    const len = (flag >> 1) - 1;
    let s = "";
    for (let i = 0; i < len; i++) s += String.fromCharCode(dv.getUint8(at + 1 + i));
    return s.replace(/\0+$/, "");
  }
  if (flag === 0 || (flag === 0x40 && dv.getUint16(at + 1, true) <= 4)) return "";
  const total = dv.getUint16(at + 1, true);
  const dataLen = Math.max(0, total - 4);
  const start = at + 4;
  if (flag === 0x90) {
    let s = "";
    for (let i = 0; i + 1 < dataLen; i += 2) s += String.fromCharCode(dv.getUint16(start + i, true));
    return s.replace(/\0+$/, "");
  }
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset + start, Math.min(dataLen, dv.byteLength - start));
  return new TextDecoder(flag === 0x40 ? "latin1" : "utf-8").decode(bytes).replace(/\0+$/, "");
}

/** Visit every present row of a table, following its page chain. */
function forEachRow(dv: DataView, lenPage: number, first: number, last: number, visit: (rowAt: number) => void, onBad: () => void) {
  const pages = Math.floor(dv.byteLength / lenPage);
  const seen = new Set<number>();
  let page = first;
  while (page > 0 && page < pages && !seen.has(page)) {
    seen.add(page);
    const off = page * lenPage;
    const flags = dv.getUint8(off + 0x1b);
    if ((flags & 0x40) === 0) {
      const counts = dv.getUint8(off + 0x18) | (dv.getUint8(off + 0x19) << 8) | (dv.getUint8(off + 0x1a) << 16);
      const numOffsets = counts & 0x1fff;
      const groups = Math.ceil(numOffsets / 16);
      for (let g = 0; g < groups; g++) {
        const base = off + lenPage - g * 0x24;
        const present = dv.getUint16(base - 4, true);
        for (let j = 0; j < 16; j++) {
          if (g * 16 + j >= numOffsets) break;
          if (!(present & (1 << j))) continue;
          const rowOfs = dv.getUint16(base - 6 - 2 * j, true);
          const rowAt = off + 0x28 + rowOfs;
          if (rowAt >= off + lenPage) {
            onBad();
            continue;
          }
          try {
            visit(rowAt);
          } catch {
            onBad();
          }
        }
      }
    }
    if (page === last) break;
    page = dv.getUint32(off + 0x0c, true);
  }
}

export function parseExportPdb(buf: ArrayBuffer): RbLibrary {
  const dv = new DataView(buf);
  const lenPage = dv.getUint32(4, true);
  const numTables = dv.getUint32(8, true);
  if (lenPage < 512 || lenPage > 65536 || numTables === 0 || numTables > 64) throw new Error("Not a rekordbox export.pdb");
  const tables = new Map<number, { first: number; last: number }>();
  for (let i = 0; i < numTables; i++) {
    const p = 0x1c + i * 16;
    tables.set(dv.getUint32(p, true), { first: dv.getUint32(p + 8, true), last: dv.getUint32(p + 12, true) });
  }
  let skippedRows = 0;
  const bad = () => skippedRows++;
  const each = (type: number, visit: (rowAt: number) => void) => {
    const t = tables.get(type);
    if (t) forEachRow(dv, lenPage, t.first, t.last, visit, bad);
  };
  const str = (at: number) => readDeviceSqlString(dv, at);

  const artists = new Map<number, string>();
  each(TABLE.artists, (r) => {
    const sub = dv.getUint16(r, true);
    const id = dv.getUint32(r + 4, true);
    const ofs = sub === 0x64 ? dv.getUint16(r + 0x0a, true) : dv.getUint8(r + 0x09);
    artists.set(id, str(r + ofs));
  });
  const albums = new Map<number, string>();
  each(TABLE.albums, (r) => {
    const sub = dv.getUint16(r, true);
    const id = dv.getUint32(r + 0x0c, true);
    const ofs = sub === 0x84 ? dv.getUint16(r + 0x16, true) : dv.getUint8(r + 0x15);
    albums.set(id, str(r + ofs));
  });
  const keys = new Map<number, string>();
  each(TABLE.keys, (r) => keys.set(dv.getUint32(r, true), str(r + 8)));

  const tracks = new Map<number, RbTrack>();
  each(TABLE.tracks, (r) => {
    const s = (i: number) => str(r + dv.getUint16(r + 0x5e + 2 * i, true));
    const tempo = dv.getUint32(r + 0x38, true);
    const id = dv.getUint32(r + 0x48, true);
    const filePath = s(20);
    if (!filePath) return;
    tracks.set(id, {
      id,
      title: s(17) || s(19),
      artist: artists.get(dv.getUint32(r + 0x44, true)) ?? "",
      album: albums.get(dv.getUint32(r + 0x40, true)) ?? "",
      key: keys.get(dv.getUint32(r + 0x20, true)) ?? "",
      bpm: tempo > 0 ? tempo / 100 : null,
      duration: dv.getUint16(r + 0x54, true),
      filePath,
      analyzePath: s(14),
    });
  });

  const playlists: RbPlaylist[] = [];
  each(TABLE.playlistTree, (r) =>
    playlists.push({
      parentId: dv.getUint32(r, true),
      sortOrder: dv.getUint32(r + 8, true),
      id: dv.getUint32(r + 0x0c, true),
      isFolder: dv.getUint32(r + 0x10, true) !== 0,
      name: str(r + 0x14),
    }),
  );
  playlists.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  const raw = new Map<number, { idx: number; track: number }[]>();
  each(TABLE.playlistEntries, (r) => {
    const pl = dv.getUint32(r + 8, true);
    const list = raw.get(pl) ?? [];
    list.push({ idx: dv.getUint32(r, true), track: dv.getUint32(r + 4, true) });
    raw.set(pl, list);
  });
  const entries = new Map<number, number[]>();
  raw.forEach((list, pl) => entries.set(pl, list.sort((a, b) => a.idx - b.idx).map((e) => e.track)));

  return { tracks, playlists, entries, skippedRows };
}

function fourcc(dv: DataView, at: number) {
  return String.fromCharCode(dv.getUint8(at), dv.getUint8(at + 1), dv.getUint8(at + 2), dv.getUint8(at + 3));
}

function utf16be(dv: DataView, at: number, bytes: number) {
  let s = "";
  for (let i = 0; i + 1 < bytes && at + i + 1 < dv.byteLength; i += 2) s += String.fromCharCode(dv.getUint16(at + i, false));
  return s.replace(/\0+$/, "");
}

/** Parse an ANLZ0000.DAT / .EXT analysis file (beat grid, cues, path). */
export function parseAnlz(buf: ArrayBuffer): RbAnalysis {
  const dv = new DataView(buf);
  if (dv.byteLength < 12 || fourcc(dv, 0) !== "PMAI") throw new Error("Not a rekordbox analysis file");
  const out: RbAnalysis = { beats: [], cues: [], path: null };
  const legacyCues: RbCue[] = [];
  const extCues: RbCue[] = [];
  let pos = dv.getUint32(4, false);
  while (pos + 12 <= dv.byteLength) {
    const tag = fourcc(dv, pos);
    const lenTag = dv.getUint32(pos + 8, false);
    if (lenTag < 12 || pos + lenTag > dv.byteLength) break;
    try {
      if (tag === "PQTZ") {
        const n = dv.getUint32(pos + 0x14, false);
        for (let i = 0; i < n && pos + 0x18 + i * 8 + 8 <= pos + lenTag; i++) {
          const e = pos + 0x18 + i * 8;
          out.beats.push({ beatNumber: dv.getUint16(e, false), bpm: dv.getUint16(e + 2, false) / 100, timeMs: dv.getUint32(e + 4, false) });
        }
      } else if (tag === "PCOB") {
        const n = dv.getUint16(pos + 0x12, false);
        let e = pos + 0x18;
        for (let i = 0; i < n && e + 0x28 <= pos + lenTag; i++) {
          const lenEntry = dv.getUint32(e + 8, false) || 0x38;
          const type = dv.getUint8(e + 0x1c);
          legacyCues.push({
            hotCue: dv.getUint32(e + 0x0c, false),
            isLoop: type === 2,
            timeMs: dv.getUint32(e + 0x20, false),
            loopEndMs: type === 2 ? dv.getUint32(e + 0x24, false) : null,
            comment: "",
          });
          e += lenEntry;
        }
      } else if (tag === "PCO2") {
        const n = dv.getUint16(pos + 0x10, false);
        let e = pos + 0x14;
        for (let i = 0; i < n && e + 0x1c <= pos + lenTag; i++) {
          const lenEntry = dv.getUint32(e + 8, false);
          if (lenEntry < 0x1c) break;
          const type = dv.getUint8(e + 0x10);
          const lenComment = lenEntry >= 0x2c ? dv.getUint32(e + 0x28, false) : 0;
          extCues.push({
            hotCue: dv.getUint32(e + 0x0c, false),
            isLoop: type === 2,
            timeMs: dv.getUint32(e + 0x14, false),
            loopEndMs: type === 2 ? dv.getUint32(e + 0x18, false) : null,
            comment: lenComment > 0 && 0x2c + lenComment <= lenEntry ? utf16be(dv, e + 0x2c, lenComment) : "",
          });
          e += lenEntry;
        }
      } else if (tag === "PPTH") {
        const len = dv.getUint32(pos + 0x0c, false);
        out.path = utf16be(dv, pos + 0x10, len);
      }
    } catch {
      /* skip a malformed section, keep the rest */
    }
    pos += lenTag;
  }
  // the extended (nxs2) list carries the same cues plus comments; prefer it when present
  // per kind (memory vs hot): prefer the extended list when it has that kind
  const pick = (hot: boolean) => {
    const ext = extCues.filter((c) => c.hotCue > 0 === hot);
    return ext.length ? ext : legacyCues.filter((c) => c.hotCue > 0 === hot);
  };
  out.cues = [...pick(false), ...pick(true)].sort((a, b) => a.timeMs - b.timeMs);
  return out;
}

/** Folder picked from the USB (via a directory file input), indexed by path. */
export class UsbFolder {
  private byPath = new Map<string, File>();
  private prefix = "";
  readonly fileCount: number;

  constructor(files: FileList | File[]) {
    const list = Array.from(files);
    this.fileCount = list.length;
    for (const f of list) {
      const rel = ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name).replace(/\\/g, "/");
      this.byPath.set(rel.toLowerCase(), f);
    }
    // find where the PIONEER folder sits so media paths ("/PIONEER/…", "/Contents/…") resolve.
    // rekordbox writes it as "PIONEER" or, on some media, as the hidden ".PIONEER".
    for (const key of this.byPath.keys()) {
      const m = /(^|\/)\.?pioneer\/rekordbox\/export\.pdb$/.exec(key);
      if (m) {
        this.prefix = key.slice(0, m.index + m[1].length);
        break;
      }
    }
  }

  get hasExport() {
    return this.resolve("/PIONEER/rekordbox/export.pdb") !== null;
  }

  /** Resolve a media path; "PIONEER/…" and ".PIONEER/…" are treated as the same folder. */
  resolve(mediaPath: string): File | null {
    const p = mediaPath.replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();
    const hit = this.byPath.get(this.prefix + p);
    if (hit) return hit;
    const alt = p.startsWith("pioneer/") ? "." + p : p.startsWith(".pioneer/") ? p.slice(1) : null;
    return alt ? (this.byPath.get(this.prefix + alt) ?? null) : null;
  }

  /** Audio files when there is no rekordbox database. */
  audioFiles(): File[] {
    return Array.from(this.byPath.values()).filter((f) => /\.(mp3|wav|aiff?|flac|m4a|aac|ogg|opus)$/i.test(f.name));
  }
}
