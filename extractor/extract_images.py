"""
extract_images.py

Decodes every ASEQ (type 0xff01) image/animation resource into full-colour
RGBA PNG sprite sheets, and writes aseq_index.json describing where each
frame sits. See aseq.py for the format itself.

Usage:
    python3 extract_images.py <rsc_dir> <output_dir> [--palettes <dir>]

Palettes: <dir> holds 768-byte raw RGB files (256 x R,G,B). Each bundle uses
the longest palette filename that is a prefix of the bundle name -- e.g.
cloc01.pal covers cloc01.rsc, cloc01i1.rsc and cloc01p.rsc -- falling back
to default.pal.

Every scene palette shares a common range of slots for characters and the
interface (0-95, 99-104 and 246-255 in the captured set). In a bundle without
its own palette, a resource that only uses slots identical across all loaded
palettes is rendered with those shared colours and indexed with
"palette": "shared". Anything else is rendered with a false-colour
placeholder and indexed with "palette": null, so it is easy to find and
re-run once the real palette is known.

Output per resource, under <output_dir>/<bundle>/:
    <id>_<n>.png   sprite sheet(s); frames are shelf-packed with 1px padding
    <id>.json      sequence lists: {"lists": [[[x, y, tag, value], ...], ...]}
                   (see aseq.py), or {"raw_hex": ...} if they didn't parse
"""
import argparse
import json
import sys
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from functools import partial
from pathlib import Path

import numpy as np
from PIL import Image

from aseq import AseqFormatError, decode_aseq, is_aseq_image
from ne_resource import NEResourceFile, TYPE_ASEQ

MAX_SHEET_WIDTH = 2048
MAX_SHEET_HEIGHT = 4096  # safe texture size for mobile WebGL
PADDING = 1
SHARED_TOLERANCE = 8  # max channel difference for a slot to count as shared
MIN_PALETTES_FOR_SHARED = 3

_i = np.arange(256)
PLACEHOLDER_PALETTE = np.stack(
    [(_i * 67) % 256, (_i * 151 + 80) % 256, (_i * 29 + 160) % 256], axis=1
).astype(np.uint8)


def load_palettes(palette_dir):
    palettes = {}
    if palette_dir is None:
        return palettes
    for path in sorted(Path(palette_dir).glob("*.pal")):
        data = path.read_bytes()
        if len(data) != 768:
            raise SystemExit(f"{path}: expected 768 bytes of RGB, got {len(data)}")
        palettes[path.stem.lower()] = np.frombuffer(data, np.uint8).reshape(256, 3)
    return palettes


def shared_palette(palettes):
    """(mask of slots identical in every palette, their colours), or None when
    there are too few palettes to tell which slots are shared."""
    if len(palettes) < MIN_PALETTES_FOR_SHARED:
        return None
    stack = np.stack(list(palettes.values())).astype(np.int16)
    mask = (stack.max(0) - stack.min(0)).max(1) <= SHARED_TOLERANCE
    return mask, np.median(stack, axis=0).astype(np.uint8)


def resolve_palette(bundle, palettes):
    for name in sorted(palettes, key=len, reverse=True):
        if name != "default" and bundle.startswith(name):
            return name, palettes[name]
    if "default" in palettes:
        return "default", palettes["default"]
    return None, PLACEHOLDER_PALETTE


def pack_frames(frames):
    """Shelf-pack frames into sheets. Returns ([[w, h], ...], [(sheet, x, y), ...])."""
    sheets, placements = [], []
    x = y = shelf_height = 0
    for frame in frames:
        if x > 0 and x + frame.width > MAX_SHEET_WIDTH:
            x, y, shelf_height = 0, y + shelf_height + PADDING, 0
        if not sheets or (y > 0 and y + frame.height > MAX_SHEET_HEIGHT):
            sheets.append([0, 0])
            x = y = shelf_height = 0
        placements.append((len(sheets) - 1, x, y))
        sheet = sheets[-1]
        sheet[0] = max(sheet[0], x + frame.width)
        sheet[1] = max(sheet[1], y + frame.height)
        x += frame.width + PADDING
        shelf_height = max(shelf_height, frame.height)
    return sheets, placements


