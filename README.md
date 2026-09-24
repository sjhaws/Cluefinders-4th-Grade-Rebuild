# ClueFinders 4th Grade Adventures — Web Port

A from-scratch reverse-engineering and web reimplementation of the 1998
CD-ROM game *ClueFinders' 4th Grade Adventures* (The Learning Company),
built from your original CD files.

## Current status

| Piece | Status |
|---|---|
| `.RSC` container format (NE resource tables) | **Solved** |
| `RESOURCE.MAP` / `AUDIO.MAP` catalog parsing | **Solved** |
| Audio extraction (WAVE resources + BGMUSIC tracks) | **Solved** — raw RIFF/WAVE (8-bit mono 22 kHz), encoded to MP3 for the web: 185 MB → 61 MB, and browsers decode each one to exactly the original's samples |
| Video conversion (Smacker → MP4) | **Solved** — all 23 movies via ffmpeg (H.264 + AAC, plays in every browser incl. iOS Safari), tagged with their colour space (BT.601 matrix, limited range) so browsers don't guess. The engine draws each frame into the game canvas rather than laying a `<video>` over it: Chrome composited the overlay separately and could switch how it converted and scaled it mid-movie, a slight fade every couple of seconds |
| ASEQ image/animation pixel format | **Solved** — 3,129 of 3,138 resources, 20,945 frames |
| Colour palettes | **Solved** — all 3,129 image resources in real colour, from 47 captured scene palettes. The last six (CLOC07, CLOC09, CLOC13, PBA, PLOC3, PWS1) were read off screenshots of the running game rather than its memory: `extractor/palette_from_screenshot.py` |
| ASEQ sequence records (frame placement/timing) | **Solved** — frame order, per-frame offsets, sound cues; ~115 ms per tick |
| `FONT.RSC` (9 resources) | **Solved** — byte-swapped Mac NFNT bitmap fonts: Geneva 10/12/14, Chicago 12/14, Arial 12 (plain and bold), Dado 14, Jackie 16, exported as atlas + metrics to `output/fonts/` and drawn by the engine, labels on puzzle answers included. A strike is indexed by Mac OS Roman byte while script text arrives as Unicode, so the engine maps between them -- without it CWS1's ÷ vanished from "60 ÷ 6 = ?". The engine waits for the metrics before the first script runs: scripts size the boxes their text sits in by measuring it, so a font arriving mid-scene would cut some boxes to the game's own metrics and the rest to a web stand-in's |
| Game scripts (`cdrom/SCRIPTS/*.MPS`) | **Format solved, disassembled** — all 43 scripts; interpreter not started (see `extractor/MPS_FORMAT.md`) |
| Web app (Vite + TS + PixiJS) | **Game engine running** — STARTUP → sign-in → CBA1 (Cairo jeep puzzle) is playable: characters with fidgets and lip-synced speech, action queues, hotspots; the correct jeep leads on to CHUB. Item loop works: drag-and-drop puzzles — CWS1 coffee cups (value containers), CWS3 sentence sled (attribute containers, two-line answers), CWS4 export map (pixel-shaped containers, push-pin hot point, conveyor with OMMultiTrinket + MoveXAction), CWS2 fabric bolts (scissors cut fractions, palette-swapped colours) — workshop rewards, backpack, placing glyphs at the CHUB dealer. Movies play (intros, cutaways, MovieAction). The LapTrap works: menu, Cairo/Oasis maps (travel to visited places), settings, club bios, credits, quit, practice mode's Choose Activity list (GO to any activity) and the Progress and Levels page (level buttons coloured mastered/difficult, pick a level with the EXE's lose-your-work warning, auto-levelling boxes). All four Cairo workshops play (CWS2 fabric cutting: RFabricContainer). Oasis workshops: OWS1 column stacking (RStackingContainer), OWS2 sentence rows (RHorizontalContainer), OWS3 map paths (RMap, MapAction), OWS4 (RRandomAction) run. Mastery rooms: CMA pentomino board (RPentominoGame: snapping, rotate/flip tools, solve check) and OMA catapult (RTrigger pull lever, RAnimationTrigger, rock physics; statue hits knock crocs down) play. OHUB's gem doors play: each door's gem pattern (gems form a 4×4 colour × shape grid; one pattern shape per door) and its 12 missing slots follow the EXE's generator, and the Oasis workshops hand out exactly the missing gems; placing them from the backpack opens the door. Items are dealt as in the EXE: workshops where the player answers worse get more of the round's items (3/3/3/3 up to 6/2/2/2). The Pyramid and the ending play through: PLOC2 → PWS1 Riddles of the Sphinx (key into the answer slot, door opens) → every third riddle PLOC3 → PWS2 Chasm of Words (crossword of letter tiles) → PLOC2 with its cutscenes on visits 4/7/10, then the climax and epilogue movies and the Play Again / Quit dialog on visit 13. Auto-levelling follows the EXE: workshops move up or down one of 4 levels from their last answers (thresholds wsAutoLevelingA/B/X/Y, defaults 5/6/4/10, STARTUP overrides), base camps and mastery rooms step up per solve. A fresh-player playthrough (`?turbo=8`, 2026-09-15) plays from sign-in to the ending and back: CBA1, all five Cairo rounds, the CLOC01 statue, CMA, CBA2, all five Oasis doors, OMA, PBA, 12 riddles and 4 crosswords, then the Play Again dialog. Fixes it needed: `delete [, name` releases a whole array; an unset bare name passed to `send` is its own text (`PropertyAction "door", visible, kTrue`); storing into `result` sets RESULT (OWS4's gems); RAnimation `pause`; RText widths round and "Arial" is Arial (OWS2's word boxes fit their row); OWS2's unquoted `load_script OLOC08.mps`; value containers compare with a small tolerance (OWS1's 8.7-inch targets); `DisplayScreen` is a no-op; `CharacterAnimAction name, id, repeat, visibleAfter` puts the character back in its idle pose when the animation ends and hides it if `visibleAfter` is 0 (the EXE's +0xf8 flag, default 1) -- every walk-out passes 0, so the kids vanish as they reach CBA1's jeep, whose drive-out animation draws them driving away, and come back at their spots when the jeep returns from the garage (reading it as "hold the last frame" left them standing in mid-air as the jeep drove off, then brought them back still sitting where it had been); hidden characters don't fidget; a container sets the z of what it holds, outright, once it is placed -- its own z + 1 (RValueContainer and RAttributeContainer; rows step it by `deltaZ`; a fabric bolt adds its segment count), after the answer's own `dropped` handler -- and an answer going home gets back the z it was made with: that lifts CWS3's phrases onto the sled, puts CWS1's cups on the tray, tucks OWS4's word between its neighbours instead of in front of them, and layers PWS2's tiles box by box; `repeatCount -1` only makes an animation loop -- `play` or a `MoveXAction` naming it runs it, so CWS4's conveyor (and OWS4's logs) stay still until a package rides on or off, while CBA2's water, which its script plays for good, keeps going; CWS4's `RAttributeContainer imageID, z, attribute` choices are drawn -- each state or country in its own colour with its name -- and let clicks through to the background like the map beneath them; an `OMMultiTrinket`'s x/y is the top-left of all its members (they are its children in the EXE, whose rect is their union), `removeTrinkets tag` drops only that tag's members, and an `RAnimation x, y, id` is placed before its image loads -- together they keep OWS4's words on their stone blocks as the sentence rolls in and stop it at `kBoxX` rather than a sentence-width further left; the renderer rounds to whole pixels, as the original draws; coordinates, sizes and z handed to engine objects drop their fraction as the EXE's `atoi` does (scripts centre with `/2`, which is real division), so OWS4's slot is at 289 not 289.5 and its word lands level with its neighbours; setting a character's x/y puts its idle pose's stored position there, the inverse of reading it, which brings back OWS4's two mice (they were some 500px off the right edge); a container carries what it holds when it moves (RContainer::moveBy moves each answer by the same delta), so OWS4's slots bring the wrong word in with the sentence and take the answer out with it, and CWS3's phrase rides away on the sled; each line of a wrapped phrase (RDoubleGraphicTextAnswer) draws at its own depth -- the answer's z plus `graphic1OffsetZ` / `graphic2OffsetZ`, as the EXE's four children do -- so CWS3's first line, lifted 10 above its phrase, covers the filler stone beside it and the row below instead of letting their edges show through. CWS3's word boxes are cut from a ladder of box widths to fit the text the engine measures, so its sentence only lines up when the answers draw in the game's own font -- the two lines of a wrapped phrase are each centred on their own box, as a single box's text is. A wrapped phrase sits at the top-left of its two boxes together and is as big as both, following the EXE (`FINDINGS.md`), so it drops onto the sled keeping the shape it had in the paragraph. PWS2 recolours each crossword with `replacePaletteEntry`: its letter tiles, boxes and chalk alphabet are redrawn in the scheme for the number of crosswords finished. A sequence's sound cues play whoever shows it -- a character as much as a plain animation: Owen's fidget grunts and the coffee-shop waiter clinks the cups away (45 character animations across 31 scripts had lost their sound; only a line of speech is started by its own cue, so the mouth keeps up). Asset browser at `?browser` |

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
  extract_audio.py       WAVE resources -> .mp3 files (needs ffmpeg)
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

