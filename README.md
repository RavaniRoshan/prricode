# prricode

An autonomous AI coding agent that runs in your terminal.

prricode drives a full agent loop against any OpenAI-compatible model backend —
read and edit files, run shell commands, search code, fetch the web, and control
the screen — with durable sessions, sandboxed execution, and a stable
JSON-RPC protocol that any frontend can speak.

## Features

- **Agent loop with tool calling** — the model works through real tools
  (`shell`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`,
  `web_fetch`, `computer`) instead of printing code you have to paste.
- **Provider-agnostic models** — one OpenAI-compatible client with first-class
  presets for Ollama (local and cloud), OpenRouter, the Kilo AI Gateway, OpenAI,
  and any custom endpoint. Offline echo provider included for tests.
- **Durable sessions** — every item (messages, tool calls, results) is
  persisted to SQLite. Resume, fork, compact, and rename sessions across runs.
- **Sandboxed execution** — shell commands run under bubblewrap isolation on
  Linux (seatbelt on macOS, passthrough elsewhere) with workspace-scoped binds.
- **Computer use** — screen capture and input injection over X11, gated by an
  approval-aware permission model.
- **Goals** — set an objective and let the agent iterate autonomously until it
  reports completion; pause, resume, or edit at any time.
- **Workflows** — ordered multi-step runs with pause/resume/cancel and
  child-step retry/skip control.
- **Skills** — `SKILL.md` capability bundles loaded from your project or home
  directory, with import support for other tool formats.
- **MCP** — connect Model Context Protocol servers (stdio or streamable HTTP)
  and expose their tools to the agent.
- **Voice plumbing** — speech-to-text/text-to-speech traits wired for
  voice-capable models; see `docs/VOICE.md`.
- **CLI + protocol** — 18 CLI subcommands for terminal use, or drive the same
  surface as a JSON-RPC server over stdio from any language.

## Supported providers

| Provider | `--provider` | Base URL | API key env |
|---|---|---|---|
| Echo (offline, no network) | `echo` | — | — |
| Ollama (local) | `ollama` | `http://localhost:11434` | — |
| Ollama Cloud | `ollama-cloud` | `https://ollama.com` | `OLLAMA_API_KEY` |
| OpenRouter | `openrouter` | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| Kilo AI Gateway | `kilo` | `https://api.kilo.ai/api/gateway` | `KILO_API_KEY` |
| OpenAI | `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| Any OpenAI-compatible endpoint | `custom` | your `--base-url` | your key env |

Any OpenAI-compatible server works as `custom` — set `--base-url` and pass the
key through the environment variable of your choice (or `config.toml`, see
`docs/CONFIGURATION.md`).

## Quickstart

Build:

```bash
git clone https://github.com/RavaniRoshan/prricode.git
cd prricode
cargo build --release
```

Run a one-off turn with the offline echo provider (no model, no network):

```bash
./target/release/prricode exec "summarize this repo" --provider echo
```

Point it at a local [Ollama](https://ollama.com) model with tool calling:

```bash
ollama pull qwen2.5-coder:3b
./target/release/prricode exec "create hello.py that prints hi, then run it" \
  --provider ollama --model qwen2.5-coder:3b
```

Run the JSON-RPC server over stdio (the same protocol any client can speak):

```bash
./target/release/prricode serve
```

### Example session (JSON-RPC)

```jsonc
// request
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"my-client","version":"0.1.0"}}}
// response
{"jsonrpc":"2.0","id":1,"result":{"schema":{"fingerprint":"sha256:6de32db0…","version":1},"serverInfo":{"name":"prricode","version":"0.1.0"}, …}}
```

Start a session, then submit a turn:

```jsonc
{"jsonrpc":"2.0","id":2,"method":"session/start","params":{"commandId":"…","workspaceRoot":"/path/to/project"}}
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"commandId":"…","sessionId":"…","input":[{"type":"text","text":"add a README section about setup"}]}}
```

See `docs/PROTOCOL.md` for the full method, notification, and type reference.

## Architecture

```
prricode/
  crates/
    prricode-core/         protocol types, schema fingerprint, error kinds
    prricode-cli/          clap CLI (18 subcommands)
    prricode-server/       JSON-RPC server over stdio, session dispatch
    prricode-agent/        turn loop, tool registry, approval engine
    prricode-provider/     model providers (echo, ollama, openrouter, kilo, openai, custom)
    prricode-sandbox/      bubblewrap/seatbelt execution isolation
    prricode-computer-use/ screen capture + input injection (X11)
    prricode-workflow/     workflow engine (steps, pause/resume, child control)
    prricode-skills/       SKILL.md loading and import
    prricode-mcp/          Model Context Protocol client (stdio + HTTP)
    prricode-voice/        speech-to-text / text-to-speech plumbing
    prricode-persistence/  SQLite storage (sessions, items, goals, usage)
  docs/                    protocol, configuration, and operator documentation
  skills/                  bundled skill definitions
  tests/                   integration and end-to-end tests
```

Data lives under `~/.local/share/prricode` (override with `--data-dir`);
configuration under `~/.config/prricode`.

## Development

```bash
cargo build              # debug build
cargo test               # unit + integration tests
cargo clippy -- -D warnings
cargo fmt --check
```

Small models (3B–4B parameters) need lenient tool-call handling — the provider
layer repairs malformed JSON, deduplicates repeated tool calls, and retries once
with a corrective prompt. `scripts/` and `tests/` carry the end-to-end scenarios
(file creation, approval flow, goal autonomy, computer use under Xvfb).

## Documentation

- `docs/PROTOCOL.md` — JSON-RPC surface, types, error codes
- `docs/CONFIGURATION.md` — providers, keys, config file
- `docs/COMPUTER_USE.md` — permissions and supported actions
- `docs/VOICE.md` — speech input/output setup
- `docs/SKILLS.md` — skill format and import
- `docs/ARCHITECTURE.md` — runtime design, notifications, storage layout
- `docs/TESTING.md` — test matrix and e2e scenarios

## License

MIT — see [LICENSE](LICENSE).
