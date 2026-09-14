"""
ne_resource.py

Parser for the Windows 16-bit "NE" (New Executable) resource container
format, as reused by ClueFinders 4th Grade Adventures (1998) for its
.RSC asset bundles.

This format is fully understood and documented here from first-hand
analysis of the game's actual files (see FINDINGS.md for the full
research trail, including the parts that are NOT yet solved).

Container layout:
    DOS header -> e_lfanew-equivalent at offset 0x3C points to 'NE' header
    NE header @ ne_off:
        +0x24 (u16): offset to resource table, relative to ne_off
    Resource table:
        u16 alignment_shift          (data offsets/lengths are in units of 1<<shift)
        repeated TYPEINFO records until a u16 `0` terminator:
            u16 type_id               (high bit set = numeric type ID)
            u16 resource_count
            u32 reserved
            repeated NAMEINFO records (resource_count of them):
                u16 rn_offset          (* unit = absolute byte offset)
                u16 rn_length          (* unit = byte length)
                u16 rn_flags
                u16 rn_id              (high bit set = numeric resource ID)
                u32 reserved

Known type IDs in this game's .RSC files (reverse-engineered, confirmed
against RESOURCE.MAP / AUDIO.MAP naming and cross-checked against the
game's own resource-table-reading code via Ghidra decompilation):
    0x800f  "ASEQ directory" - resource name/type registration entries
    0xff01  ASEQ  - animation/image resource, decoded by aseq.py (BGMUSIC.RSC
                     also stores its RIFF/WAVE music tracks under this type)
    0xff02  WAVE  - audio, raw RIFF/WAVE bytes, trivial to extract
    0xff03  WAVE  - audio variant, also raw RIFF/WAVE bytes
"""
import struct
from dataclasses import dataclass
from typing import List


@dataclass
class NEResourceEntry:
    type_id: int
    resource_id: int
    offset: int
    length: int
    flags: int

    @property
    def is_numeric_type(self) -> bool:
        return bool(self.type_id & 0x8000)

    @property
    def is_numeric_id(self) -> bool:
        return bool(self.resource_id & 0x8000)

    @property
    def numeric_id(self) -> int:
        return self.resource_id & 0x7FFF


class NEResourceFile:
    """Parses one .RSC file's NE resource table and gives access to raw
    resource bytes by type/id."""

    def __init__(self, path: str):
        self.path = path
        with open(path, "rb") as f:
            self.data = f.read()
        self._parse()

    def _parse(self):
        data = self.data
        ne_off = struct.unpack_from("<H", data, 0x3C)[0]
        if data[ne_off:ne_off + 2] != b"NE":
            raise ValueError(f"{self.path}: not an NE-format file")
        self.ne_off = ne_off

        rsrc_tab_off = struct.unpack_from("<H", data, ne_off + 0x24)[0]
        pos = ne_off + rsrc_tab_off

        self.align_shift = struct.unpack_from("<H", data, pos)[0]
        pos += 2
        unit = 1 << self.align_shift

        entries: List[NEResourceEntry] = []
        while True:
            type_id = struct.unpack_from("<H", data, pos)[0]
            pos += 2
            if type_id == 0:
                break
            count = struct.unpack_from("<H", data, pos)[0]
            pos += 2
            pos += 4  # reserved
            for _ in range(count):
                rn_off, rn_len, rn_flags, rn_id = struct.unpack_from("<HHHH", data, pos)
                pos += 12  # includes trailing 4-byte reserved field
                entries.append(NEResourceEntry(
                    type_id=type_id,
                    resource_id=rn_id,
                    offset=rn_off * unit,
                    length=rn_len * unit,
                    flags=rn_flags,
                ))
        self.entries = entries

    def entries_of_type(self, type_id: int) -> List[NEResourceEntry]:
        return [e for e in self.entries if e.type_id == type_id]

    def bytes_for(self, entry: NEResourceEntry) -> bytes:
        return self.data[entry.offset:entry.offset + entry.length]


# ---- Known type IDs -------------------------------------------------------
TYPE_ASEQ_DIRECTORY = 0x800F
TYPE_ASEQ = 0xFF01
TYPE_WAVE_A = 0xFF02
TYPE_WAVE_B = 0xFF03
WAVE_TYPES = (TYPE_WAVE_A, TYPE_WAVE_B)