Requires Python 3 with Pillow and numpy; audio and video conversion also need ffmpeg.
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
localStorage; when a player signs in, the game asks the browser to keep them
(`navigator.storage.persist()`) rather than clear them when space runs short.
Chrome decides by itself (it tends to say yes to sites a player visits often
or bookmarks), Firefox asks the player once, and Safari may still clear them
after 7 days without a visit. On a phone or tablet, tapping New Player Sign-In (or
the new name's line) brings up the on-screen keyboard: an invisible text box
over the list takes the focus (`src/engine/TouchKeyboard.ts`) and what's typed
reaches the game as key presses, autocorrect and Backspace included; its Go key
signs in. Mouse players never see it. Movies play from `output/video` (a card stands in for any that
aren't converted); clicking a movie skips it.

`?browser` opens the asset browser (`src/browser/AssetBrowser.ts`): pick a
bundle, click an image to play its sequence lists, and play the bundle's
sounds. URLs like `?browser#cloc01o1/7050` open a resource directly; Space
pauses, → steps.

`app/public/assets` is a symlink to `../../output`, so re-running the
extractor updates the app with no copying. `npm run build` copies the assets
into `dist/` (~200 MB).

## Phones and tablets

- **Fits the screen:** the game is as big as fits both the width and the height;
  the Start button sits on the game window itself, and on screens under 600px
  tall the status line and engine log are hidden.
- **Full screen:** a phone held sideways is still short while the browser shows
  its address bar, so on touch screens **Start** also goes full screen and, on
  Android, locks the screen sideways (`offerFullScreen` in `src/main.ts`;
  browsers allow both only from a tap, and the lock only once full screen);
  iPads rotate by hand. On a computer, Start just starts. After leaving full screen, a small button in the
  screen's bottom-right corner (clear of the game, which has buttons in its own
  corners) goes back. iPhones can't put a page full screen, so they get a tip to
  Add to Home Screen instead. None of this shows once the game runs from the
  Home Screen.
- **Sound on iPhone/iPad:** Safari only starts sound from inside a tap, and the
  game starts most sounds from timers. Sounds and music play through one Web
  Audio context and movies through one shared `<video>` (`src/engine/Media.ts`),
  both unlocked by the Start tap (the video by playing `public/silence.mp4`). Sound
  ignores the ring/silent switch, as the movies do, and wakes again on the next
  tap after a call or the app going to the background. A sound that still can't
  play ends after its length, so queues never stall.
- **Touch:** one finger plays (a second touch can't steal a dragged piece); a touch
  the system cancels lets go where the finger last was; no text-selection callout,
  tap flash or double-tap zoom. Holding a finger on a sign-in name deletes that
  player (the keyboard's Ctrl-R), through the game's own confirmation. New Player
  Sign-In brings up the on-screen keyboard (`src/engine/TouchKeyboard.ts`).
- **Home screen:** `public/manifest.webmanifest`, icons made from the title logo,
  and iOS meta tags let "Add to Home Screen" open the game full screen and sideways.

## Deploying

The app builds to fully static files (`app/dist/`), so any static host works.
Production builds stamp every game file's URL with `?v=` and a hash of all the
game files (`app/vite.config.ts`), so `app/public/_headers` can tell Netlify to
let browsers cache everything under `/assets/` for a year: a returning player
downloads nothing again until the files change, and then the new hash fetches
fresh copies.
The extracted assets are The Learning Company's copyrighted game content: keep
a deployment private, or have the app extract assets from the player's own CD
files in the browser.