def extract_aseq_from_file(rsc_path: Path, out_dir: Path, palettes: dict, shared=None) -> list:
    try:
        rf = NEResourceFile(str(rsc_path))
    except Exception as e:
        print(f"  skip {rsc_path.name}: {e}", file=sys.stderr)
        return []

    bundle = rsc_path.stem.lower()
    palette_name, palette = resolve_palette(bundle, palettes)
    records = []
    for entry in rf.entries_of_type(TYPE_ASEQ):
        raw = rf.bytes_for(entry)
        if not is_aseq_image(raw):
            continue  # BGMUSIC.RSC music tracks; extract_audio.py handles those
        record = {"bundle": bundle, "resource_id": entry.numeric_id}
        try:
            res = decode_aseq(raw)
        except AseqFormatError as e:
            print(f"  {rsc_path.name} id={entry.numeric_id}: {e}", file=sys.stderr)
            record.update(decoded=False, frame_count=0, error=str(e))
            records.append(record)
            continue

        res_palette_name, res_palette = palette_name, palette
        if palette_name is None and shared is not None:
            used = np.zeros(256, bool)
            for frame in res.frames:
                used[np.unique(frame.indices[frame.opaque])] = True
            if not (used & ~shared[0]).any():
                res_palette_name, res_palette = "shared", shared[1]

        res_dir = out_dir / bundle
        res_dir.mkdir(parents=True, exist_ok=True)
        sheets, placements = pack_frames(res.frames)
        canvases = [np.zeros((h, w, 4), np.uint8) for w, h in sheets]
        for frame, (s, x, y) in zip(res.frames, placements):
            canvases[s][y:y + frame.height, x:x + frame.width] = frame.to_rgba(res_palette)
        sheet_files = []
        for s, canvas in enumerate(canvases):
            name = f"{entry.numeric_id}_{s}.png"
            Image.fromarray(canvas, "RGBA").save(res_dir / name)
            sheet_files.append(f"{bundle}/{name}")
        seq_name = f"{entry.numeric_id}.json"
        if res.sequences is None:
            seq_doc = {"raw_hex": res.sequence_data.hex()}
        else:
            seq_doc = {"origin": list(res.sequences.origin), "unknown_word": res.sequences.unknown_word,
                       "table": res.sequences.table,
                       "lists": [[list(e) for e in entries] for entries in res.sequences.lists]}
        (res_dir / seq_name).write_text(json.dumps(seq_doc, separators=(",", ":")))

        record.update(
            decoded=True,
            frame_count=res.frame_count,
            header_fields=list(res.header_fields),
            big_endian=res.big_endian,
            palette=res_palette_name,
            sheets=sheet_files,
            frames=[
                {"sheet": s, "x": x, "y": y, "w": f.width, "h": f.height}
                for f, (s, x, y) in zip(res.frames, placements)
            ],
            sequence_file=f"{bundle}/{seq_name}",
        )
        if res.sequences is not None:
            record["origin"] = list(res.sequences.origin)  # lets the app place objects before loading them
        records.append(record)
    return records


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    parser.add_argument("rsc_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--palettes", type=Path, help="directory of 768-byte .pal files")
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    palettes = load_palettes(args.palettes)
    shared = shared_palette(palettes)

    rsc_files = sorted(set(args.rsc_dir.glob("*.RSC")) | set(args.rsc_dir.glob("*.rsc")))
    work = partial(extract_aseq_from_file, out_dir=args.output_dir, palettes=palettes, shared=shared)
    all_records = []
    with ProcessPoolExecutor() as pool:
        for rsc_path, recs in zip(rsc_files, pool.map(work, rsc_files)):
            if recs:
                frames = sum(r["frame_count"] for r in recs)
                print(f"{rsc_path.name}: {len(recs)} ASEQ resources ({frames} frames)")
            all_records.extend(recs)

    index_path = args.output_dir / "aseq_index.json"
    index_path.write_text(json.dumps(all_records, indent=2))
    decoded = [r for r in all_records if r["decoded"]]
    print(f"\n{len(decoded)}/{len(all_records)} ASEQ resources decoded, "
          f"{sum(r['frame_count'] for r in decoded)} frames -> {index_path}")
    kinds = Counter("placeholder" if r["palette"] is None else "shared" if r["palette"] == "shared" else "scene"
                    for r in decoded)
    print(f"palettes: {kinds['scene']} resources with a scene palette, {kinds['shared']} with the shared range, "
          f"{kinds['placeholder']} placeholder")
    placeholder = sorted({r["bundle"] for r in decoded if r["palette"] is None})
    if placeholder:
        print(f"{len(placeholder)} bundles used the placeholder palette: {', '.join(placeholder)}")


if __name__ == "__main__":
    main()
