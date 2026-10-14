# Conformance Gap Register

The closure queue for the goal *"zero open gaps"*. Each gap names its evidence, its closure plan, and its disposition (implement / flag-off / roadmap). Updated as items close.

## Basis ruling (recorded 2026-10-14)

The installed binary is **the latest public release**: its sha256
(`50937b6470cd0edf…`) exactly matches the `x86_linux` artifact in the official
`stable` channel manifest for `the release`. No newer public build exists
(`latest`/`beta` channels: Not Found). The 69-method camelCase
protocol surface from the original mapping could not have come from this build
(the release has 12 CLI subcommands and `untrusted|on-request|never` approval modes,
not 18 and `closed|open|auto|suggestive`) — it came from a earlier build.

**Disposition:** the protocol specification remains the compatibility contract (the
schema fingerprint commits to it). the release is the extraction source for the
visual/UX spec and for re-verification of everything it does contain. Every
claim in `docs/PROTOCOL-CONFORMANCE.md` carries its basis: *binary-verified
(the release)* or *prior-mapping (unverifiable against any available build)*.

## Runtime ruling (recorded 2026-10-14)

Evidence in the release: skill/plugin scripts execute via **interpreter subprocess** —
the binary carries the invocation template
`python3 <skill-dir>/scripts/find-session.py <session-id> --source auto --cwd "$PWD"`,
bundled plugins ship `scripts/*.py` (find-session.py, session-evidence.py), and
JS appears only as *generated artifacts* (`caps:generated-js-workflow`) and a web
asset (`header.min.js`). There is no embedded CPython or V8 runtime in this
build; the prior "Rust+V8" description belongs to the earlier build.

**Disposition (adjusts goal item 3):** prricode's skill runtime reaches parity via
**subprocess interpreter execution** (python3 / node / bash) through the existing
sandboxed shell tool — the same mechanism Reference uses. No deno_core embed: it would
add ~100MB for a runtime the latest public build does not contain, and a
subprocess adds zero user effort (python3/node are prerequisites of the skills
themselves). Flag: `skills.runtime = "subprocess"` documented in
`docs/ARCHITECTURE.md`; a future embedded-runtime option stays a roadmap item.

## Gap 1 — Visual TUI spec (goal item 2) — SPEC EXTRACTED ✅ (implementation next)

`docs/VISUAL-SPEC.md` (318 lines, commit `face055`) now documents, with
per-claim evidence (string excerpts, the keymap rodata table at vaddr
`0x5590048`, four bounded disassembly regions): the ~30-command slash table,
the full keymap (all our bindings verified verbatim plus ~10 more:
alt+enter queue/steer, ctrl+b background, ctrl+o expand, `@` file paths,
`!` shell mode, alt+d delete-word), the approval modal's three durability
tiers (allow once / for session / **always in this workspace**) backed by a
`PolicyAmendment{effect, durability, reason}` model with
`shell_command_exact_raw`/`argv_prefix` matchers, the status/rail fields, the
session picker semantics, and the style evidence: **no box-drawing frames, no
ANSI bytes, no sidebar — a single transcript pane plus modal drawers, with 24
bundled JSON themes** (Ayu, Catppuccin, Dracula, … Tokyo Night) carrying
TextMate scope maps. Internal crate paths leaked in the binary confirm the
pane+modal architecture (`crates/tui/src/render/panels/settings_overlay.rs`).
Three risk-class footer variants (`review_needed`/`elevated`/`blocking`) relabel
the approve key.

**Remaining for Gap 1:** (b) implement the spec deltas in our TUI — theme system DONE (0bb0072, 5 bundled themes, /theme, 141 tests); approval durability tiers DONE (5ffba11); keybindings DONE (521aab5: alt+d, @-picker, !-shell-mode, ctrl+o, ctrl+b, alt+enter); commands DONE (2d7b991: /yolo /goal /compact + honest stubs /message /ts /ps, risk-class footers); REMAINING: the spec→implementation→test checklist (Gap 1c)
amendment, the extra slash commands
(`/compact`, `/goal`, `/yolo`, `/message`, `/ts`, `/ps`), the risk-class
footers — aligned with our design language; (c) the spec→implementation→test
checklist.

