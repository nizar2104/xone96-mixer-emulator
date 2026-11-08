# NO-MAD DJ Setup

A DJ setup that runs in the browser (React + TypeScript + Vite + Web Audio):

- **6+2 mixer** laid out after the Allen & Heath Xone:96 top panel: channels A · 1–4 · B, 4-band / parametric EQ, SEND 1 (pre/post) and SEND 2, RTN C/D, two VCF filters (HPF/BPF/LPF combinable, RES, CRUNCH), crossfader and channel-fader curves, AUTO-CUE metering.
- **Two CDJ-style decks**: variable-rate player (forward, reverse, vinyl scratch), CDJ cue behaviour, loops, hot cues A–C, tempo ±6/10/16/Wide, **Master Tempo** (WSOLA time-stretch), **BPM / beat-grid detection**, **SYNC** with phase lock.
- **FX pedals**: tempo-synced stereo delay (SND 1) and reverb (SND 2), patchable to RTN A–D, footswitch bypass with trails.
- **rekordbox USB reader**: reads `PIONEER/rekordbox/export.pdb` and `USBANLZ` analysis (beat grid, memory/hot cues) from a picked folder. Read-only.
- **MIDI Learn** with guided setups for Traktor Kontrol Z1 (MK1) and X1 MK2 in MIDI mode, LED feedback, mapping export/import.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build in dist/
```

Use Chrome or Edge for MIDI (Web MIDI) and folder access.

## Notes

- `src/lib/mixer-engine.ts` – mixer, filters, sends/returns, delay and reverb
- `src/lib/cdj-deck.ts` – deck player, Master Tempo, demo tracks
- `src/lib/beat-detect.ts` – BPM / beat-grid detection (Mixxx / Queen Mary port, GPL), run in a worker (`analysis-worker.ts`, `analysis-client.ts`) together with the RGB waveform analysis (`waveform.ts`)
- `src/lib/rekordbox.ts` – export.pdb / ANLZ reader
- `src/lib/midi.ts` – MIDI Learn engine and guided setups
- Some files under `src/lib/` and `src/components/` (console capture, connector policy, preview bridges) come from the Microsoft App Builder template the app was first built in; they are inert outside that host and can be removed.

The rekordbox reader is written from the public format analysis by Deep Symmetry
(https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/).

## License

This app is licensed under the **GNU General Public License, version 2 or later** (see `LICENSE`),
because the BPM / beat-grid detection in `src/lib/beat-detect.ts` is a port of GPL code:

- [Mixxx](https://github.com/mixxxdj/mixxx) – `AnalyzerQueenMaryBeats` and `BeatUtils`
  (constant-tempo grid, BPM rounding, phase adjustment). © Mixxx Development Team, GPL-2.0-or-later.
- [Queen Mary DSP library (qm-dsp)](https://github.com/c4dm/qm-dsp) as bundled with Mixxx –
  `DetectionFunction`, `PhaseVocoder`, `TempoTrackV2`, `DownBeat`, `MathUtilities`.
  © Centre for Digital Music, Queen Mary, University of London (Christian Landone, Matthew Davies,
  Adam Stark, Chris Cannam and others), GPL-2.0-or-later.

The port follows Mixxx's fixed-tempo analysis; on top of it the app adds an on-beat check (so loud
off-beat hats/bass cannot pull the grid half a beat late) and uses qm-dsp's `DownBeat` to place beat 1,
which Mixxx itself does not do.

Not affiliated with or endorsed by Allen & Heath, Pioneer DJ / AlphaTheta or Native Instruments.
"Xone", "CDJ", "rekordbox" and "Traktor" are trademarks of their owners and are used only to describe compatibility and the hardware the layout is modelled on.
