# ASEQ Image Format — Findings

Status as of 2026-09-14: **pixel format solved.** 3,129 of 3,138 ASEQ image
resources across all 264 `.RSC` files decode completely (20,945 frames); the
9 failures are all `FONT.RSC`.
Implemented in `aseq.py`; `extract_images.py` renders RGBA sprite sheets.

**Still open:** palettes for the locations not reached in capture sessions
(see Palette), a few unknown sequence header words, and `FONT.RSC`.

This document supersedes the earlier notes that called the codec "delta
encoded" and planned a debugger watchpoint to find it. The debugger turned out
not to be needed: the format was recovered from the resource bytes directly.

## Resource layout

Every NE resource of type `0xff01` (except the RIFF/WAVE music tracks that
`BGMUSIC.RSC` stores under the same type):

```
7 x u16 header
    [0] number of sequence lists (1 for most; 10 in CLOC01/7028)
    [1] frame_count
    [2..6] not understood yet (commonly 8 or 12, 15, 1, 0, 0; or 0x0801, 0...)
(frame_count - 1) x u32   offsets of frames 1..n, RELATIVE TO FRAME 0
sequence data             tagged records, ending in the 4 bytes ff ff 00 00
frame 0 record            immediately after that terminator
frame 1..n records        at frame0 + offset[i]
```

Frame record:

```
2 bytes   tag: 04 00 (most) or 00 04 (52 resources whose header field [3] is 0)
u16       width
u16       height
height rows of RLE, each decoding to exactly `width` pixels:
    00 n         skip n pixels (transparent)
    ff c n       n copies of palette index c
    n <n bytes>  n literal palette indices (n = 1..254)
```

**Byte order.** 2,744 resources are little-endian. 385 are big-endian
(first byte is 0; e.g. header `00 01 00 08 08 01`): every u16/u32 in the
header, offset table, sequence data and width/height is byte-swapped, but the
RLE stream is byte-oriented and identical. Most likely a Mac/PC hybrid CD
build that kept some Mac-authored resources.

**Finding frame 0.** The first `ff ff 00 00` is not always the terminator —
sequence records can contain the same bytes (this caused every false decode
during research). `aseq.py` tries each occurrence and keeps the first where
every offset lands on a frame tag and every frame decodes exactly.

### Evidence

- `CCOMMON/1002` (23×24): rows hand-summed to exactly 23 pixels; renders as
  a clean icon.
- `CLOC01/7000` (640×480 background): consumes 181,456 of 181,746 bytes; the
  remainder is zero padding to the NE alignment unit.
- `CLOC01O1/7050`: all 9 offsets land exactly on `04 00` tags once measured
  from frame 0 — the earlier extractor treated them as absolute, which is why
  its `frame_001.raw` started mid-image and why some resources appeared to
  have 1,024 frames.
- Whole-game sweep: only `FONT.RSC` resources fail.

### Corrections to earlier notes

| Earlier claim | Actual |
|---|---|
| Per-frame data is delta/differential encoded | Plain row RLE; `00`/`01`/`ff` dominate because they are the opcodes |
| Header `marker` is always 1 | It counts sequence lists; values 1–26 occur |
| Offsets are absolute frame boundaries | Offsets are relative to frame 0 |
| All resources are little-endian | ~400 are big-endian |

## Sequence records

Decoded by `aseq.py::parse_sequences`; all 3,129 resources parse with exact
entry counts. Written to `<bundle>/<id>.json` by the extractor.

```
3 bytes (same order in both byte orders): x & 0xff, y & 0xff,
    high nibbles x >> 8 | (y >> 8) << 4  -- the origin
(together with the first 2 * list_count - 1 words, the rest isn't understood)
per list: u16 entry count, then entries of 4 words:
    s16 x, s16 y, s16 tag, u16 value
```

