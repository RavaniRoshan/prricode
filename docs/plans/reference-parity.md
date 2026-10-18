# Terminal Agent Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the existing Rust workspace to full behavioral and UX parity with the reference terminal agent, replacing half-finished or unwired surfaces with complete implementations, while preserving the workspace's own protocol, naming, and product-builder pipeline.

**Architecture:** Retain the Rust workspace and crate boundaries. Treat the recovered reference source tree as a read-only specification for behavior, command surface, tool surface, and UX. Implement each capability in its owning crate, behind the existing JSON-RPC protocol and approval engine. No reference source code is copied; all implementation is original. The product-builder pipeline remains a layer on top of the parity base.

**Tech Stack:** Rust 2021, Cargo workspace, tokio, ratatui/crossterm, serde/serde_json, rusqlite, reqwest, bubblewrap sandbox, X11/Wayland computer use.

**Spec:** a locally recovered reference source tree (version 2.1.88, research-only, not shipped and not committed). Supporting inventory is generated into `docs/reference/parity-matrix.md`.

## Global Constraints

- Protocol compatibility: schema fingerprint and existing method shapes in `prricode-core` never change; new capabilities are additive only.
- Public repo hygiene: no third-party product or company names in code, comments, docs, commit messages, or identifiers. Refer to the reference only as "the reference terminal agent" in shipped artifacts.
- Every agent-facing behavior is a tool or protocol method, not hidden magic.
- Honest degradation: unsupported features degrade with a clear reason (`enabled: false`, `unsupported: <why>`), never fake success.
- TDD: test first, watch it fail, implement, watch it pass.
- `cargo fmt` before every commit; clippy `-D warnings` must stay at zero.
- Agent isolation: verifier never shares context with builder; approvals gate side effects.
- Recovered reference source is proprietary research material. Implement behavior independently; do not copy source text.

---

## Phase 0 — Baseline Audit and Parity Matrix

### Task 0.1: Generate feature inventory from the reference tree

**Files:**
- Create: `docs/reference/parity-matrix.md`
- Create: `scripts/parity_inventory.sh`

**Interfaces:**
- Produces: `docs/reference/parity-matrix.md` with sections for CLI flags, commands, tools, services, screens, hooks, keybindings, output styles, migrations, plugins, skills, MCP, remote/bridge, voice, LSP, vim, tasks, coordinator.
- Consumes: the locally recovered reference source tree.

- [ ] **Step 1: Write the inventory script** that walks the reference tree and emits counts plus per-item lists for `src/commands`, `src/tools`, `src/services`, `src/hooks`, `src/components`, `src/screens`, `src/keybindings`, `src/migrations`, `src/plugins`, `src/skills`, `src/outputStyles`.

- [ ] **Step 2: Run the script** and capture output into `docs/reference/parity-matrix.md` under a "Reference Inventory" heading.

- [ ] **Step 3: Add a "Current Status" column** mapping each item to one of: `implemented`, `partial`, `missing`, `not-planned`, with the owning crate named.

- [ ] **Step 4: Commit** the matrix and script.

### Task 0.2: Audit the existing Rust workspace

**Files:**
- Modify: `docs/reference/parity-matrix.md`
- Create: `docs/reference/workspace-audit.md`

- [ ] **Step 1: Enumerate every public method** in `prricode-server` dispatch and every tool in `prricode-agent` registry; record them in `workspace-audit.md`.

- [ ] **Step 2: For each crate, record** implemented surfaces, known gaps, and unwired code paths (search for `todo!`, `unimplemented!`, `// TODO`, `// FIXME`, `unreachable!`).

- [ ] **Step 3: Cross-reference** the audit against the parity matrix; mark gaps.

- [ ] **Step 4: Commit**.

### Task 0.3: Define the parity target and exclusions

**Files:**
- Create: `docs/explanation/parity-target.md`

- [ ] **Step 1: Decide** which reference features are in scope for v1 parity (core CLI, REPL, tools, commands, permissions, MCP, skills, sessions, settings, sandbox, git helpers, LSP, voice, vim, keybindings, remote, coordinator, buddy, plugins, tasks).

- [ ] **Step 2: Decide exclusions** with reasons (ant-only internals, proprietary telemetry, account-gated services, platform-specific native binaries that cannot ship).

- [ ] **Step 3: Record the deprecation policy** for the existing product-builder pipeline (retained, layered on top).

