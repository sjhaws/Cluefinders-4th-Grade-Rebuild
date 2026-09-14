"""
build_manifest.py

Ties together parse_maps.py + the extraction outputs into one manifest.json
that the runtime web app consumes. This replaces RESOURCE.MAP/AUDIO.MAP
with a clean, web-friendly index.

Usage:
    python3 build_manifest.py <rsc_dir> <output_dir>

Expects extract_audio.py, extract_video.py, and extract_images.py to
have already been run against <output_dir>/audio, <output_dir>/video,
<output_dir>/images respectively (this script just indexes what's there;
run those first).
"""
import json
import sys
from pathlib import Path

from parse_maps import parse_map_file


def main():
    rsc_dir = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])

    resource_map = parse_map_file(str(rsc_dir / "RESOURCE.MAP"))
    audio_map = parse_map_file(str(rsc_dir / "AUDIO.MAP"))

    audio_files = {p.stem: p.name for p in (out_dir / "audio").glob("*.wav")} \
        if (out_dir / "audio").exists() else {}
    video_files = {p.stem: p.name for p in (out_dir / "video").glob("*.webm")} \
        if (out_dir / "video").exists() else {}

    aseq_index_path = out_dir / "images" / "aseq_index.json"
    aseq_index = json.loads(aseq_index_path.read_text()) if aseq_index_path.exists() else []

    manifest = {
        "generated_from": str(rsc_dir),
        "bundles": {**resource_map, **audio_map},
        "audio_files": audio_files,
        "video_files": video_files,
        "aseq_resources": aseq_index,
        "notes": (
            "aseq_resources: decoded entries reference RGBA sprite sheets under "
            "images/; palette=null means a placeholder palette was used. "
            "See extractor/FINDINGS.md."
        ),
    }

    decoded = [r for r in aseq_index if r.get("decoded")]
    out_path = out_dir / "manifest.json"
    out_path.write_text(json.dumps(manifest, separators=(",", ":")))  # loaded by the app at startup
    print(f"Manifest written to {out_path}")
    print(f"  {len(manifest['bundles'])} bundles catalogued")
    print(f"  {len(audio_files)} audio files")
    print(f"  {len(video_files)} video files")
    print(f"  {len(decoded)}/{len(aseq_index)} ASEQ resources decoded "
          f"({sum(1 for r in decoded if r.get('palette') is None)} with placeholder palette)")


if __name__ == "__main__":
    main()
