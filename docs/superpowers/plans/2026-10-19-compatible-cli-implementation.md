# Full CLI-Compatible Implementation: Implementation Plan

> **Plan status:** Draft for user review. This is the full feature-parity program for a pinned target release; it is not an MVP plan. Native REA findings are not yet available, so target-specific native behavior remains an explicit prerequisite and open item.
>
> **Execution:** After approval, use `subagent-driven-development` or `executing-plans` as the implementation workflow. Update `docs/PROGRESS.md` at every task handoff so any later agent can resume from the recorded state.

**Goal:** Build an independently implemented coding-agent CLI with broad observable compatibility with the pinned reference build `2.1.303` on Linux x86-64, plus a first-class provider manager/catalog that can connect multiple authorized model services concurrently. Full scope includes terminal and headless use, settings/context discovery, tools and permissions, session persistence, provider/model management, extensions, integrations, packaging, and measured compatibility reporting.

**Architecture:** Proposed TypeScript/Node.js CLI with stable domain interfaces beneath CLI/TUI renderers. Keep provider protocol drivers, model capability normalization, conversation orchestration, session storage, permission enforcement, tool execution, configuration/context loading, and extension hosts as separate modules. Keep model-generated actions behind permission and execution services. Store provider credentials as environment or OS credential-store references. The provider catalog must not resolve secrets or choose a destination for them on its own.

**Initial technology direction:** TypeScript on Node.js LTS; JSON/JSONL configuration and session records with explicit versioning; provider drivers behind a common streaming interface. Confirm the TUI and persistence libraries in short architecture spikes before depending on them. This choice is a proposal pending the user’s review.

**Research:** [Research report](../../../research/compatible-cli.md)  
**Target record:** [REA record for the pinned reference build (2.1.303)](../../reverse-engineering/reference-agent-2.1.303-partial.md)  
**Resume ledger:** [Project progress](../../PROGRESS.md)

## Scope and compatibility rules

