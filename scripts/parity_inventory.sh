#!/usr/bin/env bash
set -euo pipefail
SOURCE_ROOT="${1:-/tmp/reference-source}"
SRC="$SOURCE_ROOT/src"

echo "# Reference Inventory"
echo
echo "Source root: \`$SOURCE_ROOT\` (local recovered reference tree; research only, not shipped)"
echo

for d in commands tools services hooks components screens keybindings migrations plugins skills outputStyles; do
  if [ -d "$SRC/$d" ]; then
    echo "## $d"
    echo
    echo "Count: $(find "$SRC/$d" -mindepth 1 -maxdepth 1 | wc -l)"
    echo
    find "$SRC/$d" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | sed 's/^/- /'
    echo
  fi
done

echo "## Top-level src files"
echo
find "$SRC" -maxdepth 1 -type f -printf '%f\n' | sort | sed 's/^/- /'
