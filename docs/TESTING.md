# Testing

What is tested, how, and how to run it.

## Gates

```bash
cargo build                 # zero warnings
cargo clippy --workspace    # zero warnings
cargo fmt --check
cargo test --workspace      # 38 tests at time of writing
```

## What the unit/integration suite covers

- **prricode-provider** (17 tests): SSE parsing across chunk boundaries,
  streamed tool-call assembly, lenient JSON repair (fences, truncation,
  chatter), tool-call response parsing, usage/cost extraction, config
  precedence (CLI > env > file > preset), Kilo org header injection, and a
  mock HTTP server exercising list/chat/stream/error paths plus the native
  Ollama NDJSON path.
- **prricode-agent** (5 tests): text tool-call recovery — fenced JSON,
  concatenated objects, bare JSON, unknown-tool rejection, dedupe.
- **prricode-sandbox** (3 tests): path scoping (escapes rejected), real
  command execution, availability reporting.
- **prricode-skills** (4 tests): frontmatter parsing, plain-markdown fallback,
  import + load + prompt rendering round-trip, rejection of directories
  without `SKILL.md`.
- **prricode-workflow** (4 tests): run lifecycle (start/pause/resume/advance/
  complete), cancel + child control, token budget, unknown-run errors.
- **prricode-computer-use** (3 tests): display probe behavior, no-display
  errors, action deserialization from the wire shape.
- **prricode-mcp** (1 test): full stdio handshake against a bash MCP server —
  initialize, tools/list, tools/call.
- **prricode-voice** (1 test): unconfigured STT/TTS error clarity.

## End-to-end scenario

`tests/e2e.sh` drives the real binary over stdio against a local Ollama model:

```bash
ollama pull qwen2.5-coder:3b
BIN=./target/release/prricode bash tests/e2e.sh
```

It verifies: `initialize` handshake, session creation, a full agent turn
(the model creates `hello.py` and the loop executes the tool), tool
notifications, and `-32601` for unknown methods. Note: stdin must stay open
while a turn runs — the harness pipes a sleep after the requests.

## Provider smoke tests (manual, network)

```bash
prricode model-profile --provider openrouter        # no key needed
prricode exec "say hi" --provider kilo --model liquid/lfm-2.5-2.6b:free
prricode exec "say hi" --provider ollama --model qwen2.5-coder:3b
```

The gate-runner tests execute real toolchains in temp workspaces — the Rust
path (cargo) is deterministic everywhere; the Node gate test needs node on
PATH (absent → exit 127, still a failing gate, so the failure mode is safe).
The Python gate path is exercised via unit-level plans; pytest presence on
the host decides which command runs.

## CI

`.github/workflows/ci.yml` has two jobs:

- **fast** (every push/PR): `cargo fmt --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`,
  plus an offline CLI smoke (echo exec, schema, and a `-32601` check over stdio).
- **e2e** (main pushes / manual dispatch): installs Ollama, pulls
  `qwen2.5-coder:3b`, and runs `tests/e2e.sh`.

## Known flakes

- The 3B e2e model sometimes emits prose before/after tool calls; recovery
  handles it, but a run may exceed 25 iterations on complex prompts.
- Kilo `:free` models are rate-limited to 200 requests/hour per IP.
