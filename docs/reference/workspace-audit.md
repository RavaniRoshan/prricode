# Workspace Audit

## Crates and implemented surfaces

- `prricode-core`: protocol types, schema fingerprint, error kinds, internals disposition inventory.
- `prricode-cli`: clap CLI, 18 subcommands, bare launches TUI.
- `prricode-server`: JSON-RPC dispatch (methods listed in lib.rs), sessions, goals, notifications.
- `prricode-agent`: turn loop, tool registry (Shell, Read, Write, Edit, ListDir, Glob, Grep, WebFetch, Computer, Task, Mcp, Workflow, GoalComplete), approval engine, subagents.
- `prricode-provider`: Echo + Ollama native + OpenAI-compatible client, TOML config, credential store.
- `prricode-persistence`: SQLite sessions, items, goals, usage, settings, gate records.
- `prricode-sandbox`: bubblewrap execution, network toggle, path scoping.
- `prricode-computer-use`: X11 screenshots/input, Wayland probes.
- `prricode-workflow`: workflow definitions + run state machine.
- `prricode-skills`: SKILL.md loading/import + script runtime.
- `prricode-mcp`: MCP stdio client.
- `prricode-voice`: STT/TTS traits + backends.
- `prricode-tui`: interactive UI, composer, streaming, approvals, themes, image paste, command bar, pipeline rail.
- `prricode-spec`: concept, EARS, specs, task graph.
- `prricode-verify`: gate runner, adversarial verifier, dossier.
- `prricode-ship`: release, deploy, operate.
- `prricode-pipeline`: stage orchestration.
- `prricode-web`: (present in workspace members? check) web surfaces.

## Known gaps (parity-relevant)

- Tool surface is much smaller than the reference (no AskUserQuestion, PlanMode, Worktree, NotebookEdit, TodoWrite, Task* family, LSP, ToolSearch, Brief, Config, etc.).
- Slash command surface is limited (~25 commands vs 101).
- No non-interactive print mode/output formats.
- No LSP client integration in agent tools.
- Voice and vim surfaces are partial.
- Coordinator/multi-agent mode not implemented.
- Plugin system is partial.
- Remote/bridge/server mode partial.
- Cron/scheduled triggers partial.
- Usage/cost tracking needs verification.

## Unwired code paths

- Search for `todo!`/`unimplemented!` found only two `unreachable!` in pipeline loops.
- Several TUI commands are server-side placeholders (`/message`, `/ts`, `/ps`).
- Many reference commands are absent entirely.

## Server dispatch method count

See `crates/prricode-server/src/lib.rs` dispatch match for the current list (approx. 90+ methods).
