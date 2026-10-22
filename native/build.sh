#!/bin/sh
# The build of the native sandbox helper.
#
# Evidence: `docs/reverse-engineering/COVERAGE-AUDIT.md` §2.9 — the helper is
# a native worker that performs the kernel calls (the namespace unshare, the
# mounts, the `prctl` calls, the seccomp filter with the listener, the two
# notification ioctls, `process_vm_readv`) that the launcher's TypeScript
# process cannot issue.
#
# The build is deliberate and loud:
#
#   - it never silently falls back to the previous backend or to a no-op
#     build: a compiler or a source that is missing ends the build with a
#     named error and a non-zero status;
#   - it emits a standalone ELF worker whose name never ends in `.node` —
#     a `.node` file would register with the JavaScript loader, and this
#     implementation ships no native addon — and it refuses such a name;
#   - it writes to a temporary file and moves it into place, so a failed
#     build never leaves a stale worker behind for a caller to trust.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
src="$root/native/src/sandbox-helper.c"
out="$root/native/build/sandbox-helper"

if ! command -v cc >/dev/null 2>&1; then
  echo "Error: the C compiler (cc) is not on the PATH; the native sandbox helper cannot be built." >&2
  exit 1
fi
if ! test -r "$src"; then
  echo "Error: the helper's source is not readable at $src." >&2
  exit 1
fi
case "$out" in
  *.node)
    echo "Error: the helper's output name would end in '.node', and this implementation ships no native addon." >&2
    exit 2
    ;;
esac

mkdir -p "$(dirname -- "$out")"
tmp="$out.build.$$"
rm -f -- "$tmp" "$out"

cc -O2 -std=c11 -Wall -Wextra -Werror -o "$tmp" "$src"
mv -- "$tmp" "$out"

echo "Built $out"
