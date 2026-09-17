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
| Video conversion (Smacker → MP4) | **Solved** — all 23 movies via ffmpeg (H.264 + AAC, plays in every browser incl. iOS Safari) |
| ASEQ image/animation pixel format | **Solved** — 3,129 of 3,138 resources, 20,945 frames |
| Colour palettes | **Solved** — all 3,129 image resources in real colour, from 47 captured scene palettes. The last six (CLOC07, CLOC09, CLOC13, PBA, PLOC3, PWS1) were read off screenshots of the running game rather than its memory: `extractor/palette_from_screenshot.py` |
| ASEQ sequence records (frame placement/timing) | **Solved** — frame order, per-frame offsets, sound cues; ~115 ms per tick |
| `FONT.RSC` (9 resources) | **Solved** — byte-swapped Mac NFNT bitmap fonts: Geneva 10/12/14, Chicago 12/14, Arial 12 (plain and bold), Dado 14, Jackie 16, exported as atlas + metrics to `output/fonts/` and drawn by the engine, labels on puzzle answers included. The engine waits for the metrics before the first script runs: scripts size the boxes their text sits in by measuring it, so a font arriving mid-scene would cut some boxes to the game's own metrics and the rest to a web stand-in's |
| Game scripts (`cdrom/SCRIPTS/*.MPS`) | **Format solved, disassembled** — all 43 scripts; interpreter not started (see `extractor/MPS_FORMAT.md`) |
| Web app (Vite + TS + PixiJS) | **Game engine running** — STARTUP → sign-in → CBA1 (Cairo jeep puzzle) is playable: characters with fidgets and lip-synced speech, action queues, hotspots; the correct jeep leads on to CHUB. Item loop works: drag-and-drop puzzles — CWS1 coffee cups (value containers), CWS3 sentence sled (attribute containers, two-line answers), CWS4 export map (pixel-shaped containers, push-pin hot point, conveyor with OMMultiTrinket + MoveXAction), CWS2 fabric bolts (scissors cut fractions, palette-swapped colours) — workshop rewards, backpack, placing glyphs at the CHUB dealer. Movies play (intros, cutaways, MovieAction). The LapTrap works: menu, Cairo/Oasis maps (travel to visited places), settings, club bios, credits, quit, practice mode's Choose Activity list (GO to any activity) and the Progress and Levels page (level buttons coloured mastered/difficult, pick a level with the EXE's lose-your-work warning, auto-levelling boxes). All four Cairo workshops play (CWS2 fabric cutting: RFabricContainer). Oasis workshops: OWS1 column stacking (RStackingContainer), OWS2 sentence rows (RHorizontalContainer), OWS3 map paths (RMap, MapAction), OWS4 (RRandomAction) run. Mastery rooms: CMA pentomino board (RPentominoGame: snapping, rotate/flip tools, solve check) and OMA catapult (RTrigger pull lever, RAnimationTrigger, rock physics; statue hits knock crocs down) play. OHUB's gem doors play: each door's gem pattern (gems form a 4×4 colour × shape grid; one pattern shape per door) and its 12 missing slots follow the EXE's generator, and the Oasis workshops hand out exactly the missing gems; placing them from the backpack opens the door. Items are dealt as in the EXE: workshops where the player answers worse get more of the round's items (3/3/3/3 up to 6/2/2/2). The Pyramid and the ending play through: PLOC2 → PWS1 Riddles of the Sphinx (key into the answer slot, door opens) → every third riddle PLOC3 → PWS2 Chasm of Words (crossword of letter tiles) → PLOC2 with its cutscenes on visits 4/7/10, then the climax and epilogue movies and the Play Again / Quit dialog on visit 13. Auto-levelling follows the EXE: workshops move up or down one of 4 levels from their last answers (thresholds wsAutoLevelingA/B/X/Y, defaults 5/6/4/10, STARTUP overrides), base camps and mastery rooms step up per solve. A fresh-player playthrough (`?turbo=8`, 2026-09-15) plays from sign-in to the ending and back: CBA1, all five Cairo rounds, the CLOC01 statue, CMA, CBA2, all five Oasis doors, OMA, PBA, 12 riddles and 4 crosswords, then the Play Again dialog. Fixes it needed: `delete [, name` releases a whole array; an unset bare name passed to `send` is its own text (`PropertyAction "door", visible, kTrue`); storing into `result` sets RESULT (OWS4's gems); RAnimation `pause`; RText widths round and "Arial" is Arial (OWS2's word boxes fit their row); OWS2's unquoted `load_script OLOC08.mps`; value containers compare with a small tolerance (OWS1's 8.7-inch targets); `DisplayScreen` is a no-op. CWS3's word boxes are cut from a ladder of box widths to fit the text the engine measures, so its sentence only lines up when the answers draw in the game's own font -- the two lines of a wrapped phrase are each centred on their own box, as a single box's text is. PWS2 recolours each crossword with `replacePaletteEntry`: its letter tiles, boxes and chalk alphabet are redrawn in the scheme for the number of crosswords finished. Asset browser at `?browser` |

See `extractor/FINDINGS.md` for the format details and the palette research.

## Project layout

```
extractor/            Python asset-extraction pipeline (offline, run once)
  ne_resource.py         NE resource-table parser (the .RSC format)
  parse_maps.py          RESOURCE.MAP / AUDIO.MAP catalog parser
  aseq.py                ASEQ image/animation decoder
  nfnt.py                NFNT bitmap font decoder (FONT.RSC)
  extract_fonts.py       NFNT -> glyph atlas PNG + metrics index.json
  extract_images.py      ASEQ -> RGBA PNG sprite sheets + aseq_index.json
  extract_audio.py       WAVE resources -> .wav files
  extract_video.py       Smacker -> MP4 conversion
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
python3 extract_video.py  "$GAME/cdrom" ../output/video           # all 23 .SMK files (RSC/ and MOVIES/)
python3 extract_fonts.py  "$GAME/cdrom/RSC" ../output             # FONT.RSC -> atlases + metrics
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
starts there instead of STARTUP. `?turbo=8` fast-forwards the game (animations,
queue delays and sounds run 8 times faster) for testing long stretches.
`?webfonts` draws text with web stand-ins instead of the game's own bitmap
fonts, to compare the two. Player saves live in the browser's
localStorage. Movies play from `output/video` (a card stands in for any that
aren't converted); clicking a movie skips it.

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
