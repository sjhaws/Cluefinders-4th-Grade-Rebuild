"""
mps.py

Parser for the game's compiled scripts (cdrom/SCRIPTS/*.MPS). All integers
are big-endian. See MPS_FORMAT.md for the evidence behind each piece.

    u8          format version (1)
    u32         record count R
    R x (u8 opcode, u16 operand)
    u32         word count W
    W x u16     operand lists: constant indices, each list ended by 0xffff
    u32         constant count C, including BUILTIN_COUNT implicit constants
    (C - BUILTIN_COUNT) x serialized constants

An operand is, depending on the opcode, the word index of an operand list, a
record index to jump to, or unused.
"""
import struct
from dataclasses import dataclass, field
from typing import Dict, List, Optional

BUILTIN_COUNT = 3
BUILTIN_NAMES = ["$0", "$1", "$result"]  # $result: value of the last call; $0/$1 not yet understood

LIST, JUMP, NONE, RAW = "list", "jump", "none", "raw"

# opcode -> (mnemonic, operand kind). Mnemonics are working names inferred from usage.
OPCODES = {
    0x06: ("call", LIST),           # label constant or variable holding a label, arguments
    0x07: ("sub", LIST),            # label constant (value = its own record index), parameter names
    0x08: ("loop", LIST),           # var, start, end  |  condition
    0x09: ("loop_test", LIST),      # same list as the matching loop
    0x0A: ("jump_if_false", JUMP),
    0x0B: ("jump", JUMP),
    0x0C: ("if", LIST),             # condition
    0x0D: ("end", NONE),
    0x0F: ("return", NONE),
    0x12: ("set", LIST),            # var, value  |  var, Class, constructor args
    0x13: ("delete", LIST),
    0x15: ("call_global", LIST),    # function, args; result in $result
    0x23: ("set_prop", LIST),       # object, property, [key,] value
    0x24: ("get_prop", LIST),       # object, property, [key,] destination
    0x25: ("start", RAW),
    0x28: ("send", LIST),           # object, method, args
    0x2D: ("load_script", LIST),
    0x2E: ("exit", NONE),
}

NULL = 0xFFFFFFFF


class MpsFormatError(ValueError):
    pass


@dataclass
class Constant:
    index: int                      # numbering used by operand lists and refs
    kind: int                       # 0 name, 1 literal, 2 member access, 3 call form, 4 expression
    type: int                       # 0 none, 2 string, 3 integer, 4 float
    text: str                       # source text
    value: object = None            # int for integers/labels, str for floats
    extra: Optional[str] = None     # value text of a named constant, or compiled expression
    refs: List[int] = field(default_factory=list)


@dataclass
class Record:
    index: int
    opcode: int
    operand: int
    mnemonic: str
    args: List[int] = field(default_factory=list)   # constant indices (LIST opcodes)
    target: Optional[int] = None                    # record index (JUMP opcodes)


@dataclass
class Script:
    records: List[Record]
    constants: Dict[int, Constant]
    lists: Dict[int, List[int]]

    def text_of(self, index: int) -> str:
        if index < BUILTIN_COUNT:
            return BUILTIN_NAMES[index]
        return self.constants[index].text


class _Reader:
    def __init__(self, data: bytes, pos: int = 0):
        self.data, self.pos = data, pos

    def u8(self):
        return self._unpack(">B", 1)

    def u16(self):
        return self._unpack(">H", 2)

    def u32(self):
        return self._unpack(">I", 4)

    def _unpack(self, fmt, size):
        if self.pos + size > len(self.data):
            raise MpsFormatError(f"read past end at {self.pos}")
        value = struct.unpack_from(fmt, self.data, self.pos)[0]
        self.pos += size
        return value

    def string(self) -> Optional[str]:
        n = self.u32()
        if n == NULL:
            return None
        if n > 65536 or self.pos + n > len(self.data):
            raise MpsFormatError(f"bad string length {n} at {self.pos - 4}")
        s = self.data[self.pos:self.pos + n].decode("latin-1")
        self.pos += n
        return s


def _parse_constant(r: _Reader, index: int) -> Constant:
    kind, typ = r.u32(), r.u32()
    if typ in (0, 2):
        union = [r.u32(), r.u32(), r.u32()]
        value = None
    elif typ == 3:
        union = [r.u32(), r.u32(), r.u32(), r.u32()]
        value = struct.unpack(">i", struct.pack(">I", union[0]))[0]
    elif typ == 4:
        n = r.u16()
        value = r.data[r.pos:r.pos + n].decode("latin-1")
        r.pos += n
        union = [r.u32(), r.u32(), r.u32()]
    else:
        raise MpsFormatError(f"constant {index}: unknown type {typ} at {r.pos - 8}")
    _unused, text, extra = r.string(), r.string(), r.string()
    refs: List[int] = []
    if kind in (2, 3, 4):
        count = r.u32()
        if count > 256:
            raise MpsFormatError(f"constant {index}: {count} refs")
        refs = [r.u16() for _ in range(count)]
        if kind == 3:
            # "a|b|c" forms always store 3 slots; slots beyond the number of
            # parts hold uninitialized bytes
            refs = refs[:len((text or "").split("|"))]
    else:
        r.string()  # always null in the shipped scripts
    return Constant(index, kind, typ, text or "", value, extra, refs)


def parse_script(data: bytes) -> Script:
    r = _Reader(data)
    if r.u8() != 1:
        raise MpsFormatError("not a version-1 MPS script")
    raw_records = [(r.u8(), r.u16()) for _ in range(r.u32())]
    words = [r.u16() for _ in range(r.u32())]
    count = r.u32()
    constants = {i: _parse_constant(r, i) for i in range(BUILTIN_COUNT, count)}
    if r.pos != len(data):
        raise MpsFormatError(f"{len(data) - r.pos} bytes after the constant pool")

    lists: Dict[int, List[int]] = {}
    start, current = 0, []
    for i, w in enumerate(words):
        if w == 0xFFFF:
            lists[start] = current
            start, current = i + 1, []
        else:
            current.append(w)

    for c in constants.values():
        for ref in c.refs:
            if ref >= count:
                raise MpsFormatError(f"constant {c.index} refers to {ref} of {count}")

    records = []
    for i, (opcode, operand) in enumerate(raw_records):
        if opcode not in OPCODES:
            raise MpsFormatError(f"record {i}: unknown opcode 0x{opcode:02x}")
        mnemonic, operand_kind = OPCODES[opcode]
        rec = Record(i, opcode, operand, mnemonic)
        if operand_kind == LIST:
            if operand not in lists:
                raise MpsFormatError(f"record {i} ({mnemonic}): operand {operand} is not a list start")
            rec.args = lists[operand]
            if any(a >= count for a in rec.args):
                raise MpsFormatError(f"record {i}: constant index out of range")
        elif operand_kind == JUMP:
            if operand >= len(raw_records):
                raise MpsFormatError(f"record {i} ({mnemonic}): jump target {operand} out of range")
            rec.target = operand
        records.append(rec)
    return Script(records, constants, lists)
