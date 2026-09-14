"""
palette_score.py

Scores how well a 256-colour palette fits a scene background: the right
palette makes neighbouring pixels similar colours, a wrong one scatters them.

    score = mean colour distance between differing adjacent pixels
            / mean distance of the background's colours from their average

Lower is better. Used by palette_capture.py to decide which scene a palette
read from the running game belongs to.
"""
import pickle
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "extractor"))
from aseq import AseqFormatError, decode_aseq, is_aseq_image  # noqa: E402
from ne_resource import NEResourceFile, TYPE_ASEQ  # noqa: E402

TOP_PAIRS = 3000
MIN_SPREAD = 40  # palettes whose used colours barely vary can't be judged
BACKGROUND_MIN_SIZE = (600, 400)


@dataclass
class Background:
    bundle: str
    resource_id: int
    frame: int
    first: np.ndarray    # palette index of the left/top pixel of each adjacent pair
    second: np.ndarray   # palette index of the right/bottom pixel
    counts: np.ndarray   # how often each pair occurs
    used: np.ndarray     # palette indices present
    weights: np.ndarray  # pixel share of each used index
    indices: np.ndarray  # (height, width) uint8, for surface detection and previews
    opaque: np.ndarray   # (height, width) bool


def background_stats(bundle, resource_id, frame_index, frame) -> Background:
    idx = frame.indices.astype(np.int32)
    opaque = frame.opaque
    horizontal = (idx[:, :-1] * 256 + idx[:, 1:])[opaque[:, :-1] & opaque[:, 1:]]
    vertical = (idx[:-1] * 256 + idx[1:])[opaque[:-1] & opaque[1:]]
    pairs = np.concatenate([horizontal, vertical])
    pairs = pairs[pairs // 256 != pairs % 256]
    unique, counts = np.unique(pairs, return_counts=True)
    top = np.argsort(counts)[::-1][:TOP_PAIRS]
    freq = np.bincount(idx[opaque], minlength=256)
    used = np.nonzero(freq)[0]
    return Background(bundle, resource_id, frame_index, unique[top] // 256, unique[top] % 256,
                      counts[top].astype(np.float64), used, freq[used] / freq.sum(),
                      frame.indices, frame.opaque)


def load_backgrounds(rsc_dir: Path, cache: Path) -> list:
    if cache.exists():
        return pickle.loads(cache.read_bytes())
    backgrounds = []
    for rsc_path in sorted(set(rsc_dir.glob("*.RSC")) | set(rsc_dir.glob("*.rsc"))):
        rf = NEResourceFile(str(rsc_path))
        for entry in rf.entries_of_type(TYPE_ASEQ):
            raw = rf.bytes_for(entry)
            if not is_aseq_image(raw):
                continue
            try:
                res = decode_aseq(raw)
            except AseqFormatError:
                continue
            for i, frame in enumerate(res.frames):
                if frame.width >= BACKGROUND_MIN_SIZE[0] and frame.height >= BACKGROUND_MIN_SIZE[1]:
                    bg = background_stats(rsc_path.stem.lower(), entry.numeric_id, i, frame)
                    if bg.counts.size:  # a flat single-colour frame can't be scored
                        backgrounds.append(bg)
    cache.write_bytes(pickle.dumps(backgrounds))
    return backgrounds


def score(palettes: np.ndarray, bg: Background) -> np.ndarray:
    """palettes: (N, 256, 3) -> (N,) scores, lower is better; inf if unjudgeable."""
    p = palettes.astype(np.float64)
    roughness = (np.abs(p[:, bg.first] - p[:, bg.second]).sum(-1) @ bg.counts) / bg.counts.sum()
    colours = p[:, bg.used]
    mean = (colours * bg.weights[None, :, None]).sum(1, keepdims=True)
    spread = (np.abs(colours - mean).sum(-1) * bg.weights).sum(1)
    out = roughness / np.maximum(spread, 1e-6)
    out[spread < MIN_SPREAD] = np.inf
    return out


def rank_backgrounds(palette: np.ndarray, backgrounds: list):
    """Returns [(score, Background), ...] best first for one (256, 3) palette."""
    scores = [(float(score(palette[None], bg)[0]), bg) for bg in backgrounds]
    return sorted(scores, key=lambda s: s[0])
