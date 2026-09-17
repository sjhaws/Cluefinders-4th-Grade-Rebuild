"""
nfnt.py

Decodes the bitmap fonts in FONT.RSC.

They are classic Mac `FontRec` (NFNT) records with every 16-bit field
byte-swapped for the Windows port. Two things prove the byte order: read as
little-endian, `ascent + descent == fRectHeight` holds for all nine fonts, and
`owTLoc` lands exactly on the offset/width table computed from the other
fields. Read as big-endian the numbers are nonsense.

Layout:

    0   26 bytes   header (13 words, see FIELDS)
    26  ...        strike: a 1-bit-per-pixel image, rowWords*2 bytes per row,
                   fRectHeight rows, holding every glyph side by side
        ...        location table, lastChar-firstChar+3 words: glyph i spans
                   strike columns loc[i] .. loc[i+1]-1, so its width is the
                   difference between neighbours
        ...        offset/width table, the same length: one byte is how far
                   right of the pen to draw (on top of kernMax), the other is
                   how far the pen then advances. 0xFFFF means the character is
                   not in this font. Mac order is offset then width, but the
                   byte swap exchanges them, so read little-endian the LOW byte
                   is the offset and the HIGH byte the advance -- the other way
                   round gives a 6-pixel 'A' an advance of 2.

Both tables hold lastChar-firstChar+3 words and run back to back, the location
table ending exactly where owTLoc points. Only the first lastChar-firstChar+2
locations are real, though: glyph i spans locs[i]..locs[i+1], so the characters
need entries 0..nchars. The very last word is not a location -- in every one of
the nine fonts it only makes sense read the other way round (big-endian), where
it lands just under the strike width -- so it is left alone, and the optional
missing-character glyph with it.
"""
import struct
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np

HEADER_LEN = 26
FIELDS = ("fontType", "firstChar", "lastChar", "widMax", "kernMax", "nDescent",
          "fRectWidth", "fRectHeight", "owTLoc", "ascent", "descent", "leading", "rowWords")
MISSING = 0xFFFF


class NfntFormatError(ValueError):
    pass


@dataclass
class Glyph:
    code: int            # character code, or -1 for the missing-character glyph
    x: int               # the glyph's column in the strike, from the location table
    bitmap: np.ndarray   # (height, width) bool, taken from the strike
    offset: int          # pixels right of the pen before drawing
    advance: int         # pixels the pen moves after drawing

    @property
    def width(self) -> int:
        return self.bitmap.shape[1]


@dataclass
class NfntFont:
    fontType: int
    firstChar: int
    lastChar: int
    widMax: int
    kernMax: int
    nDescent: int
    fRectWidth: int
    fRectHeight: int
    owTLoc: int
    ascent: int
    descent: int
    leading: int
    rowWords: int
    strike: np.ndarray            # (fRectHeight, rowWords*16) bool
    glyphs: Dict[int, Glyph]
    missing: Optional[Glyph]

    @property
    def height(self) -> int:
        return self.fRectHeight

    @property
    def line_height(self) -> int:
        return self.ascent + self.descent + self.leading

    def text_width(self, text: str) -> int:
        """Pen advance for a string, the way the original measures it."""
        total = 0
        for ch in text:
            glyph = self.glyphs.get(ord(ch), self.missing)
            if glyph is not None:
                total += glyph.advance
        return total


def looks_like_nfnt(raw: bytes) -> bool:
    if len(raw) < HEADER_LEN:
        return False
    values = dict(zip(FIELDS, struct.unpack_from("<13h", raw, 0)))
    return (values["ascent"] + values["descent"] == values["fRectHeight"]
            and values["fRectHeight"] > 0 and values["rowWords"] > 0
            and 0 <= values["firstChar"] <= values["lastChar"] <= 255)


def decode_nfnt(raw: bytes) -> NfntFont:
    if len(raw) < HEADER_LEN:
        raise NfntFormatError(f"too short: {len(raw)} bytes")
    values = dict(zip(FIELDS, struct.unpack_from("<13h", raw, 0)))
    if values["ascent"] + values["descent"] != values["fRectHeight"]:
        raise NfntFormatError("ascent + descent != fRectHeight; not a byte-swapped FontRec")

    height, row_words = values["fRectHeight"], values["rowWords"]
    row_bytes = row_words * 2
    strike_end = HEADER_LEN + row_bytes * height
    if strike_end > len(raw):
        raise NfntFormatError(f"strike runs past the resource ({strike_end} > {len(raw)})")
    bits = np.unpackbits(
        np.frombuffer(raw[HEADER_LEN:strike_end], np.uint8).reshape(height, row_bytes), axis=1)
    strike = bits.astype(bool)

    count = values["lastChar"] - values["firstChar"] + 3   # chars + missing glyph + terminator
    loc_end = strike_end + count * 2
    ow_start = HEADER_LEN - 10 + values["owTLoc"] * 2      # owTLoc counts words from its own field
    if loc_end > len(raw) or ow_start + count * 2 > len(raw):
        raise NfntFormatError("location or offset/width table runs past the resource")
    locs: List[int] = list(struct.unpack_from(f"<{count}H", raw, strike_end))
    ows: List[int] = list(struct.unpack_from(f"<{count}H", raw, ow_start))

    nchars = values["lastChar"] - values["firstChar"] + 1
    glyphs: Dict[int, Glyph] = {}
    for i in range(nchars):
        ow = ows[i]
        if ow == MISSING:                                  # character absent from this font
            continue
        left, right = locs[i], locs[i + 1]
        if right < left or right > strike.shape[1]:
            raise NfntFormatError(f"glyph {i} spans {left}..{right}, outside the strike")
        glyphs[values["firstChar"] + i] = Glyph(
            code=values["firstChar"] + i,
            x=left,
            bitmap=strike[:, left:right],
            offset=(ow & 0xFF) + values["kernMax"],
            advance=ow >> 8)
    return NfntFont(strike=strike, glyphs=glyphs, missing=None, **values)


def ascii_art(glyph: Glyph, on: str = "#", off: str = ".") -> str:
    return "\n".join("".join(on if v else off for v in row) for row in glyph.bitmap)


if __name__ == "__main__":
    import sys
    from ne_resource import NEResourceFile, TYPE_ASEQ

    path = sys.argv[1] if len(sys.argv) > 1 else (
        "/home/steven/Documents/Windows Transfer/ClueFinders4thGrade/cdrom/RSC/FONT.RSC")
    wanted = [int(a) for a in sys.argv[2:]] or None
    rf = NEResourceFile(path)
    for entry in rf.entries_of_type(TYPE_ASEQ):
        if wanted and entry.numeric_id not in wanted:
            continue
        raw = rf.bytes_for(entry)
        try:
            font = decode_nfnt(raw)
        except NfntFormatError as e:
            print(f"font {entry.numeric_id}: {e}")
            continue
        print(f"\n=== font {entry.numeric_id}: {len(font.glyphs)} glyphs, "
              f"{font.fRectHeight}px box, ascent {font.ascent}, descent {font.descent}, "
              f"widMax {font.widMax}, kernMax {font.kernMax} ===")
        for ch in "AaBg1":
            glyph = font.glyphs.get(ord(ch))
            if glyph is None:
                continue
            print(f"'{ch}' width {glyph.width} offset {glyph.offset} advance {glyph.advance}")
            print(ascii_art(glyph))
