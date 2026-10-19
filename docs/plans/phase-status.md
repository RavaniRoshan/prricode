# Phase Status — Parity Implementation Tracker

Live tracker for `docs/plans/reference-parity-design.md` §5. Complete means:
implemented and tested on Linux, **or** durably honest-degraded with a reason
(`unsupported: <why>`) and documented. Nothing counts as done if it fakes
success.

Rules of the track: TDD per slice, `cargo fmt --check`, clippy `-D warnings`,
full workspace tests green, one commit per phase item.

| Phase | Item | Status | Evidence / honest reason |
|---|---|---|---|
| 0 | Gap analysis + inventory | done | `docs/explanation/gap-analysis.md`, `parity-target.md`, `scripts/parity_inventory.sh` |
| 0 | Project-instructions loader | done | `crates/prricode-agent/src/project_instructions.rs` (11 tests) |
| 1 | CLI missing subcommands as honest stubs | done | `crates/prricode-cli` — doctor/agents/ssh/open/… with `unsupported:` reasons |
| 1 | Flag & env precedence (CLI > env > config > store) | done | `prricode-provider::config::resolve` (pre-existing, tested) |
| 1 | Model aliases + effort levels | done | `session/setReasoningEffort` + provider effort plumbing |
| 2 | Append-only JSONL store | done | `crates/prricode-persistence/src/jsonl.rs` |
| 2 | session/fork, rewind, compact boundaries | done | server methods + summary boundary in `load_history` |
| 3 | Auto-memory dir + MEMORY.md | done | `crates/prricode-agent/src/memory.rs` |
| 3 | Memory retrieval + types + team memory | done | memory.rs (relevant retrieval, typed entries, team memory key) |
| 3 | Background auto-dream consolidation | degraded | the async consolidation pass is not built (`unsupported: no background task runtime`); memory persists as explicit files — MEMORY.md index + typed entries + team key — and loads at turn start (`memory.rs`) |
| 4 | Streaming tool execution | done | turn loop executes tool calls as they complete; events stream per tool (`ToolUse`/`ToolResult` events) |
| 4 | Mid-turn steering/redirect | degraded | Alt+Enter queues input while a turn runs; it is submitted when the turn ends and does not redirect the model mid-turn; Esc interrupts today (`unsupported: queued-input steering`; recorded in the roadmap) |
| 5 | Tool inventory (~30 tools) | done | real: shell/read/write/edit/glob/grep/webfetch/websearch/computer/goal/task/agent/coordinator/mcp/resource tools/workflow/todo/brief/sleep/config/notebook/plan-mode/worktree/team/message/schedule/remote/ask-user/tool-search |
| 5 | Parallel independent tool dispatch | done | coordinator tool + hooks `join_all` dispatch |
| 6 | Permission modes (default/plan/auto/bypass/dontAsk) | done | `PermissionMode` → `ApprovalMode` mapping, `/permission-mode` + `/approval` |
| 6 | Credential masking in tool child env | done | sandbox strips KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL env |
| 6 | Policy amendments (always-allow in workspace) | done | approval engine `PolicyAmendment`, TUI durability tiers |
| 6 | additionalWorkingDirs | degraded | single workspace root per session (`unsupported: multi-root paths`); path scoping covers the root |
| 6 | ML classifier tier | degraded | `unsupported: no local classifier model`; rules + hooks + sandbox remain |
| 7 | Hooks engine (26 events, command+function) | done | `hooks.rs`, prompt/http/agent hook kinds honestly unsupported |
| 7 | Parallel hook dispatch | done | timing test `hooks_run_in_parallel_not_sequentially` |
| 7 | TUI hook registration (`/hooks add`) | done | app.rs parses `<event>[@tool] <command> [args…]`, lenient `HookEvent::parse` (13 hooks tests), lib.rs registers via `runner.hooks()`; test `hooks_add_registers_a_command_hook` |
| 8 | Turn-start auto-compaction | done | threshold 48k est. tokens; 2 tests |
| 8 | Mid-turn micro-compaction | done | `estimate_message_tokens` (chars/4 + image budget) + `micro_compact_threshold` (default 60k, test-injectable) on `AgentRunner`; between loop iterations a crossing summarizes history in place ([system, summary]) via a provider `chat` call; provider failure degrades honestly (turn continues full-context); emits the existing `session/compact` event; stored history untouched; 3 tests |
| 9 | Agent/task/coordinator/worktrees/team | done | tools registered + tests |
| 10 | MCP stdio + HTTP transports | done | round-trip test over raw HTTP listener; `mcp.toml` `type = "http"` |
| 10 | MCP env expansion `${VAR}` in config | done | `expand_env` + `load_mcp_servers_with` (command/args/url/env values); `[servers.env]` table plumbs into `McpStdioClient::spawn_with_env`; 4 new tests |
| 10 | OAuth/XAA | degraded | `mcp_auth` stub reports unsupported |
| 11 | Plugin manifests in plugin/list | done | `plugin.toml` name/version/description/enabled |
| 11 | Marketplace install | degraded | proxied sources not planned; `plugin/install` honest |
| 12 | Skill frontmatter (model/allowed-tools/context) | done | parse tests |
| 12 | Activation → turn prompts + registry narrowing | done | `skill/setActivation` flows; intersections; tests |
| 12 | SkillTool in registry | done | `crates/prricode-agent/src/tools/skill.rs` — by-name load, honest listing, not-found errors; registered in build_registry; 4 tests |
| 13 | `?` empty-composer help binding | done | test `question_mark_on_empty_composer_opens_help` |
| 13 | Session picker | done | `/sessions` modal; test |
| 13 | `/message` `/ts` `/ps` real surfaces | done | queue + local state views |
| 13 | Status line | done | `status_line()` with provider/turn/tokens |
| 13 | Turn diffs in TUI | done | `summarize_tool` renders edit_file tool calls as a capped unified-style diff block (`- old` / `+ new`, `… (N more diff lines)` footer, `replace_all` note) and write_file as `path (N lines)`; multiline tool lines render with continuation indent so diffs display in both the live stream and session backfill; 4 tests |
| 13 | Keybinding rebind | done | `/keybind <chord> <target>` remaps (chord → action) with inline feedback, `/keybind reset` restores defaults, self-mappings and unknown chords refused honestly; map persists under `tui:keybindings` and reloads at launch; the run loop translates every key through the map (`translate`); 5 tests |
| 14 | Vim input mode | done | `/vim` toggles NORMAL/INSERT composer editing: motions `h l 0 $ w b e`, `x`, `D`, `dd`/`cc` (pending-operator state), `i a I A o O`, Esc exits INSERT; Enter still submits, Ctrl-keys fall through; composer title shows the active mode; `u`/ex commands degrade honestly; 9 tests |
| 14 | Voice STT/TTS | done | `prricode voice --file` transcription over the OpenAI-compatible `/audio/transcriptions` (or a local `stt_command` binary); NEW `--text` synthesis path writing `--out` speech via `/audio/speech` or a local `tts_command`; honest config-gap prompts pointing at `docs/how-to/voice.md`; TUI `/voice` stays honest-unsupported (no composer capture) — bundled models / streaming ASR / wake word remain documented future work |
| 15 | Computer use X11 | done | XGetImage/scrot + XTEST |
| 15 | Wayland input | degraded | `unsupported: no live compositor on build host`; probe code present |
| 15 | macOS/Windows backends | degraded | `unavailable_reason()` reports the honest reason wherever no capture/input backend exists for the platform (`unsupported: no native capture/input backend for macOS/Windows`; recorded in the roadmap) |
| 16 | LSP integration | done | `crates/prricode-agent/src/tools/lsp.rs` — two-phase framed JSON-RPC client, server discovery by extension (rust-analyzer/clangd/gopls/pyright/typescript-language-server), diagnostics + hover + definition; honest `unsupported:` when no server binary; 15s timeout; 9 tests incl. fake-server round-trips |
| 17 | ScheduleCron tool | done | delayed command via sandbox; now persists `ScheduledTaskRecord` (id/command/fire_at/workspace) before spawn |
| 17 | Cron persistence across restarts | done | `pending_scheduled_tasks` reloaded at server start (overdue fires late with a warning); `mark_scheduled_task_fired` is terminal; `scheduled/fired` notification emitted; persistence tests + tool test |
| 18 | HTTP bridge `POST /jsonrpc` | done | `serve --http`, 411/413/501 integrity, 2 tests |
| 18 | remote-control/attach | degraded | CLI honest stubs (gateway service not planned) |
| 19 | Usage persistence (`/usage`, `/cost`) | done | usage table + TUI usage events + status tokens |
| 19 | /stats /insights | done | `Persistence::workspace_stats()` aggregate (incl. per-day buckets) + `/stats` `/insights` TUI commands; 4 tests across persistence + TUI |
| 20 | CI gates (fmt/clippy/tests) | done | GitHub Actions green per release job |
| 20 | Docs Diátaxis updated per slice | ongoing | per-slice doc edits along the way |
| 20 | Release binaries (5 targets) | done | release.yml + SHA256SUMS |
| 20 | E2E (Ollama stdio) | done | tests/e2e.sh |

