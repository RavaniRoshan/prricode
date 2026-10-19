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
| 3 | Background auto-dream consolidation | degraded | consolidations run at load time, not async background (`unsupported: background task runtime not wired`; honest) |
| 4 | Streaming tool execution | done | turn loop executes tool calls as they complete; events stream per tool (`ToolUse`/`ToolResult` events) |
| 4 | Mid-turn steering/redirect | degraded | queued-input steering documented as future work; Esc interrupts work today |
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
| 8 | Mid-turn micro-compaction | pending | … |
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
| 13 | Turn diffs in TUI | pending | … |
| 13 | Keybinding rebind | pending | … |
| 14 | Vim input mode | partial | `/vim` toggle exists; motions pending |
| 14 | Voice STT/TTS | partial | OpenAI-compatible `/audio/*` backend wired; local engines probed |
| 15 | Computer use X11 | done | XGetImage/scrot + XTEST |
| 15 | Wayland input | degraded | `unsupported: no live compositor on build host`; probe code present |
| 15 | macOS/Windows backends | degraded | platform-N/A; documented in roadmap |
| 16 | LSP integration | pending | … |
| 17 | ScheduleCron tool | done | delayed command via sandbox (process-local lifetime, documented) |
| 17 | Cron persistence across restarts | pending | … |
| 18 | HTTP bridge `POST /jsonrpc` | done | `serve --http`, 411/413/501 integrity, 2 tests |
| 18 | remote-control/attach | degraded | CLI honest stubs (gateway service not planned) |
| 19 | Usage persistence (`/usage`, `/cost`) | done | usage table + TUI usage events + status tokens |
| 19 | /stats /insights | done | `Persistence::workspace_stats()` aggregate (incl. per-day buckets) + `/stats` `/insights` TUI commands; 4 tests across persistence + TUI |
| 20 | CI gates (fmt/clippy/tests) | done | GitHub Actions green per release job |
| 20 | Docs Diátaxis updated per slice | ongoing | per-slice doc edits along the way |
| 20 | Release binaries (5 targets) | done | release.yml + SHA256SUMS |
| 20 | E2E (Ollama stdio) | done | tests/e2e.sh |

## Working instructions for the tracker

Grep for `| pending` to get the next batch. Do not stop until every row is
`done` or `degraded` with evidence. Update rows as slices land; commit the
tracker with each completed item.
