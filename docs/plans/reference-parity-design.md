# Plan: Make prricode a full parity implementation of the reference terminal coding agent

> Status: **PLANNING ONLY — no implementation yet.** Awaiting user switch to act mode.
> Source of truth for the reference: a recovered source tree (v2.1.88) recovered
> locally (see `scripts/parity_inventory.sh` for how the inventory is generated)
> plus the installed official binary (v2.1.302) and the external
> reverse-engineering report set. All third-party names stay out of
> code/docs/commits; the reference is called "the reference agent" here.

## 0. Constraints (non-negotiable, from AGENTS.md)

1. Protocol compatibility: schema fingerprint `sha256:6de32db0…` and existing
   method shapes never change. New capabilities are additive.
2. No third-party product/company names in source, comments, docs, commits,
   identifiers. The recovered reference stays anonymous; prricode presents as
   its own, credit-sourced design.
3. Every agent-facing behavior is a tool or a protocol method, not hidden magic.
4. Honest degradation: `enabled: false`, `unsupported: <why>` — never fake success.
5. TDD: test first, watch fail, implement, watch pass.
6. `cargo fmt` + clippy `-D warnings` zero before commit.
7. Verifier never shares context with builder.
8. Agent isolation: subagents get isolated child contexts, not parent permissions.

## 1. Design principles to honour (from the user's brief)

Core fundamentals of the TUI app:
- Collaborate in the terminal; runs on the user's machine; local filesystem,
  local shell.
- Synchronous, conversational — the user sees it read, edit, run tests and can
  redirect mid-task.
- `AGENTS.md` + `SKILL.md` + hooks + MCP. Standards encoded in files that
  travel with the repo.
- Agent Teams: parallel sub-agents sharing context but working in isolated
  worktrees.
- Ahead on harder multi-file refactors; strongly preferred for code cleanliness.
- Permission-based: you approve actions locally.
- Used ~1.4x more tokens, ~23% higher per-task cost — justified for ambiguous,
  exploratory, architectural-judgment tasks in messy monorepos/legacy code with
  local toolchain access; deepest customization; first-pass code quality and
  long-session memory.

TAOR: Think, Act, Observe, Repeat. Flow per turn:
`user input -> context assembled from AGENT.MD + conversation history + prior
tool results -> model decides action -> tool executed -> result injected back
-> loop checks whether to continue.`

Hard-coded planners make fragile agents. The runtime is deliberately dumb; the
model is the brain, the harness is the body. The decision to stop lives entirely
in the model.

Five values (paper that reverse-engineered the reference):
1. Human Decision Authority — observe, approve, interrupt, audit.
2. Safety, Security, Privacy — protect even when the human is inattentive.
3. Reliable Execution — do what the human meant; coherent over hours.
4. Capability Amplification — ~27% of tasks were work engineers wouldn't
   attempt otherwise.
5. Contextual Adaptability — fits the project, tools, conventions; improves
   over time.

Thirteen principles (where most other agents get it wrong):
1. Minimal scaffolding, maximal operational harness.
2. Context as scarce resource with progressive management.
3. Deny-first with human escalation.
4. Graduated trust spectrum (~20% auto-approve at start, >40% by session 750).
5. Defense in depth — permission rules + PreToolUse hooks + ML classifier +
   optional sandbox, any can block.
6. Externalized programmable policy — rules live outside code in settings,
   `AGENTS.md`, hooks.
7. Append-only durable state — sessions are JSONL logs never mutated; recover,
   rewind, fork.
8. Values over rules — contextual judgment backed by deterministic guardrails.
9. Composable multi-mechanism extensibility — MCP, plugins, skills, hooks at
   different context costs.
10. Reversibility-weighted risk — read-only = low friction, destructive writes
    = high friction.
11. Transparent file-based config and memory — version-controllable markdown,
    not opaque DB.
12. Isolated subagent boundaries — subagents get isolated child contexts, not
    parent's permissions.
13. Graceful recovery and resilience — recover silently; reserve human attention
    for unrecoverable.

## 2. Reference architecture inventory (from recovered source)

### 2.1 Entry / bootstrap
- `main.tsx` (4683 lines) — CLI entry, arg parsing, mode dispatch (interactive
  REPL, print/headless, SDK, daemon, bridge/remote-control, agents, gateway).
- `setup.ts`, `bootstrap/state.ts`, `context.ts` — cwd, global state, context
  assembly.
- `entrypoints/sdk/`, `entrypoints/agentSdkTypes.ts` — SDK/programmatic API.

