# prricode

<p align="center">
  <a href="https://github.com/RavaniRoshan/prricode/actions/workflows/ci.yml"><img src="https://github.com/RavaniRoshan/prricode/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/RavaniRoshan/prricode/releases/latest"><img src="https://img.shields.io/github/v/release/RavaniRoshan/prricode" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
</p>

**Concept in. Running product out.**

prricode is an autonomous AI coding agent that lives in your terminal. Bring a
rough idea and it carries the whole job end to end — conversation →
specification → plan → build → verification → delivery → operation — with a
human approval at the irreversible moments (deploy, spend, publish) rather
than at every edit.

<p align="center">
  <img src="assets/prricode-demo.gif" alt="prricode's TUI carrying a concept through the Product Builder pipeline — the clarify stage interviewing the operator about a word-count CLI, driven by a live model" width="776">
</p>
<p align="center">
  <a href="assets/prricode-demo.mp4">mp4</a> · <a href="assets/prricode-demo.webm">webm</a>
</p>

## What it is

A coding agent you drive with words, not flags: run `prricode` with no
arguments and the whole thing is a TUI — sessions, providers, models, themes,
approvals, and the Product Builder pipeline are all commands you type. Nothing
to memorise, no second app to learn, and the config file is optional.

What makes it different is underneath. A gated pipeline where **each stage
exits only on a machine-checkable verdict**, an **independent verifier** that
judges work the builder never saw, and a reviewable artifact that is an
**acceptance dossier** — what changed, what was verified and how, evidence,
residual risk, and what was not tested — rather than a diff you have to trust.

<p align="center">
  <img src="assets/readme/pipeline.svg" width="100%"
       alt="The Product Builder pipeline: concept, clarify, specify, plan, build, verify, ship, operate. Each stage exits only on a machine-checkable verdict — the EARS gate on the spec, the typecheck, build and test gates on every build task, and an independent adversarial verifier. A rejected stage is repaired, not a dead end, and the acceptance dossier rather than the diff is what you review.">
</p>

The autonomy rule: full autonomy where an oracle exists, human judgement where
it doesn't. The build runs open inside a disposable worktree — you already
consented at the plan gate — and the gates are what judge the result.

## Try it

Install, either way:

```bash
# prebuilt binary — releases publish five platforms plus SHA256SUMS
curl -fsSLO https://github.com/RavaniRoshan/prricode/releases/latest/download/prricode-x86_64-unknown-linux-gnu.tar.gz
tar xzf prricode-x86_64-unknown-linux-gnu.tar.gz && ./prricode exec "say hi" --provider echo

# or from source
git implementation https://github.com/RavaniRoshan/prricode.git
cd prricode
cargo build --release          # or: git checkout v0.2.2
```

Then:

