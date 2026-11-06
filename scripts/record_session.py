#!/usr/bin/env python3
"""Regenerate foundry_core/session.json: run the demo script on a fresh fixture and save the recording.

    python3 scripts/record_session.py            # write foundry_core/session.json
    python3 scripts/record_session.py --check    # exit 1 if the committed file is stale
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from foundry_core.recording import BUNDLED, record  # noqa: E402


def main() -> int:
    text = json.dumps(record(), indent=1, sort_keys=True) + "\n"
    if "--check" in sys.argv:
        ok = BUNDLED.exists() and BUNDLED.read_text() == text
        print("session.json is current" if ok else "session.json is STALE: run scripts/record_session.py")
        return 0 if ok else 1
    BUNDLED.write_text(text)
    print(f"wrote {BUNDLED} ({len(text)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
