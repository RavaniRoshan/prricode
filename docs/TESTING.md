# Testing

What is tested, how, and how to run it.

## Gates

```bash
cargo build                 # zero warnings
cargo clippy --workspace    # zero warnings
cargo fmt --check
cargo test --workspace      # 180 tests at time of writing
```

## What the unit/integration suite covers

- **prricode-cli** (6 tests): every subcommand's argument graph parses —
  including the `auth token <provider>` positional, which must not collide
  with the global `--provider` flag — plus the global flags next to
  subcommands.
- **prricode-provider** (20 tests): SSE parsing across chunk boundaries,
  streamed tool-call assembly, lenient JSON repair (fences, truncation,
  chatter), tool-call response parsing, usage/cost extraction, config
  precedence (CLI > env > file > preset), Kilo org header injection, a
  gateway error object answered with HTTP 200 (the provider's own message
  must survive), and a mock HTTP server exercising list/chat/stream/error
  paths plus the native Ollama NDJSON path.
- **prricode-tui** (50 tests): composer keymap and editing, slash-command
  routing, approval durability tiers and risk classes, theme loading and
  switching, image-paste state, pipeline rail state.
- **prricode-agent** (13 tests): tool-call recovery — fenced JSON,
  concatenated objects, bare JSON, unknown-tool rejection, dedupe; approval
  timeout resolution and policy-amendment matching.
- **prricode-sandbox** (3 tests): path scoping (escapes rejected), real
  command execution, availability reporting.
- **prricode-skills** (5 tests): frontmatter parsing, plain-markdown fallback,
  import + load + prompt rendering round-trip, rejection of directories
  without `SKILL.md`, script execution through the sandbox.
- **prricode-workflow** (5 tests): run lifecycle (start/pause/resume/advance/
  complete), cancel + child control, token budget, unknown-run errors.
- **prricode-computer-use** (5 tests): display probe behavior, no-display
  errors, action deserialization from the wire shape.
- **prricode-mcp** (1 test): full stdio handshake against a bash MCP server —
  initialize, tools/list, tools/call.
- **prricode-voice** (1 test): unconfigured STT/TTS error clarity.
- **prricode-spec / verify / ship / pipeline** (61 tests): EARS validation,
  the layered spec, wave scheduling, gate verdicts, the acceptance dossier,
  ship-record extraction, rollback conditions, operate-log redaction, and
  the stage state machine.

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

## Live provider verification (manual, network)

The mock-server tests cover the wire format; these steps verify the real
thing against a live provider. Keep the key in the environment only — never
in the repo, the config file, or a commit.

```bash
export OPENROUTER_API_KEY=sk-or-...        # or KILO_API_KEY for Kilo
BIN=./target/release/prricode

# 1. catalog: the provider is reachable and lists its models
$BIN model-profile --provider openrouter | grep ':free)' | head

# 2. one-off chat through the OpenAI-compatible client
$BIN exec "Reply with exactly: PONG" --provider openrouter --model liquid/lfm-2.5-2.6b:free

# 3. credential store: store the key, then prove it resolves without the env var
$BIN auth token openrouter --key-env OPENROUTER_API_KEY   # 0600 store
env -u OPENROUTER_API_KEY $BIN exec "reply with PONG" --provider openrouter --model ...
$BIN auth status                                          # shows "stored", never the value

# 4. agent loop over the protocol (same shape as tests/e2e.sh, live provider)
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"live","version":"0"}}}\n\
{"jsonrpc":"2.0","id":2,"method":"session/start","params":{"commandId":"00000000-0000-7000-8000-000000000001","workspaceRoot":"/tmp/live","approvalMode":"open","modelId":"liquid/lfm-2.5-2.6b:free"}}\n' \
  | (sleep 60; cat) | $BIN serve --provider openrouter
```

Then send `turn/start` with a tool-requiring prompt and expect:
`turn/item` deltas, a `toolUse` item, a `toolResult` item, and
`turn/completed` carrying `inputTokens`/`outputTokens`.

**Model selection over the protocol** takes a full `ModelSelection`
(`modelId`, `providerId`, `profileId`, `displayLabel` — all four required);
see `docs/PROTOCOL.md`. `session/setModel` answers with the stored selection
and emits `session/modelChanged`.

**TUI against a live model**: `prricode --provider openrouter --model ...`
opens the TUI; `/model` and `/provider` switch live, and a plain message
runs a full turn with approvals inline.

### What live runs have actually covered

Verified against OpenRouter's free catalog and Kilo's anonymous `:free`
tier (2026-10-14): catalog fetch (462 models), one-off chat, a full
tool-calling turn over stdio (`write_file` → `shell` → tool results → final
answer), `session/setModel` + the `session/modelChanged` notification,
usage aggregation (`usage/read`), the credential store round-trip
(0600 → resolution without the env var), and the TUI with `/model`,
`/provider`, `/help` against a live model.

Known limits of the free tiers, not of prricode: OpenRouter's shared free
pool returns HTTP 429 when the upstream provider is exhausted (Google,
Poolside), and one gateway answered HTTP 200 with a top-level `error`
object and no `choices` — prricode now surfaces that error verbatim instead
of "response has no choices".

The gate-runner tests execute real toolchains in temp workspaces — the Rust
path (cargo) is deterministic everywhere; the Node gate test needs node on
PATH (absent → exit 127, still a failing gate, so the failure mode is safe).
The Python gate path is exercised via unit-level plans; pytest presence on
the host decides which command runs.

Ship/operate tests are local-only: ship runs against temp git repos with no
remote, deploy execution is tested with local commands (exit codes, redaction,
release-id extraction), and the `gh` paths degrade to tag-only/skip in test
environments. No test performs a real deploy or network call.

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
