#!/usr/bin/env python3
"""Count words (default), lines, or characters in a file."""
import sys


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print("usage: wordcount.py <file> [--lines] [--chars]", file=sys.stderr)
        return 2
    path = args[0]
    try:
        with open(path, "r", encoding="utf-8") as handle:
            text = handle.read()
    except OSError as exc:
        print(f"cannot read {path}: {exc}", file=sys.stderr)
        return 1
    if "--lines" in sys.argv:
        print(f"lines {len(text.splitlines())}")
    elif "--chars" in sys.argv:
        print(f"chars {len(text)}")
    else:
        print(f"words {len(text.split())}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
