// Fixture check for the rekordbox export.pdb reader (src/lib/rekordbox.ts).
// Builds a small synthetic DeviceSQL database in memory, laid out per Deep Symmetry's
// export analysis (https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/),
// parses it and checks tracks, the playlist tree and playlist entries.
// Run: npm run test:rekordbox   (Node strips the TypeScript types itself)
// This is synthetic data, not a real rekordbox USB export.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { UsbFolder, parseExportPdb } from "../src/lib/rekordbox.ts";

const LEN_PAGE = 4096;

/** DeviceSQL string: short ASCII when it fits, otherwise long UTF-16LE (flag 0x90). */
function devStr(s: string): Uint8Array {
  if (/^[\x20-\x7e]*$/.test(s) && s.length <= 126) {
    const out = new Uint8Array(1 + s.length);
    out[0] = ((s.length + 1) << 1) | 1;
    for (let i = 0; i < s.length; i++) out[1 + i] = s.charCodeAt(i);
    return out;
  }
  const out = new Uint8Array(4 + s.length * 2);
  const dv = new DataView(out.buffer);
  out[0] = 0x90;
  dv.setUint16(1, out.length, true);
  for (let i = 0; i < s.length; i++) dv.setUint16(4 + 2 * i, s.charCodeAt(i), true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Fixed-size row head followed by strings; `ofs` receives each string's offset from the row start. */
function rowWithStrings(head: number, strings: string[], fill: (dv: DataView, ofs: number[]) => void): Uint8Array {
  const encoded = strings.map(devStr);
  const ofs: number[] = [];
  let at = head;
  for (const e of encoded) {
    ofs.push(at);
    at += e.length;
  }
  const row = concat([new Uint8Array(head), ...encoded]);
  fill(new DataView(row.buffer), ofs);
  return row;
}

/** One data page holding `rows`; indexes in `deleted` are written but not marked present. */
function dataPage(index: number, type: number, rows: Uint8Array[], deleted: number[] = []): Uint8Array {
  const page = new Uint8Array(LEN_PAGE);
  const dv = new DataView(page.buffer);
  dv.setUint32(0x04, index, true);
  dv.setUint32(0x08, type, true);
  dv.setUint32(0x0c, 0, true); // next page: none
  const n = rows.length;
  const packed = n | (n << 13); // num_row_offsets (13 bits) | num_rows (11 bits)
  page[0x18] = packed & 0xff;
  page[0x19] = (packed >> 8) & 0xff;
  page[0x1a] = (packed >> 16) & 0xff;
  page[0x1b] = 0x34; // data page (bit 0x40 clear)
  let heap = 0;
  rows.forEach((row, i) => {
    const g = Math.floor(i / 16);
    const j = i % 16;
    const base = LEN_PAGE - g * 0x24;
    page.set(row, 0x28 + heap);
    dv.setUint16(base - 6 - 2 * j, heap, true);
    if (!deleted.includes(i)) dv.setUint16(base - 4, dv.getUint16(base - 4, true) | (1 << j), true);
    heap += (row.length + 3) & ~3;
  });
  assert.ok(0x28 + heap < LEN_PAGE - Math.ceil(n / 16) * 0x24, "fixture page overflow");
  return page;
}

// --- rows -----------------------------------------------------------------------

const artist = (id: number, name: string) =>
  rowWithStrings(0x0a, [name], (dv, [o]) => {
    dv.setUint16(0, 0x60, true);
    dv.setUint32(4, id, true);
    dv.setUint8(8, 0x03);
    dv.setUint8(9, o);
  });

const key = (id: number, name: string) =>
  rowWithStrings(8, [name], (dv) => {
    dv.setUint32(0, id, true);
    dv.setUint32(4, id, true);
  });

function track(id: number, title: string, artistId: number, keyId: number, bpm: number, seconds: number, file: string) {
  const strings: string[] = Array.from({ length: 21 }, () => "");
  strings[14] = `/PIONEER/USBANLZ/P0${id}/ANLZ0000.DAT`;
  strings[17] = title;
  strings[19] = file.split("/").pop() ?? "";
  strings[20] = file;
  return rowWithStrings(0x88, strings, (dv, ofs) => {
    dv.setUint16(0, 0x24, true);
    dv.setUint32(0x20, keyId, true);
    dv.setUint32(0x38, Math.round(bpm * 100), true);
    dv.setUint32(0x44, artistId, true);
    dv.setUint32(0x48, id, true);
    dv.setUint16(0x54, seconds, true);
    ofs.forEach((o, i) => dv.setUint16(0x5e + 2 * i, o, true));
  });
}

const node = (id: number, parentId: number, sortOrder: number, isFolder: boolean, name: string) =>
  rowWithStrings(0x14, [name], (dv) => {
    dv.setUint32(0x00, parentId, true);
    dv.setUint32(0x08, sortOrder, true);
    dv.setUint32(0x0c, id, true);
    dv.setUint32(0x10, isFolder ? 1 : 0, true);
  });

function entry(index: number, trackId: number, playlistId: number) {
  const row = new Uint8Array(12);
  const dv = new DataView(row.buffer);
  dv.setUint32(0, index, true);
  dv.setUint32(4, trackId, true);
  dv.setUint32(8, playlistId, true);
  return row;
}

// --- database -------------------------------------------------------------------

const tables: { type: number; rows: Uint8Array[]; deleted?: number[] }[] = [
  {
    type: 0,
    rows: [
      track(1, "Sunrise", 10, 100, 124, 372, "/Contents/A/Sunrise.mp3"),
      track(2, "Deep Water", 11, 101, 122.5, 401, "/Contents/B/Deep Water.mp3"),
      track(3, "Ünïcode Träck", 10, 100, 128, 300, "/Contents/A/Unicode.mp3"),
    ],
  },
  { type: 2, rows: [artist(10, "Artist One"), artist(11, "Artist Two")] },
  { type: 5, rows: [key(100, "8A"), key(101, "11B")] },
  {
    type: 7,
    rows: [
      node(5, 0, 1, false, "Warm-up"),
      node(1, 0, 0, true, "Gigs"),
      node(2, 1, 1, false, "Peak Time"),
      node(3, 1, 0, true, "2026"),
      node(4, 3, 0, false, "Closing ✦"),
      node(6, 0, 2, false, "Deleted list"),
    ],
    deleted: [5],
  },
  {
    type: 8,
    rows: [
      // stored out of order; Peak Time holds track 2 twice
      entry(2, 2, 2),
      entry(0, 1, 2),
      entry(1, 2, 2),
      entry(0, 3, 4),
      entry(0, 2, 5),
      entry(1, 99, 5), // dangling track id: kept as an id, dropped by the browser
    ],
  },
];

const pages: Uint8Array[] = [new Uint8Array(LEN_PAGE)];
const header = new DataView(pages[0].buffer);
header.setUint32(4, LEN_PAGE, true);
header.setUint32(8, tables.length, true);
header.setUint32(0x0c, tables.length + 1, true);
tables.forEach((t, i) => {
  const pageIndex = i + 1;
  const p = 0x1c + i * 16;
  header.setUint32(p, t.type, true);
  header.setUint32(p + 8, pageIndex, true);
  header.setUint32(p + 12, pageIndex, true);
  pages.push(dataPage(pageIndex, t.type, t.rows, t.deleted));
});
const pdb = concat(pages);

// --- checks ---------------------------------------------------------------------

// REKORDBOX_FIXTURE_OUT=<path> also writes the synthetic export.pdb, e.g. to try it in the app
if (process.env.REKORDBOX_FIXTURE_OUT) writeFileSync(process.env.REKORDBOX_FIXTURE_OUT, pdb);

const lib = parseExportPdb(pdb.buffer as ArrayBuffer);

assert.equal(lib.skippedRows, 0);
assert.equal(lib.tracks.size, 3);
assert.deepEqual(lib.tracks.get(2), {
  id: 2,
  title: "Deep Water",
  artist: "Artist Two",
  album: "",
  key: "11B",
  bpm: 122.5,
  duration: 401,
  filePath: "/Contents/B/Deep Water.mp3",
  analyzePath: "/PIONEER/USBANLZ/P02/ANLZ0000.DAT",
});
assert.equal(lib.tracks.get(3)?.title, "Ünïcode Träck");

// tree: deleted row skipped, children in sort order, folder flag and parents kept
assert.equal(lib.playlists.length, 5);
assert.ok(!lib.playlists.some((p) => p.id === 6), "row not marked present must be skipped");
const under = (parent: number) => lib.playlists.filter((p) => p.parentId === parent).map((p) => p.name);
assert.deepEqual(under(0), ["Gigs", "Warm-up"]);
assert.deepEqual(under(1), ["2026", "Peak Time"]);
assert.deepEqual(under(3), ["Closing ✦"]);
assert.equal(lib.playlists.find((p) => p.id === 1)?.isFolder, true);
assert.equal(lib.playlists.find((p) => p.id === 2)?.isFolder, false);

// entries: playlist order from entry_index, duplicates kept
assert.deepEqual(lib.entries.get(2), [1, 2, 2]);
assert.deepEqual(lib.entries.get(4), [3]);
assert.deepEqual(lib.entries.get(5), [2, 99]);
assert.equal(lib.entries.get(1), undefined, "folders have no entries");

// USB folder lookup: "PIONEER" and the hidden ".PIONEER" are the same folder
for (const dir of ["PIONEER", ".PIONEER"]) {
  const file = (rel: string) => Object.assign(new File([], rel.split("/").pop() ?? ""), { webkitRelativePath: rel });
  const usb = new UsbFolder([
    file(`KINGSTON/${dir}/rekordbox/export.pdb`),
    file(`KINGSTON/${dir}/USBANLZ/P002/ANLZ0000.DAT`),
    file("KINGSTON/Contents/A/Sunrise.mp3"),
  ]);
  assert.ok(usb.hasExport, `${dir}: export.pdb found`);
  assert.ok(usb.resolve("/PIONEER/USBANLZ/P002/ANLZ0000.DAT"), `${dir}: /PIONEER/ path resolves`);
  assert.ok(usb.resolve("/.PIONEER/USBANLZ/P002/ANLZ0000.DAT"), `${dir}: /.PIONEER/ path resolves`);
  assert.ok(usb.resolve("/Contents/A/Sunrise.mp3"), `${dir}: audio resolves`);
}

// not a database
assert.throws(() => parseExportPdb(new ArrayBuffer(LEN_PAGE)));

console.log("rekordbox fixture check: OK (tracks, playlist tree, playlist entries, USB paths)");