- [ ] **Step 4: Commit**.

---

## Phase 1 — Core Runtime and CLI Parity

### Task 1.1: CLI argument and subcommand parity

**Files:**
- Modify: `crates/prricode-cli/src/main.rs`
- Test: `crates/prricode-cli/tests/cli_parity.rs` (new)

- [ ] **Step 1: Write failing tests** asserting presence of core flags and subcommands (`-p/--print`, `--output-format`, `--permission-mode`, `--worktree`, `--model`, `--resume`, `--continue`, `mcp`, `auth`, `doctor`, `update`, `install`, `plugin`, `agents`, `server`, `ssh`, `open`).

- [ ] **Step 2: Run tests; confirm failure.**

- [ ] **Step 3: Implement missing flags/subcommands** by extending the clap definitions, delegating to existing handlers where present.

- [ ] **Step 4: Run tests; confirm pass.**

- [ ] **Step 5: Commit.**

### Task 1.2: Non-interactive print mode and output formats

**Files:**
- Modify: `crates/prricode-cli/src/main.rs`, `crates/prricode-server/src/lib.rs`
- Test: `tests/e2e_print_mode.sh` (new)

- [ ] **Step 1: Write failing tests** for `--print` with `text`, `json`, and `stream-json` output.

- [ ] **Step 2: Implement** a headless turn path that runs one turn and emits the requested format.

- [ ] **Step 3: Verify** tests pass and clippy clean.

- [ ] **Step 4: Commit.**

### Task 1.3: Session lifecycle parity

**Files:**
- Modify: `crates/prricode-server/src/lib.rs`, `crates/prricode-persistence/src/*.rs`
- Test: `crates/prricode-server/tests/session_lifecycle.rs` (new)

- [ ] **Step 1: Write failing tests** for create, resume by id, continue most recent, fork, rename, export, share.

- [ ] **Step 2: Implement** missing session operations in persistence and dispatch.

- [ ] **Step 3: Run tests; commit.**

### Task 1.4: Cost, usage, and token tracking

**Files:**
- Modify: `crates/prricode-provider/src/*.rs`, `crates/prricode-persistence/src/*.rs`, `crates/prricode-tui/src/*.rs`
- Test: unit tests in provider crate

- [ ] **Step 1: Write failing tests** for per-turn and per-session token/cost accumulation and display.

- [ ] **Step 2: Implement** usage accounting on the provider response path and surface in TUI/status.

- [ ] **Step 3: Run tests; commit.**

---

## Phase 2 — Tool Parity

### Task 2.1: Tool registry audit and missing core tools

**Files:**
- Modify: `crates/prricode-agent/src/tools/mod.rs`, `crates/prricode-agent/src/loop_runner.rs`
- Create: `crates/prricode-agent/src/tools/{ask_user,plan_mode,worktree,notebook,bash,...}.rs` as needed
- Test: `crates/prricode-agent/tests/tool_registry.rs` (new)

- [ ] **Step 1: Write failing test** enumerating expected tool names and asserting registration.

