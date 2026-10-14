# Roadmap

Documented future work, in priority order. Each entry names what exists
today so the gap is explicit.

## Platform

- **macOS computer-use backend.** prricode's computer-use is X11-first
  (screenshots via `XGetImage`, input via XTEST) and runs on macOS only under
  XQuartz. The prricode's computer use is macOS accessibility-based.
  Next step: a macOS backend behind the existing `ComputerUse` trait using the
  Accessibility APIs (AXUIElement) for reading the UI tree and CGEvent for
  input injection; `computerUseSetup/check` reports the real permission state
  (Accessibility + Screen Recording in System Settings). The Linux backend and
  its tests stay as they are; the trait seam already exists.
- **Wayland screen capture.** Under a pure Wayland session without XWayland,
  screenshots go through `grim`/`wlr-screencopy`; input via `wlrctl`/portal
  (xdg-desktop-portal RemoteDesktop). Declared unsupported until then.

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

- **The remaining 19 themes** — five of the reference set's 24 are bundled;
  the JSON theme format is identical, so bundling the rest is a data task.
- **`?` shortcut overlay on an empty composer** — `/help` toggles the panel
  today; the literal key-when-empty binding is a follow-up.
- **Image paste (ctrl+v)** — `media/upload` exists server-side; composer
  clipboard integration is the follow-up.
- **Session picker list** — `/sessions` shows state today; a navigable picker
  of stored sessions is the follow-up.

## Verification

- **Autonomous rollback execution** — the ship stage records the rollback
  command and the previous release id; executing it on health-check failure
  without a prompt is the operate stage's last step.
- **Property-based test generation** — the verifier judges from concrete
  evidence today; generating property tests from EARS requirements text
  (fast-check/hypothesis) is the stronger oracle.

## Protocol

- **Approval timeout and abort decisions** — the `timed_out`/`aborted`
  decision variants exist in the spec's vocabulary; the transport-level
  timeout is not implemented.
