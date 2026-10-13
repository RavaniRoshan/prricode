# prricode — Product Specification

**Date:** 2026-10-13
**Status:** Implementation Ready

---

## 1. Product Identity

**Name:** prricode
**Tagline:** Autonomous AI coding agent with durable sessions, sandboxed execution, and computer-use capabilities.
**Internal codename:** prricode (no mapping needed — this IS the product)

## 2. Architecture

### 2.1 Core Stack
| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Host runtime | Rust | Memory safety, performance, V8 embedding |
| JS/TS engine | V8 (via deno_core or direct) | First-class JS/TS execution |
| Protocol | JSON-RPC 2.0 over stdio | Language-agnostic, debuggable |
| Persistence | SQLite (via rusqlite) | Durable sessions, goals, history |
| Sandbox | bubblewrap (Linux) / seatbelt (macOS) | OS-level isolation |
| CLI | Rust (clap) | Native performance, rich help |

### 2.2 Protocol
**MSP-compatible** — implements the MSP surface:
- 69 methods, 39 notifications, 37 error kinds
- 345 type definitions
- Grantable capabilities: `userShell`, `sessionMcp`, `sessionListStream`, `feedback`, `computerUseSetup`, `computerUseHostSetup`
- Schema fingerprint: `sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9`

### 2.3 CLI Surface
18 subcommands:
```
resume, exec, config, export, trace, model-profile, skills,
voice, plugins, sandbox, schema, serve, session-message, mcp,
auth, login, logout, init
```

Key flags:
- `--provider echo|reference|local`
- `--reasoning-effort none|minimal|low|medium|high|xhigh|max|ultra`
- `--base-url`, `--worktree`, `--approval-mode`, `--permission-profile`
- `--context-compaction-strategy`

## 3. Feature Set

### 3.1 Core Features
1. **Durable Sessions** — session.jsonl format, resumable via cursor
2. **Multi-Provider** — echo (offline), reference (OAuth), local
3. **Sandboxed Execution** — bubblewrap/seatbelt isolation
4. **Computer Use** — screen capture, click, type, scroll
5. **Workflow Engine** — pause/resume/cancel, child control, token budgets
6. **Goal System** — persistent goals with continuation prompts
7. **Skill System** — 20 bundled skills, import from Claude/Codex
8. **Approval Modes** — closed, plus 3 other modes
9. **Context Compaction** — configurable strategies
10. **MCP Integration** — stdio + streamableHttp transports

### 3.2 Bundled Skills (20)
```
browser-app-delivery, create-plugin, create-skill, doctor,
durable-test-collateral, git, greenfield-project-scaffolding, grill,
import, manage-settings, migrate, plan, python-env, read-session,
requirements-claude, resume-codex, table-fit, taste, workflow-authoring
```

### 3.3 Model Support
- `prricode-spark-1.3`, `-1.2`, `-1.1` + `-contributor` variants
- Configurable via `--model` and `--base-url`

## 4. Project Structure

```
prricode/
  Cargo.toml              # Workspace root
  crates/
    prricode-core/        # Protocol types, schema, fingerprint
    prricode-cli/         # CLI argument parsing (clap)
    prricode-server/      # JSON-RPC server, session management
    prricode-sandbox/     # bubblewrap/seatbelt abstraction
    prricode-computer-use/ # Screen capture, input injection
    prricode-workflow/    # Workflow engine
    prricode-skills/      # Skill loading, execution
    prricode-persistence/ # SQLite, goals.db, session.jsonl
    prricode-provider/    # Provider abstraction (echo/reference/local)
  skills/                 # Bundled skill definitions
  schema/                 # Generated JSON schema
  tests/                  # Integration tests
```

## 5. Implementation Priority

### Phase 1 — Protocol Core
- [ ] JSON-RPC 2.0 server over stdio
- [ ] All 69 methods with correct params/results
- [ ] All 39 notifications
- [ ] All 37 error kinds
- [ ] Schema fingerprint matching

### Phase 2 — CLI + Session
- [ ] All 18 subcommands with help
- [ ] Session start/resume lifecycle
- [ ] Durable session.jsonl persistence
- [ ] Provider abstraction (echo first)

### Phase 3 — Runtime
- [ ] V8 integration for JS/TS skills
- [ ] Sandbox abstraction (bubblewrap)
- [ ] Approval mode enforcement
- [ ] Computer-use capabilities

### Phase 4 — Advanced
- [ ] Workflow engine
- [ ] Goal system with continuation
- [ ] Skill import (Claude/Codex)
- [ ] MCP server integration

## 6. Key Features
1. **Open source** — full source available
2. **Provider-agnostic** — not locked to any specific provider API
3. **Community skills** — import from any source
4. **Local-first** — works fully offline with echo provider
5. **Transparent** — no telemetry by default, no hidden behavior

## 7. Security Model
- Sandboxed execution via bubblewrap/seatbelt
- No network access by default in sandbox
- Approval mode for sensitive operations
- Workspace trust gate (untrusted workspaces get restricted capabilities)
- Credentials stored in `$XDG_CONFIG_HOME/prricode/auth.json`