## Gap 1 archive — original evidence list

**Evidence (the release strings):** keymap (`ctrl+j` newline, `ctrl+r` history
search, `ctrl+g` edit in `$VISUAL`/`$EDITOR`, `alt+b/f` word moves, `ctrl+k/y`
kill/yank, `esc` close/cancel), slash commands (`/model`, `/sessions`,
`/settings`, `/provider`, `/new`, `/resume`, `/clear`, `/export`, `/quit`),
composer vocabulary ("composer draft", "enter save - esc cancel", "esc close"),
approval outcomes (`allow:approved`, `allow:approved_for_session`), session
picker text ("No other local sessions"), status strings ("answer the pending
approval first", "build 427…"), gate semantics.

**Closure:** (a) write `docs/VISUAL-SPEC.md` from the extracted vocabulary
+ a disassembly pass over the render strings region for layout labels;
(b) implement the spec in the ratatui TUI aligned with prricode's design
language (colors, panel structure may be ours — the *behavioral* contract is
theirs); (c) a checklist mapping every spec item → code location + test.

**Disposition:** implement (goal item 2).

## Gap 2 — Internal types (goal item 4) — CLOSED (ec40bbb)

`prricode_core::internals` dispositions all 251 binary families (implemented / flagged-with-future-work); the unaccounted-internals grep is empty.

**Evidence:** 364 `struct X with N elements` Debug names in the release
(AgentSpawn*, BranchSeed*, CodeMode*, reminder/inbox records, …) — runtime
internals with no protocol presence.

**Closure:** each is either implemented (the ones the pipeline actually needs:
agent lineage/reminders) or carries a flagged-off code path with a
`// future work:` comment naming it. `docs/PROTOCOL-CONFORMANCE.md` loses the
unaccounted-internals paragraph; this register tracks each item.

**Disposition:** implement-or-flag (goal item 4).

## Gap 3 — Skill/plugin runtime — CLOSED (3c0f88c)

Shebang-interpreter script execution through the sandboxed shell tool with the documented argv contract; bundled wordcount skill + e2e test.

**Closure:** `prricode-skills` gains script execution: a skill may ship
`scripts/`; the agent invokes them via the sandboxed shell tool with the
documented argv contract (`python3 <skill-dir>/scripts/<helper> <args>`),
mirroring the binary's template. Covered by a test that ships a python3 helper
skill and runs it.

**Disposition:** implement via subprocess (see Runtime ruling).

## Gap 4 — Auth (goal item 5)

**Closure:** prricode's own credential flow (env + config, already 80% there
from the provider layer) is formalized as `prricode auth`; the External OAuth
protocol methods (`accountLogin/start|cancel`, `auth/deviceLogin`,
`auth/supersedeLoginCredential`, `subscription/activate`,
`mcpServer/oauthLogin|cancel`) become flagged-off no-op handlers with
`// future work: external OAuth providers` comments — present on the wire,
returning a documented "not enabled" result, never silently succeeding.

**Disposition:** implement-our-own + flag-off-theirs (goal item 5).

## Gap 5 — macOS computer-use (goal item 6)

**Disposition:** roadmap only — `docs/ROADMAP.md` records the macOS
accessibility backend as the next platform target (founder ruling: skipped in
this goal).

## Gap 6 — CLI subcommand count (18 vs the release's 12)

**Closure:** document the delta in the conformance report with basis
(prior-mapping), no code change — our CLI is a superset.

**Disposition:** documented.

---

**Queue order (updated):** Gap 1a spec ✅, Gap 1b themes ✅ → 1b remainder (approval tiers, keybindings, commands, risk footers, checklist) → Gap 2 (internals) → Gap 3 (runtime) →
Gap 4 (auth) → Gap 5/6 (docs). Gates rerun after each gap closes.
