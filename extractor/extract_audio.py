"""
extract_audio.py

Extracts every WAVE-type resource (NE type 0xff02 / 0xff03) from a set of
.RSC files, plus the RIFF/WAVE music tracks BGMUSIC.RSC stores under the
ASEQ type (0xff01). These are raw, standard RIFF/WAVE bytes with no
proprietary encoding at all -- confirmed by direct inspection -- all 8-bit
mono 22,050 Hz PCM. Each one is encoded to MP3 (LAME VBR quality 4, about
46 kbit/s) for the web, cutting the audio from 185 MB to 61 MB. LAME's header
records the encoder's padding, so browsers decode each sound to exactly the
original's samples, starting on the same one (checked in Chromium), and the
looping music tracks stay the length they loop at.

Usage:
    python3 extract_audio.py <rsc_dir> <output_dir>
"""
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ne_resource import NEResourceFile, TYPE_ASEQ, WAVE_TYPES


def encode_mp3(wav: bytes, out_path: Path) -> bool:
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-f", "wav", "-i", "pipe:0",
        "-c:a", "libmp3lame", "-q:a", "4", str(out_path),
    ]
    result = subprocess.run(cmd, input=wav, capture_output=True)
    if result.returncode != 0:
        print(f"  FAILED {out_path.name}: {result.stderr[-300:].decode(errors='replace')}", file=sys.stderr)
        return False
    return True


def extract_audio_from_file(rsc_path: Path, out_dir: Path, pool: ThreadPoolExecutor) -> list:
    try:
        rf = NEResourceFile(str(rsc_path))
    except Exception as e:
        print(f"  skip {rsc_path.name}: {e}", file=sys.stderr)
        return []

    jobs = []
    bundle_stem = rsc_path.stem.lower()
    for type_id in WAVE_TYPES + (TYPE_ASEQ,):
        for entry in rf.entries_of_type(type_id):
            raw = rf.bytes_for(entry)
            if not raw.startswith(b"RIFF"):
                continue  # ASEQ images; every WAVE-type sample seen so far is a real RIFF
            out_path = out_dir / f"{bundle_stem}_{entry.numeric_id}.mp3"
            jobs.append(pool.submit(encode_mp3, raw, out_path))
    return jobs


def main():
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not found (install it, e.g. `sudo apt install ffmpeg`)")
    rsc_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    rsc_files = sorted(rsc_dir.glob("*.RSC")) + sorted(rsc_dir.glob("*.rsc"))
    rsc_files = sorted(set(rsc_files))
    with ThreadPoolExecutor() as pool:
        for rsc_path in rsc_files:
            jobs = extract_audio_from_file(rsc_path, out_dir, pool)
            n = sum(job.result() for job in jobs)
            if jobs:
                print(f"{rsc_path.name}: {n} mp3 files")
            total += n
    print(f"\nTotal: {total} audio files extracted to {out_dir}")


if __name__ == "__main__":
    main()
