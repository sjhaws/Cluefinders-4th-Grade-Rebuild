"""
aseq.py

Decoder for ASEQ (NE resource type 0xff01) animation/image resources.
Solved from the raw resource bytes -- see FINDINGS.md for the evidence.

Resource layout (all u16/u32 fields use the resource's own byte order):

    7 x u16 header
        [0] number of sequence lists (1 for most resources)
        [1] frame_count
        [2..6] not yet understood (commonly 8/12, 15, 1, 0, 0)
    (frame_count - 1) x u32   offsets of frames 1..n, relative to frame 0
    sequence data             animation scripts, ending in ff ff 00 00 and
                              immediately followed by frame 0 (see below)
    frame records             tag (bytes 04 00 or 00 04), u16 width, u16 height,
                              then `height` rows of RLE

Byte order: most resources are little-endian; ~400 are big-endian (their
first byte is 0). The RLE stream itself is byte-oriented and identical.

Row RLE (each row decodes to exactly `width` pixels):
    00 n         skip n pixels (transparent)
    ff c n       n copies of palette index c
    n <n bytes>  n literal palette indices (n = 1..254)

Sequence data (s16 words, resource byte order):
    3 bytes, packed the same way in both byte orders: x & 0xff, y & 0xff,
        high nibbles (x >> 8 | (y >> 8) << 4) -- the "origin"
    the rest of the first word pair and (2 * list_count - 1) words total
        aren't understood
    The origin is where the image sits on screen when a script passes
    kUseAOCoords (11111) for its position.
    per list: u16 entry count, then that many 4-word entries
        (s16 x, s16 y, s16 tag, u16 value)
    tag >= 0     show frame `tag` with its top-left at (x, y); value is a
                 per-frame id
    tag == -4    list start       tag == -2  list end
    tag == -1    list terminator (the last one's tag/value are the ff ff 00 00)
    tag == -101  resource reference, value = resource id (sounds for lip-sync)
Entries play one per tick; lip-synced lists put a tick at ~115 ms.

The frame-0 position is found by trying each 0xffff 0x0000 terminator in the
sequence data and keeping the first one where every frame offset lands on a
frame tag and every frame decodes exactly -- sequence records can contain the
same byte pattern, so the first match is not always the right one.
"""
import struct
from dataclasses import dataclass
from typing import List, Optional

import numpy as np

HEADER_LEN = 14
SEQUENCE_END = b'\xff\xff\x00\x00'
FRAME_TAGS = (b'\x04\x00', b'\x00\x04')
MAX_DIMENSION = 4096

SEQ_LIST_START = -4
SEQ_LIST_END = -2
SEQ_TERMINATOR = -1
SEQ_RESOURCE = -101


class AseqFormatError(ValueError):
    pass


@dataclass
class AseqFrame:
    width: int
    height: int
    indices: np.ndarray  # (height, width) uint8 palette indices
    opaque: np.ndarray   # (height, width) bool, False where the RLE skipped

    def to_rgba(self, palette: np.ndarray) -> np.ndarray:
        """palette: (256, 3) uint8 -> (height, width, 4) uint8."""
        rgba = np.empty((self.height, self.width, 4), np.uint8)
        rgba[..., :3] = palette[self.indices]
        rgba[..., 3] = np.where(self.opaque, 255, 0)
        return rgba


@dataclass
class AseqSequences:
    unknown_word: int                # origin low bytes
    table: List[int]                 # 2 * list_count - 1 words; table[0] low byte = origin high nibbles
    lists: List[List[tuple]]         # entries: (x, y, tag, value)
    origin: tuple = (0, 0)           # screen position used with kUseAOCoords


@dataclass
class AseqResource:
    big_endian: bool
    header_fields: tuple
    frames: List[AseqFrame]
    sequence_data: bytes                   # raw sequence bytes
    sequences: Optional[AseqSequences]     # None if they failed to parse

    @property
    def frame_count(self) -> int:
        return len(self.frames)


def is_aseq_image(raw: bytes) -> bool:
    """False for the RIFF/WAVE payloads that BGMUSIC.RSC stores under 0xff01."""
    return len(raw) >= HEADER_LEN and not raw.startswith(b'RIFF')