### 2.2 Core loop
- `QueryEngine.ts` (1295) — owns conversation state; `submitMessage()` async
  generator; persists transcripts (JSONL) before/after; budget & turn limits;
  structured output; orphaned permissions.
- `query.ts` (1729) — the TAOR loop: calls model, executes tools, handles
  compaction, stop hooks, retries, fallback model.
- `services/api/reference-client.ts` — API client, streaming, usage, retry, fallback.
- `utils/processUserInput/processUserInput.ts` — slash commands, attachments,
  queued commands, input preprocessing.

### 2.3 Tools (39)
AgentTool, AskUserQuestionTool, BashTool (PowerShellTool variant), BriefTool,
ConfigTool, EnterPlanModeTool, EnterWorktreeTool, ExitPlanModeTool,
ExitWorktreeTool, FileEditTool, FileReadTool, FileWriteTool, GlobTool,
GrepTool, LSPTool, ListMcpResourcesTool, MCPTool, McpAuthTool,
NotebookEditTool, REPLTool, ReadMcpResourceTool, RemoteTriggerTool,
ScheduleCronTool, SendMessageTool, SkillTool, SleepTool, SyntheticOutputTool,
TaskCreate/Get/List/Output/Stop/Update, TeamCreateTool, TeamDeleteTool,
TodoWriteTool, ToolSearchTool, WebFetchTool, WebSearchTool.
Plus shared/, testing/, utils.ts.

### 2.4 Commands (~85 slash commands)
add-dir, agents, ant-trace, autofix-pr, backfill-sessions, branch, break-cache,
bridge, bridge-kick, brief, bughunter, chrome, clear, color, commit,
commit-push-pr, compact, config, context, copy, cost, ctx_viz, debug-tool-call,
desktop, diff, doctor, effort, env, exit, export, extra-usage, fast, feedback,
files, good-docs, heapdump, help, hooks, ide, init, init-verifiers, insights,
install-github-app, install-slack-app, install, issue, keybindings, login,
logout, mcp, memory, mobile, mock-limits, model, oauth-refresh, onboarding,
output-style, passes, perf-issue, permissions, plan, plugin, pr_comments,
privacy-settings, rate-limit-options, release-notes, reload-plugins, remote-env,
remote-setup, rename, reset-limits, resume, review, rewind, sandbox-toggle,
security-review, session, share, skills, stats, status, statusline, stickers,
summary, tag, tasks, teleport, terminalSetup, theme, thinkback, thinkback-play,
ultraplan, upgrade, usage, version, vim, voice, … plus advisor, btw, context,
cost, files, help.

### 2.5 Permissions & approvals
- `types/permissions.ts` — PermissionMode (default/plan/auto/bypassPermissions),
  ToolPermissionContext, alwaysAllow/Deny/Ask rules, additionalWorkingDirs,
  isBypassPermissionsModeAvailable, shouldAvoidPermissionPrompts, etc.
- `hooks/useCanUseTool.tsx` — canUseTool decision, rule matching, classifier.
- `components/permissions/*` — per-tool permission dialogs (Bash, FileEdit,
  FileWrite, WebFetch, NotebookEdit, SedEdit, EnterPlan/ExitPlan, AskUserQuestion,
  ComputerUseApproval, PowerShell, Skill).
- `hooks/toolPermission/handlers/*` — interactive, coordinator, swarm workers,
  automated checks.
- Deny-first, defense in depth (rules + PreToolUse hooks + ML classifier +
  optional sandbox).

### 2.6 Hooks engine
- `types/hooks.ts` — 26 hook events: PreToolUse, PostToolUse, PostToolUseFailure,
  PermissionRequest, PermissionDenied, Notification, UserPromptSubmit,
  SessionStart, SessionEnd, Stop, StopFailure, SubagentStart, SubagentStop,
  PreCompact, PostCompact, TeammateIdle, TaskCreated, TaskCompleted,
  Elicitation, ElicitationResult, ConfigChange, WorktreeCreate, WorktreeRemove,
  InstructionsLoaded, CwdChanged, FileChanged.
- Command hooks, prompt hooks, http hooks, agent hooks, function hooks.
- `services/...` + `utils/hooks/` — execution, matchers, settings.

### 2.7 Memory
- `memdir/` — auto memory (`~/.<reference>/projects/<project>/memory/`), MEMORY.md
  index, relevant memory retrieval (`findRelevantMemories`), memory types,
  team memory, memory age.
- `services/SessionMemory/`, `services/extractMemories/`, `services/autoDream/`
  — session memory extraction, background "dream" consolidation.
