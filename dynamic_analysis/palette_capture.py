"""
palette_capture.py

Captures the game's scene palettes by reading the memory of the running game
under Wine while you play. No debugger needed.

Every few seconds it:
  1. finds which scene backgrounds are currently decoded into a drawing
     surface -- rows of palette indices with the next row exactly one
     width later (the still-compressed resource data never looks like that),
  2. collects every 256-colour palette in memory that starts with the Windows
     system colours, and
  3. scores each palette against each background on screen (palette_score.py),
     keeping the best fit per background across the whole session.

Linux only lets a process read the memory of processes it started
(kernel.yama.ptrace_scope=1), so this script launches the game itself.
State accumulates across sessions in <capture_dir>/best.json.

Usage:
    python3 palette_capture.py <game_dir> <capture_dir> [--interval 5] [--duration SECONDS]
    python3 palette_capture.py <game_dir> <capture_dir> --finalize [--max-score 1.0]

Play normally and visit as many scenes as you can, then quit the game.
For debugging, `touch <capture_dir>/dump` makes the next scan save the game's
writable memory regions and palettes to <capture_dir>/dump_<seconds>/.
Finalizing writes <capture_dir>/palettes/<bundle>.pal for extract_images.py
--palettes; <capture_dir>/previews/ shows each background in its palette.
"""
import argparse
import hashlib
import json
import pickle
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

from palette_score import load_backgrounds, score

WINESERVER = "/usr/lib/x86_64-linux-gnu/wine/wineserver"
MAX_REGION = 256 << 20
SIG_LEN = 32
# Windows static colours at indices 249..255 (red, green, yellow, blue, magenta,
# cyan, white) in the three layouts palettes are stored in.
PALETTE_ANCHORS = [
    (re.compile(rb"\xff\x00\x00.\x00\xff\x00.\xff\xff\x00.\x00\x00\xff.\xff\x00\xff.\x00\xff\xff.\xff\xff\xff.", re.S), 4, [0, 1, 2]),  # PALETTEENTRY
    (re.compile(rb"\x00\x00\xff.\x00\xff\x00.\x00\xff\xff.\xff\x00\x00.\xff\x00\xff.\xff\xff\x00.\xff\xff\xff.", re.S), 4, [2, 1, 0]),  # RGBQUAD
    (re.compile(rb"\xff\x00\x00\x00\xff\x00\xff\xff\x00\x00\x00\xff\xff\x00\xff\x00\xff\xff\xff\xff\xff"), 3, [0, 1, 2]),  # RGB
]
STATIC_LOW = np.array([(0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128),
                       (128, 0, 128), (0, 128, 128), (192, 192, 192)], np.int16)
MIN_DISTINCT_COLOURS = 64
# Busy, heavily patterned scenes score higher with the right palette, and some
# wrong palettes score as low as ~0.8, so fits above this need a look.
REVIEW_SCORE = 0.6


def bg_key(bg):
    return f"{bg.bundle}/{bg.resource_id}/{bg.frame}"


