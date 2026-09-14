"""
extract_video.py

Converts the game's Smacker (.SMK) video files to WebM (VP9 + Opus) for
web playback, using ffmpeg's built-in Smacker demuxer/decoder.

Usage:
    python3 extract_video.py <movies_dir> <output_dir>
"""
import subprocess
import sys
from pathlib import Path


def convert_one(smk_path: Path, out_dir: Path, crf: int = 32) -> bool:
    out_path = out_dir / (smk_path.stem.lower() + ".webm")
    cmd = [
        "ffmpeg", "-y", "-i", str(smk_path),
        "-c:v", "libvpx-vp9", "-crf", str(crf), "-b:v", "0",
        "-c:a", "libopus",
        str(out_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  FAILED {smk_path.name}: {result.stderr[-300:]}", file=sys.stderr)
        return False
    return True


def main():
    movies_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    smk_files = sorted(movies_dir.glob("*.SMK")) + sorted(movies_dir.glob("*.smk"))
    smk_files = sorted(set(smk_files))

    ok = 0
    for smk in smk_files:
        print(f"converting {smk.name}...")
        if convert_one(smk, out_dir):
            ok += 1
    print(f"\n{ok}/{len(smk_files)} videos converted to {out_dir}")


if __name__ == "__main__":
    main()