- Target behavior is pinned to the pinned reference build `2.1.303`, npm distribution, Linux x86-64 artifact SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`. Extend platforms only through explicit matrix entries; record every tested platform and version.
- The deliverable is observable compatibility, not reuse of private source code or credentials. Separate target-compatible behavior from product extensions requested here.
- Multi-provider management is a required product extension inspired by Kimi Code: simultaneous provider entries, protocol-specific adapters, a searchable/importable model catalog, and interactive `/provider` management plus a noninteractive command. It is not represented as a the reference agent feature.
- Target-specific native findings remain unknown until REA returns a completed native Evidence record. The first execution task must resume that analysis through a retained or narrower Ghidra operation; do not treat timed-out operations as evidence.
- Use only provider credentials authorized for the selected services. Do not collect, reuse, or route the vendor's consumer subscription sessions/OAuth for this implementation. Keep secrets out of settings exports, sessions, debug logs, and fixtures.
- Permissions, path boundaries, shell execution, approval prompts, and credential redaction are enforced by implementation-owned code, independent of model instructions.
- Each compatibility claim links to a pinned target contract row and identifies whether its evidence is official documentation, REA, bounded runtime observation, product requirement, inference, or unknown.
- All feature domains below remain in the plan. Dependency ordering controls implementation sequence; it does not remove later domains from the target.

## Durable task marking and handoff contract

Use stable IDs (`CC-001`, `CC-002`, …) and the checkboxes in this file as milestone markers. `docs/PROGRESS.md` is the resume index and must be updated by every implementing agent when it starts, after completing a task, and before handing off. A handoff records: task ID/status, commit or working-tree reference if available, files changed, evidence IDs and hashes, decisions, commands actually run, verification results, known failures, and the exact next task/action. Never infer progress from the last chat, an agent’s memory, or a checkbox without a matching ledger entry. If an agent stops mid-task, leave the task unchecked and write the last safe checkpoint and restart instructions in the ledger.

## Planned project layout

- `docs/PROGRESS.md` — durable task status and agent handoff record.
- `docs/reverse-engineering/target-manifest.md` — target identity, hash, platform, scope, and analysis boundaries.
- `docs/reverse-engineering/evidence-index.md` — claims linked to evidence, confidence, and open questions.
- `docs/compatibility/` — command, config, providers, sessions, tools, permissions, extensions, integrations, and results matrices.
- `src/cli/` — argument parsing, command dispatch, output formats, and noninteractive mode.
- `src/config/` — precedence, environment, project instructions, and extension discovery.
- `src/provider/` — provider registry, catalog, auth references, protocol drivers, capability normalization, and model routing.
- `src/session/` — turn lifecycle, event model, persistence, continue/resume/fork, and compaction.
- `src/permissions/` and `src/tools/` — policies, user approval, isolated tool runners, and built-in tools.
- `src/extensions/` — MCP, hooks, skills/commands, subagents, plugins/marketplaces, and code intelligence boundaries.
- `src/ui/` and `src/integrations/` — interactive terminal, accessibility, editor/IDE and automation protocols.
- `tests/contracts/`, `tests/security/`, and `tests/compatibility/` — deterministic contracts, security boundaries, and target comparison scenarios.

## Milestones

### CC-001 — Complete a usable REA native baseline and freeze the target manifest

**Files:** Modify `docs/reverse-engineering/reference-agent-2.1.303-partial.md`; create `docs/reverse-engineering/target-manifest.md` and `docs/reverse-engineering/evidence-index.md`.

- [ ] Confirm the persistent target digest before each run and preserve the successful npm wrapper Evidence ID.
- [ ] Resume Ghidra from a retained project/snapshot or use a narrower REA operation. The broad `read_binary_inventory_summary` timed out at 330, 360, and 900 seconds; do not repeat unchanged.
- [ ] Produce one native REA Evidence ID that identifies the ELF, sections/segments, entry point or relevant function inventory, plus analysis limitations.
- [ ] Pursue focused REA evidence for CLI dispatch/flags, provider and model config, session/persistence, tool and permission dispatch, and extension interfaces. Keep each result tied to the same target hash.
- [ ] Record observations, inferences, confidence, and unanswered questions separately; retain timeout/error reports as operational limitations, not target behavior.
- **Gate:** The target manifest is pinned and at least one native REA Evidence ID is recorded. If the Ghidra provider cannot produce one, record the exact blocker and continue only with documentation-backed rows labeled as such.

### CC-002 — Establish the durable project ledger and evidence-backed feature matrix

**Files:** Create `docs/PROGRESS.md`; create/modify `docs/compatibility/feature-matrix.md` and `docs/reverse-engineering/evidence-index.md`.

- [ ] Initialize stable task IDs and fields for current task, last completed task, next action, evidence IDs/hashes, decisions, changed files, verification run, blocker, and restart command.
- [ ] Cover every domain: CLI commands/flags, interactive UX, output formats, config/context, providers/catalog, routing/auth, tools, permissions/sandbox, sessions/history/compaction, MCP/hooks/skills/subagents/plugins, IDE/editor interfaces, background/remote workflows where documented for the pinned target, packaging/update/diagnostics, and security.
- [ ] Tag each row `target documented`, `REA observed`, `runtime observed`, `project requirement`, `inference`, or `unknown`; do not turn docs for a later release into `2.1.303` observations.
- [ ] Add a handoff protocol that tells the next agent exactly where to resume and how to update the ledger.
- **Gate:** An incoming agent can identify the next task and evidence state by reading repository files only.

### CC-003 — Define and freeze CLI/config/session compatibility contracts

**Files:** Create `docs/compatibility/cli-contract.md`, `config-contract.md`, `session-contract.md`, and `terminal-scenarios.md`.

- [ ] Specify command forms, help/version, flags, error/exit behavior, stdin, text/JSON/stream-JSON output, cancellation, and interactive startup for the pinned release.
- [ ] Specify config scopes and per-key precedence/merge behavior, env precedence, project instruction discovery, bare/minimal mode, and provenance of each resolved value.
- [ ] Specify session create/list/continue/resume/fork, identity, persistence, history lookup, compaction, corruption recovery, and secret redaction.
- [ ] Define deterministic scenarios and expected stdout/stderr/state from cited documentation, REA, and explicitly authorized bounded observations.
- **Gate:** No contract marks a feature supported without a source row and target version.

### CC-004 — Build the multi-provider registry, catalog, and provider manager

**Files:** Create `src/provider/types.ts`, `registry.ts`, `catalog.ts`, `credentials.ts`, `commands.ts`, `src/ui/provider-manager.ts`, and `docs/compatibility/providers.md`.

- [ ] Define `ProviderDefinition` with stable ID, protocol type/version, endpoint, auth reference, enabled state, source/provenance, and metadata; define `ModelDefinition` with provider ID, provider model ID, alias, context/output limits, capability declarations, and default/fallback metadata.
- [ ] Allow multiple simultaneously connected providers and multiple models per provider. Support add, edit, test connection without prompt disclosure, list, select default, delete, import/export without secret values, and noninteractive management.
- [ ] Implement the interactive `/provider` manager and a scriptable provider command with validation, confirmations for destructive edits, and catalog reachability diagnostics.
- [ ] Support curated catalog snapshots and an optional external catalog/custom registry. Treat imported endpoint/auth-variable hints as untrusted metadata; never read a secret merely because a catalog names an environment variable.
- [ ] Define cache refresh/offline behavior, model deprecation/availability status, endpoint allowlisting or explicit trust prompts, provider-specific capabilities, and clear unsupported-feature reporting.
- **Gate:** Users can configure and switch among two mock providers without changing session code or persisting credential values.

### CC-005 — Implement provider protocol drivers and capability normalization

**Files:** Create protocol drivers under `src/provider/drivers/`, normalized stream types, and `docs/compatibility/provider-protocols.md`.

- [ ] Establish `ProviderDriver` operations for model listing/metadata, auth validation, streaming turn requests, tool calls/results, cancellation, usage, errors, and retry classification.
- [ ] Implement adapters for Anthropic Messages; OpenAI Chat Completions and Responses; Google GenAI; Vertex AI; Amazon Bedrock; Microsoft Foundry; and configurable OpenAI-compatible gateways. Include Kimi-compatible endpoints as a preset, without requiring Kimi account OAuth.
- [ ] Normalize text, reasoning/analysis where provider permits, tool calls, images/attachments, usage, finish reasons, and streaming deltas while retaining provider-specific fields in an extension bag.
- [ ] Add per-model capability declarations and truthful mismatch handling for vision, tool use, structured output, reasoning, context/output size, and multimodal input.
- [ ] Resolve credentials only from explicitly configured env references or OS credential storage; redact them from errors, telemetry, child-process environment, and logs.
- **Gate:** Protocol contract fixtures pass for every advertised adapter, and an unsupported capability fails clearly before sending an incompatible request.

### CC-006 — Implement shared agent runtime, streaming event model, and model routing

**Files:** Create `src/runtime/`, `src/session/events.ts`, `src/provider/router.ts`, and `docs/compatibility/agent-loop.md`.

- [ ] Define stable `AgentRequest`, `AgentEvent`, `TurnState`, `ToolProposal`, and `RuntimeDependencies` contracts independent of TUI and provider wire formats.
- [ ] Implement provider/model selection, per-session overrides, fallback chains, context-budget checks, cancellation, retry/backoff, and bounded loop behavior.
- [ ] Convert normalized provider tool calls into proposals only. Route every proposal through the permission service before execution and return results as runtime events.
- [ ] Support attachments and context assembly with explicit size/token accounting and provider capability negotiation.
- [ ] Specify error and resume behavior for partial streams, provider disconnects, malformed frames, rate limits, and interrupted turns.
- **Gate:** A mock provider can stream a complete text-only and tool-call turn through the shared event model with no UI dependency.

### CC-007 — Implement permission policy, sandbox boundary, and built-in tools

**Files:** Create `src/permissions/`, `src/tools/`, `src/sandbox/`, `docs/compatibility/permissions.md`, and `docs/compatibility/tools.md`.

- [ ] Define the full pinned permission-mode/rule contract, source precedence, allow/deny/ask behavior, approval UI payload, and audit record.
- [ ] Implement core file read/search/list, create/edit/write, shell/PTY, and other pinned built-in tools through a common authorized execution boundary.
- [ ] Enforce workspace/additional-directory boundaries against traversal and symlinks; handle shell launch, cancellation, output limits, process cleanup, and denied commands.
- [ ] Filter provider credentials from child environments and redact secrets from tool output, session data, crash reports, and debug logs.
- [ ] Add adversarial fixtures for path escape, symlink replacement, command quoting/injection, approval bypass, malformed tool inputs, and output truncation.
- **Gate:** Denied actions never reach executors; allowed/approved operations stay within declared boundaries.

### CC-008 — Implement settings, context discovery, instructions, memory, and commands

**Files:** Create `src/config/`, `src/context/`, `src/commands/`, and `docs/compatibility/configuration.md`.

- [ ] Implement managed, CLI, project-local, shared-project, and user scopes with key-specific replacement/merge rules.
- [ ] Load project instructions and rules with correct directory ancestry, subdirectory behavior, shared/user sources, trust decisions, and minimal/bare mode.
- [ ] Implement auto memory or the pinned target’s equivalent, bounded storage, retrieval, user controls, and clear separation from committed project instructions.
- [ ] Discover slash commands/skills from built-in, project, user, plugin, and MCP sources; preserve namespacing, argument passing, invocation policy, and precedence.
- [ ] Record source provenance for each loaded instruction, config value, command, and memory item.
- **Gate:** Deterministic fixtures prove each documented precedence and discovery rule with no accidental out-of-scope path loading.

### CC-009 — Implement session persistence, resumption, history, and compaction

**Files:** Create `src/session/store.ts`, `resume.ts`, `history.ts`, `compaction.ts`, and `docs/compatibility/session-storage.md`.

- [ ] Store versioned append-only session events with stable IDs, project/worktree context, provider/model reference, turn status, and safe metadata.
- [ ] Implement new session, continue-latest, resume-by-ID/name, fork, list/search, export/delete, interrupted-turn recovery, and corrupt-record handling.
- [ ] Implement context compaction/summarization hooks with provenance and recovery boundaries; never put credentials in transcripts.
- [ ] Handle concurrent processes, atomic writes, file permissions, retention, and explicit purge semantics.
- [ ] Ensure resuming after process restart reconstructs context and next-turn selection without relying on terminal history.
- **Gate:** Contract scenarios cover persistence and each supported lifecycle action across process boundaries.

### CC-010 — Implement CLI commands, headless modes, and automation interfaces

**Files:** Create `src/cli/args.ts`, `dispatch.ts`, `print.ts`, `output.ts`, and `docs/compatibility/automation.md`.

- [ ] Implement pinned command/flag parsing, precedence, diagnostics, subcommands, stdin, and exit status.
- [ ] Implement print/headless text, JSON, and stream-JSON modes with exact event framing, error output, tool-use reporting, and cancellation.
- [ ] Implement noninteractive provider management, model selection, session management, config diagnostics, and machine-readable output.
- [ ] Implement documented hooks for stdin/stdout, system prompt/settings injection, allowed tool filters, directory scope, verbosity/debug, and bare/minimal mode.
- [ ] Keep stdout protocol-clean where machine-readable formats are selected; send diagnostics to the target-appropriate channel.
- **Gate:** Contract scenarios compare CLI invocations and stable fields against the pinned target’s documented/observed behavior.

### CC-011 — Implement full interactive terminal experience and accessibility modes

**Files:** Create `src/ui/terminal.ts`, `input.ts`, `transcript.ts`, `permission-prompt.ts`, `accessibility.ts`, and `docs/compatibility/interactive-mode.md`.

- [ ] Implement prompt editing/history, multiline input, queued messages, interrupt/resume, transcript navigation/search, tool activity, permission prompts, slash menu, session controls, and exit behavior.
- [ ] Render shared `AgentEvent` and session events without embedding runtime logic in the UI.
- [ ] Implement resize/terminal capability handling, color themes, plain/screen-reader mode, copy/paste behavior, and recoverable terminal cleanup.
- [ ] Add pseudo-terminal interaction scenarios for the pinned release and compare prompts, key actions, and visible state.
- **Gate:** UI scenarios pass on a real TTY and supported plain/accessibility output mode.

### CC-012 — Implement MCP, hooks, skills, subagents, plugins, and code intelligence

**Files:** Create `src/extensions/mcp/`, `hooks/`, `skills/`, `subagents/`, `plugins/`, `code-intelligence/`, and `docs/compatibility/extensions.md`.

- [ ] Implement MCP transports and resource/tool/prompt discovery, per-project/user/managed configuration, OAuth where supported by the external server, timeout and disconnect behavior.
- [ ] Implement hook lifecycle events, matcher semantics, shell/HTTP/prompt/agent action types, timeout/result handling, and fail-closed security policy.
- [ ] Implement skills/custom slash commands, supporting files, frontmatter, argument expansion, dynamic invocation, and trust/preload controls.
- [ ] Implement isolated subagent definitions, tool/model/permission restrictions, task output, cancellation, nested delegation boundaries, and session linkage.
- [ ] Implement plugin manifests, namespaced components, marketplace metadata/install/update/uninstall, trust prompts, and provenance.
- [ ] Implement supported language-server/code-intelligence hooks as a distinct optional integration.
- **Gate:** Each extension type has a compatibility matrix, isolated fixture suite, trust boundary, and failure mode before being enabled by default.

### CC-013 — Implement integrations, background execution, and lifecycle operations

**Files:** Create `src/integrations/`, `src/jobs/`, `src/diagnostics/`, and `docs/compatibility/integrations.md`.

- [ ] Add supported editor/IDE context and launch/session handoff adapters from the target matrix.
- [ ] Add background job/session start, status, stop, resume, remove, and cleanup behavior where present in the pinned target.
- [ ] Add MCP server management, diagnostics/doctor, logs, version/update channel controls, purge, and installation health reports where in target scope.
- [ ] Define network/remote/cloud features as individual rows with auth boundary, service dependency, and parity status; do not claim online-service parity from a local executable.
- [ ] Ensure automation interfaces never post/publish data or contact optional external integrations without explicit user setup.
- **Gate:** Each declared integration has a local contract and service-independent failure test; remote-service claims are explicitly bounded.

### CC-014 — Package for supported platforms and provide setup/migration documentation

**Files:** Create release/build configuration, `README.md`, `docs/install.md`, `docs/configuration.md`, and migration/provider guides.

- [ ] Build reproducible Linux x64 packages first; define explicit gates for Linux ARM64, macOS, Windows/WSL, and musl if each platform is in scope.
- [ ] Provide safe installation, shell completion, diagnostics, upgrades/rollback, config/session migration, and uninstall behavior.
- [ ] Document provider setup and required capabilities without asking users to paste secrets into chat or checked-in config.
- [ ] Generate SBOM/dependency inventory and publish this implementation’s own compatibility limitations and security model.
- **Gate:** Clean installation and upgrade walkthroughs succeed for every platform claimed in release metadata.

### CC-015 — Measure full compatibility, close gaps, and define release criteria

**Files:** Create `tests/compatibility/scenarios/`, `docs/compatibility/results.md`, and update `docs/PROGRESS.md` and `docs/reverse-engineering/evidence-index.md`.

- [ ] Run deterministic target/implementation comparisons for CLI, configuration, provider selection (project extension), tool permissions, sessions, streams, TUI, extensions, integrations, and diagnostics.
- [ ] Keep model-dependent agent coding tasks separate; record provider/model, prompt, environment, repeats, and task outcome.
- [ ] Report each row as `match`, `partial`, `mismatch`, `not tested`, or `unknown`, with target version, artifact hash, and evidence pointer.
- [ ] Close critical security gaps before calling a feature compatible; rerun only affected scenarios and record results.
- [ ] Publish the supported-feature matrix and known gaps. Do not call this implementation “fully compatible” while any required domain is unknown or unimplemented.
- **Gate:** Release compatibility statement is reproducible from repository artifacts and declares exactly what was compared.

## Review focus

- Credential reference resolution and provider endpoint trust; no credential leakage through provider/model catalog import.
- Permission startup/default behavior, config precedence, and managed policy boundaries.
- Symlink/path traversal and shell/process boundaries under concurrency and cancellation.
- Session corruption recovery, interrupted streams, resume/fork identity, and secret redaction.
- MCP/hooks/plugins executing untrusted code or crossing a workspace boundary.
- Protocol capability mismatches across providers and transparent behavior for unsupported features.
- Progress ledger correctness: every task transition ties to files, evidence, and verification, with an exact resume step.

## Review decision requested

Review the full scope, the proposed TypeScript architecture, and the provider protocol matrix. Once approved, implementation begins at `CC-001`/`CC-002`: retain a usable native REA baseline, initialize the progress ledger, and freeze the compatibility matrix before application code.
