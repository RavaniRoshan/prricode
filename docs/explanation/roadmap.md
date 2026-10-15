# Roadmap

Documented future work, in priority order. Each entry names what exists
today so the gap is explicit.

## Platform

- **macOS computer-use backend.** DONE in v0.2.2: `unavailable_reason()` now
  names macOS and Windows as *platforms without a backend* instead of blaming
  a missing X display, and points at the interim X11 path. Still to do —
  implemented from a macOS host, where it can be compiled and exercised:
  - capture: `ScreenCaptureKit` (per-display, works with the Screen Recording
    permission) with `CGWindowListCreateImage` as the fallback; the existing
    `CaptureMethod` enum gains a macOS variant
  - input: `CGEvent` create/post for mouse and key events, behind the same
    `InputMethod` selection the Linux probe uses
  - the UI tree: `AXUIElement` reads replacing the AT-SPI-shaped `unknown`
    the Linux path reports today
  - permissions: `computerUseSetup/check` reporting the real state of
    Accessibility and Screen Recording in System Settings, which on macOS are
    per-app grants rather than a display-server extension
  Why it is not written here: none of it can be compiled or exercised from a
  Linux host, and committing untestable platform FFI would be worse than the
  documented gap.
- ~~**Wayland screen capture + input selection**~~ — DONE in v0.2.2. `grim`
  screencopy for screenshots; input selection across X11 XTEST, `wlrctl`,
  `ydotool`, and the portal, reported through `computerUseSetup/check` as
  `inputMethod` plus `inputUnavailableReason`.
- **Wayland input execution against a live compositor.** The selection is
  unit-tested; the wlrctl/ydotool paths have not run against a real
  compositor, and the portal consent handshake is not implemented.

## Voice

- ~~**Local speech**~~ — DONE in v0.2.2. `voice.stt_command` /
  `voice.ttt_command` run whatever is installed (`whisper.cpp`, `piper`, your
  own script) instead of the HTTP backend; see
  `docs/how-to/voice.md`. Nothing is bundled.
- **A bundled model manager.** Local speech needs the user's own build; a
  download-on-first-use manager is a future option.
- **Streaming ASR + wake word.** Input is file/turn-based today.

## Providers

- **vLLM / llama.cpp / LM Studio** endpoints — all are OpenAI-compatible and
  work today via `--provider custom`; first-class presets with model
  auto-discovery are the remaining work.

## TUI deltas

- **Theme set: COMPLETE** — all 24 reference themes + the house theme are
  bundled and switchable via `/theme` (two palettes, Houston and Snazzy Light,
  are best-effort pending upstream verification).
- **Image paste (ctrl+v): COMPLETE** — wl-paste/xclip clipboard capture,
  attach/detach in the composer, image parts ride the turn; attachments never
  enter composer history.
- **`?` shortcut overlay on an empty composer** — `/help` toggles the panel
  today; the literal key-when-empty binding is a follow-up.
- **Session picker list** — `/sessions` shows state today; a navigable picker
  of stored sessions is the follow-up.

## Brownfield

- ~~**Workspace survey**~~ — DONE in v0.1.1. A deterministic (no model, no
  network) read of stack, layout, and existing tests, folded into the spec
  and plan prompts, with the plan's first task told to preserve what is there
  instead of scaffolding a second project.
- ~~**Task reuse**~~ — DONE in v0.2.2. Plan tasks carry a `files` list of
  existing workspace-relative paths, enforced by a reuse gate: a task naming a
  file that is not there, or naming nothing, is rejected rather than building
  its own world.

## Verification

- **Autonomous rollback execution: COMPLETE** — armed at deploy-confirmation
  (default off); a failed health check runs the recorded rollback command
  through the sandbox and records the outcome in the operate log.
- **Approval timeout: COMPLETE** — configurable via
  `PRRICODE_APPROVAL_TIMEOUT_SECS` (default 600s), resolving as `timed_out`.')
- ~~**Cost per delivered outcome**~~ — DONE in v0.1.0. Tokens + gate wall
  time per verified requirement, persisted per run and rendered in the dossier
  and the TUI rail. See `docs/reference/protocol-conformance.md`.
- ~~**Property-based test generation**~~ — DONE in v0.1.1. Count and
  file-existence criteria become real assertions run as a `property`
  gate; anything the generator cannot check skips loudly and lands as
  UNVERIFIED. See `docs/reference/protocol-conformance.md`.
- ~~**Property-based test generation**~~ — DONE in v0.1.1. Count and
  file-existence criteria become real assertions run as a `property`
  gate; anything the generator cannot check skips loudly and lands as
  UNVERIFIED. See `docs/reference/protocol-conformance.md`.

## Protocol

