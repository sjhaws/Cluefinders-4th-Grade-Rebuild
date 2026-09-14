"""
extract_audio.py

Extracts every WAVE-type resource (NE type 0xff02 / 0xff03) from a set of
.RSC files, plus the RIFF/WAVE music tracks BGMUSIC.RSC stores under the
ASEQ type (0xff01). These are raw, standard RIFF/WAVE bytes with no
proprietary encoding at all -- confirmed by direct inspection. Extraction is
just "find it, write it."

Usage:
    python3 extract_audio.py <rsc_dir> <output_dir>
"""
import sys
from pathlib import Path

from ne_resource import NEResourceFile, TYPE_ASEQ, WAVE_TYPES


def extract_audio_from_file(rsc_path: Path, out_dir: Path) -> int:
    try:
        rf = NEResourceFile(str(rsc_path))
    except Exception as e:
        print(f"  skip {rsc_path.name}: {e}", file=sys.stderr)
        return 0

    count = 0
    bundle_stem = rsc_path.stem.lower()
    for type_id in WAVE_TYPES + (TYPE_ASEQ,):
        for entry in rf.entries_of_type(type_id):
            raw = rf.bytes_for(entry)
            if not raw.startswith(b"RIFF"):
                continue  # ASEQ images; every WAVE-type sample seen so far is a real RIFF
            out_name = f"{bundle_stem}_{entry.numeric_id}.wav"
            (out_dir / out_name).write_bytes(raw)
            count += 1
    return count


def main():
    rsc_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    total = 0
    rsc_files = sorted(rsc_dir.glob("*.RSC")) + sorted(rsc_dir.glob("*.rsc"))
    rsc_files = sorted(set(rsc_files))
    for rsc_path in rsc_files:
        n = extract_audio_from_file(rsc_path, out_dir)
        if n:
            print(f"{rsc_path.name}: {n} wav files")
        total += n
    print(f"\nTotal: {total} audio files extracted to {out_dir}")


if __name__ == "__main__":
    main()