- `services/MagicDocs/`, `services/AgentSummary/`.

### 2.8 Context management / compaction
- `services/compact/` — autoCompact, microCompact, apiMicrocompact,
  sessionMemoryCompact, snipCompact (HISTORY_SNIP), time-based MC,
  postCompactCleanup, grouping, prompt.
- `context.ts`, `utils/fileStateCache.ts`, `utils/messages.ts`.

### 2.9 Sessions / persistence
- JSONL append-only transcripts (`utils/sessionStorage.ts`): recordTranscript,
  flushSessionStorage, resume, fork, rewind, compact boundaries, preserved
  segments, parent UUIDs.
- `commands/resume`, `commands/rewind`, `commands/branch`, `commands/rename`,
  `commands/tag`, `commands/export`, `commands/share`, `commands/teleport`.
- File history snapshots for rewind.

### 2.10 MCP
- `services/mcp/` — client (stdio, SSE, HTTP, WebSocket), auth (OAuth, XAA),
  config, elicitation, channel notifications/permissions, in-process transport,
  SDK control transport, vscode SDK MCP, official registry, env expansion,
  headers helper.
- Commands: mcp, MCPTool, ListMcpResourcesTool, ReadMcpResourceTool, McpAuthTool.

### 2.11 Subagents / tasks / teams
- `tools/AgentTool/` — subagent spawning, loadAgentsDir, agent definitions,
  isolation (worktree), built-in agents.
- `tasks/` — LocalAgentTask, LocalShellTask, RemoteAgentTask, InProcessTeammateTask,
  DreamTask, LocalMainSessionTask.
- `coordinator/coordinatorMode.ts` — coordinator mode (multi-agent orchestration).
- `tools/TaskCreate/Get/List/Output/Stop/Update`, TeamCreate/Delete, SendMessage.
- `components/teams/`, `components/tasks/`.

### 2.12 Worktrees
- `EnterWorktreeTool`, `ExitWorktreeTool`, `WorktreeCreate/Remove` hooks,
  git worktree isolation for agents.

### 2.13 Bridge / remote / IDE
- `bridge/` — bridge main, messaging, permission callbacks, pointer, status,
  remote control, direct connect.
- `remote/` — RemoteSessionManager, SessionsWebSocket, remote permission bridge.
- IDE integration: `useIDEIntegration`, `services/lsp`, LSPTool, `/ide`,
  `/chrome`, `/desktop`, `/mobile`, `/teleport`.

### 2.14 Plugins & skills
- `plugins/`, `services/plugins/`, `commands/plugin`, `commands/reload-plugins`,
  `commands/skills`.
- `skills/` — bundled skills, skill loading, frontmatter.
- Plugin marketplace, official marketplace notification.

### 2.15 Project instructions
- CLAUDE.md / AGENTS.md loading (hierarchical, imports, html comment stripping)
  — prricode already added `project_instructions.rs`.

### 2.16 Vim mode
- `vim/` — vim input mode, motions, operators.

### 2.17 Voice
- `voice/`, `services/voice.ts`, `services/voiceStreamSTT.ts`, `services/voiceKeyterms.ts`,
  `hooks/useVoice.ts`, `/voice` command.

### 2.18 Computer use
- `components/permissions/ComputerUseApproval`, `@ant/computer-use-mcp` (external),
  screenshot/input. prricode has computer-use crate (X11).

### 2.19 Output / rendering
- `ink/` (custom ink fork), components (diff, messages, Spinner, CustomSelect,
  ui, tasks, teams, mcp, permissions, hooks, memory, Passes, DesktopUpsell,
  referenceCodeHint, LogoV2).
- Themes, status line, fullscreen renderer, diffs, keybindings rebinding.

### 2.20 Cost / usage / analytics
- `cost-tracker.ts`, `services/analytics/`, `/cost`, `/usage`, `/stats`,
  `/insights`, `/extra-usage`, `/rate-limit-options`.

### 2.21 Misc
- `buddy/` (pet), `moreright/`, `outputStyles/`, `native-ts/`, `upstreamproxy/`,
  `migrations/`, `constants/`.
- Cron/scheduling: ScheduleCronTool, `/loop` (via useScheduledTasks).
- SleepTool, BriefTool.

## 3. prricode current state (summary)

From `docs/explanation/gap-analysis.md`:
- 18 crates; ~226 tests; protocol fingerprint stable.
- internals.rs: 24/364 surfaces implemented, 231 flagged.
- Agent: 9 tools (shell, read, write, edit, list_dir, glob, grep, web_fetch,
  computer, task, mcp, workflow) — missing ~30.