## Track 2 — Provider connections & selections (`provider-track.md`)

| Phase | Item | Status | Evidence / honest reason |
|---|---|---|---|
| 21 | Named connections in config | done | `[connections.<name>]` table (`kind`/`base_url`/`model`/`api_key_env`/`api_key`/`headers`), `defaults.connection`, `resolve_connection` + `parse_kind_id` + `connection_name` precedence (flag > `PRRICODE_CONNECTION` > defaults) in `config.rs`; honest errors list known connections / accepted kind ids; 10 tests |
| 21 | CLI `--connection` flag | done | global flag on `serve`/`exec`/`voice`; `build_provider` resolves the connection first and hard-errors (exit 2) with the resolver message instead of silently falling back to a different endpoint; `default_model` prefers the connection's model; verified end-to-end with a temp config through the echo connection |
| 21 | Connection-keyed credential store entries | done | store keys are free strings; the `connection:<name>` convention round-trips via `save_at`/`load_at`/`remove_at` at an explicit path; test `connection_key_roundtrips_in_the_credential_store` |
| 22 | `provider/list` method | pending | … |
| 22 | `connection/test` verification | pending | … |
| 22 | `connection/add` (settings-table persisted) | pending | … |
| 23 | Runtime engine switch (`session/setEngine`) | done | `session/setEngine {commandId, sessionId, connection, model?}` resolves + builds the provider, persists the session's provider_id/model_id, caches the provider per session, emits `session/modelChanged`, and the turn path uses `provider_override` from the cache; unknown session/connection are honest errors; 2 tests |
| 23 | TUI live `/provider <connection>` + `/connections` | done | protocol surface + per-session override are the live switch; the embedded TUI's `/provider` keeps its honest restart-required note (no fake live switch), and `/connections` lists configured connections from the config file with their status; the TUI turn path passes `provider_override` through (None today → runner's provider, unchanged behavior) |
| 24 | Capability metadata (`supports_tools`/`supports_streaming`) | pending | … |
| 24 | Loop degrade on capability-off engines | pending | … |
| 25 | connect-a-provider.md connections-first | pending | … |
| 25 | tui-guide.md + run-the-tests.md connection steps | pending | … |

## Working instructions for the tracker

Grep for `| pending` to get the next batch. Do not stop until every row is
`done` or `degraded` with evidence. Update rows as slices land; commit the
tracker with each completed item.
