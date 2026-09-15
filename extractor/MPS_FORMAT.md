# MPS Script Format — Findings

Status as of 2026-09-14: **file format solved, opcodes identified.** All 43
scripts in `cdrom/SCRIPTS` parse completely (`mps.py`) and disassemble into
readable listings (`disassemble_scripts.py` → `output/scripts/<NAME>.txt`,
plus `<NAME>.json` for the web runtime). The next step is an interpreter.

The scripts are the game: `STARTUP.MPS` caches resource bundles, creates the
world object and its properties, plays the logo/opening/title movies (skippable
with a click, Space or Return) and loads `Signin.mps`; every location,
minigame and hub has its own script.

## File layout

All integers are **big-endian** (the scripts were compiled on a Mac, unlike
the resources).

```
u8          version (1)
u32         record count R
R x         u8 opcode, u16 operand
u32         word count W
W x u16     operand lists: constant indices, each list ended by 0xffff
u32         constant count C (includes 3 implicit built-in constants)
(C - 3) x   serialized constants
```

The operand is an operand-list word index, a record index to jump to, or
unused, depending on the opcode.

## Constants

Each constant is a serialized value object:

```
u32 kind            0 name, 1 literal, 2 member access, 3 "a|b|c" form, 4 expression
u32 type            0 none, 2 string, 3 integer, 4 float
value block         type 0/2: 3 x u32   type 3: s32 value + 3 x u32
                    type 4: u16 length + float text + 3 x u32
string              always empty
string              source text ("port", "\"common.rsc\"", "objectBoxX+xOff")
string              named constant's value ("MVCCut1.smk", "+278") or
                    compiled expression ("s+tt"); -1 length = none
kind 0/1:  string   always none
kind 2/3/4: u32 n + n x u16 refs   constant indices of the operands
```

- **Built-ins:** constant indices 0–2 aren't stored; references are in the same
  numbering. Index 2 holds the last call's return value (`call_global
  IntersectTest …` is followed by `set test, $result`). 0 and 1 aren't
  understood yet (1 appears as an object in event handlers).
- **Labels** are named integer constants whose value text is `+N`; N is the
  record index of the subroutine.
- **Member access** (kind 2) names a variable by value: `button.buttonNumber`
  with `buttonNumber = 3` is the variable `button.3`. The base (`button`) is
  literal text; the refs hold only the keys. Named constants like
  `objectAOIDs.1 = 1013` make these work as lookup tables.
- **Expressions** keep their source text and a compiled form that reads
  **right-to-left as postfix**: `t` pushes the next ref (refs in order), `z`
  pushes "none" (unary minus is `none - x`), an operator pops right then left,
  and `s` is a no-op marker. `(key@chars)-1` compiles to `s-ts@tt` with refs
  `[key, chars, 1]`; `p2-p1-1` to `s-ts-tt`, evaluating left-associatively.
  Operators seen: `+ - * / % = # (not equal) < > @ (1-based position of left
  in right) ~ (not)`. Confirmed in the web runtime: reading the form left-to-right
  broke the sign-in screen's key handling.
- **Kind 3** (`ud|1|t2`, `rockName|6`) always stores 3 ref slots; slots beyond
  the number of `|` parts contain uninitialized bytes and are ignored.

## Opcodes

Mnemonics are working names inferred from usage across all scripts.

| op | mnemonic | operand | meaning |
|---|---|---|---|
| 0x06 | call | list | call a subroutine: label (or variable holding one), args |
| 0x07 | sub | list | subroutine entry: label, parameter names |
| 0x08 | loop | list | loop start: `var, from, to` or a condition |
| 0x09 | loop_test | list | loop test (same list as its `loop`) |
| 0x0a | jump_if_false | jump | after `if` / `loop_test` |
| 0x0b | jump | jump | unconditional |
| 0x0c | if | list | condition |
| 0x0d | end | — | else/endif marker (no-op) |
| 0x0f | return | — | end of subroutine or handler |
| 0x12 | set | list | `var, value` or `var, Class, constructor args` |
| 0x13 | delete | list | release an object; `delete [, cups` (operands `[` and a name) releases every element `cups.1`, `cups.2`, … |
| 0x15 | call_global | list | engine function (`CacheDLL`, `RandomNumber`, …); result in `$result` |
| 0x23 | set_prop | list | `object, property, [key,] value`; binding a label to an event property installs a handler |
| 0x24 | get_prop | list | `object, property, [key,] destination` |
| 0x25 | start | raw | first record of most scripts; operand not understood |
| 0x28 | send | list | method call: `object, method, args`; an unset bare name among the args passes its own text (`add, PropertyAction, "door", visible, kTrue` names the property `visible`) |
| 0x2d | load_script | list | switch to another script (`location+".mps"`) |
| 0x2e | exit | — | 2 uses (sign-in and PLOC2); probably quits |

Checks across all 43 scripts (`disassemble_scripts.py` prints them):

- every `if` is followed by `jump_if_false` (2,529/2,529)
- every `loop` is followed by `loop_test` with the same list, then
  `jump_if_false` (416/416)
- every direct `call` lands on a `sub` with the same label (926/926); 84 more
  calls go through a variable
- every `sub` label points at itself or at a same-name duplicate definition

## Engine classes

Script objects are instances of engine classes named in `4THADV32.EXE`
(`RWorldPort`, `RScenePort`, `RSmackerMovie`, `RAnimation`, `RCharacter`,
`RBackPack`, `RHotSpot`, `RQueue`, `RText`, `RPButton`, `RDialog`, `RLapTrap`,
puzzle classes, and action types like `SoundAction`, `PlayAnimAction`,
`CharacterSpeechAction`, `MoveXYAction`, `DelayAction`). Their method and
property names sit in string tables next to each class name in the EXE, which
is the main reference for implementing them.

## Open questions

- Built-in constants 0 and 1; the `start` operand; `exit`.
- Exact semantics of `@`, `~` and kind 3 forms; evaluation order of chained
  operators.
- `loop` with `var, from, to`: whether `loop_test` increments before testing
  (the first pass must not skip `from`).
- How the event loop resumes after `return` from the top-level script body.
