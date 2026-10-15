# Conformance Decisions

The decision log for the protocol-conformance pass: each item names what was
decided, why, and where it landed. Read
[`docs/PROTOCOL-CONFORMANCE.md`](PROTOCOL-CONFORMANCE.md) for what the surface
*is*; this file records how the ambiguous parts were resolved.

All items are closed. Where a decision deferred work, the deferral is recorded
in [`docs/ROADMAP.md`](ROADMAP.md).

## Decision — the compatibility target is the specification

The schema fingerprint commits prricode to the specified surface (69 methods, 39
notifications, 37 error kinds, 18 CLI subcommands, 6 capabilities). Every
handler is either implemented or an honest "not available" result with a
reason; nothing fakes success.

**Where:** `crates/prricode-core/src/protocol.rs` (fingerprint, error kinds),
`crates/prricode-server/src/lib.rs` (dispatch).

## Decision — skill scripts run as interpreter subprocesses

A skill may ship `scripts/` and the agent invokes them through the sandboxed
shell tool with a documented argv contract
(`python3 <skill-dir>/scripts/<helper> <args>`); python3/node/bash are
prerequisites of the skills themselves, so a subprocess adds zero user effort.
No embedded JS runtime: it would add ~100MB for a runtime the skill format does
not require.

**Flag:** `skills.runtime = "subprocess"`, documented in
`docs/ARCHITECTURE.md`. An embedded-runtime option stays a roadmap item.

**Where:** `crates/prricode-skills` (script runtime),
`skills/wordcount/` (reference example), plus an e2e test that ships a python3
helper skill and runs it.

## Decision — TUI behavior over TUI appearance

The TUI implements the documented behavioral contract: the full composer
keymap, the approval modal's three durability tiers (allow once / for session /
**always in this workspace**) backed by a `PolicyAmendment` model with
`shell_command_exact_raw`/`argv_prefix` matchers, the status/rail fields, and
three risk-class footer variants that relabel the approve key.

Colors, panel structure, and copy are prricode's own design language; the
*behavioral* contract is what had to match.

**Where:** `docs/VISUAL-SPEC.md` (spec + implementation checklist),
`crates/prricode-tui` (implementation, 51 tests).

## Decision — internal engine types are dispositioned, not mirrored

The engine surface has 251 internal type families with no protocol-wire
presence. Each is dispositioned in
`prricode_core::internals::inventory()` as **Implemented** (the concept exists
under our own naming — mirroring their names would add compatibility debt, not
conformance) or **Flagged** (a `// future work:` entry naming what is not
built). The unaccounted-internals check is empty.

**Where:** `crates/prricode-core/src/internals.rs`,
`docs/INTERNALS-DISPOSITION.md`.

## Decision — prricode's own credential store, external OAuth flagged off

Credential resolution is env > config > the 0600 store, formalized as
`prricode auth token/status` (and `prricode logout [provider]` to drop one, or
all). The external OAuth protocol methods (`accountLogin/start|cancel`,
`auth/deviceLogin`, `auth/supersedeLoginCredential`, `subscription/activate`,
`mcpServer/oauthLogin|cancel`) stay present on the wire as flagged-off no-op
handlers with `// future work:` comments, returning a documented "not enabled"
result — never silently succeeding.

**Where:** `crates/prricode-provider/src/credentials.rs`,
`crates/prricode-cli` (`auth`, `login`, `logout`), `docs/CONFIGURATION.md`.

## Deferred — macOS computer-use backend

Computer use is X11-first (screenshots via `XGetImage`/scrot/import, input via
XTEST) with a Wayland capture probe behind `grim`. A macOS accessibility
backend (AXUIElement for the UI tree, CGEvent for input) is the next platform
target, behind the existing `ComputerUse` trait.

**Where:** `docs/ROADMAP.md`, `crates/prricode-computer-use`.

## Documented — CLI subcommand count

The 18-subcommand surface is a superset of the smallest earlier command set in
the family; the delta is documented in the conformance report rather than
"fixed" by dropping commands.

**Where:** `docs/PROTOCOL-CONFORMANCE.md` (CLI section).

---

**All items closed.** Final gates at close: build clean, clippy `-D warnings`
zero, fmt clean, 189 workspace tests passing, full Ollama e2e
(`tests/e2e.sh`) PASS, and CI green on both jobs.
