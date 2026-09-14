# Capturing scene palettes from the running game

The ASEQ images store 8-bit palette indices, but no game file holds the
palettes they're drawn with (see `extractor/FINDINGS.md`). This folder
captures them live: you play the game under Wine while `palette_capture.py`
reads its memory.

## How it works

Every few seconds the script:

1. finds which scene backgrounds are decoded into a drawing surface — rows of
   a known background with the next row exactly one width later,
2. collects every 256-colour palette in memory that starts with the Windows
   system colours, and
3. scores each palette against each background on screen
   (`palette_score.py`: the right palette makes neighbouring pixels similar),
   keeping the best fit per background.

Linux only lets a process read the memory of processes it started
(`kernel.yama.ptrace_scope=1`), so the script launches the game itself —
attaching to an already-running game won't work.

## Requirements

- Wine (tested with 10.0, default prefix — do **not** set `WINEARCH=win32`)
- Python 3 with numpy and Pillow
- A desktop session, since you'll be playing

## Capture session

```bash
cd dynamic_analysis
python3 palette_capture.py "/path/to/ClueFinders4thGrade" captures
```

The game starts; play normally and walk through as many locations as you
can. Output looks like:

```
[ 125.0s] 3 palettes, on screen: ['cloc01/7000/0'], elsewhere in memory: - (2.1s scan)
  cloc01/7000/0: palette 5e96f52d36aa score 0.214 (runner-up 1.02)
```

Quit the game (or press Ctrl+C in the terminal, which also shuts Wine down)
when you're done. Sessions accumulate in `captures/best.json`, so you can
play in several sittings.

Check `captures/previews/` — each background rendered in its captured
palette. A correct capture looks like normal artwork; a wrong one looks
posterised or psychedelic.

## Finalize and re-extract

```bash
python3 palette_capture.py "/path/to/ClueFinders4thGrade" captures --finalize
cd ../extractor
python3 extract_images.py "/path/to/ClueFinders4thGrade/cdrom/RSC" ../output/images \
    --palettes ../dynamic_analysis/captures/palettes
```

`--finalize` writes `captures/palettes/<bundle>.pal` for every scene whose
best fit scores under `--max-score` (default 1.0), flags fits above 0.6 with
"check preview", and lists scenes not captured yet. From the first live
session: palettes confirmed correct by their previews scored 0.23–0.90 —
busy, patterned scenes (fabric shelves, dithered interiors) score higher —
while wrong palettes scored as low as ~0.8. The score ranks candidates well
but can't replace looking at the flagged previews.

## Troubleshooting

- **Black game window:** set
  `wine reg add "HKCU\Software\Wine\Direct3D" /v DirectDrawRenderer /d gdi /f`
  (already set on the original machine), or `UseDirectDraw=0` in `4THADV.INI`.
- **"No sound driver" dialog:** press Enter.
- **Nothing ever shows as "on screen":** run `touch captures/dump` while a
  scene is visible; the next scan saves the game's writable memory and
  palettes to `captures/dump_<seconds>/` for offline inspection.
- **Scenes that can't be detected:** 5 LapTrap minigame backgrounds and
  `oma/16023` are too flat to fingerprint. Their bundles can reuse a sibling
  scene's palette.

## Verified so far

- Launching via `wine 4THADV32.EXE` keeps the game in the script's own
  process, and its memory is readable (~660 MB scanned in ~4 s).
- During the opening video, the palette found in memory matches
  `MVOP1.SMK`'s palette (mean channel difference 0.4).
- Surface detection passes synthetic tests at every byte alignment, top-down
  and bottom-up, and works live: two sessions (~20 minutes of play) captured
  22 scene palettes, every preview checked by eye.
- The game crashed once after ~9 minutes under Wine. Captures are saved every
  scan, so a crash loses nothing — relaunch and carry on.

## Older notes

`sandbox_attempt.gdb` filters the resource-lookup breakpoint (`0x464064`,
resource ID in `$eax & 0xffff`) from the earlier codec hunt; see the Wine
section of `extractor/FINDINGS.md`.
