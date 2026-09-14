# ClueFinders 4th Grade Adventures — Web Port

A from-scratch reverse-engineering and web reimplementation of the 1998
CD-ROM game *ClueFinders' 4th Grade Adventures* (The Learning Company),
built from your original CD files.

## Current status

| Piece | Status |
|---|---|
| `.RSC` container format (NE resource tables) | **Solved** |
| `RESOURCE.MAP` / `AUDIO.MAP` catalog parsing | **Solved** |
| Audio extraction (WAVE resources + BGMUSIC tracks) | **Solved** — raw RIFF/WAVE, no decoding needed |
| Video conversion (Smacker → WebM) | **Solved** — via ffmpeg |
| ASEQ image/animation pixel format | **Solved** — 3,129 of 3,138 resources, 20,945 frames |
| Colour palettes | **Mostly done** — 76% of image resources in real colour (22 captured scene palettes + the shared range); 24% still placeholder in locations not reached yet |
| ASEQ sequence records (frame placement/timing) | **Solved** — frame order, per-frame offsets, sound cues; ~115 ms per tick |
| `FONT.RSC` (9 resources) | **Open** |
| Game scripts (`cdrom/SCRIPTS/*.MPS`) | **Format solved, disassembled** — all 43 scripts; interpreter not started (see `extractor/MPS_FORMAT.md`) |
| Web app (Vite + TS + PixiJS) | **Game engine running** — STARTUP → sign-in → first location (CBA1); characters, hotspots, LapTrap, movies not implemented yet. Asset browser at `?browser` |

See `extractor/FINDINGS.md` for the format details and the palette research.

## Project layout

```
extractor/            Python asset-extraction pipeline (offline, run once)
  ne_resource.py         NE resource-table parser (the .RSC format)
  parse_maps.py          RESOURCE.MAP / AUDIO.MAP catalog parser
  aseq.py                ASEQ image/animation decoder
  extract_images.py      ASEQ -> RGBA PNG sprite sheets + aseq_index.json
  extract_audio.py       WAVE resources -> .wav files
  extract_video.py       Smacker -> WebM conversion
  build_manifest.py      Combines everything into manifest.json
  mps.py                 Compiled game script (.MPS) parser
  disassemble_scripts.py .MPS -> readable listings + JSON
  FINDINGS.md            Resource format notes, open problems, Wine tips
  MPS_FORMAT.md          Script format and opcode notes

dynamic_analysis/     Live palette capture under Wine (see its README)
  palette_capture.py     Launches the game, reads its memory, matches palettes to scenes
  palette_score.py       Scores how well a palette fits a scene background

app/                  Runtime web app (Vite + TypeScript + PixiJS)
```

## Running the extraction pipeline

Requires Python 3 with Pillow and numpy; video conversion also needs ffmpeg.
`GAME` is the folder containing `4THADV32.EXE`.

```bash
cd extractor
python3 extract_images.py "$GAME/cdrom/RSC" ../output/images   # ~10 s, 62 MB
python3 extract_audio.py  "$GAME/cdrom/RSC" ../output/audio
python3 extract_video.py  "$GAME/cdrom/RSC" ../output/video      # 22 .SMK files live in RSC/
python3 extract_video.py  "$GAME/cdrom/MOVIES" ../output/video   # plus MV107A.SMK
python3 build_manifest.py "$GAME/cdrom/RSC" ../output
python3 disassemble_scripts.py "$GAME/cdrom/SCRIPTS" ../output/scripts
```

`extract_images.py --palettes <dir>` uses real palettes once they exist:
768-byte RGB `.pal` files named by bundle prefix (`cloc01.pal` covers
`cloc01.rsc`, `cloc01i1.rsc`, `cloc01p.rsc`, …), with `default.pal` as the
fallback. Bundles without one get a false-colour placeholder and
`"palette": null` in the index.

Image output, per resource under `output/images/<bundle>/`:

- `<id>_<n>.png` — RGBA sprite sheet(s); frame rectangles are listed in
  `aseq_index.json` / `manifest.json`
- `<id>.json` — sequence lists (frame order, offsets, sound cues)

## Running the app

```bash
cd app
npm install
npm run dev       # dev server with hot reload
npm run build     # production build to dist/
```

The app runs the game's own scripts (`src/engine/`):

- `ScriptVm.ts` executes the disassembled `.MPS` JSON (`output/scripts/`)
- `GameEngine.ts` implements engine functions, input, sound and script switching
- `DisplayObjects.ts`, `SelList.ts`, `Queue.ts`, `WorldState.ts` implement the
  engine classes scripts create; `classes.ts` lists which are implemented
  (the rest are logged as "not implemented" in the page's engine log)

Open the dev server and press **Start**. `?script=SIGNIN` (or any script name)
starts there instead of STARTUP. Player saves live in the browser's
localStorage. Movies show a placeholder card until the Smacker files are
converted.

`?browser` opens the asset browser (`src/browser/AssetBrowser.ts`): pick a
bundle, click an image to play its sequence lists, and play the bundle's
sounds. URLs like `?browser#cloc01o1/7050` open a resource directly; Space
pauses, → steps.

`app/public/assets` is a symlink to `../../output`, so re-running the
extractor updates the app with no copying. `npm run build` copies the assets
into `dist/` (~250 MB).

## Deploying

The app builds to fully static files (`app/dist/`), so any static host works.
The extracted assets are The Learning Company's copyrighted game content: keep
a deployment private, or have the app extract assets from the player's own CD
files in the browser.
