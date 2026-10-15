# AGENTS.md — prricode

Reference for any agent (human or AI) working in this repository. Read this
first; it encodes the decisions that keep the codebase coherent.

## What this is

**prricode** — an autonomous AI coding agent for the terminal, built as an
open-source Rust workspace. It drives a JSON-RPC protocol over stdio, runs a
tool-calling agent loop against any OpenAI-compatible model backend, and
extends into the **Product Builder** pipeline: concept → clarify → specify →
plan → build → verify → ship → operate, turning an idea into a verified,
shippable product.

License: MIT. All code here is our own. **Never reference, name, or cite any
third-party product or company anywhere** — source, comments, docs, commit
messages,
identifiers. The protocol surface is our own design.

## Stack

- Rust 2021, Cargo workspace, 15 crates (see map below)
- tokio async runtime; ratatui + crossterm for the TUI
- serde/serde_json everywhere; rusqlite for persistence; reqwest for HTTP
- bubblewrap for Linux sandboxing; X11 (x11rb/xdotool/scrot) for computer use
- GitHub Actions CI: `cargo fmt --check`, `cargo clippy --workspace
  --all-targets -- -D warnings`, `cargo test --workspace`, Ollama e2e

## Non-negotiable rules

1. **Protocol compatibility**: the schema fingerprint and existing method
   shapes in `prricode-core` never change. New capabilities are additive
   (new methods, new fields with `#[serde(default)]`, new tools, new
   notifications).
2. **Public repo hygiene**: no third-party product or company names in code
   or docs; no
   secrets in the repo — credentials live in the 0600 credential store or env
   vars; user secrets in deploy flows are environment-only for child processes
   and redacted from every captured artifact.
3. **Every agent-facing behavior is a tool or a protocol method**, not hidden
   magic. New capabilities land in the tool registry or the dispatch match.
4. **Honest degradation**: a feature that cannot run degrades with a clear
   reason (`enabled: false`, `unsupported: <why>`), never fake success.
5. **TDD**: test first, watch it fail, implement, watch it pass. Every new
   crate ships tests; the workspace suite is the gate.
6. **`cargo fmt` before every commit; clippy `-D warnings` must stay at zero.**
7. **Agent isolation**: the verifier never shares context with the builder.
   Approvals gate sensitive actions; the approval engine is the only path to
   side effects.

## Crate map

| Crate | Responsibility |
|---|---|
| `prricode-core` | Protocol types, schema fingerprint (`sha256:6de32db0…`), 37 error kinds, internals disposition inventory |
| `prricode-cli` | clap CLI — 18 subcommands; bare `prricode` launches the TUI |
| `prricode-server` | JSON-RPC dispatch (85+ methods), sessions, goals, notifications |
| `prricode-agent` | Turn loop, tool registry, approval engine (timeout + policy amendments), subagents |
| `prricode-provider` | Echo + Ollama native + one OpenAI-compatible client (openrouter/kilo/openai/ollama-cloud/custom presets), TOML config, credential store |
| `prricode-persistence` | SQLite: sessions, items, goals, usage, settings, gate records |
| `prricode-sandbox` | bubblewrap execution, network toggle, path scoping |
| `prricode-computer-use` | X11 screenshots (XGetImage/scrot/import) + input (XTEST), Wayland probe (grim) |
| `prricode-workflow` | Workflow definitions + run state machine (pause/resume/cancel/child control) |
| `prricode-skills` | SKILL.md loading/import + script runtime (shebang interpreters via the sandbox) |
| `prricode-mcp` | MCP stdio client (initialize/tools_list/tools_call) |
| `prricode-voice` | STT/TTS traits + OpenAI-compatible `/audio/*` backend |
| `prricode-tui` | Interactive terminal UI: composer, streaming, approvals (y/s/a/n durability), 25 themes, image paste, `/command` bar, pipeline rail, `/ship` `/deploy` `/operate` |
| `prricode-spec` | Concept, EARS requirements, Core-4 layered specs, 5 stack presets, task graph + waves |
| `prricode-verify` | Gate runner (typecheck/build/test), adversarial verifier, acceptance dossier |
| `prricode-ship` | GitHub release path, agent-arranged deploy (env-only secrets + redaction), operate (health checks, run log, issue reopen, autonomous rollback) |
| `prricode-pipeline` | Stage orchestration: clarify → specify → plan → build → verify → ship → operate |

## Key flows (where to look)