def decode_rle(buf: bytes, pos: int, width: int, height: int):
    """Decode `height` RLE rows starting at `pos`. Returns (indices, opaque, end)."""
    pixels = bytearray(width * height)
    mask = bytearray(width * height)
    try:
        for y in range(height):
            row = y * width
            x = 0
            while x < width:
                op = buf[pos]
                if op == 0x00:
                    x += buf[pos + 1]
                    pos += 2
                    continue
                if op == 0xFF:
                    n = buf[pos + 2]
                    pixels[row + x:row + x + n] = bytes((buf[pos + 1],)) * n
                    pos += 3
                else:
                    n = op
                    pixels[row + x:row + x + n] = buf[pos + 1:pos + 1 + n]
                    pos += 1 + n
                mask[row + x:row + x + n] = b'\x01' * n
                x += n
            if x != width:
                raise AseqFormatError(f'row {y} decoded to {x} pixels, expected {width}')
    except IndexError:
        raise AseqFormatError('RLE data runs past end of resource') from None
    if len(pixels) != width * height:
        raise AseqFormatError('RLE row overran frame width')
    indices = np.frombuffer(bytes(pixels), np.uint8).reshape(height, width)
    opaque = np.frombuffer(bytes(mask), np.uint8).reshape(height, width).astype(bool)
    return indices, opaque, pos


def decode_frame(raw: bytes, pos: int, endian: str) -> AseqFrame:
    if raw[pos:pos + 2] not in FRAME_TAGS:
        raise AseqFormatError(f'no frame tag at {pos}')
    width, height = struct.unpack_from(endian + 'HH', raw, pos + 2)
    if not (0 < width <= MAX_DIMENSION and 0 < height <= MAX_DIMENSION):
        raise AseqFormatError(f'implausible frame size {width}x{height} at {pos}')
    indices, opaque, _ = decode_rle(raw, pos + 6, width, height)
    return AseqFrame(width, height, indices, opaque)


def parse_sequences(seq: bytes, list_count: int, endian: str) -> AseqSequences:
    words = struct.unpack(f"{endian}{len(seq) // 2}h", seq[:len(seq) // 2 * 2])
    table_len = 2 * list_count - 1
    pos = 1 + table_len
    lists = []
    for li in range(list_count):
        if pos >= len(words):
            raise AseqFormatError(f"sequence list {li} missing")
        count = words[pos] & 0xFFFF
        pos += 1
        entries = []
        while True:
            if pos + 2 > len(words):
                raise AseqFormatError(f"sequence list {li} runs past the end")
            x, y = words[pos], words[pos + 1]
            if pos + 4 > len(words):
                # the final terminator's tag and value are the ff ff 00 00 that
                # ends the sequence data
                entries.append((x, y, SEQ_TERMINATOR, 0))
                pos += 2
                break
            tag, value = words[pos + 2], words[pos + 3] & 0xFFFF
            entries.append((x, y, tag, value))
            pos += 4
            if tag == SEQ_TERMINATOR:
                break
        if len(entries) != count:
            raise AseqFormatError(f"sequence list {li} has {len(entries)} entries, header says {count}")
        lists.append(entries)
    if pos != len(words):
        raise AseqFormatError(f"{len(words) - pos} words of sequence data left over")
    table = [w & 0xFFFF for w in words[1:1 + table_len]]
    # byte-packed, so the same bytes in both byte orders: x low, y low, high nibbles
    origin = (seq[0] | (seq[2] & 0x0F) << 8, seq[1] | (seq[2] >> 4) << 8) if len(seq) >= 3 else (0, 0)
    return AseqSequences(words[0] & 0xFFFF, table, lists, origin)


def decode_aseq(raw: bytes) -> AseqResource:
    if not is_aseq_image(raw):
        raise AseqFormatError('not an ASEQ image resource')
    big_endian = raw[0] == 0 and raw[1] != 0
    endian = '>' if big_endian else '<'
    header = struct.unpack_from(endian + '7H', raw, 0)
    frame_count = header[1]
    if frame_count < 1:
        raise AseqFormatError('frame_count is 0')
    table_end = HEADER_LEN + 4 * (frame_count - 1)
    if table_end > len(raw):
        raise AseqFormatError('frame offset table runs past end of resource')
    offsets = [0] + list(struct.unpack_from(f'{endian}{frame_count - 1}I', raw, HEADER_LEN))

    search = table_end
    while True:
        end = raw.find(SEQUENCE_END, search)
        if end < 0:
            raise AseqFormatError('no frame base satisfies the offset table')
        base = end + len(SEQUENCE_END)
        search = end + 1
        if any(raw[base + o:base + o + 2] not in FRAME_TAGS for o in offsets):
            continue
        try:
            frames = [decode_frame(raw, base + o, endian) for o in offsets]
        except AseqFormatError:
            continue
        seq = raw[table_end:end]
        try:
            sequences = parse_sequences(seq, header[0], endian)
        except AseqFormatError:
            sequences = None
        return AseqResource(big_endian, header, frames, seq, sequences)