- [ ] **Step 2: Add missing tool structs** implementing the `Tool` trait, starting with `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `EnterWorktree`, `ExitWorktree`, `NotebookEdit`, `TodoWrite`, `Task*`.

- [ ] **Step 3: Wire tools** into `build_registry`.

- [ ] **Step 4: Run tests; commit.**

### Task 2.2: Bash tool fidelity

**Files:**
- Modify: `crates/prricode-agent/src/tools/shell.rs` (or equivalent)
- Test: crate unit tests

- [ ] **Step 1: Write failing tests** for timeout, background execution, sandbox toggle, path scoping, output truncation.

- [ ] **Step 2: Implement** missing behaviors.

- [ ] **Step 3: Run tests; commit.**

### Task 2.3: File tools fidelity

**Files:**
- Modify: read/write/edit/list/glob/grep tools
- Test: crate unit tests

- [ ] **Step 1: Write failing tests** for partial reads, line ranges, encoding, atomic writes, diff output, binary handling.

- [ ] **Step 2: Implement**.

- [ ] **Step 3: Run tests; commit.**

### Task 2.4: Web tools fidelity

**Files:**
- Modify: `crates/prricode-agent/src/tools/web_fetch.rs`, web search
- Test: crate unit tests with mock server

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** caching, redirect handling, content extraction, search provider.

- [ ] **Step 3: Run tests; commit.**

### Task 2.5: MCP tooling fidelity

**Files:**
- Modify: `crates/prricode-mcp/src/*.rs`, `crates/prricode-agent/src/tools/mcp.rs`
- Test: integration tests

- [ ] **Step 1: Write failing tests** for resource list/read, tool search, auth flow, channel notifications.

- [ ] **Step 2: Implement**.

- [ ] **Step 3: Run tests; commit.**

### Task 2.6: LSP, voice, vim, and computer-use tools

**Files:**
- Modify: `crates/prricode-computer-use`, voice crate, new LSP client module
- Test: crate tests

- [ ] **Step 1: Write failing tests** for LSP diagnostics/goto/refs, voice STT/TTS, vim mode transitions.

- [ ] **Step 2: Implement** or degrade with explicit `unsupported` reasons where host prerequisites missing.

- [ ] **Step 3: Run tests; commit.**

---

## Phase 3 — Command and Interaction Parity

### Task 3.1: Slash command registry

**Files:**
- Modify: `crates/prricode-tui/src/*.rs`, `crates/prricode-server/src/lib.rs`
- Create: `crates/prricode-agent/src/commands.rs` (or server-side)
- Test: unit tests

- [ ] **Step 1: Write failing test** listing expected slash commands and dispatch.

- [ ] **Step 2: Implement** a command registry with metadata (name, description, aliases, source) and dispatch to handlers.

- [ ] **Step 3: Wire** into TUI `/command` bar and server protocol.

- [ ] **Step 4: Run tests; commit.**

### Task 3.2: Core slash commands (batch 1)

**Files:**
- Modify: command handlers
- Test: integration tests

Commands: help, clear, compact, context, cost, usage, status, doctor, version, exit, rename, resume, share, export, copy, diff, files, branch, tag, theme, color, vim, fast, effort, model, config, permissions, hooks, memory, mcp, skills, plugins, tasks, plan, rewind, sandbox-toggle.

- [ ] **Step 1: Write failing tests** per command (argument parsing + output).

- [ ] **Step 2: Implement** handlers, reusing existing crates.

- [ ] **Step 3: Run tests; commit.**

### Task 3.3: Git and GitHub slash commands (batch 2)

Commands: commit, commit-push-pr, review, pr_comments, branch, teleport, install-github-app, install-slack-app, security-review, autofix-pr, bughunter.

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** using sandboxed git/gh invocations.

- [ ] **Step 3: Run tests; commit.**

### Task 3.4: Remote, bridge, and server commands (batch 3)

Commands: remote-setup, remote-env, bridge, bridge-kick, server, ssh, open, teleport, remote-control, assistant.

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** or degrade with reasons where network/remote prerequisites unavailable.

- [ ] **Step 3: Run tests; commit.**

### Task 3.5: Utility and ant-only-gated commands (batch 4)

Commands: heapdump, mock-limits, reset-limits, ant-trace, perf-issue, ctx_viz, break-cache, backfill-sessions, insights, stickers, passes, upgrade, login, logout, oauth-refresh, onboarding, terminalSetup, thinkback, thinkback-play, extra-usage, rate-limit-options, release-notes, stats, summary, env, add-dir, output-style, mobile, desktop, chrome.

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** or mark `not-planned` with reasons in the parity matrix.

- [ ] **Step 3: Run tests; commit.**

---

## Phase 4 — UX and Interface Parity

### Task 4.1: Message rendering and diff display

**Files:**
- Modify: `crates/prricode-tui/src/*.rs`
- Test: TUI unit tests / snapshot tests

- [ ] **Step 1: Write failing tests** for message list, tool call rendering, structured diff, spinner, status line.

- [ ] **Step 2: Implement** rendering components matching reference layout.

- [ ] **Step 3: Run tests; commit.**

### Task 4.2: Permission and approval dialogs

**Files:**
- Modify: `crates/prricode-agent/src/approval.rs`, `crates/prricode-tui/src/*.rs`

- [ ] **Step 1: Write failing tests** for y/s/a/n flows, timeout denial, policy amendments.

- [ ] **Step 2: Implement** missing dialog variants (plan approval, sandbox, MCP auth, trust dialog).

- [ ] **Step 3: Run tests; commit.**

### Task 4.3: Settings, keybindings, themes

**Files:**
- Modify: `crates/prricode-tui/src/*.rs`, `crates/prricode-persistence/src/*.rs`

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** settings UI, keybinding editor, theme switching (25 themes baseline).

- [ ] **Step 3: Run tests; commit.**

### Task 4.4: Onboarding, help, and wizards

**Files:**
- Modify: TUI + server

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** onboarding flow, help V2, setup wizards.

- [ ] **Step 3: Run tests; commit.**

---

## Phase 5 — Advanced Subsystems

### Task 5.1: Coordinator and multi-agent mode

**Files:**
- Modify: `crates/prricode-agent/src/*.rs`, `crates/prricode-server/src/lib.rs`

- [ ] **Step 1: Write failing tests** for coordinator mode, teammate spawning, in-process/tmux modes.

- [ ] **Step 2: Implement** agent swarms on top of existing subagent infrastructure.

- [ ] **Step 3: Run tests; commit.**

### Task 5.2: Tasks, cron, and workflow scripts

**Files:**
- Modify: `crates/prricode-workflow/src/*.rs`, agent tools

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** task list tools, cron triggers, workflow scripts.

- [ ] **Step 3: Run tests; commit.**

### Task 5.3: Plugins and bundled skills

**Files:**
- Modify: `crates/prricode-skills/src/*.rs`, new plugin crate or module

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** plugin loading, bundled plugins, reload command.

- [ ] **Step 3: Run tests; commit.**

### Task 5.4: Remote control, bridge, and server mode

**Files:**
- Modify: `crates/prricode-server/src/lib.rs`, new remote module

- [ ] **Step 1: Write failing tests.**

- [ ] **Step 2: Implement** HTTP/WebSocket server mode, bridge, SSH deploy.

- [ ] **Step 3: Run tests; commit.**

### Task 5.5: Buddy, proactive, and experimental features

**Files:**
- Modify: agent/server

- [ ] **Step 1: Write failing tests** or mark `not-planned` with reasons.

- [ ] **Step 2: Implement** in-scope items; degrade others with reasons.

- [ ] **Step 3: Run tests; commit.**

---

## Phase 6 — Product Builder Integration on Parity Base

### Task 6.1: Rebase pipeline on parity runtime

**Files:**
- Modify: `crates/prricode-pipeline/src/*.rs`, `crates/prricode-tui/src/*.rs`

- [ ] **Step 1: Write failing tests** that pipeline stages run on the parity tool/command set.

- [ ] **Step 2: Adapt** pipeline to use new tools/commands instead of ad-hoc surfaces.

- [ ] **Step 3: Run tests; commit.**

### Task 6.2: Documentation and conformance

**Files:**
- Modify: `docs/**`, `docs/reference/protocol-conformance.md`

- [ ] **Step 1: Update** docs to describe the parity surface without third-party names.

- [ ] **Step 2: Add conformance tests** for protocol additions.

- [ ] **Step 3: Commit.**

---

## Phase 7 — Verification and Release

### Task 7.1: Parity test suite

**Files:**
- Create: `tests/parity/*.rs` or shell scripts

- [ ] **Step 1: Define** parity acceptance criteria from the matrix.

- [ ] **Step 2: Implement** automated checks for command/tool/flag presence and basic behavior.

- [ ] **Step 3: Run full workspace tests + clippy + fmt.**

- [ ] **Step 4: Commit.**

### Task 7.2: Release

- [ ] **Step 1: Tag** release after CI green.

- [ ] **Step 2: Publish** binaries.

---

## Execution Notes

- Start with Phase 0 to lock the scope and avoid scope creep.
- Each phase should leave the workspace compiling and tests green.
- Prefer extending existing crates over creating new ones; new crates require justification in the PR.
- Any feature that cannot run on this host must degrade with an explicit reason, not fake success.
- The recovered reference source is used only for behavioral specification during research; implementation is original.

## Self-Review Checklist (run before execution)

1. Spec coverage: every item in `docs/reference/parity-matrix.md` maps to a task.
2. Placeholder scan: no TBD/TODO in committed plan tasks; deferred items are marked `not-planned` with reasons.
3. Type consistency: tool and command names used across phases match the registry names defined in Phase 2/3.

---

Plan complete and saved to `docs/plans/reference-parity.md`. Two execution options:

1. Subagent-Driven (recommended) — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. Inline Execution — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