- **One-off model call**: `prricode-cli/src/main.rs` `Command::Exec` →
  `prricode_provider::ModelProvider::chat`.
- **Protocol turn**: `prricode-server/src/lib.rs` `handle_turn_start` spawns
  `prricode-agent::AgentRunner::run_turn_cancellable`; items persist to
  `prricode-persistence`; notifications stream via `AgentEvent`.
- **Approvals**: sensitive tool calls go through
  `prricode-agent/src/approval.rs`; the TUI answers with y (once) / s
  (session) / a (always-in-workspace, persisted as a `PolicyAmendment`) / n;
  a timeout resolves as `timed_out` (denial).
- **Product Builder**: `prricode-pipeline/src/{clarify,specify,plan,build,
  verify,ship}.rs` — each stage is a step-driven state machine the TUI drives;
  specs live in the settings table under `pipeline:<sessionId>`.
- **Config resolution** (CLI > env > config.toml > credential store):
  `prricode-provider/src/config.rs::resolve`.

## Where things live

| What | Path |
|---|---|
| Docs site (mkdocs-material, published from `main`) | `mkdocs.yml`, `docs/index.md`, `.github/workflows/docs.yml` |
| Tutorial (start here) | `docs/tutorials/first-product.md` |
| Protocol reference | `docs/reference/protocol.md` |
| Conformance report | `docs/reference/protocol-conformance.md` |
| Visual/UX spec + implementation checklist | `docs/reference/visual-spec.md` |
| Conformance decisions (closed rulings) | `docs/explanation/conformance-decisions.md` |
| Launch status (audit, measurement surfaces, preregistered targets) | `docs/explanation/launch-status.md` |
| Product requirements | `docs/explanation/prd.md`, `docs/explanation/prd-onepager.md` |
| Implementation plans | `docs/plans/` |
| Roadmap (documented future work) | `docs/explanation/roadmap.md` |
| Config/credentials | `docs/how-to/connect-a-provider.md` |
| TUI guide (terminal-native: every command/setting in the TUI) | `docs/how-to/tui-guide.md` |
| Test matrix + live-provider verification | `docs/how-to/run-the-tests.md` |
| Contributing / security | `CONTRIBUTING.md`, `SECURITY.md` |

## Testing

- Unit + integration: `cargo test --workspace` (189 tests; scripted
  providers, mock HTTP servers, real temp-workspace tool execution).
- E2E: `tests/e2e.sh` drives `prricode serve` over stdio against local Ollama
  (`qwen2.5-coder:3b`) — session, turn, tool execution, `-32601`.
- Live-provider verification (manual, network; key in the environment only):
  `docs/how-to/run-the-tests.md` — catalog, one-off chat, a tool-calling turn over stdio,
  `session/setModel`, the credential store round-trip, and the TUI. Last run
  against OpenRouter's free catalog and Kilo's `:free` tier.
- Computer-use tests run against the live X11 display; the gate runner tests
  execute real cargo in temp workspaces.
- Never commit a test that fakes a real side effect; degrade with a reason or
  skip on the host.

## Documentation

Docs live under `docs/` in four Diátaxis quadrants — `tutorials/`,
`how-to/`, `reference/`, `explanation/` — with `docs/index.md` as the entry
point and `mkdocs.yml` building them into the published site. When you add a
doc, put it in the quadrant that matches its job and add it to the nav.
Every command, setting, and configuration must be documented from the TUI
first, with the file/env equivalent second.

## Current state (2026-10-15)

Protocol surface, TUI, agent loop, product-builder pipeline through operate,
verification moat, multi-provider layer, and the project's own-naming posture
are complete and CI-green. Live-provider verification is done (see Testing);
three bugs it or the audit surfaced are fixed and tested: the `auth token`
clap arg-id collision, a gateway error object answered with HTTP 200, and the
build stage stalling on approvals.

Every agent-facing surface is reachable from the TUI
(`docs/how-to/tui-guide.md`); the config file and env vars are the optional
equivalents (`docs/how-to/connect-a-provider.md`).

The first release is tagged `v0.1.0`. A launch-readiness preflight
(`docs/explanation/launch-status.md`) records what is verified, which
measurement surfaces are registered (owner-side GitHub analytics only — the
product itself ships no telemetry), and the preregistered D0/W1/M1 targets.
Roadmap items remaining (macOS computer-use backend, Wayland compositor
end-to-end, Houston/Snazzy palette verification, approval timeout transport
surface, a press/facts kit) are documented in `docs/explanation/roadmap.md`.