- No hooks engine, no auto-memory, no JSONL store, no resume/fork/rewind
  persistence, no permission modes beyond approval modes, no model aliases,
  no effort levels, no seatbelt sandbox, no HTTP/SSE MCP, no fullscreen
  renderer, no diffs, no keybinding rebind, no status line.
- Project instructions loader already added (first slice).

## 4. Gap matrix (reference capability -> prricode)

| Reference capability | prricode status | Priority |
|---|---|---|
| TAOR loop with model-decided stop | present (loop_runner) | P0 |
| Streaming tool execution | partial | P0 |
| Interruption/cancellation | present | P0 |
| JSONL append-only sessions + resume/fork/rewind | missing | P0 |
| Permission modes (default/plan/auto/bypass) | missing (approval modes only) | P0 |
| Deny-first + defense in depth | partial (approval engine) | P0 |
| Project instructions (CLAUDE/AGENTS.md) | implemented (first slice) | done |
| Auto-memory (memdir) | missing | P1 |
| Compaction (auto/micro/session-memory) | missing | P1 |
| Hooks engine (26 events) | missing (events defined only) | P1 |
| Subagents (AgentTool, worktree isolation) | partial (TaskTool) | P1 |
| Coordinator mode | missing | P2 |
| MCP (stdio) | present; HTTP/SSE/WS missing | P1 |
| MCP auth (OAuth/XAA) | missing | P2 |
| Plugins | missing (skills only) | P2 |
| Skills (frontmatter, imports) | partial | P1 |
| Worktrees (enter/exit) | missing | P1 |
| Vim mode | missing | P2 |
| Voice | partial | P2 |
| Computer use | partial (X11) | P2 |
| LSP integration | missing | P2 |
| Cron/scheduling | missing (goal has cron?) | P2 |
| Bridge/remote/IDE | missing | P3 |
| Cost/usage tracking | partial | P1 |
| Status line / diffs / fullscreen TUI | partial | P1 |
| Keybindings rebind | missing | P2 |
| Tool inventory completion (~30 tools) | missing | P1 |
| Model aliases + effort levels | missing | P1 |
| CLI surface alignment (commands/flags) | partial | P1 |
| Sandbox hardening (seatbelt, creds mask, proxy) | partial | P1 |

## 5. Phased implementation plan

Each phase = additive slices, TDD, clippy clean, tests green. Order by
dependency and risk.

### Phase 0 — Architectural scan & inventory (DONE)
- gap-analysis.md written; internals disposition inventory (24/364).
- Project instructions loader (first slice).

### Phase 1 — CLI surface alignment
- Add missing subcommands as honest stubs (gateway, agents, attach, auto-mode,
  import, purge, remote-control, setup-token, daemon, self-hosted-runner) with
  `unsupported:` reasons where not runnable.
- Align flags & env var precedence (CLI > env > config.toml > credential store).
- Add model aliases + effort levels to provider.

### Phase 2 — Append-only JSONL session store
- New persistence module: JSONL transcripts (sessions never mutated), resume,
  fork, rewind, compact boundaries, preserved segments, parent UUIDs, file-history
  snapshots.
- Keep SQLite for settings/usage/gates; add JSONL alongside.
- Methods: session/resume, session/fork, session/rewind, session/compact (already
  partially present).

### Phase 3 — Auto-memory
- `~/.prricode/projects/<project>/memory/` with MEMORY.md index.
- Relevant memory retrieval, memory types, team memory.
- Session memory extraction (background), auto-dream consolidation (optional,
  degrade honestly).

### Phase 4 — Streaming tool execution + interruption
- Execute tools as they stream in (not after full response).
- Mid-turn interruption/redirect (steer).
- Tool use summaries.

### Phase 5 — Tool inventory completion + parallel dispatch
- Add missing ~30 tools: AgentTool (enhance TaskTool), AskUserQuestion,
  Bash/PowerShell, Brief, Config, Enter/ExitPlanMode, Enter/ExitWorktree,
  FileEdit/Read/Write (exist), Glob/Grep (exist), LSP, ListMcpResources,
  MCPTool (exists), McpAuth, NotebookEdit, REPL, ReadMcpResource, RemoteTrigger,
  ScheduleCron, SendMessage, SkillTool, Sleep, SyntheticOutput, Task* (exist
  partially), TeamCreate/Delete, TodoWrite (exists), ToolSearch, WebFetch (exists),
  WebSearch.
