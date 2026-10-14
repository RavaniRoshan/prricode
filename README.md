# prricode

**An autonomous AI coding agent that lives in your terminal.**

prricode reads your request, opens your codebase, and does the work — reads
files, writes edits, runs builds and tests, greps for that one symbol, fetches
the docs, and (when you allow it) drives the screen. It speaks a stable
JSON-RPC protocol over stdio, so any editor, TUI, or script can drive it.

```
$ prricode exec "add a --json flag to the export command and test it" --provider ollama
```

## What it does

- **Actually works, not just talks** — a real agent loop with tools: `shell`
  (sandboxed), `read_file`, `write_file`, `edit_file`, `glob`, `grep`,
  `web_fetch`, `task` (subagents), and `computer` (screen + input).
- **Bring any model** — one OpenAI-compatible client with first-class presets
  for Ollama (local and cloud), OpenRouter, the Kilo AI Gateway, OpenAI, and
  any custom endpoint. Offline echo provider for tests.
- **Remembers** — every message, tool call, and result is persisted in SQLite.
  Resume, fork, and compact sessions across runs.
- **Goals** — set an objective and let it iterate autonomously until it
  reports done. Pause, resume, or retarget any time.
- **Approval modes that fit your risk appetite** — ask, auto-approve, or
  suggest-and-wait. Sensitive actions never run silently.
- **Computer use** — screenshot, click, type, and scroll over X11, gated by
  the same approval system. See `docs/COMPUTER_USE.md`.
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

## The interactive session

Running `prricode` with no subcommand opens the terminal UI — the default
way to work with the agent:

- **Composer**: `Return` sends, `Ctrl+J` newline, `Ctrl+R`/`Ctrl+P`/`Ctrl+N`
  history, `Ctrl+G` edit in `$EDITOR`, `Alt+B`/`Alt+F` word moves, `Ctrl+K`/
  `Ctrl+Y` kill/yank, `Ctrl+L` clear
- **Approvals inline**: sensitive tool calls pause with
  `y` allow-once / `a` allow-for-session / `n` deny
- **`Ctrl+C`/`Esc`** interrupt a running turn without losing the session
- **Slash commands**: `/model`, `/sessions`, `/new`, `/resume`, `/clear`,
  `/approval`, `/provider`, `/settings`, `/help`, `/quit`

```bash
prricode                                  # pick your provider/model, start talking
prricode --provider ollama --model qwen2.5-coder:3b
```

## Quickstart

```bash
git clone https://github.com/RavaniRoshan/prricode.git
cd prricode
cargo build --release

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
The engine that exists today (agent loop, tools, sandbox, workflow, sessions)
is the foundation; the spec, verification, ship, and operate stages are the
roadmap.

v0.1 covers Concept → Clarify → Specify → Plan → Build-with-gates — an
EARS-checked spec, a wave-scheduled task graph, and a gated build in a per-run
git worktree.

- [`docs/PRD.md`](docs/PRD.md) — the full product requirements document
- [`docs/PRD-onepager.md`](docs/PRD-onepager.md) — the positioning card

## Under the hood

```
prricode/
  crates/
    prricode-core/         protocol types, schema fingerprint, 37 error kinds
    prricode-cli/          18 subcommands
    prricode-server/       JSON-RPC dispatch, sessions, goals, notifications
    prricode-agent/        turn loop, tool registry, approval engine
    prricode-provider/     echo + ollama + OpenAI-compatible presets
    prricode-persistence/  SQLite: sessions, items, goals, usage, settings
    prricode-sandbox/      bubblewrap execution
    prricode-computer-use/ X11 screenshots + input injection
    prricode-workflow/     workflow runs with child control
    prricode-skills/       SKILL.md loading and import
    prricode-mcp/          MCP stdio client
    prricode-voice/        speech-to-text / text-to-speech plumbing
  docs/                    protocol, configuration, and operator docs
  tests/                   e2e scenario driving the real binary
```

The tool-calling layer is built for small models: fenced-JSON recovery,
argument repair, dedupe, and retry — so a 3B model running on your laptop
still lands its tool calls.

## Documentation

- `docs/PROTOCOL.md` — the JSON-RPC surface: methods, types, error codes
- `docs/CONFIGURATION.md` — providers, keys, config file
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