**Origin** is the image's screen position, used when a script passes
`kUseAOCoords` (11111) as the position (e.g. `RPButton kUseAOCoords,
kUseAOCoords, 30611`). Evidence: the sign-in arrows' art is baked into the
background at exactly (423, 213) and (423, 249) — the decoded origins — and
the medallion buttons decode onto the background's dark button holes. The
bytes are packed identically in big-endian resources: CBA1's big-endian speech
animations (e.g. Joni's 4031) land exactly on their little-endian idle poses
(4005 at (36, 305)) only when read byte-wise.

| tag | meaning |
|---|---|
| ≥ 0 | show frame `tag` with its top-left at (x, y); value is a per-frame id (consistent in 99.6% of uses) |
| −4 | list start |
| −2 | list end |
| −1 | list terminator (the last list's tag/value are the `ff ff 00 00` before frame 0) |
| −101 | resource reference, value = resource id — sounds for lip-sync (1,938 uses) |

- One entry plays per tick. Across 1,591 lists that start a sound, sound
  length ÷ frame entries gives a median of **~115 ms per tick** (p10–p90
  103–124 ms).
- (x, y) is each frame's top-left. Test: render consecutive frames and
  measure pixel agreement. In 270 sampled stationary lists (talk/idle),
  top-left placement matched best in 225, ahead of no offsets (35),
  bottom-left (9), centre (1) and flipped y (0). In moving lists (e.g.
  CLOC01O1/7050's dog walking right from x=−5 to x=243) "no offsets" overlaps
  more only because the character really translates; top-left still beats
  every other anchor.
- Multi-list resources (header field [0] > 1) hold several animations for one
  character, e.g. idle plus talking lists that reference their dialogue
  sounds.

## Palette

The RLE stores 8-bit palette indices; no palette is stored in any game file.
Ruled out:

- No 256-colour Windows palette (static colours at 0–9/246–255) in any game
  file, in RGB, BGR, RGBQUAD or PALETTEENTRY layout. The only hits are the
  16-colour icons in the EXE and `SMACKW32.DLL`.
- No 768-byte run of 6-bit VGA values outside image data.
- The 22 Smacker videos in `cdrom/RSC` hold 21 distinct palettes (one per video, shared only
  in the ~20 Windows system colours). None renders the CLOC01 background
  correctly, so scenes have their own palettes.
- Scripts reference `replacePaletteEntry` (CWS2/PWS2) and the EXE has an
  `AOPaletteRecord` class, so palettes are probably built or modified at
  runtime.

**Live capture** (`dynamic_analysis/palette_capture.py`) solved it. Reading
the running game's memory under Wine finds complete 256-colour palettes that
start with the Windows system colours (during the opening video, the one in
use matched `MVOP1.SMK`'s to a mean channel difference of 0.4). Matching them
against the background on screen captured 22 scene palettes in two play
sessions, each confirmed by eye in a rendered preview.

**Palette layout.** Slots 0–95, 99–104 and 246–255 (112 of 256) are
identical in every scene palette: the shared character and interface
colours. Scenes change only the other slots. Character animations and the
shared bundles (`common`, `ccommon`, `ocommon`, `laptrap`) draw almost
entirely from the shared range, so they render correctly without their own
scene's palette; `extract_images.py` uses this automatically.

Coverage: 2,054 resources with a captured scene palette, 325 using only the
shared range, 750 (24%) still placeholder — Oasis locations 2–9 and hub,
Cairo locations 7/9/13/14, `cba2`, `ows4`, `pws1`, `ploc2`/`ploc3`, `pba`.
Another capture session in those locations fills them in.

`extract_images.py --palettes <dir>` takes 768-byte RGB `.pal` files named by
bundle prefix (`cloc01.pal` covers `cloc01*.rsc`) and falls back to a
false-colour placeholder, recorded as `"palette": null` in the index.

## FONT.RSC

**Solved.** 9 resources, all typed `NFNT` in the file's own `0x800f`
directory: classic Mac `FontRec` bitmap fonts with every 16-bit field
byte-swapped for the Windows port. Two things settle the byte order — read
little-endian, `ascent + descent == fRectHeight` holds for all nine, and
`owTLoc` lands exactly on the offset/width table computed from the other
fields. Read big-endian the numbers are nonsense.

    0   26 bytes  header: fontType, firstChar, lastChar, widMax, kernMax,
                  nDescent, fRectWidth, fRectHeight, owTLoc, ascent, descent,
                  leading, rowWords
    26  ...       strike: 1 bit per pixel, rowWords*2 bytes per row,
                  fRectHeight rows, every glyph side by side
        ...       location table, lastChar-firstChar+3 words: glyph i spans
                  strike columns loc[i]..loc[i+1]
        ...       offset/width table, same length, starting at owTLoc

Two traps. The offset/width bytes are *also* swapped, so read little-endian the
low byte is the offset (added to `kernMax`) and the high byte the advance —
the other way round gives a 6-pixel `A` an advance of 2. And the final word of
the location table is not a location: in all nine fonts it only makes sense
read big-endian, where it lands just under the strike width, so only entries
0..nchars are used and the optional missing-character glyph is skipped.

Glyphs whose advance is narrower than their ink are correct, not a decoding
error: `_` must overlap so runs join up, and `f` leans into the next letter.

Which face each resource holds comes from the EXE's own registration calls at
`0x4116b0` — nine `register(name, style, points, resourceID)` calls into
`0x4103f3`. Every `points` matches that strike's ascent, and 30/31 differ only
in the style flag, which is what identifies it as bold:

| id | face | points | | id | face | points |
|---|---|---|---|---|---|---|
| 10 | Geneva | 10 bold | | 30 | Arial | 12 |
| 11 | Geneva | 12 | | 31 | Arial | 12 bold |
| 12 | Geneva | 14 | | 40 | Dado | 14 |
| 20 | Chicago | 12 | | 50 | Jackie | 16 |
| 21 | Chicago | 14 | | | | |

`nfnt.py` decodes them and `extract_fonts.py` writes `output/fonts/<id>.png`
(the strike as white-on-transparent RGBA) plus `index.json` with each glyph as
`[x, width, offset, advance]`. Note FONT.RSC resource ids collide with
COMMON.RSC ones (20 is both a font and the open backpack), so fonts are
addressed through their own index, never through the shared ASEQ id map.

## `OMASolved` is never set: a bug in the game's own scripts

`gPort.OMASolved` is read by the six Oasis location scripts (OLOC02..OLOC08) and
by the EXE's LapTrap, but **no script ever sets it to 1**. Every script resets it
to 0 in the shared `gGameCompleted` sub, and OMA's win path (`crocDownCtr = 4`,
OMA.txt:1149) calls `autoLevel` and walks the kids out without setting it --
where CMA's `eGameSolved` does set `CMASolved` (CMA.txt:1071), and PWS1/PWS2 both
set their own `PWS1Solved` / `PWS2Solved`. So the flag is dead in the original
too, and the port is faithful by doing nothing.

It costs almost nothing, which is presumably why it was never noticed:

- The locations read it as `if ((numOpenDoors=5)+(omaDone=kTrue))` -- an OR that
  picks which set of idle chatter the kids use. OMA is only reachable through
  `eExitForward`, which OHUB fires once `round = kMaxDoors`, so `numOpenDoors` is
  already 5 whenever OMA has been played and the first term is always true.
- The LapTrap uses it to decide whether changing an activity's level loses the
  player's work, so OMA always warns.

## Running the game under Wine (for palette capture)

From the earlier live sessions — still accurate:

- Don't set `WINEARCH=win32` on Wine 9+ (WoW64 builds reject it); a default
  prefix runs `4THADV32.EXE`.
- A black game window is a DirectDraw-under-Wine issue; try
  `wine reg add "HKCU\Software\Wine\Direct3D" /v DirectDrawRenderer /d gdi /f`
  or `UseDirectDraw=0` in `4THADV.INI`.
- Under `winedbg --gdb`, run `handle SIGSEGV nostop noprint pass` first (Wine
  uses SIGSEGV internally).
- `break *0x464064` fires on every resource lookup; the resource ID is in
  `$eax & 0xffff` at entry. Put multi-line `commands` blocks in a file and
  `source` it.
- A global `break ReadFile` is too noisy; typed comparisons on synthesized
  argument variables fail in the winedbg gdb proxy (register expressions work).

## Historical dead ends

- `BI_RLE8` decoding (tested; the format is not BI_RLE8).
- Static analysis of the generic `Resource` class (vtable `0x4dd258`, load
  method `FUN_00463eb2`, factories `FUN_00473b3c`/`FUN_00456ab0`): loading is
  type-agnostic, so it never led to the decoder.
