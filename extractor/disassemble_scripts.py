"""
disassemble_scripts.py

Disassembles every compiled game script (*.MPS) into a readable listing and a
JSON form for the web runtime, and checks the inferred opcode meanings
against the whole script set.

Usage:
    python3 disassemble_scripts.py <scripts_dir> <output_dir>

Writes <output_dir>/<NAME>.txt and <output_dir>/<NAME>.json.
"""
import json
import sys
from collections import Counter
from pathlib import Path

from mps import BUILTIN_COUNT, MpsFormatError, Script, parse_script


def is_label(c) -> bool:
    return c.kind == 0 and c.type == 3 and bool(c.extra) and c.extra.startswith("+")


def render_arg(script: Script, index: int) -> str:
    if index < BUILTIN_COUNT:
        return script.text_of(index)
    c = script.constants[index]
    if c.kind == 4:
        return f"({c.text})"
    if is_label(c):
        return f"{c.text}@{c.value}"
    return c.text


def listing(script: Script) -> str:
    lines = []
    for rec in script.records:
        if rec.mnemonic == "sub":
            lines.append("")
        if rec.target is not None:
            body = f"-> {rec.target}"
        else:
            body = ", ".join(render_arg(script, a) for a in rec.args)
        lines.append(f"{rec.index:5d}  {rec.mnemonic:14s} {body}".rstrip())
    return "\n".join(lines) + "\n"


def to_json(name: str, script: Script) -> dict:
    return {
        "name": name,
        "records": [
            {"op": r.opcode, "m": r.mnemonic, **({"target": r.target} if r.target is not None else {"args": r.args})}
            for r in script.records
        ],
        "constants": {
            str(c.index): {k: v for k, v in {
                "kind": c.kind, "type": c.type, "text": c.text, "value": c.value,
                "extra": c.extra, "refs": c.refs or None}.items() if v is not None}
            for c in script.constants.values()
        },
    }


def check(script: Script, stats: Counter):
    recs = script.records
    for i, rec in enumerate(recs):
        nxt = recs[i + 1] if i + 1 < len(recs) else None
        if rec.mnemonic == "if":
            stats["if followed by jump_if_false"] += nxt is not None and nxt.mnemonic == "jump_if_false"
            stats["if total"] += 1
        if rec.mnemonic == "loop":
            ok = nxt is not None and nxt.mnemonic == "loop_test" and nxt.args == rec.args \
                and i + 2 < len(recs) and recs[i + 2].mnemonic == "jump_if_false"
            stats["loop followed by loop_test + jump_if_false"] += ok
            stats["loop total"] += 1
        if rec.mnemonic == "call" and rec.args:
            label = script.constants.get(rec.args[0])
            if label is not None and is_label(label):
                target = label.value
                ok = 0 <= target < len(recs) and recs[target].mnemonic == "sub" \
                    and recs[target].args[:1] == rec.args[:1]
                stats["call (direct) lands on matching sub"] += ok
                stats["call total"] += 1
            else:
                stats["indirect calls (through a variable)"] += 1
        if rec.mnemonic == "sub" and rec.args:
            label = script.constants.get(rec.args[0])
            # some files define the same subroutine twice (shared code included
            # more than once); the label then points at the other definition
            ok = label is not None and isinstance(label.value, int) and 0 <= label.value < len(recs) and (
                label.value == i or (recs[label.value].mnemonic == "sub" and recs[label.value].args[:1] == rec.args[:1]))
            stats["sub label points at this sub or a same-name duplicate"] += ok
            stats["sub total"] += 1


def main():
    scripts_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    stats, ops = Counter(), Counter()
    failures = []
    files = sorted(set(scripts_dir.glob("*.MPS")) | set(scripts_dir.glob("*.mps")))
    for path in files:
        try:
            script = parse_script(path.read_bytes())
        except MpsFormatError as e:
            failures.append((path.name, str(e)))
            continue
        name = path.stem.upper()
        (out_dir / f"{name}.txt").write_text(listing(script))
        (out_dir / f"{name}.json").write_text(json.dumps(to_json(name, script), separators=(",", ":")))
        ops.update(r.mnemonic for r in script.records)
        check(script, stats)

    print(f"{len(files) - len(failures)}/{len(files)} scripts disassembled -> {out_dir}")
    for name, err in failures:
        print(f"  FAILED {name}: {err}")
    print("records by mnemonic:", dict(ops.most_common()))
    for key in ("if", "loop", "call", "sub"):
        total = stats[f"{key} total"]
        for k, v in stats.items():
            if k.startswith(key) and not k.endswith("total"):
                print(f"  {k}: {v}/{total} ({100 * v / max(total, 1):.1f}%)")
    print(f"  indirect calls (through a variable): {stats['indirect calls (through a variable)']}")


if __name__ == "__main__":
    main()