def signatures(bg, max_sigs=3):
    """[(32 bytes of a row, the same columns one row down, width)] from the most varied rows."""
    h, w = bg.indices.shape
    found = []
    for r in range(h // 9, h - 1, max(1, h // 9)):
        row, below = bg.indices[r], bg.indices[r + 1]
        ok = bg.opaque[r] & bg.opaque[r + 1]
        starts = [x for x in range(0, w - SIG_LEN, 8) if ok[x:x + SIG_LEN].all()]
        if not starts:
            continue
        x = max(starts, key=lambda s: len(np.unique(row[s:s + SIG_LEN])))
        distinct = len(np.unique(row[x:x + SIG_LEN]))
        if distinct >= 8:
            found.append((distinct, row[x:x + SIG_LEN].tobytes(), below[x:x + SIG_LEN].tobytes(), w))
    found.sort(key=lambda f: f[0], reverse=True)
    return [f[1:] for f in found[:max_sigs]]


def build_sig_table(backgrounds):
    """Index each signature by a 4-byte word at each of the four byte alignments,
    so a single aligned pass over memory finds it wherever it starts."""
    by_word = {}
    for bg in backgrounds:
        for sig, below, width in signatures(bg):
            for align in range(4):
                for o in range(align, SIG_LEN - 3, 4):
                    word = sig[o:o + 4]
                    if len(set(word)) >= 3 and word[0] != word[1]:
                        by_word.setdefault(int.from_bytes(word, "little"), []).append(
                            (bg_key(bg), sig, below, width, o))
                        break
    words = np.array(sorted(by_word), np.uint32)
    low16 = np.zeros(65536, bool)
    low16[words & 0xFFFF] = True
    return {"by_word": by_word, "words": words, "low16": low16}


def read_regions(pid):
    maps = Path(f"/proc/{pid}/maps").read_text().splitlines()
    with open(f"/proc/{pid}/mem", "rb", 0) as mem:
        for line in maps:
            parts = line.split()
            start, end = (int(x, 16) for x in parts[0].split("-"))
            if "r" not in parts[1] or end - start > MAX_REGION or "[v" in line:
                continue
            try:
                mem.seek(start)
                data = mem.read(end - start)
            except (OSError, ValueError, OverflowError):
                continue
            yield parts[1], data


def find_palettes(data, found):
    for regex, width, order in PALETTE_ANCHORS:
        for m in regex.finditer(data):
            start = m.start() - 249 * width
            if start < 0:
                continue
            pal = np.frombuffer(data[start:start + 256 * width], np.uint8).reshape(256, width)[:, order]
            if np.abs(pal[:8].astype(np.int16) - STATIC_LOW).max() > 8:
                continue
            if len(np.unique(pal[10:246], axis=0)) < MIN_DISTINCT_COLOURS:
                continue
            found.setdefault(hashlib.md5(pal.tobytes()).hexdigest()[:12], np.ascontiguousarray(pal))


def find_surfaces(data, sig_table, present, loose):
    """Adds keys of backgrounds whose rows appear laid out as a drawing surface to
    `present`, and keys whose rows merely occur somewhere to `loose`."""
    n = len(data) // 4
    low16 = np.frombuffer(data, "<u2", n * 2)[0::2]
    words = np.frombuffer(data, "<u4", n)
    cand = np.nonzero(sig_table["low16"][low16])[0]
    cand = cand[np.isin(words[cand], sig_table["words"])]
    for idx in cand:
        for key, sig, below, width, o in sig_table["by_word"][int(words[idx])]:
            pos = 4 * int(idx) - o
            if key in present or pos < 0 or data[pos:pos + SIG_LEN] != sig:
                continue
            loose.add(key)
            if data[pos + width:pos + width + SIG_LEN] == below or \
                    (pos >= width and data[pos - width:pos - width + SIG_LEN] == below):
                present.add(key)


def scan(pid, sig_table, dump_dir=None):
    palettes, present, loose = {}, set(), set()
    for n, (perms, data) in enumerate(read_regions(pid)):
        find_palettes(data, palettes)
        if "w" in perms and len(data) >= 300_000:
            find_surfaces(data, sig_table, present, loose)
            if dump_dir:
                (dump_dir / f"region_{n:04d}.bin").write_bytes(data)
    if dump_dir:
        for name, pal in palettes.items():
            (dump_dir / f"pal_{name}.pal").write_bytes(pal.tobytes())
    return palettes, present, loose - present


def save_preview(bg, palette, path):
    rgba = np.zeros(bg.indices.shape + (4,), np.uint8)
    rgba[..., :3] = palette[bg.indices]
    rgba[..., 3] = np.where(bg.opaque, 255, 0)
    Image.fromarray(rgba, "RGBA").save(path)


def capture(args, backgrounds):
    out = args.capture_dir
    (out / "captured").mkdir(parents=True, exist_ok=True)
    (out / "previews").mkdir(exist_ok=True)
    best_path = out / "best.json"
    best = json.loads(best_path.read_text()) if best_path.exists() else {}
    by_key = {bg_key(bg): bg for bg in backgrounds}

    sig_table = build_sig_table(backgrounds)

    game = subprocess.Popen(["wine", "4THADV32.EXE"], cwd=args.game_dir,
                            env={**__import__("os").environ, "WINEDEBUG": "-all"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    stop = {"flag": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.update(flag=True))
    signal.signal(signal.SIGINT, lambda *_: stop.update(flag=True))
    print(f"game started (pid {game.pid}); play, then quit the game to finish", flush=True)
    log = open(out / "captures.jsonl", "a")
    started = time.time()
    try:
        while game.poll() is None and not stop["flag"]:
            if args.duration and time.time() - started > args.duration:
                break
            t0 = time.time()
            dump_dir = None
            if (out / "dump").exists():
                (out / "dump").unlink()
                dump_dir = out / f"dump_{int(t0 - started)}"
                dump_dir.mkdir()
            try:
                palettes, present, loose = scan(game.pid, sig_table, dump_dir)
            except (FileNotFoundError, ProcessLookupError, PermissionError) as e:
                print(f"scan failed: {e}", flush=True)
                break
            entry = {"t": round(t0 - started, 1), "palettes": sorted(palettes),
                     "in_memory_not_on_surface": sorted(loose), "backgrounds": {}}
            if palettes and present:
                names = list(palettes)
                stack = np.stack([palettes[n] for n in names])
                for key in sorted(present):
                    scores = score(stack, by_key[key])
                    order = np.argsort(scores)
                    s, name = float(scores[order[0]]), names[order[0]]
                    runner_up = float(scores[order[1]]) if len(order) > 1 else None
                    entry["backgrounds"][key] = {"palette": name, "score": round(s, 4),
                                                 "runner_up": None if runner_up is None else round(runner_up, 4)}
                    if key not in best or s < best[key]["score"]:
                        (out / "captured" / f"{name}.pal").write_bytes(palettes[name].tobytes())
                        best[key] = {"palette": name, "score": s}
                        save_preview(by_key[key], palettes[name], out / "previews" / f"{key.replace('/', '_')}.png")
                        print(f"  {key}: palette {name} score {s:.3f} (runner-up {runner_up})", flush=True)
                best_path.write_text(json.dumps(best, indent=2))
            entry["scan_seconds"] = round(time.time() - t0, 1)
            log.write(json.dumps(entry) + "\n")
            log.flush()
            print(f"[{entry['t']:>6}s] {len(palettes)} palettes, on screen: {sorted(present) or '-'}, "
                  f"elsewhere in memory: {sorted(loose) or '-'} ({entry['scan_seconds']}s scan)"
                  f"{f' [memory dumped to {dump_dir}]' if dump_dir else ''}", flush=True)
            time.sleep(max(0.0, args.interval - (time.time() - t0)))
    finally:
        if game.poll() is None:
            subprocess.run([WINESERVER, "-k"])
            try:
                game.wait(timeout=20)
            except subprocess.TimeoutExpired:
                game.kill()
        log.close()


def finalize(args):
    out = args.capture_dir
    best = json.loads((out / "best.json").read_text())
    per_bundle = {}
    for key, rec in best.items():
        bundle = key.split("/")[0]
        if rec["score"] <= args.max_score and (bundle not in per_bundle or rec["score"] < per_bundle[bundle]["score"]):
            per_bundle[bundle] = {**rec, "background": key}
    (out / "palettes").mkdir(exist_ok=True)
    for bundle, rec in sorted(per_bundle.items()):
        data = (out / "captured" / f"{rec['palette']}.pal").read_bytes()
        (out / "palettes" / f"{bundle}.pal").write_bytes(data)
        # cloc08a's animation bundles are named cloc8ai1.rsc etc.; only rewrite
        # "08a"-style names so e.g. cloc01 never becomes a cloc1 prefix of cloc13
        alias = re.sub(r"^([a-z]+)0(\d[a-z])", r"\1\2", bundle)
        if alias != bundle:
            (out / "palettes" / f"{alias}.pal").write_bytes(data)
        review = "  <- check preview" if rec["score"] > REVIEW_SCORE else ""
        print(f"{bundle:10s} <- {rec['palette']} (score {rec['score']:.3f} on {rec['background']}){review}")
    rejected = sorted({k.split('/')[0] for k, r in best.items()} - set(per_bundle))
    if rejected:
        print(f"no palette under --max-score {args.max_score} for: {', '.join(rejected)}")
    cache = out / "backgrounds.pkl"
    if cache.exists():
        all_bundles = {bg.bundle for bg in pickle.loads(cache.read_bytes())}
        unseen = sorted(all_bundles - {k.split("/")[0] for k in best})
        if unseen:
            print(f"scenes not captured yet: {', '.join(unseen)}")
    print(f"{len(per_bundle)} palettes written to {out / 'palettes'}")


def main():
    parser = argparse.ArgumentParser(description="Capture scene palettes from the running game.")
    parser.add_argument("game_dir", type=Path, help="folder containing 4THADV32.EXE")
    parser.add_argument("capture_dir", type=Path)
    parser.add_argument("--interval", type=float, default=5.0, help="seconds between scans")
    parser.add_argument("--duration", type=float, help="stop after this many seconds")
    parser.add_argument("--finalize", action="store_true", help="write palettes/<bundle>.pal from best.json")
    parser.add_argument("--max-score", type=float, default=1.0,
                        help="reject fits worse than this (confirmed captures scored 0.23-0.90)")
    args = parser.parse_args()
    if args.finalize:
        finalize(args)
        return
    args.capture_dir.mkdir(parents=True, exist_ok=True)
    print("loading backgrounds (first run decodes them, ~15 s)...", flush=True)
    backgrounds = load_backgrounds(args.game_dir / "cdrom" / "RSC", args.capture_dir / "backgrounds.pkl")
    capture(args, backgrounds)


if __name__ == "__main__":
    sys.exit(main())
