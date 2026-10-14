# prricode

**An autonomous AI coding agent that lives in your terminal.**

prricode reads your request, opens your codebase, and does the work — reads
files, writes edits, runs builds and tests, greps for that one symbol, fetches
the docs, and (when you allow it) drives the screen. It speaks a stable
JSON-RPC protocol over stdio, so any editor, TUI, or script can drive it.

It is terminal-native: run `prricode` with no arguments and the whole agent is
a TUI — sessions, providers, models, themes, approvals, and the Product Builder
pipeline are all commands you type, not flags you memorise.

```
$ prricode                                   # the TUI — the default way in
$ prricode exec "add a --json flag to the export command and test it" --provider ollama
```

## What it does

- **Actually works, not just talks** — a real agent loop with tools: `shell`
  (sandboxed), `read_file`, `write_file`, `edit_file`, `glob`, `grep`,
  `web_fetch`, `task` (subagents), and `computer` (screen + input).
- **Bring any model** — one OpenAI-compatible client with first-class presets
  for Ollama (local and cloud), OpenRouter, the Kilo AI Gateway, OpenAI, and
  any custom endpoint. Offline echo provider for tests. Switch provider and
  model live from the TUI (`/provider`, `/model`) — no restart.
- **Remembers** — every message, tool call, and result is persisted in SQLite.
  Resume, fork, and compact sessions across runs.
- **Goals** — set an objective and let it iterate autonomously until it
  reports done. Pause, resume, or retarget any time.
- **Approval modes that fit your risk appetite** — ask, auto-approve, or
  suggest-and-wait. Sensitive actions never run silently: three durability
  tiers (once / session / always-in-this-workspace, the last persisted as a
  policy amendment) and a timeout that denies rather than hangs.
- **Computer use** — screenshot, click, type, and scroll over X11, gated by
  the same approval system. See `docs/COMPUTER_USE.md`.
- **25 themes, image paste** — 25 bundled JSON themes (`/theme`), plus your own
  in `~/.config/prricode/themes/`. Paste a screenshot straight into the
  composer with `Ctrl+V`; the model sees it.
- **Credentials, stored safely** — `prricode auth token <provider>` keeps keys
  in a 0600 store; keys never land in the repo or in logs.
- **Skills** — `SKILL.md` capability bundles that extend what the agent knows.
  See `docs/SKILLS.md`.
- **Workflows** — multi-step runs with pause/resume and child retry/skip.
- **Voice, when the model has ears** — STT/TTS plumbing over OpenAI-compatible
  audio endpoints. See `docs/VOICE.md`.
- **MCP-ready** — a stdio MCP client for Model Context Protocol servers.

## Pick your brain

| Provider | `--provider` | Key env | Notes |
|---|---|---|---|
| Echo (offline) | `echo` | — | No network; replies `echo: <text>`. Tests and protocol debugging. |
| Ollama (local) | `ollama` | — | `/api` native surface with tools. |
| Ollama Cloud | `ollama-cloud` | `OLLAMA_API_KEY` | Hosted models, same account. |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Hundreds of models, one key. |
| Kilo AI Gateway | `kilo` | `KILO_API_KEY` | `:free` models work anonymously. |
| OpenAI | `openai` | `OPENAI_API_KEY` | |
| Anything else | `custom` | yours | Any OpenAI-compatible endpoint via `--base-url`. |

## The terminal is the interface

prricode is terminal-native. Run it with no subcommand and the agent is a TUI
— and every setting, command, and configuration is reachable from the
composer. There is no config file you must write, and no second app to learn.
The config file and environment variables exist as *optional equivalents* for
those who prefer files or CI; the TUI reads them at startup.

- **Composer**: `Return` sends, `Ctrl+J` newline, `Ctrl+R`/`Ctrl+P`/`Ctrl+N`
  history, `Ctrl+G` edit in `$EDITOR`, `Alt+B`/`Alt+F` word moves, `Ctrl+K`/
  `Ctrl+Y` kill/yank, `Ctrl+L` clear
- **`@`** insert a file path, **`!cmd`** run a shell command in the workspace,
  **`Ctrl+V`** paste an image from the clipboard
- **`Ctrl+C`/`Esc`** interrupt a running turn without losing the session
- **Approvals inline**: sensitive tool calls pause with
  `y` allow-once / `s` allow-for-session / `a` always-in-this-workspace / `n`
  deny — and time out into a denial rather than hanging
- **Slash commands** — settings and pipeline, all in-app:

  | Group | Commands |
  |---|---|
  | Session | `/new`, `/resume`, `/sessions`, `/clear`, `/compact`, `/quit` |
  | Settings | `/model`, `/provider`, `/approval`, `/yolo`, `/theme`, `/goal` |
  | Product Builder | `/concept`, `/spec`, `/plan`, `/build`, `/ship`, `/deploy`, `/operate`, `/dossier` |
  | Info | `/help`, `/?` |

The full keymap, the approval flow, theming, and the file/env equivalents are
in [`docs/TUI-GUIDE.md`](docs/TUI-GUIDE.md).

