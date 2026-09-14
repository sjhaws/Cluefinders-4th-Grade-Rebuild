"""
parse_maps.py

RESOURCE.MAP and AUDIO.MAP are plain tab-delimited text files that catalog
every named resource across all the game's .RSC bundles. Format (confirmed
by inspection):

    <bundle filename>
    <TYPE>\t<numeric id>
    <TYPE>\t<numeric id>
    ...
    <bundle filename>
    ...

e.g.:
    cloc01i1.rsc
    ASEQ	3000
    ASEQ	3001

This module parses that into a nested dict: {bundle_filename: [(type, id), ...]}
"""
from pathlib import Path
from typing import Dict, List, Tuple


def parse_map_file(path: str) -> Dict[str, List[Tuple[str, int]]]:
    bundles: Dict[str, List[Tuple[str, int]]] = {}
    current_bundle = None

    text = Path(path).read_text(encoding="latin-1")
    for raw_line in text.splitlines():
        line = raw_line.rstrip("\r\n")
        if not line.strip():
            continue
        if line.startswith("\t"):
            # entry line: <TAB>TYPE<TAB>ID
            parts = line.split("\t")
            # parts[0] is '' (from the leading tab)
            if len(parts) < 3:
                continue
            type_name = parts[1].strip()
            try:
                res_id = int(parts[2].strip())
            except ValueError:
                continue
            if current_bundle is not None:
                bundles.setdefault(current_bundle, []).append((type_name, res_id))
        elif line.strip().lower().endswith(".rsc"):
            current_bundle = line.strip().lower()
        # else: header lines (date, count) — ignored
    return bundles


if __name__ == "__main__":
    import sys
    import json
    result = parse_map_file(sys.argv[1])
    print(json.dumps(result, indent=2)[:2000])
    total_entries = sum(len(v) for v in result.values())
    print(f"\n{len(result)} bundles, {total_entries} total entries", file=sys.stderr)
