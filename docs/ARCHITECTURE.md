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
| `prricode-spec` | Product Builder domain: concept, EARS requirements, Core-4 spec, stack presets, task graph (no IO) |
| `prricode-pipeline` | Product Builder stage orchestration over `AgentRunner` + gated build over `WorkflowEngine` |

## The TUI

`prricode` with no subcommand launches the interactive terminal UI
(`prricode-tui`, ratatui). It drives the same `AgentRunner` as the server,
in-process: `UiCommand` flows UI → agent task, `UiEvent` flows agent → UI
(streaming deltas, tool uses, approval requests, turn lifecycle). The keymap
mirrors the Reference TUI: Return submits, Ctrl+J newline, Ctrl+R/P/N history,
Ctrl+G editor, Alt+B/F word moves, Ctrl+K/Y kill/yank, Ctrl+L clear, Esc/
Ctrl+C interrupt, and three-way approvals (allow once / allow for session /
deny). Slash commands: `/model`, `/sessions`, `/new`, `/resume`, `/clear`,
`/approval`, `/provider`, `/settings`, `/help`, `/quit`.

## Product Builder pipeline

Two crates at a clean seam. `prricode-spec` is the pure domain layer — no IO,
no network, no tokio: concept intake, the Clarify interview state machine, EARS
requirements, the layered Core-4 spec, the five stack presets, and the
dependency-ordered task graph with wave scheduling. `prricode-pipeline` is the
thin orchestrator that drives those stages over the same `AgentRunner` the
server and TUI already use, and runs the Build stage over
`prricode-workflow`'s engine.

```
Concept ──► Clarify ──► Specify ──► Plan ──► Build
              │            │            │         │
              │ interview  │ EARS gate  │ trace-  │ waves over the workflow
              │ (one ques- │ (spec must │ ability │ engine: tasks in a wave
              │ tion at a  │ be EARS)   │ gate    │ run concurrently;
              │ time)      │            │ (every  │ pause/cancel/budget
              │            │            │ req has │ gates between waves
              │            │            │ a task) │
```

Human approval gates sit at exactly two boundaries: concept confirmation and
spec confirmation. Everything else exits on a machine-checkable verdict.

Each run gets its own workspace: `Pipeline::prepare_worktree` creates
`<data-dir>/runs/<session-id>/` as a git worktree off the current workspace
when the process runs inside a git repository (`git worktree add --detach`),
and a plain directory otherwise; the Build stage's turns run with that path as
their workspace root. See `docs/CONFIGURATION.md` for the preset list and
storage locations.

Server surface (additive, see `docs/PROTOCOL.md`): `pipeline/conceptSet`
starts a run and emits the first interview question as a `turn/item`
notification; `pipeline/specRead` returns the latest spec and stage;
`pipeline/planRead` returns the wave plan. Pipeline state persists per session
in the `settings` table under `pipeline:<sessionId>`. The TUI drives the same
stages in-process (`/concept`, `/spec`, `/plan`, `/build`).

## Verification (v0.2)

The verify stage is the pipeline's acceptance layer. Three seams in
`prricode-verify`:

- **Gates** — `gates.rs` detects the stack (Node/Python/Rust) and runs
  deterministic gates (`typecheck`/`build`/`test`) through `prricode-sandbox`
  with no network. Every `GateRecord` is machine-checkable: command, exit
  code, passed, evidence tail, duration.
- **Verifier** — an adversarial agent turn with structural isolation: a fresh
  runner derived with an evidence-only registry (`read_file`/`glob`/`grep` —
  no shell, no writes), empty history, one iteration. It receives the EARS
  requirements and the evidence bundle and returns a verdict per requirement
  (PASS/FAIL/UNVERIFIED with cited evidence). A verdict set missing any
  requirement is an error, never silently accepted.
- **Dossier** — `dossier.rs` renders the acceptance dossier (what changed /
  verified how / evidence / residual risk / not-tested) to
  `<data_dir>/runs/<run_id>/acceptance-dossier.md` and persists the report
  (`gate_records` table + `dossier:<run_id>` settings row). The TUI shows it
  via `/dossier`; the protocol exposes `pipeline/verifyRead`.

Cheap gates run after each build task; the verifier pass runs once, after the
build completes (verification economics: PRD §7).

## Ship & Operate (v0.3)

`prricode-ship` holds three seams:

- **Ship** (`release.rs`) — install artifacts (`INSTALL.md`, written only when
  absent) → commit → tag → push → `gh release create` when `gh` is available,
  tag-only otherwise. Zero credentials required.
- **Deploy** (`deploy.rs`) — stack-informed target proposal (wrangler.toml →
  Cloudflare, fly.toml → Fly, vercel.json → Vercel, Procfile → Heroku,
  nothing recognizable → a manual plan that asks the operator to name the
  target). Execution passes credentials as **environment variables of the
  child process only**; captured output is redacted (secret values, token
  patterns) before it lands anywhere. Nothing secret is written to SQLite,
  the spec, the dossier, or git.
- **Operate** (`operate.rs`) — health checks (URL or command), an append-only
  JSONL run log at `<data_dir>/operate/<run_id>.jsonl`, and a best-effort
  `gh issue create` with redacted evidence when a health check fails.

The pipeline's `ShipFlow` is step-driven (propose → operator choice → per-
credential secret collection → execute → record → health pass): it never
blocks on operator input, and the TUI drives it the same way it drives the
concept/spec gates. The TUI masks secret input in the composer and never
records it. Protocol surface: `pipeline/shipRead`, `pipeline/operateRead`.

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
