"""
extract_video.py

Converts the game's Smacker (.SMK) movies to MP4 (H.264 + AAC) for web
playback, using ffmpeg's built-in Smacker demuxer/decoder. MP4 plays in
every current browser, including Safari on iOS; the movies are 640x480 at
8 fps with 22 kHz mono audio, so the files stay small.

Usage:
    python3 extract_video.py <game_dir> <output_dir>

Movies live in both cdrom/RSC and cdrom/MOVIES, so <game_dir> is searched
recursively. Output names are the lower-case stem, e.g. mvtitle.mp4.
"""
import shutil
import subprocess
import sys
from pathlib import Path


def convert_one(smk_path: Path, out_dir: Path, crf: int = 20) -> bool:
    out_path = out_dir / (smk_path.stem.lower() + ".mp4")
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-i", str(smk_path),
        "-c:v", "libx264", "-crf", str(crf), "-preset", "slow", "-tune", "animation",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "96k", "-ar", "44100",
        "-movflags", "+faststart",
        str(out_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  FAILED {smk_path.name}: {result.stderr[-300:]}", file=sys.stderr)
        return False
    return True


def main():
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found (install it, e.g. `sudo apt install ffmpeg`)")
    game_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    smk_files = sorted({p for p in game_dir.rglob("*") if p.suffix.lower() == ".smk"})

    ok = 0
    for smk in smk_files:
        print(f"converting {smk.name}...")
        if convert_one(smk, out_dir):
            ok += 1
    print(f"\n{ok}/{len(smk_files)} videos converted to {out_dir}")


if __name__ == "__main__":
    main()