```bash
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

Or carry a concept all the way through the pipeline:

```bash
./target/release/prricode                       # then: /concept <your idea>
```

## Pick your brain

One OpenAI-compatible client, first-class presets. Switch provider and model
live from the TUI (`/provider`, `/model`) — no restart.

| Provider | `--provider` | Key env | Notes |
|---|---|---|---|
| Echo (offline) | `echo` | — | No network; replies `echo: <text>`. Tests and protocol debugging. |
| Ollama (local) | `ollama` | — | `/api` native surface with tools. |
| Ollama Cloud | `ollama-cloud` | `OLLAMA_API_KEY` | Hosted models, same account. |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | Hundreds of models, one key. |
| Kilo AI Gateway | `kilo` | `KILO_API_KEY` | `:free` models work anonymously. |
| OpenAI | `openai` | `OPENAI_API_KEY` | |
| Anything else | `custom` | yours | Any OpenAI-compatible endpoint via `--base-url`. |

Keys live in a 0600 credential store (`prricode auth token <provider>`) or
environment variables — never in the repo, never in logs.

## What it does

- **A real agent loop with tools** — `shell` (sandboxed), `read_file`,
  `write_file`, `edit_file`, `glob`, `grep`, `web_fetch`, `task` (subagents),
  and `computer` (screen + input). Built for small models: fenced-JSON
  recovery, argument repair, dedupe, and retry, so a 3B model on your laptop
  still lands its tool calls.
- **Verification, not vibes** — deterministic gates after every build task, an
  adversarial verifier with structural context isolation, property tests
  generated from the EARS requirements, and the acceptance dossier with
  delivery economics (tokens and gate time per verified requirement).
- **Brownfield-aware** — the pipeline surveys an existing workspace first
  (stack, layout, tests), plans tasks against the files that are already
  there, and rejects plans that would scaffold a second project.
- **Remembers** — every message, tool call, and result is persisted in SQLite.
  Resume, fork, and compact sessions across runs.
- **Approvals that fit your risk appetite** — allow once, for the session, or
  always in this workspace (persisted as a policy amendment), with a timeout
  that denies rather than hangs.
- **Ship and operate** — a GitHub release path, agent-arranged deploys with
  environment-only secrets and redaction, health checks, and autonomous
  rollback on regression (armed at your say-so).
- **A business layer** — market research, pricing, and landing-page plans,
  every claim either sourced or marked unsourced.
- **Extensible** — `SKILL.md` capability bundles, a stdio MCP client, 25
  bundled themes, `Ctrl+V` image paste, and STT/TTS plumbing for models with
  ears.

## The terminal is the interface

Every setting, command, and configuration is reachable from the composer. The
config file and environment variables exist as *optional equivalents* for
those who prefer files or CI; the TUI reads them at startup.

- **Composer**: `Return` sends, `Ctrl+J` newline, `Ctrl+R`/`Ctrl+P`/`Ctrl+N`
  history, `Ctrl+G` edit in `$EDITOR`, `Alt+B`/`Alt+F` word moves, `Ctrl+K`/
  `Ctrl+Y` kill/yank, `Ctrl+L` clear
- **`@`** insert a file path, **`!cmd`** run a shell command in the workspace,
  **`Ctrl+V`** paste an image from the clipboard
- **`Ctrl+C`/`Esc`** interrupt a running turn without losing the session
- **Approvals inline**: sensitive tool calls pause with `y` allow-once / `s`
  allow-for-session / `a` always-in-this-workspace / `n` deny
- **Slash commands** — settings and pipeline, all in-app:

  | Group | Commands |
  |---|---|
  | Session | `/new`, `/resume`, `/sessions`, `/clear`, `/compact`, `/quit` |
  | Settings | `/model`, `/provider`, `/approval`, `/yolo`, `/theme`, `/goal` |
  | Product Builder | `/concept`, `/spec`, `/plan`, `/build`, `/ship`, `/deploy`, `/operate`, `/dossier` |
  | Business layer | `/research`, `/pricing`, `/landing` |
  | Info | `/help`, `/?` |

The full keymap, the approval flow, theming, and the file/env equivalents are
in [`docs/how-to/tui-guide.md`](docs/how-to/tui-guide.md).

## The protocol

A stable JSON-RPC 2.0 surface over stdio, so any editor, TUI, or script can
drive the same agent. A session in three lines:

```jsonc
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-ui","version":"0.1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"session/start","params":{"commandId":"…","workspaceRoot":"/path/to/project"}}
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"commandId":"…","sessionId":"…","input":[{"type":"text","text":"fix the failing test"}]}}
```

Progress streams back as notifications: `turn/item` deltas, `tool_use`,
`approval/requested`, `turn/completed`. The pipeline is drivable too
(`pipeline/conceptSet`, `pipeline/specRead`, `pipeline/verifyRead`, …).

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
    prricode-computer-use/ X11 screenshots + input, Wayland capture/input selection
    prricode-workflow/    workflow runs with child control
    prricode-skills/      SKILL.md loading and import
    prricode-mcp/         MCP stdio client
    prricode-voice/       speech-to-text / text-to-speech: HTTP or local commands
    prricode-tui/         the terminal UI: 25 themes, image paste, /commands
    prricode-spec/        EARS requirements, layered specs, task graph + waves
    prricode-verify/      gate runner, property tests, adversarial verifier, dossier
    prricode-ship/        release path, deploy, operate (rollback)
    prricode-pipeline/    stage orchestration, workspace survey, business layer
  docs/                   protocol, configuration, TUI, and operator docs
  tests/                  e2e scenario driving the real binary
```

226 tests, `cargo fmt --check` clean, clippy clean at `-D warnings`, and a
real Ollama e2e in CI. Every capability degrades honestly — when something
cannot run it says so with a reason, never a fake success.

## Documentation

The [documentation site](https://ravaniroshan.github.io/prricode/) is
organised the Diátaxis way, so you can tell at a glance whether something will
teach you, solve a problem, describe the machinery, or explain a decision.

| | |
|---|---|
| **[Tutorial](https://ravaniroshan.github.io/prricode/tutorials/first-product/)** | **Start here** — a twenty-minute lesson from a rough idea to a verified product, with the dossier at the end |
| **[How-to guides](https://ravaniroshan.github.io/prricode/how-to/tui-guide/)** | The TUI is the interface (every command, key, and setting), connecting a provider, running the tests, skills, computer use, voice |
| **[Reference](https://ravaniroshan.github.io/prricode/reference/protocol/)** | The JSON-RPC surface, the protocol conformance report, the visual/UX spec |
| **[Explanation](https://ravaniroshan.github.io/prricode/explanation/prd/)** | The product requirements, architecture, roadmap, conformance decisions, and [launch status](https://ravaniroshan.github.io/prricode/explanation/launch-status/) — what is verified, what is measured, and the preregistered targets |

Everything is also readable as Markdown in
[docs/](https://github.com/RavaniRoshan/prricode/tree/main/docs).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers the gates, the house rules, and how
to pick up work. Security reports go through
[SECURITY.md](SECURITY.md) — never a public issue.

## Development

```bash
cargo build
cargo test --workspace
cargo clippy --workspace
cargo fmt --check
```

## License

MIT — see [LICENSE](LICENSE).