```bash
prricode                                  # pick your provider/model, start talking
prricode --provider ollama --model qwen2.5-coder:3b
```

## Quickstart

```bash
git implementation https://github.com/RavaniRoshan/prricode.git
cd prricode
cargo build --release

# the TUI — the default way in: provider/model are picked or typed in-app
./target/release/prricode

# offline, no model needed
./target/release/prricode exec "summarize this repo" --provider echo

# local model
ollama pull qwen2.5-coder:3b
./target/release/prricode exec "create hello.py that prints hi, then run it" \
  --provider ollama --model qwen2.5-coder:3b

# free hosted model, no key
./target/release/prricode exec "say hi" --provider kilo --model liquid/lfm-2.5-2.6b:free

# serve the protocol over stdio
./target/release/prricode serve --provider ollama
```

A JSON-RPC session in three lines:

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-ui","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"session/start","params":{"commandId":"…","workspaceRoot":"/path/to/project"}}
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"commandId":"…","sessionId":"…","input":[{"type":"text","text":"fix the failing test"}]}}
```

Progress streams back as notifications: `turn/item` deltas, `tool_use`,
`approval/requested`, `turn/completed`.

## The Product Builder

prricode is growing from a coding agent into a **product builder**: concept in,
running product out. A gated pipeline — Concept → Clarify → Specify → Plan →
Build → Verify → Ship → Operate — where each stage exits only on a
machine-checkable verdict, an independent verifier judges work the builder
never sees, and the reviewable artifact is an acceptance dossier, not a diff.
The whole pipeline is driven from the TUI: `/concept` starts the interview,
`/spec`, `/plan`, `/build` run the stages, `/ship` and `/deploy` deliver,
`/operate` watches, and `/dossier` opens the acceptance dossier.

- **Specify** — EARS-checked requirements and a layered spec (product,
  requirements, design, backend, frontend, infra, non-functional), each
  acceptance criterion a property the verifier can check.
- **Plan** — a dependency-ordered task graph grouped into waves; independent
  tasks run concurrently, dependent ones gate.
- **Build** — every task executes in an isolated worktree and must clear its
  gate (typecheck + build + test) before anything advances.
- **Verify** — the verifier never shares context with the builder: it reads the
  requirement, not the conversation, and returns a per-requirement verdict.
- **Ship** — a GitHub release + install steps as the default path (zero
  credentials), or an optional agent-arranged deploy that proposes a target
  from the product's stack and asks for exactly the credentials it needs
  (masked, environment-only, redacted from every artifact).
- **Operate** — health checks, the run log, issue reopen when a change breaks
  in production, and autonomous rollback on regression.

- [`docs/PRD.md`](docs/PRD.md) — the full product requirements document
- [`docs/PRD-onepager.md`](docs/PRD-onepager.md) — the positioning card

## Under the hood

```
prricode/
  crates/
    prricode-core/        protocol types, schema fingerprint, 37 error kinds
    prricode-cli/         18 subcommands; bare `prricode` launches the TUI
    prricode-server/      JSON-RPC dispatch, sessions, goals, notifications
    prricode-agent/       turn loop, tool registry, approval engine
    prricode-provider/    echo + ollama + OpenAI-compatible presets, credential store
    prricode-persistence/ SQLite: sessions, items, goals, usage, settings
    prricode-sandbox/     bubblewrap execution
    prricode-computer-use/ X11 screenshots + input, Wayland probe
    prricode-workflow/    workflow runs with child control
    prricode-skills/      SKILL.md loading and import
    prricode-mcp/         MCP stdio client
    prricode-voice/       speech-to-text / text-to-speech plumbing
    prricode-tui/         the terminal UI: 25 themes, image paste, /commands
    prricode-spec/        EARS requirements, layered specs, task graph + waves
    prricode-verify/      gate runner, adversarial verifier, acceptance dossier
    prricode-ship/        release path, deploy, operate (rollback)
    prricode-pipeline/    stage orchestration for the Product Builder
  docs/                   protocol, configuration, TUI, and operator docs
  tests/                  e2e scenario driving the real binary
```

The tool-calling layer is built for small models: fenced-JSON recovery,
argument repair, dedupe, and retry — so a 3B model running on your laptop
still lands its tool calls.

## Documentation

- `docs/TUI-GUIDE.md` — **the terminal is the interface**: every command, key,
  and setting, all reachable from the TUI
- `docs/PROTOCOL.md` — the JSON-RPC surface: methods, types, error codes
- `docs/CONFIGURATION.md` — providers, keys, config file (the TUI equivalents
  are listed alongside)
- `docs/COMPUTER_USE.md` — permissions, actions, Xvfb testing
- `docs/SKILLS.md` — skill format, import, authoring
- `docs/VOICE.md` — speech setup
- `docs/ARCHITECTURE.md` — request path, storage, notifications
- `docs/TESTING.md` — test matrix and e2e scenarios
- `docs/PROTOCOL-CONFORMANCE.md` — protocol conformance report

## Development

```bash
cargo build
cargo test --workspace
cargo clippy --workspace
cargo fmt --check
```

## License

MIT — see [LICENSE](LICENSE).