- Parallel dispatch of independent tool calls.

### Phase 6 — Permission modes + sandbox hardening
- Permission modes: default, plan, auto, bypassPermissions, dontAsk.
- ToolPermissionContext with alwaysAllow/Deny/Ask rules, additionalWorkingDirs,
  isBypassPermissionsModeAvailable.
- Defense in depth: rules + PreToolUse hooks + (optional) ML classifier + sandbox.
- Graduated trust spectrum (auto-approve rate grows with session count).
- Sandbox: seatbelt (macOS), credentials mask, network proxy, path scoping.

### Phase 7 — Hooks engine
- Implement 26 hook events, 5 hook types (command, prompt, http, agent,
  function), matchers, settings integration, PreToolUse/PostToolUse/PermissionRequest
  etc.
- Fire HookExecuted notifications (already defined).

### Phase 8 — Context management / compaction
- autoCompact, microCompact, apiMicrocompact, sessionMemoryCompact, snipCompact
  (optional feature), time-based MC, postCompactCleanup.
- Context as scarce resource: progressive management, token budgeting.

### Phase 9 — Subagents, coordinator, worktrees
- AgentTool with definitions, isolation (worktree), built-in agents.
- Coordinator mode (multi-agent orchestration).
- TeamCreate/Delete, SendMessage.
- Enter/ExitWorktree tools.

### Phase 10 — MCP completion
- HTTP/SSE/WebSocket transports, OAuth/XAA auth, elicitation, channel
  notifications/permissions, in-process transport, official registry, env
  expansion.

### Phase 11 — Plugins
- Plugin loader, marketplace, reload-plugins, bundled plugins, plugin-scoped
  MCP/skills/hooks.

### Phase 12 — Skills completion
- Frontmatter fields, imports, bundled skills, skill improvement survey.

### Phase 13 — TUI completion
- Fullscreen renderer, diffs (turn diffs), keybindings rebind, status line,
  vim mode, voice integration, task list watcher, background task navigation.

### Phase 14 — Vim mode + Voice
- Vim input mode, motions, operators.
- Voice STT/TTS (already partial), bundled models (optional).

### Phase 15 — Computer use completion
- Wayland input, macOS/Windows backends (or honest degradation).

### Phase 16 — LSP integration
- LSPTool, IDE integration, diagnostics.

### Phase 17 — Cron / scheduling
- ScheduleCronTool, /loop, scheduled tasks.

### Phase 18 — Bridge / remote / IDE
- Bridge main, messaging, permission callbacks, remote control, direct connect,
  remote sessions, IDE integration, teleport.

### Phase 19 — Cost / usage / analytics
- Cost tracker, /cost, /usage, /stats, /insights, rate-limit handling.

### Phase 20 — Verification, docs, release
- Adversarial verifier on all new code; acceptance dossiers; docs in Diátaxis;
  release binaries.

## 6. Cross-cutting decisions

- Naming: all identifiers ours; no third-party names. Map reference concepts to
  prricode names (e.g., "CLAUDE.md" -> we already support CLAUDE.md + AGENTS.md
  fallback; keep both for compatibility but docs say AGENTS.md first).
- Protocol: additive only. New methods/fields with `#[serde(default)]`.
- Persistence: JSONL alongside SQLite; SQLite remains for settings/usage/gates.
- Honest degradation: macOS/Windows/Linux sandbox and computer-use degrade with
  reasons.
- Agent isolation: verifier never shares context; subagents get restricted
  registries (already implemented via derive_with_registry).
- TDD: every new module ships tests; workspace suite is the gate.

## 7. Immediate next actions (act mode)

1. Re-run `cargo test --workspace` baseline; record test count.
2. Start Phase 1: CLI surface alignment (honest stubs + flags + env precedence).
3. Start Phase 2: JSONL session store (highest-value foundation).
4. Parallel: Phase 7 hooks engine (needed by Phase 6 defense-in-depth).

## 8. Risks

- Scope is enormous (~512k LOC reference). Must be sliced; each phase shippable.
- No upstream source rights; treat recovered source as research only; write
  our own code.
- Platform coverage: Linux first; macOS/Windows degrade honestly.
- Model-dependent features (ML classifier) degrade without a model.
- Performance: 1.4x token usage; ensure compaction lands before long sessions.

## 9. Open questions for the user

- Confirm act mode to begin Phase 1 + 2 + 7 in parallel.
- Confirm whether to keep CLAUDE.md support (already added) or AGENTS.md only.
- Confirm target platforms priority (Linux first assumed).
