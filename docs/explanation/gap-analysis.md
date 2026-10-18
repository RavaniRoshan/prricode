# Gap analysis — prricode vs. reference terminal coding agent

Snapshot taken during the Phase 0 architectural scan. Baseline at scan time:
`cargo fmt --check` clean, `cargo clippy --workspace --all-targets -- -D warnings`
clean, `cargo test --workspace` green (~226 tests).

## Internals disposition inventory (prricode-core)

`crates/prricode-core/src/internals.rs` records 364 internal struct families:

- **Implemented: 24**
- **Flagged (future work, not implemented): 231**

The flagged families span the entire agent surface — memory, compaction,
context, hooks, plugins, subagents, sessions, approvals, sandbox, MCP, voice,
computer use, workflow, spec/verify/ship. This is the quantitative measure of
"not fully wired."

## Crate-level gaps

| Crate | Wired? | Notes |
|---|---|---|
| prricode-core | partial | 24/364 internal surfaces implemented; protocol fingerprint stable |
| prricode-cli | partial | 18 subcommands; missing reference commands (gateway, agents, attach, auto-mode, import, purge, remote-control, setup-token, daemon, self-hosted-runner) and several flags |
| prricode-server | strong | 85+ methods, sessions, goals, notifications; fork/rewind/compact handlers present |
| prricode-agent | partial | turn loop present; tool registry has 9 tools; missing ~30; no hooks engine, no project-instructions loader (now added), no auto-memory |
| prricode-provider | partial | echo + ollama + openai-compat presets; no model aliases, no effort levels |
| prricode-persistence | partial | SQLite only; no JSONL append-only store, no resume/fork/rewind persistence |
| prricode-sandbox | partial | bubblewrap Linux only; no seatbelt (macOS), no credentials mask, no network proxy |
| prricode-computer-use | partial | X11 only; Wayland input not implemented; macOS/Windows stubs |
| prricode-workflow | present | state machine present |
| prricode-skills | partial | SKILL.md loading + script runtime; missing frontmatter fields, imports |
| prricode-mcp | partial | stdio only; no HTTP/SSE/WebSocket |
| prricode-voice | partial | traits + OpenAI-compat + local commands; no bundled models |
| prricode-tui | strong | composer, streaming, approvals, 25 themes, image paste, command bar, pipeline rail; missing fullscreen renderer, diffs, keybindings rebinding, status line |
| prricode-spec | present | concept/EARS/Core-4/stack presets/task graph |
| prricode-verify | present | gate runner, adversarial verifier, acceptance dossier |
| prricode-ship | present | release, deploy, operate |
| prricode-pipeline | present | clarify→specify→plan→build→verify→ship→operate |

## First slice implemented (this pass)

- Added `crates/prricode-agent/src/project_instructions.rs`: loads `CLAUDE.md` /
  `.claude/CLAUDE.md` / `CLAUDE.local.md` and (fallback) `AGENTS.md` /
  `.claude/AGENTS.md` from the workspace and every ancestor (broadest first),
  strips block-level HTML comments, resolves `@path` imports, supports modes
  `AgentMdOrAgentsMd` (default), `AgentMdOnly`, `AgentMdAndAgentsMd`,
  `ManagedOnly`.
- Wired into `build_system_prompt` via new `project_instructions` field and
  into `run_turn_inner` via `load_project_instructions`.
- 11 unit tests added; all pass; clippy clean.

## Recommended next slices

1. Phase 1: CLI surface alignment (add missing subcommands as honest stubs +
   flags + env var precedence).
2. Phase 2: JSONL append-only session store + resume/fork/rewind.
3. Phase 3 (cont.): auto-memory (`~/.prricode/projects/<project>/memory/`).
4. Phase 4: streaming tool execution + interruption in loop_runner.
5. Phase 5: tool inventory completion + parallel dispatch.
6. Phase 6: permission modes + sandbox hardening.
7. Phase 7: hooks engine.
8. Phase 8: TUI fullscreen renderer + diffs + keybindings.
9. Phase 9: model aliases + effort levels.
10. Phase 10: verification, docs, release.
