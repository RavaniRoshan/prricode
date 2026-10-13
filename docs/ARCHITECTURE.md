# Architecture

How prricode is put together, from the transport layer down.

## Request path

```
stdin JSON-RPC
   │
   ▼
PrricodeServer::dispatch          crates/prricode-server
   │  pure protocol methods (sessions, goals, models, media…)
   │
   └─ turn/start ─► spawn AgentRunner (per-turn task)   crates/prricode-agent
                        │
                        ▼
                   turn loop
                     │  chat / chat_stream ─► ModelProvider  crates/prricode-provider
                     │       (echo, ollama, openrouter, kilo, openai, custom)
                     │
                     ├─ tool_calls? ─► ToolRegistry (approval-gated)
                     │                    ├─ shell      → prricode-sandbox (bwrap)
                     │                    ├─ files/grep/glob/web_fetch
                     │                    ├─ computer   → prricode-computer-use (X11)
                     │                    └─ task       → subagent (same loop, fresh context)
                     │
                     └─ no tool_calls ─► final answer
```

Every turn runs as a detached tokio task holding a `TurnHandle`; `turn/cancel`
and `turn/interrupt` signal it through a watch channel. The main stdin loop is
never blocked, which is what lets a client answer `approval/requested` with
`approval/decide` while the turn waits.

## Crates

| Crate | Responsibility |
|---|---|
| `prricode-core` | Protocol types, schema fingerprint, error kinds (37) |
| `prricode-cli` | 18 subcommands (clap), provider/config resolution |
| `prricode-server` | JSON-RPC dispatch, session/goal/approval state, notification emitter |
| `prricode-agent` | Turn loop, tool registry, approval engine, goal continuation |
| `prricode-provider` | Echo + Ollama native + one OpenAI-compatible client with presets |
| `prricode-persistence` | SQLite (sessions, items, goals, usage, settings) |
| `prricode-sandbox` | bubblewrap command building + execution, network toggling |
| `prricode-computer-use` | X11 screenshots (XGetImage) and input (XTEST via xdotool) |
| `prricode-workflow` | Workflow definition + run state machine, child control |
| `prricode-skills` | SKILL.md loading, import, prompt rendering |
| `prricode-mcp` | MCP stdio client (initialize, tools/list, tools/call) |
| `prricode-voice` | STT/TTS traits + OpenAI-compatible `/audio/*` implementations |

## Storage

SQLite at `~/.local/share/prricode/prricode.db` (override `--data-dir`):

- `sessions` — id, workspace, model, provider, approval mode
- `items` — every user/assistant/tool_use/tool_result/summary/media record
- `goals` — objective, status, continuation counter
- `usage_records` — per-call tokens and cost
- `settings` — key/value store used by settings/* methods
- `uploads`, `plugins`, `hooks`, `approvals`, `workflow_runs`, `task_attempts`, `skills`

History is rebuilt from `items` on every turn; a `summary` item marks the
context boundary after `session/compact`.

## Notifications

The agent emits `AgentEvent` values; `notification_for` maps them to JSON-RPC
notifications on stdout. 39 method names are mapped (see
`docs/PROTOCOL.md`); live emissions cover turn lifecycle, item deltas,
approvals, goals, sessions, tasks, usage, and settings. Computer-use, workflow,
MCP, and hook notifications are mapped and arrive with their subsystems.

## Tool calling resilience

Small local models frequently emit tool calls as fenced JSON in the text
channel instead of native `tool_calls`. The loop runs `extract_text_tool_calls`
recovery: fenced blocks, concatenated objects, bare JSON, with name validation
against the tool registry, dedupe, and `repair_json` for malformed arguments.
Tool arguments repaired the same way at the provider boundary
(`repair_json`, `ToolCallAssembler` in `prricode-provider`).

## Security model

- Sensitive tool calls pass the approval engine: `Closed`/`Auto` ask for
  shell/writes/computer/MCP; `Open` auto-approves; `Suggestive` returns the
  call as a suggestion without executing.
- Shell runs under bubblewrap with the workspace bind-mounted and no network
  unless enabled; `web_fetch` is the sanctioned outbound path.
- `session/userShell` requires `Open` mode (a synchronous RPC cannot wait for a
  decision without deadlocking the transport).
- Credentials live in the environment or `api_key_env` references — never in
  the repo.
