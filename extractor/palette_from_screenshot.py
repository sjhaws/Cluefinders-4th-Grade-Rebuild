"""
palette_from_screenshot.py

Recovers a scene's 256-colour palette from screenshots of the original game.

ASEQ frames store palette indices, so a screenshot of the same scene gives the
colour of every index it shows: line the screenshot up with the scene's
background frame, and each index takes the colour its pixels have. This
replaces a live memory capture (dynamic_analysis/) for any scene the player
can photograph.

The screenshot need not be 640x480 or pixel-aligned: the game window is found
by hill-climbing the crop rectangle that makes index -> colour most
consistent, then refining it on exact colour matches.

How much of a screenshot can be trusted depends on how it was made:

* A lossless grab (PNG, no scaling or nearest-neighbour) reproduces every
  pixel, so every index votes -- including ones that only ever appear in
  dithered speckle.
* A smoothly scaled or JPEG screenshot blends neighbouring colours, so only
  pixels whose 3x3 index neighbourhood is uniform are trustworthy. Indices
  that appear solely in dithering cannot be recovered from such a shot and
  are reported as unresolved.

Which of the two a screenshot is gets measured, not assumed. Characters, the
cursor and dialogs sit on top of the background, so each index takes its most
common colour rather than the first one seen, and indices with too little
agreement are left to the fallback palette.

Pass several screenshots of the same scene to cover more of it -- votes from
all of them are pooled.

Usage:
    python3 palette_from_screenshot.py <bundle> <rsc_dir> <shot.png> [shot2.png ...] \
        [--out-dir ../dynamic_analysis/captures/palettes] [--resource ID]
        [--fallback-palettes ../output/palettes] [--preview DIR] [--dry-run]
"""
import argparse
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from aseq import decode_aseq, is_aseq_image
from extract_images import (PLACEHOLDER_PALETTE, load_palettes, resolve_palette,
                            shared_palette)
from ne_resource import NEResourceFile, TYPE_ASEQ

SCREEN = (640, 480)
CLUSTER = 8        # colours within this cube vote together (scaling/JPEG noise)


def background_frame(rsc_dir: Path, bundle: str, resource_id=None):
    """The bundle's full-screen background frame: (resource_id, indices, opaque)."""
    path = next((p for p in Path(rsc_dir).iterdir()
                 if p.stem.lower() == bundle.lower() and p.suffix.lower() == ".rsc"), None)
    if path is None:
        raise SystemExit(f"no {bundle.upper()}.RSC in {rsc_dir}")
    rf = NEResourceFile(str(path))
    best = None
    for entry in rf.entries_of_type(TYPE_ASEQ):
        raw = rf.bytes_for(entry)
        if not is_aseq_image(raw):
            continue
        if resource_id is not None and entry.numeric_id != resource_id:
            continue
        for frame in decode_aseq(raw).frames:
            area = frame.width * frame.height
            if best is None or area > best[2]:
                best = (entry.numeric_id, frame, area)
    if best is None:
        raise SystemExit(f"{bundle}: no ASEQ image found")
    rid, frame, _ = best
    if (frame.width, frame.height) != SCREEN:
        print(f"note: {bundle} {rid} is {frame.width}x{frame.height}, not 640x480",
              file=sys.stderr)
    return rid, frame.indices, frame.opaque


def interior_mask(indices: np.ndarray, opaque: np.ndarray) -> np.ndarray:
    """Pixels whose 3x3 neighbourhood is one opaque index: safe from scaling blends."""
    same = np.ones_like(opaque)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            shifted_i = np.roll(np.roll(indices, dy, 0), dx, 1)
            shifted_o = np.roll(np.roll(opaque, dy, 0), dx, 1)
            same &= (shifted_i == indices) & shifted_o
    same[0, :] = same[-1, :] = same[:, 0] = same[:, -1] = False
    return same & opaque


