# Roadmap

Documented future work, in priority order. Each entry names what exists
today so the gap is explicit.

## Platform

- **macOS computer-use backend.** prricode's computer-use is X11-first
  (screenshots via `XGetImage`, input via XTEST) and runs on macOS only under
  XQuartz, so it is X11-only there today.
  Next step: a macOS backend behind the existing `ComputerUse` trait using the
  Accessibility APIs (AXUIElement) for reading the UI tree and CGEvent for
  input injection; `computerUseSetup/check` reports the real permission state
  (Accessibility + Screen Recording in System Settings). The Linux backend and
  its tests stay as they are; the trait seam already exists.
- **Wayland screen capture.** The `grim` path is probed and wired; a pure
  Wayland session without XWayland now captures via `grim` (screencopy), and
  input via `wlrctl`/portal (xdg-desktop-portal RemoteDesktop) is the
  remaining piece.

## Voice

- **Local speech.** The STT/TTS traits are OpenAI-compatible HTTP today; a
  bundled `whisper.cpp`/`piper` backend (feature-flagged, downloaded on first
  use) would make voice work fully offline.
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

