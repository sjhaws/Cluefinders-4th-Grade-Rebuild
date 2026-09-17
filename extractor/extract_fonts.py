"""
extract_fonts.py

Turns the bitmap fonts in FONT.RSC into a PNG atlas and metrics per font.

An NFNT already stores all its glyphs side by side in one strike image, so the
atlas is that strike, converted to white-on-transparent RGBA; each glyph is a
rectangle in it. See nfnt.py for the format.

Usage:
    python3 extract_fonts.py <rsc_dir> <output_dir>

Output, under <output_dir>/fonts/:
    <id>.png      the strike, fRectHeight tall, white glyphs on transparent
    index.json    per font: metrics and every glyph's rectangle, where
                  glyph = [x, width, offset, advance]; x indexes the atlas,
                  offset is how far right of the pen to draw it, advance how
                  far the pen then moves. Draw at y = baseline - ascent.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image

from ne_resource import NEResourceFile, TYPE_ASEQ
from nfnt import NfntFormatError, decode_nfnt, looks_like_nfnt

# Which face each resource holds, from the EXE's own registration calls at
# 0x4116b0: nine `push size; push points; push style; push name; call 0x4103f3`
# sequences, i.e. register(name, style, points, resourceID). Every `points`
# matches that strike's ascent, and resources 30 and 31 differ only in the
# style flag -- same name, same size -- which is what marks it as bold.
# Scripts ask for a face by name and point size, so both are exported.
FONTS = {
    10: ("Geneva", 10, True),
    11: ("Geneva", 12, False),
    12: ("Geneva", 14, False),
    20: ("Chicago", 12, False),
    21: ("Chicago", 14, False),
    30: ("Arial", 12, False),
    31: ("Arial", 12, True),
    40: ("Dado", 14, False),
    50: ("Jackie", 16, False),
}


def atlas_image(font) -> Image.Image:
    """The strike as white-on-transparent RGBA."""
    height, width = font.strike.shape
    rgba = np.zeros((height, width, 4), np.uint8)
    rgba[..., :3] = 255
    rgba[..., 3] = np.where(font.strike, 255, 0)
    return Image.fromarray(rgba, "RGBA")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    ap.add_argument("rsc_dir", type=Path)
    ap.add_argument("output_dir", type=Path)
    args = ap.parse_args()

    path = next((p for p in args.rsc_dir.iterdir() if p.name.upper() == "FONT.RSC"), None)
    if path is None:
        raise SystemExit(f"no FONT.RSC in {args.rsc_dir}")
    out = args.output_dir / "fonts"
    out.mkdir(parents=True, exist_ok=True)

    rf = NEResourceFile(str(path))
    fonts = {}
    for entry in sorted(rf.entries_of_type(TYPE_ASEQ), key=lambda e: e.numeric_id):
        raw = rf.bytes_for(entry)
        if not looks_like_nfnt(raw):
            print(f"  skip {entry.numeric_id}: not an NFNT")
            continue
        try:
            font = decode_nfnt(raw)
        except NfntFormatError as e:
            print(f"  {entry.numeric_id}: {e}")
            continue
        fid = entry.numeric_id
        atlas_image(font).save(out / f"{fid}.png")
        # Glyph columns come straight from the location table, so the atlas is
        # the strike as it stands and needs no packing.
        glyphs = {code: [glyph.x, glyph.width, glyph.offset, glyph.advance]
                  for code, glyph in sorted(font.glyphs.items())}
        family, points, bold = FONTS.get(fid, (f"font{fid}", font.ascent, False))
        fonts[fid] = {
            "id": fid,
            "family": family,
            "points": points,
            "bold": bold,
            "ascent": font.ascent,
            "descent": font.descent,
            "leading": font.leading,
            "lineHeight": font.line_height,
            "height": font.fRectHeight,
            "maxWidth": font.widMax,
            "kernMax": font.kernMax,
            "atlas": f"fonts/{fid}.png",
            "atlasWidth": int(font.strike.shape[1]),
            "glyphs": glyphs,
        }
        print(f"  font {fid:3d} {family:8s} {points:2d}pt{' bold' if bold else '     '} "
              f"{len(glyphs):3d} glyphs, {font.fRectHeight}px, ascent {font.ascent}, "
              f"atlas {font.strike.shape[1]}x{font.strike.shape[0]}")

    index = args.output_dir / "fonts" / "index.json"
    index.write_text(json.dumps(fonts, separators=(",", ":"), sort_keys=True))
    print(f"\n{len(fonts)} fonts -> {index}")


if __name__ == "__main__":
    main()