def sample_colours(shot: np.ndarray, rect, indices: np.ndarray, mask: np.ndarray, stride=1):
    """Screenshot colours for the masked background pixels, under crop `rect`.

    Returns (indices, colours, positions); the positions are frame coordinates,
    which tell a solid thing standing in front of the scene from the scattered
    pixels of the artwork itself.
    """
    x0, y0, x1, y1 = rect
    h, w = indices.shape
    ys, xs = np.arange(0, h, stride), np.arange(0, w, stride)
    sy = np.clip(y0 + (ys + 0.5) * (y1 - y0) / h, 0, shot.shape[0] - 1).astype(int)
    sx = np.clip(x0 + (xs + 0.5) * (x1 - x0) / w, 0, shot.shape[1] - 1).astype(int)
    keep = mask[np.ix_(ys, xs)]
    gx, gy = np.meshgrid(xs, ys)
    return (indices[np.ix_(ys, xs)][keep], shot[np.ix_(sy, sx)][keep],
            np.stack([gx[keep], gy[keep]], axis=1))


CELL = 32          # screen cell for measuring how spread out a colour is


def _cells(xy: np.ndarray) -> int:
    """How many screen cells a set of pixels touches."""
    if len(xy) == 0:
        return 1
    return len(np.unique(((xy[:, 1] // CELL).astype(np.int64) << 8) | (xy[:, 0] // CELL)))


def vote(idx: np.ndarray, rgb: np.ndarray, cluster=CLUSTER, xy: np.ndarray = None):
    """Per index: (colour, votes for it, share of that index's pixels, runner-up votes).

    Colours are grouped into cubes `cluster` wide so that near-misses support
    each other; the winning group then reports its most common exact colour.
    cluster=1 makes it a plain exact-colour vote. The runner-up's count comes
    back too: whatever covers an index contributes many different colours, so
    the margin over second place says more than the raw share.
    """
    if len(idx) == 0:
        return {}
    coarse = ((rgb[:, 0] // cluster).astype(np.int64) << 16) \
        | ((rgb[:, 1] // cluster).astype(np.int64) << 8) | (rgb[:, 2] // cluster)
    keys = (idx.astype(np.int64) << 24) | coarse
    unique, counts = np.unique(keys, return_counts=True)
    totals, best, second = {}, {}, {}
    for key, count in zip(unique.tolist(), counts.tolist()):
        i = key >> 24
        totals[i] = totals.get(i, 0) + count
        if count > best.get(i, (0, 0))[0]:
            second[i] = best.get(i, (0, None))
            best[i] = (count, key)
        elif count > second.get(i, (0, None))[0]:
            second[i] = (count, key)
    out = {}
    for i, (count, key) in best.items():
        rcount, rkey = second.get(i, (0, None))
        cells = rcells = 0
        if xy is not None:
            cells = _cells(xy[keys == key])
            if rkey is not None:
                rcells = _cells(xy[keys == rkey])
                # A board or a character covers a compact patch of screen, while
                # the scene's own colours are strewn right across it by the
                # dithering. Reaching further matters, not packing tighter: when
                # the runner-up spans far more of the picture than the leader,
                # the leader is something standing in front of the scene.
                if rcount * 4 >= count and rcells >= 2 * cells:
                    count, key, cells, rcount, rkey, rcells = (
                        rcount, rkey, rcells, count, key, cells)
        block = rgb[keys == key]
        colours, freq = np.unique(block, axis=0, return_counts=True)
        out[i] = (colours[freq.argmax()], count, count / totals[i], rcount, cells, rcells)
    return out


def agreement(shot, rect, indices, mask, stride=3, cluster=CLUSTER):
    """Share of sampled pixels explained by one colour per index."""
    idx, rgb, _xy = sample_colours(shot, rect, indices, mask, stride)
    if len(idx) < 500:
        return 0.0
    return sum(v[1] for v in vote(idx, rgb, cluster).values()) / len(idx)


# Each edge alone (which rescales), then both edges of an axis together (which
# slides the window without rescaling it) -- an off-by-one offset is the common
# case and stretching the window to reach it ruins every dithered area.
MOVES = ((1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (0, 0, 0, 1),
         (1, 0, 1, 0), (0, 1, 0, 1))


def climb(shot, indices, mask, rect, steps, cluster):
    """Nudge and slide `rect` while agreement improves."""
    h, w = shot.shape[:2]
    rect = list(rect)
    best = agreement(shot, rect, indices, mask, cluster=cluster)
    for step in steps:
        improved = True
        while improved:
            improved = False
            for move in MOVES:
                for sign in (-step, step):
                    trial = [r + sign * m for r, m in zip(rect, move)]
                    if trial[2] - trial[0] < 64 or trial[3] - trial[1] < 64:
                        continue
                    if trial[0] < -w or trial[1] < -h or trial[2] > 2 * w or trial[3] > 2 * h:
                        continue
                    value = agreement(shot, trial, indices, mask, cluster=cluster)
                    if value > best + 1e-6:
                        rect, best, improved = trial, value, True
    return tuple(rect), best


def seed_rects(shot, indices):
    """Plausible starting windows: the whole image, and the frame centred at the
    scale implied by either dimension (a window with borders on one axis)."""
    h, w = shot.shape[:2]
    fh, fw = indices.shape
    seeds = [[0, 0, w, h]]
    for scale in {w / fw, h / fh}:
        x0, y0 = (w - fw * scale) / 2, (h - fh * scale) / 2
        seeds.append([round(x0), round(y0), round(x0 + fw * scale), round(y0 + fh * scale)])
    return seeds


def align(shot, indices, opaque, interior):
    """Find the game window: coarse on blend-tolerant votes, then exact-colour.

    The coarse pass can drift a pixel wide of an unscaled screenshot -- a
    stretch that costs little on blend-tolerant votes but wrecks every dithered
    area -- so the seed rectangles are refined and scored exactly too, and the
    best of them all wins.
    """
    seeds = seed_rects(shot, indices)
    start = max(seeds, key=lambda r: agreement(shot, r, indices, interior))
    coarse, _ = climb(shot, indices, interior, start, (32, 16, 8, 4, 2, 1), CLUSTER)
    best, best_fit = None, -1.0
    for candidate in {tuple(coarse), *(tuple(s) for s in seeds)}:
        rect, fit = climb(shot, indices, opaque, candidate, (4, 2, 1), 1)
        if fit > best_fit:
            best, best_fit = rect, fit
    return best, best_fit


def fallback_palette(bundle: str, palette_dir):
    """Colours for indices no screenshot shows: the scene's own palette if one
    exists, else the shared range plus the median of every captured palette --
    a plausible colour beats the false-colour placeholder."""
    palettes = load_palettes(palette_dir) if palette_dir else {}
    if not palettes:
        return np.array(PLACEHOLDER_PALETTE, copy=True), "placeholder"
    name, palette = resolve_palette(bundle, palettes)
    if name not in (None, "default"):
        return np.array(palette, copy=True), f"{name}.pal"
    stack = np.stack(list(palettes.values())).astype(np.int16)
    base = np.median(stack, axis=0).astype(np.uint8)
    shared = shared_palette(palettes)
    note = "median of captured palettes"
    if shared is not None:
        mask, colours = shared
        base[mask] = colours[mask]
        note = f"shared range ({int(mask.sum())} slots) + median of captured palettes"
    return base, note


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    ap.add_argument("bundle", help="scene bundle, e.g. cloc13")
    ap.add_argument("rsc_dir", type=Path, help="the game's cdrom/RSC")
    ap.add_argument("screenshots", type=Path, nargs="+")
    ap.add_argument("--resource", type=int, help="background resource id (default: largest)")
    ap.add_argument("--out-dir", type=Path, default=Path("../dynamic_analysis/captures/palettes"))
    ap.add_argument("--fallback-palettes", type=Path, default=Path("../output/palettes"))
    ap.add_argument("--preview", type=Path, default=Path("../dynamic_analysis/captures/previews"))
    ap.add_argument("--rect", type=int, nargs=4, metavar=("X0", "Y0", "X1", "Y1"),
                    help="skip the search and use this crop (single screenshot only)")
    ap.add_argument("--min-votes", type=int, default=6, help="pixels an index needs")
    ap.add_argument("--min-share", type=float, default=0.34, help="agreement an index needs")
    ap.add_argument("--thin-at", type=int, default=16,
                    help="flag recovered slots resting on fewer pixels than this")
    ap.add_argument("--margin", type=float, default=2.0,
                    help="how far a colour must outvote the runner-up to win a "
                         "mostly-covered index")
    ap.add_argument("--crisp-at", type=float, default=0.95,
                    help="how close exact agreement must come to blend-tolerant "
                         "agreement for a screenshot to count as lossless")
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    args = ap.parse_args()

    bundle = args.bundle.lower()
    rid, indices, opaque = background_frame(args.rsc_dir, bundle, args.resource)
    interior = interior_mask(indices, opaque)
    shown = len(np.unique(indices[opaque]))
    print(f"{bundle} {rid}: {int(opaque.sum())} background pixels using {shown} indices, "
          f"{int(interior.sum())} pixels clear of edges")

    all_idx, all_rgb, all_xy, in_idx, in_rgb, in_xy, shots = [], [], [], [], [], [], []
    for path in args.screenshots:
        shot = np.asarray(Image.open(path).convert("RGB"))
        if args.rect and len(args.screenshots) == 1:
            rect = tuple(args.rect)
            fit = agreement(shot, rect, indices, opaque, cluster=1)
        else:
            rect, fit = align(shot, indices, opaque, interior)
        scale = (rect[2] - rect[0]) / indices.shape[1]
        # Characters hide part of the background in every frame, capping exact
        # agreement well below 1 even for a perfect grab. So losslessness is
        # judged by whether tolerating near-misses would explain any more
        # pixels -- on a clean grab it buys nothing, on a compressed one it
        # buys a lot -- rather than by the raw share, which only measures how
        # much of the scene happens to be visible.
        fuzzy = agreement(shot, rect, indices, opaque, cluster=CLUSTER)
        crisp = fit >= args.crisp_at * fuzzy
        print(f"  {path.name}: {shot.shape[1]}x{shot.shape[0]}, window {rect} "
              f"({scale:.3f}x), {fit:.1%} exact of {fuzzy:.1%} explained -> "
              f"{'lossless' if crisp else 'blended'}")
        i, c, p = sample_colours(shot, rect, indices, opaque)
        all_idx.append(i)
        all_rgb.append(c)
        all_xy.append(p)
        if not crisp:                   # blended: only edge-free pixels can be trusted
            i, c, p = sample_colours(shot, rect, indices, interior)
        in_idx.append(i)
        in_rgb.append(c)
        in_xy.append(p)
        shots.append((shot, rect))

    pooled_idx, pooled_rgb = np.concatenate(all_idx), np.concatenate(all_rgb)
    pooled_xy = np.concatenate(all_xy)
    exact_votes = vote(pooled_idx, pooled_rgb, 1, pooled_xy)
    fuzzy_votes = vote(pooled_idx, pooled_rgb, CLUSTER, pooled_xy)
    trusted = vote(np.concatenate(in_idx), np.concatenate(in_rgb), CLUSTER,
                   np.concatenate(in_xy))
    total = max(1, len(pooled_idx))
    exact_share = sum(v[1] for v in exact_votes.values()) / total
    fuzzy_share = sum(v[1] for v in fuzzy_votes.values()) / total
    lossless = exact_share >= args.crisp_at * fuzzy_share

    palette, source = fallback_palette(bundle, args.fallback_palettes)
    primary = exact_votes if lossless else trusted
    # A lossless screenshot reproduces colours outright, so a single visible
    # pixel settles an index; a blended one needs a crowd to average out.
    need = 1 if lossless else args.min_votes
    def decided(entry, floor):
        """An index is settled either by winning outright -- whatever stands on
        it contributes many different colours, so the true colour beats each of
        them -- or by reaching across the picture while its rival sits in one
        compact patch, which is what a covered index looks like."""
        colour, count, share, runner, cells, rcells = entry
        return colour is not None and count >= floor and (
            share >= args.min_share
            or count >= args.margin * max(1, runner)
            or (cells > 0 and cells >= 1.5 * rcells))

    blank = (None, 0, 0, 0, 0, 0)
    strong, fuzzy, weak = [], [], []
    for i in sorted(set(primary) | set(trusted)):
        entry = primary.get(i, blank)
        if decided(entry, need):
            palette[i] = entry[0]
            strong.append(i)
            continue
        entry = trusted.get(i, blank)
        if decided(entry, args.min_votes):
            palette[i] = entry[0]
            fuzzy.append(i)
        else:
            weak.append((i, entry[1], entry[2]))
    unseen = 256 - len(set(exact_votes))
    print(f"pooled screenshots are {'lossless' if lossless else 'blended'} "
          f"({exact_share:.1%} exact of {fuzzy_share:.1%} explained): {len(strong)} slots "
          f"recovered, {len(fuzzy)} from edge-free pixels only, {len(weak)} unclear, "
          f"{unseen} never shown -> {source}")
    if weak:
        print("  unclear: " + ", ".join(f"{i}({c}px,{s:.0%})" for i, c, s in weak[:12])
              + (" ..." if len(weak) > 12 else ""))
    # A colour whose every pixel hides under a character is recovered from the
    # character instead, and agrees with itself while being wrong -- so say how
    # thin the evidence is rather than reporting a confident count.
    risky = [(i, c, s) for i, (_, c, s, r, cl, rcl) in sorted(primary.items())
             if i in strong and (c < args.thin_at
                                 or (c < 2 * args.margin * max(1, r) and cl < 1.5 * rcl))]
    if risky:
        print(f"  {len(risky)} slots rest on thin or divided evidence (something may be "
              f"standing on them): "
              + ", ".join(f"{i}({c}px,{s:.0%})" for i, c, s in risky[:12])
              + (" ..." if len(risky) > 12 else ""))

    idx, rgb = np.concatenate(all_idx), np.concatenate(all_rgb)
    near = np.mean(np.all(np.abs(palette[idx].astype(int) - rgb.astype(int)) <= 8, axis=1))
    exact = np.mean(np.all(palette[idx] == rgb, axis=1))
    print(f"redrawn background matches the screenshots exactly on {exact:.1%} of "
          f"pixels, within 8/255 on {near:.1%}")

    if args.dry_run:
        return
    args.out_dir.mkdir(parents=True, exist_ok=True)
    out = args.out_dir / f"{bundle}.pal"
    out.write_bytes(palette.astype(np.uint8).tobytes())
    print(f"wrote {out}")

    if args.preview:
        args.preview.mkdir(parents=True, exist_ok=True)
        rebuilt = Image.fromarray(palette[indices].astype(np.uint8), "RGB")
        shot, rect = shots[0]
        window = Image.fromarray(shot, "RGB").crop(rect).resize(rebuilt.size)
        sheet = Image.new("RGB", (rebuilt.width * 2, rebuilt.height))
        sheet.paste(window, (0, 0))
        sheet.paste(rebuilt, (rebuilt.width, 0))
        path = args.preview / f"{bundle}_from_screenshot.png"
        sheet.save(path)
        print(f"preview (screenshot | rebuilt) {path}")


if __name__ == "__main__":
    main()
