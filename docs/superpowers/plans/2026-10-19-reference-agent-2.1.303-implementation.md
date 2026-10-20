# The pinned reference build (2.1.303) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an independently implemented coding-agent CLI that is observably compatible with the pinned reference build `2.1.303` on Linux x86-64, and that adds a first-class multi-provider manager with provider-owned model catalogs — a deliberate product extension that the target does not have.

**Architecture:** TypeScript on Node.js LTS, layered as: stable domain interfaces (provider, session, permission, tool, extension) beneath CLI and TUI renderers. Provider protocol drivers implement one streaming interface; the provider registry holds multiple concurrently configured connections, each owning a credential *reference* (never a secret) and a model catalog. Model-generated actions never reach execution without passing the permission service. Session state is an append-only JSONL event log with a versioned schema, so a session can be resumed by replaying it.

**Tech Stack:** TypeScript 5.x on **Node.js 24** (Node 24 is Active LTS until 2026-10-20, when it enters Maintenance, with EOL 2028-04-30; Node 26 becomes Active LTS on 2026-10-28; Node 22 is already in Maintenance with EOL 2027-04-30. Node 24 costs nothing — `vitest@5` requires `^22.12 || ^24 || >=26` and `ink@8` requires `>=22`); `zod` **v4** pinned explicitly (v4 replaces `.strict()`/`.passthrough()` with `z.strictObject()`/`z.looseObject()` and `.merge()` with `.extend()`); `vitest` 5 for unit and contract tests; **the MCP transport is hand-rolled** rather than taken from `@modelcontextprotocol/sdk` — the pinned `1.32.1` declares only `LATEST_PROTOCOL_VERSION = 2025-11-25` and its `Client` does not expose the `server/discover` probe, the `-32022` version-negotiation ladder, the stateless `_meta` framing, or the legacy fallback that the plan's modern-first negotiation requires (amended during `CC-011`; the dependency is unused and was removed from `package.json` — the lockfile must be regenerated at release time); **Ink 8** for the TUI (chosen over OpenTUI, which requires Node ≥ 26.4.0, and over `blessed`, unmaintained since 2015 — Ink 8 is the only candidate with *any* screen-reader support, and that support is basic: an `aria-role` subset, not full accessibility); **JSONL** for session storage (`node:sqlite` is only Stability 1.2 "release candidate", its API differs by Node line, and it received a CVE in July 2026); **Bun `bun build --compile`** for the self-contained binary (62 MB / 7 ms startup, versus 146 MB / 24 ms for Node SEA, whose tooling is still Stability 1.1 and which cannot ship on Alpine); **no `keytar`** (archived 2022) — OS keychain access shells out to the platform CLI, with a layered backend that falls back to a CLI backend when no native module is available.

**Spec:** [REA coverage audit](../../reverse-engineering/COVERAGE-AUDIT.md) is the behavioral spec — it is the authority for what the target does. [REA record](../../reverse-engineering/reference-agent-2.1.303-partial.md) carries the evidence behind it. [Research report](../../../research/reference-agent-2.1.303-research.md) carries external product context, protocol shapes, and the known security failure modes that the implementation must not reproduce. [Progress ledger](../../PROGRESS.md) is the resume index.

**Target pin:** `the pinned reference build @ 2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.

---

## Global Constraints

These apply to every task. Most values are copied verbatim from the REA coverage audit or the project brief. The exceptions are marked inline as `inference` (derived from third-party analysis of the target's transcript format, pending REA confirmation) or as a **project requirement** (a deliberate design decision this implementation makes because the target does not have it).

- Target behavior is pinned to `2.1.303`. Anything observed only in later official documentation is **not** a target behavior.
- The deliverable is **observable compatibility**, not reuse of Anthropic's private source or credentials. the vendor's consumer subscription sessions and OAuth must not be collected, reused, or routed.
- Credentials are **references only**: an environment variable name, a file path, or an OS credential-store key. No implementation may read a secret into a catalog, a settings file, a session record, a log line, or a fixture.
- The provider catalog **must not select or read secrets** and **must not choose a destination** for them.
- Multi-provider management is a **project requirement**, not part of the reference agent. It must be labelled as an extension everywhere it surfaces (UI, `--help`, docs, compatibility matrix).
- Permissions, path boundaries, shell execution, approval prompts, and credential redaction are enforced by **implementation-owned** code, independent of model instructions.
- The target's settings tier model must be reproduced exactly, including the two distinct orderings:
  - top-level key resolution, highest first: `policySettings`, `flagSettings`, `userSettings`;
  - merged-key resolution, highest first: `localSettings`, `projectSettings`, `userSettings`;
  - a higher tier's **block** applies as a whole over any lower tier and is never merged key by key.
- The target's provider route names are exactly: `firstParty`, `gateway`, `bedrock`, `foundry`, `anthropicAws`, `anthropicGoogleCloud`, `mantle`, `vertex`. This implementation must support the same set as its *provider kinds*.
- The target's control-request subtypes are exactly: `initialize`, `set_model`, `set_max_thinking_tokens`, `set_permission_mode`, `rename_session`, `set_color`, `file_suggestions`, `read_file`, `get_workspace_diff`, `get_context_usage`, `get_usage`, `mcp_status`, `mcp_authenticate`, `mcp_oauth_callback_url`, `mcp_reconnect`, `interrupt`, `apply_flag_settings`, `mcp_set_servers`, `stop_task`, `background_tasks`, `cancel_async_message`, `side_question`, `fork_conversation`.
- The target's hook events are exactly **33**: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PermissionDenied`, `PermissionRequest`, `SessionStart`, `SessionEnd`, `Notification`, `Setup`, `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`, `DirectoryAdded`, `MessageDisplay`. `StatusLine` and `FileSuggestion` are **settings-level display handlers, not hook events**, and are not decision points.
- The target's MCP connection batching is `3` for local servers and `20` for remote servers. These are this implementation's defaults.
- The target's default non-streaming request timeout is a **fallback** of `600000` ms; when no explicit timeout is given, the client first computes one from the model's output-token limit and the requested `max_tokens`.
- The target's Anthropic API version header is `anthropic-version: 2023-06-01`.
- The target's permission decision vocabulary is exactly: behavior `allow` | `deny` | `ask`; source `classifier` | `hook` | `user_permanent` | `user_temporary` | `user_abort` | `user_reject` | `unknown`; reason type `rule` | `safetyCheck` | `other`.
- The target's permission **rule precedence** is `deny` → `ask` → `allow`, **first match wins, and specificity is irrelevant**: a broad deny beats a narrower allow, and an allow rule can never carve an exception out of a deny. Deny rules block in **every** mode; allow rules have no effect in `bypassPermissions`.
- The target's permission **modes** are exactly six: `default` (UI label Manual, alias `manual`), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`. Start-mode precedence is `--permission-mode` flag → `permissions.defaultMode` → built-in default. `auto` and `bypassPermissions` written into a settings file are **ignored**; the built-in default is `auto` for terminal sessions and `default` for headless runs — subject to three availability overrides: a settings file setting `disableAutoMode: "disable"` falls back to `default`, a HIPAA-configured session falls back to `default`, and a session where auto mode is unavailable (unsupported model, organization policy, or a server-side kill switch) starts in Manual.
- A compound shell command is split on `&&`, `||`, `;`, `|`, `|&`, `&`, and newlines, and **each sub-command must match independently**. The "don't ask again" affordance persists **one rule per sub-command that needs approval, capped at 5 rules**, to the repository's `.claude/settings.local.json`.
- The target's file-mutating tool set is exactly `Edit`, `Write`, `NotebookEdit`.
- The target's session transcript format is **JSONL**, and its storage root is `~/.claude` with a `projects` subtree. The project directory name is derived from the working directory path, and the session file is `<project>/<sessionId>.jsonl`.
- The target's session record **format is internal and changes between versions**. Every compatibility claim about session files must therefore be re-verified against the pinned release, and this implementation's own format must be independently versioned with a documented migration path.
- **The following session behaviors are `inference`, not REA-observed**, and are recorded here only as the shape this implementation should implement pending `CC-001` Step 4: resume selects the newest leaf and walks the parent chain backwards rather than replaying the file in order; compaction is a boundary marker rather than a deletion; a preserved tail is re-attached after the boundary; and oversized tool output is replaced by a stub plus a content-replacement record. These come from third-party analysis of the target's transcript format, not from the pinned binary.
- This implementation must not reintroduce failure modes observed in **earlier** the reference agent releases and already fixed by `2.1.303`: compound-command allow-list checks that were skipped on the allow path, a sub-command count cap that degraded to a generic ask, symlink/TOCTOU gaps between the permission check and the write, a command validator that stripped quoted text before checking, and approval prompts that displayed a literal command string rather than the resolved destination. These are this implementation's regression tests, not claims that `2.1.303` still has them.
- This implementation's sandbox is a **five-layer** design, and the seccomp user-notification supervisor is **observability and emulation, not enforcement**. The kernel's own UAPI header states that the seccomp notifier "cannot be used to implement a security policy", because the target can rewrite pointer arguments while blocked waiting for the supervisor. Any path the supervisor authorizes must be re-checked against a kernel-enforced layer. This implementation must block `io_uring_setup` — io-wq worker threads bypass `seccomp_run_filters()` entirely — and must not claim a guarantee stronger than the layers deliver.
- Every compatibility claim in `docs/compatibility/` links to a target contract row and names its evidence class: `target documented`, `REA observed`, `runtime observed`, `project requirement`, `inference`, or `unknown`.
- One REA/Ghidra analysis at a time. On this WSL host, cap Ghidra at `GHIDRA_HEADLESS_MAXMEM=1536M` and bound JavaScript worker heaps.
- `docs/PROGRESS.md` is updated at every task start, every task completion, and every handoff.

---

## Review Focus

These are the input classes and failure modes the spec implies but that no single task's tests obviously exercise. Each line names the input and the behavior a reasonable person would expect. The owning task for each is named in brackets.

1. **A settings file that is a symlink to the user settings file.** The project tier must be *skipped*, not applied and not silently merged. [CC-003]
2. **A hook that approves a tool call and rewrites the tool input.** The rewritten input must be what executes, and the decision must record that it was rewritten — and a rewritten input the tool's own validator rejects must deny the call. A *rule* must never rewrite input at all. [CC-007]
3. **A Bash command with a redirect and two sub-commands, one requiring approval.** Approval must be required for the *stripped* sub-command, and the user must see that one part of several needs approval. [CC-007]
4. **Two provider connections configured at once, one of which has no credential.** This implementation must still start, must not route to the unusable one, and must not attempt to read the other one's secret. [CC-005]
5. **A `can_use_tool` control request whose `request_id` is not a string.** The target drops it because no response is possible; this implementation must drop it too rather than replying with a malformed response. [CC-011]
6. **A model whose `provider_ids` entry is `null` for the active route but non-null for another route.** The target resolves to the other route; this implementation's catalog must represent `null` as "not served", never as "unknown". [CC-005]
7. **A permission-request hook that approves a WebFetch with arguments the tool cannot verify.** The fetch must be refused, and the refusal must not be reported as a user denial. [CC-007]
8. **A session log written by a newer schema version.** Resumption must refuse cleanly with a version error rather than silently dropping events. This is a **project requirement**; the target's behavior here is `unknown`, because the target's own format is documented as internal and changing. [CC-009]
9. **An MCP server that exits during `tools/list`.** The server must be marked failed, must not block the session, and must be retryable. This is a **project requirement**; the target's server lifecycle is `partial` in the REA audit. [CC-011]
10. **A credential that is only present in the OS keychain.** The catalog and `/provider` listing must show the connection as configured *without* showing the credential, and without the keychain ever being read during a listing operation. [CC-005]
11. **A compound shell command of 51 sub-commands where the 51st is the dangerous one.** This implementation must check every sub-command, never degrade to a generic ask, and never cap the count. [CC-007]
12. **A file path that is a symlink to a file outside the working directory.** An allow rule must require both the requested path and the resolved target to match; a deny rule must fire if either matches; and the write must re-resolve the path after the check rather than trusting the pre-check resolution. [CC-007]
13. **A tool description that changes after the user approved it.** This implementation must re-surface the change, so a "rug pull" cannot silently alter an approved tool's behavior. This is a **project requirement**; the target does not do it — the known MCP gap is that clients do *not* notify on a description change. [CC-011]

---

## Planned file structure

Each file has one responsibility. Files that change together live together.

```
docs/
  PROGRESS.md                                  # durable ledger, updated every handoff
  reverse-engineering/
    reference-agent-2.1.303-partial.md            # REA record (evidence-backed observations)
    COVERAGE-AUDIT.md                          # behavioral spec: what the target does
    CONTINUE-REA-PROMPT.md                     # runbook for continuing REA
  compatibility/
    feature-matrix.md                          # every claim + evidence class
    command-surface.md                         # CLI commands, flags, exit codes
    settings-precedence.md                     # tier model conformance table
    provider-catalog.md                        # catalog + route conformance
    session-format.md                          # JSONL schema + resume semantics
    permission-matrix.md                       # decision vocabulary + rule semantics
    extension-surface.md                       # MCP subtypes + hook events
    results.md                                 # measured match/partial/mismatch
  superpowers/plans/
    2026-10-19-reference-agent-2.1.303-implementation.md   # this plan
src/
  cli/            args.ts command.ts headless.ts output.ts commands/ provider.ts catalog.ts
  ui/             app.ts modals/ providerPicker.ts render/ messages.ts prompts.ts markdown.ts
  config/         tiers.ts loader.ts schema.ts scope.ts
  provider/
    registry.ts            # the extension: N concurrent connections
    catalog.ts             # per-connection model catalog
    routes.ts              # target-compatible route selection and endpoint policy
    credentials.ts         # references only; resolution is explicit
    drivers/ types.ts anthropic.ts bedrock.ts vertex.ts foundry.ts gateway.ts mantle.ts anthropicAws.ts anthropicGoogleCloud.ts
    normalize.ts           # capability normalization across drivers
  session/        event.ts store.ts resume.ts compaction.ts
  permissions/    decision.ts rules.ts prompts.ts
  tools/          registry.ts builtins/ runner.ts
  extensions/     mcp/ client.ts manager.ts control.ts  hooks/ registry.ts runner.ts schema.ts  skills/ subagents/ plugins/
  platform/       sandbox/ policy.ts launcher.ts landlock.ts seccomp.ts proxy.ts
  integration/    ide/
  agent/          loop.ts context.ts dispatch.ts
tests/
  unit/ contracts/ security/ compatibility/
scripts/
  build.ts
```

---

## Milestones

Ordering is dependency-driven, not scope-driven. Every domain stays in the plan; ordering only controls sequence.

### CC-001 — Close the REA coverage audit (prerequisite)

**Files:** Modify `docs/reverse-engineering/COVERAGE-AUDIT.md`; Modify `docs/reverse-engineering/reference-agent-2.1.303-partial.md`; Modify `docs/PROGRESS.md`.

**Interfaces:** Consumes: the retained Evidence records under `/home/shiva/opt/reference-agent-rea/evidence/` and the per-module records under `/home/shiva/opt/reference-agent-rea/analysis/modules/`. Produces: a per-group gate state in the audit that other milestones cite.

- [x] **Step 1: Re-run the five transfer-budget-limited modules** at a per-file ceiling that fits (tiered 60000 → 30000 → 20000 → 12000), using `/home/shiva/opt/reference-agent-rea/analysis/run-js-module-tiered.sh`. Verify: each record reports `truncated: false`.
- [x] **Step 2: Trace the Messages `parseResponse` callee** in the completed SDK graph with `seeds.py` + `trace_javascript_semantics` seeded at a call-site node id. Verify: the trace result names a resolved callee, and the audit's "response parsing" row moves to `observed`.
- [x] **Step 3: Trace the agent turn and tool dispatch** in the completed `chunk-6bp7hdav.js` graph. Verify: the audit's "agent loop and tool dispatch" row records the observed scheduling order and the point at which the next model request is issued.
- [x] **Step 4: Trace the session resume algorithm** in the same graph: `--resume` / `--continue` selection, the session index, and transcript replay. Verify: the audit's "session resumption" row moves to `observed`.
- [x] **Step 5: Targeted Ghidra pass over the seccomp supervisor's switch cases** to decode the per-record metadata and the per-syscall action at the table `0x6c749c0`. Verify: a new Evidence record names the action for at least the 27 filesystem syscalls.
- [x] **Step 6: Re-run the audit and record the gate decision** per group. Verify: every group is `observed` or an explicitly accepted partial with a named reason.
- [x] **Step 7: Commit.**
  ```bash
  git add docs/reverse-engineering/ docs/PROGRESS.md
  git commit -m "docs(rea): close coverage audit"
  ```

**Gate:** Every requirement group in the audit is `observed`, or is an accepted partial with a named artifact and a implementation-visible consequence recorded in the audit.

### CC-002 — Ledger, feature matrix, and evidence index

**Files:** Create `docs/compatibility/feature-matrix.md`, `docs/compatibility/results.md`; Modify `docs/PROGRESS.md`.

**Interfaces:** Consumes: `COVERAGE-AUDIT.md` §3. Produces: a row per requirement with columns `id | group | requirement | evidence-class | evidence-id | target-observed? | implementation-status | test-ref`. Every later task's `test-ref` points at a row here.

- [x] **Step 1: Write the matrix generator test** — assert that every audit row appears exactly once and that every row has a non-empty `evidence-class` from the closed set.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, matrix file missing.
- [x] **Step 3: Create `docs/compatibility/feature-matrix.md`** with one row per audit requirement, seeded from the audit's own table.
- [x] **Step 4: Run the test to verify it passes** — expected: PASS.
- [x] **Step 5: Add the `results.md` vocabulary** — `match | partial | mismatch | not-tested | unknown` with the rule that a row is `unknown` rather than `match` when the target evidence is `unknown`.
- [x] **Step 6: Commit.**

**Gate:** An incoming agent can find the next task and the evidence state from repository files alone.

### CC-003 — Settings tiers and precedence

**Files:** Create `src/config/tiers.ts`, `src/config/schema.ts`, `src/config/loader.ts`, `src/config/scope.ts`; Create `tests/contracts/settings-precedence.test.ts`; Create `docs/compatibility/settings-precedence.md`.

**Interfaces:**
- Consumes: nothing (first domain task).
- Produces:
  ```ts
  export type SettingsSource = 'policySettings' | 'flagSettings' | 'userSettings' | 'projectSettings' | 'localSettings';
  export const TOP_LEVEL_KEY_ORDER: readonly SettingsSource[];   // ['policySettings','flagSettings','userSettings']
  export const MERGED_KEY_ORDER: readonly SettingsSource[];      // ['localSettings','projectSettings','userSettings']
  export const PROJECT_SIDE_SOURCES: readonly SettingsSource[];  // ['projectSettings','localSettings']
  export interface SettingsTier { source: SettingsSource; value: unknown; }
  export function resolveTopLevelKey(tiers: Map<SettingsSource, unknown>, key: string): SettingsTier[];
  export function resolveMergedKey(tiers: Map<SettingsSource, unknown>, key: string): SettingsTier[];
  export function effectiveSource(tiers: Map<SettingsSource, unknown>, key: string): SettingsSource | null;
  export function loadSettings(opts: { cwd: string; configDir: string; restricted: boolean }): SettingsLoadResult;
  export interface SettingsLoadResult {
    tiers: Map<SettingsSource, SettingsTier>;
    errors: { source: SettingsSource; path: string; severity: 'warning' | 'error'; message: string }[];
    readMode: Map<SettingsSource, 'none' | 'as_read' | 'machine_admin'>;
    linkedAway: SettingsSource[];
  }
  ```

- [x] **Step 1: Write the failing test** — `TOP_LEVEL_KEY_ORDER` resolves `policySettings` over `flagSettings` over `userSettings`; `MERGED_KEY_ORDER` resolves `localSettings` over `projectSettings` over `userSettings`; a project tier whose path resolves to the user settings path is absent from `tiers`; `restricted: true` yields `null` for `projectSettings` and `localSettings`; a `policySettings` tier reports `readMode` `machine_admin`.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, module not found.
- [x] **Step 3: Implement `src/config/tiers.ts`** with the three order constants and the two resolvers; the resolvers return the full `[{source, value}]` list (highest first) so the UI can report which tier won.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing loader test** — three cases, all REA-observed: (a) a project settings file that is a symlink to the user settings file is reported in `linkedAway` and contributes no tier; (b) a project settings file that resolves to the *same* file as the user settings file is **skipped entirely** and its source is reported with the read mode `as_read`, not `none`; (c) a local settings file merges over a legacy local settings file with the local file winning.
- [x] **Step 6: Implement `src/config/loader.ts`** — resolve the project settings path, compare real paths against the user settings path, skip a linked-away project tier, skip a same-file project tier while reporting it as `as_read`, read local settings over legacy local settings, and record per-tier read modes.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Implement `src/config/schema.ts`** as a `zod` schema for the settings document with `permissions.allow`, `permissions.deny`, `permissions.ask`, `permissions.defaultMode`, `sandbox.filesystem.{allowRead,allowWrite,denyRead,denyWrite,credentials}`, and `spellcheck`; unknown keys are preserved, not dropped, because the target preserves them.
- [x] **Step 9: Write `docs/compatibility/settings-precedence.md`** as the conformance table mapping each audit row to the test that pins it.
- [x] **Step 10: Commit.**
  ```bash
  git add src/config tests/contracts/settings-precedence.test.ts docs/compatibility/settings-precedence.md
  git commit -m "feat(config): settings tier model and precedence"
  ```

### CC-004 — Provider registry, credentials, and route selection

**Files:** Create `src/provider/registry.ts`, `src/provider/routes.ts`, `src/provider/credentials.ts`; Create `tests/contracts/provider-registry.test.ts`, `tests/security/provider-credentials.test.ts`.

**Interfaces:**
- Consumes: `src/config/tiers.ts` (`SettingsSource`, `effectiveSource`).
- Produces:
  ```ts
  export type ProviderRoute = 'firstParty' | 'gateway' | 'bedrock' | 'foundry'
                          | 'anthropicAws' | 'anthropicGoogleCloud' | 'mantle' | 'vertex';
  export const ROUTE_ORDER: readonly ProviderRoute[];   // target dispatch order
  export interface Connection {
    id: string;                       // stable, user-chosen
    name: string;
    route: ProviderRoute;
    baseUrl?: string;
    credential: CredentialRef;
    catalogSource: 'builtin' | 'file' | 'url';
    enabled: boolean;
  }
  export type CredentialRef =
    | { kind: 'env'; name: string }
    | { kind: 'file'; path: string; format: 'raw' | 'bearer' }
    | { kind: 'keychain'; service: string; account: string };
  export interface ProviderRegistry {
    list(): readonly Connection[];
    get(id: string): Connection | undefined;
    add(conn: Connection): void;
    remove(id: string): boolean;
    active(): Connection | undefined;   // exactly one; throws if zero or >1 enabled
  }
  export function selectRoute(env: NodeJS.ProcessEnv, settings?: RouteSettings): ProviderRoute;
  export type RouteSettings = SettingsTierMap | SettingsAccessor;   // see the note below
  export function resolveCredential(ref: CredentialRef): Promise<{ present: boolean; value?: string }>;
  export function credentialStatus(ref: CredentialRef): Promise<'configured' | 'missing' | 'unreadable'>;
  export type SettingsAccessor = (key: string) => unknown;
  export interface EndpointPolicy {
    route: ProviderRoute;
    baseUrlVariables: string[];      // e.g. ['ANTHROPIC_BEDROCK_BASE_URL', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME', ...]
    ownHost?: RegExp;                // matches a vendor-hosted endpoint; anything else is a user-supplied one
  }
  export const ENDPOINT_POLICIES: readonly EndpointPolicy[];
  export function resolveBaseUrl(route: ProviderRoute, env: NodeJS.ProcessEnv, explicit?: string): { baseUrl: string; isVendorHost: boolean };
  ```

**Amended after implementation.** The plan originally wrote `selectRoute(env, settings: SettingsSource)`. A bare source *name* carries no value, and the plan's own "Consumes" line requires `effectiveSource`, which takes the tier map — so the parameter is now `RouteSettings = SettingsTierMap | SettingsAccessor` and is optional. The route names, the dispatch order, and the endpoint table are unchanged.

**Endpoint policy.** The target declares, per provider, the environment variables that may supply a base URL and a regular expression matching that provider's **own** vendor host — `bedrock`/`bedrock-runtime` regional hosts, `bedrock-mantle`, `aws-external-anthropic`, `aiplatform`/`*.googleapis.com` for Vertex, `claude`/`*.googleapis.com` for Anthropic-on-Google-Cloud, and `<name>.services.ai.azure.com` for Foundry. The distinction matters: a base URL that matches the vendor's own host is a normal deployment, while one that does not is a **user-supplied endpoint** and this implementation must treat it as untrusted — for example by refusing to send credentials to it unless the connection explicitly opts in. This implementation must reproduce the variable list and the host patterns exactly, because they are the observable contract.

**Design note (this is the extension, not target behavior).** The target has **no** user-managed connection registry: route selection yields exactly one active route from environment flags, and the model catalog is built in. The registry above is the deliberate product extension. External precedent (Kimi Code, Roo Code, OpenCode, Goose, Hermes) agrees on three points that this design adopts: a connection is keyed by a **free-form name** rather than a provider type, so several connections may exist for the same protocol; the model catalog is a **separate table** from the connection table, so a catalog refresh cannot rewrite a connection's identity; and the **secret store and the config record are two different layers**, so a catalog refresh never touches a credential. Kimi Code's `api_key` / `api_key_env` are mutually exclusive with **no automatic shell-environment fallback**; this implementation keeps a single explicit `env` reference kind instead, because a reference has no secret in it.

- [x] **Step 1: Write the failing route test** — `selectRoute` returns `gateway` when the gateway flag is set, otherwise the first matching provider flag in the order `bedrock`, `foundry`, `anthropicAws`, `anthropicGoogleCloud`, `mantle`, `vertex`, otherwise `firstParty`.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, module not found.
- [x] **Step 3: Implement `src/provider/routes.ts`** with `ROUTE_ORDER` and `selectRoute`, mirroring the target's dispatch order exactly.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing registry test** — two enabled connections with different routes; `active()` throws when more than one is enabled; `add` rejects a duplicate `id`; `remove` of an unknown `id` returns `false`.
- [x] **Step 6: Implement `src/provider/registry.ts`** — an in-memory registry with an `enabled` flag and a single-active invariant. This is the **extension**: the target has exactly one active route and no registry.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing credential test** — `credentialStatus` for an `env` ref reports `configured` when the variable is set and `missing` when it is not, **without** returning the value; `resolveCredential` is the only function that returns a value; the registry's `list()` output contains no secret material.
- [x] **Step 9: Implement `src/provider/credentials.ts`** — `credentialStatus` inspects presence only; `resolveCredential` is the single resolution point and is never called by listing or catalog code. The keychain backend shells out to the platform CLI (macOS: `security find-generic-password -w -s <service> -a <account>`) with a layered fallback, because `keytar` was archived in 2022 and a native binding is a hard conflict with a self-contained executable.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Add a security test** asserting that `JSON.stringify(registry.list())` contains no value from a populated credential env var, and that `credentialStatus` on a keychain reference does **not** read the keychain (it reports the reference's presence only, so a listing never triggers an OS prompt).
- [x] **Step 12: Write the failing endpoint-policy test** — `resolveBaseUrl('bedrock', env)` picks up `ANTHROPIC_BEDROCK_BASE_URL` and reports `isVendorHost: false` for a host that is not a `bedrock` regional host; `resolveBaseUrl('vertex', env)` picks up `ANTHROPIC_VERTEX_BASE_URL`; a provider with no base-URL variable reports the vendor's own default host with `isVendorHost: true`.
- [x] **Step 13: Implement `ENDPOINT_POLICIES`** with the exact variable list and host patterns the target declares, and implement `resolveBaseUrl` so it distinguishes a vendor host from a user-supplied endpoint.
- [x] **Step 14: Write the failing untrusted-endpoint test** — a connection whose base URL is user-supplied does not receive the credential unless the connection explicitly opts in, and the refusal names the host.
- [x] **Step 15: Implement the untrusted-endpoint guard** in `src/provider/registry.ts`.
- [x] **Step 16: Run it to verify it passes** — expected: PASS.
- [x] **Step 17: Commit.**
  ```bash
  git add src/provider tests/contracts/provider-registry.test.ts tests/security/provider-credentials.test.ts
  git commit -m "feat(provider): connection registry, credential references, route selection"
  ```

### CC-005 — Provider-owned model catalog

**Files:** Create `src/provider/catalog.ts`, `src/provider/normalize.ts`, `src/provider/catalogs/builtin.json`; Create `tests/contracts/provider-catalog.test.ts`.

**Interfaces:**
- Consumes: `src/provider/registry.ts` (`Connection`, `ProviderRoute`, `resolveConnectionCredential`), `src/provider/routes.ts` (`ROUTE_NAMES`, `isProviderRoute`, `ResolvedBaseUrl`).
- Produces:
  ```ts
  export interface CatalogModel {
    id: string;                 // logical model id, e.g. 'claude-haiku-4-5'
    family: string;             // 'haiku' | 'sonnet' | 'opus' | 'fable' | 'mythos'
    displayName: string;
    knowledgeCutoff?: string;
    providerIds: Partial<Record<ProviderRoute, string>>;  // absent key = not served
    eagerInputStreaming: Partial<Record<ProviderRoute, boolean>>;
    vertexRegionEnvVar?: string;
    maxOutputTokens: { default: number; upper: number };
    pricing?: string;
    capabilities: string[];
    // Additional fields the target's catalog carries; preserved rather than dropped.
    advisorRank?: number;
    context?: { window: number; native1m?: boolean; supports1mBeta?: boolean };
    defaultEffort?: string;
    effortCostIndex?: number;
    fallback3p?: string;
    imageLimits?: Record<string, unknown>;
  }
  export interface ModelCatalog {
    connectionId: string;
    schemaVersion: number;
    models: CatalogModel[];
  }
  export function providerIdFor(model: CatalogModel, route: ProviderRoute): string | undefined;
  export function resolveModel(catalog: ModelCatalog, modelId: string, route: ProviderRoute): string | undefined;
  export function listModels(catalog: ModelCatalog, filter?: { family?: string; query?: string }): CatalogModel[];
  export function importCatalog(raw: unknown): ModelCatalog;   // validates schema_version and providerIds
  ```

- [x] **Step 1: Write the failing catalog test** — a model whose `providerIds` has no `bedrock` key is *not served* by bedrock; `providerIdFor` returns `undefined`, and the test asserts the difference from "unknown" by requiring an explicit `absent` result rather than a nullable field that conflates the two.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, module not found.
- [x] **Step 3: Implement `src/provider/catalog.ts`** with the four functions above. Use `Partial<Record<...>>` deliberately: an absent key means "not served", and there is no representation for "unknown".
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing builtin test** — `src/provider/catalogs/builtin.json` parses, has `schemaVersion: 1`, and contains at least one model whose `providerIds` covers all eight routes plus at least one model that omits at least one route.
- [x] **Step 6: Create `src/provider/catalogs/builtin.json`** by transcribing the target's catalog literal from `chunk-w4f5s3e0.js`, preserving `provider_ids` key names and `null` as *absent*. Cite the source module and offset in a `_provenance` field in the file.

  **The literal has already been extracted** to `/home/shiva/opt/reference-agent-rea/analysis/target-model-catalog.json` — the full object with `schema_version: 1`, eleven `pricing_tiers`, and **22 models**. Use it as the transcription source rather than re-deriving it by hand. Nine of the 22 models carry all eight route ids and thirteen omit at least one, so both cases in Step 5 are present. The catalog also carries fields beyond the plan's first draft — `advisor_rank`, `context`, `default_effort`, `effort_cost_index`, `fallback_3p`, `image_limits` — and families beyond haiku/sonnet/opus: **`fable`** and **`mythos`**. Preserve those rather than dropping them; the interface above has been widened accordingly.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing normalize test** — a model with `eagerInputStreaming.vertex === true` yields a capability flag; `maxOutputTokens.upper` bounds the request `max_tokens`; a model with no `providerIds` for the active route is filtered out of the model's usable list.
- [x] **Step 9: Implement `src/provider/normalize.ts`** producing a driver-agnostic capability object.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Commit.**
  ```bash
  git add src/provider tests/contracts/provider-catalog.test.ts
  git commit -m "feat(provider): provider-owned model catalog"
  ```

### CC-005b — The Bedrock+Mantle `anthropic.*` override

**Why this task exists.** The target's `wd(model)` layers a per-model override on top of the route selector, and the rule has **two** halves (audit §2.1):

- **(a)** *"with Bedrock and Mantle both enabled, an `anthropic.*` model resolves to `mantle`"* — **target-observed, and not implemented**;
- **(b)** *"otherwise, if the catalog has no id for the selected route but has one for `mantle`, the model resolves to `mantle`"* — implemented in `CC-005`.

**Ten of the target's 22 catalog rows are `anthropic.*` ones**, so half (a) is not a corner: with Bedrock+Mantle enabled, the target routes those ten to `mantle` and this implementation routes them to `bedrock`. The compatibility report measures the divergence and reports it as a `mismatch` on rows `F-07` and `F-08`.

**Files:** Modify `src/provider/routes.ts`; Modify `src/provider/catalog.ts`; Modify `tests/contracts/provider-registry.test.ts`; Modify `tests/contracts/drivers.test.ts`.

**Interfaces:**
- Consumes: `src/provider/routes.ts` (`selectRoute`, `RouteSettings`, the route env vars).
- Produces: an `enabledRoutes(env, settings): ReadonlySet<ProviderRoute>` in `src/provider/routes.ts`; `resolveRouteForModel(model, route, enabled?)` in `src/provider/catalog.ts`, where `enabled` is the set of routes the user turned on.

- [x] **Step 1: Write the failing test** — with **both** Bedrock and Mantle enabled, an `anthropic.*` model resolves to **`mantle`**, not to `bedrock`; and with only one of them enabled, the model resolves the ordinary way.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, the override is not implemented.
- [x] **Step 3: Implement `enabledRoutes`** in `src/provider/routes.ts` — the set of routes whose flag is on, derived from the same rules `selectRoute` uses. It must not read the environment twice or disagree with it.
- [x] **Step 4: Apply the override** in `resolveRouteForModel` — the `anthropic.*` → `mantle` redirect goes **before** the half-(b) fallback, and only when **both** routes are enabled. The existing three-argument callers must keep working, so the new argument is **optional** and the override is off when it is absent.
- [x] **Step 5: Update the module headers** in `src/provider/catalog.ts` and `src/provider/routes.ts` — half (a) is now implemented, and the header must say so.
- [x] **Step 6: Run it to verify it passes** — expected: PASS.
- [x] **Step 7: Commit.**

**Result:** `enabledRoutes(env, settings?)` in `src/provider/routes.ts` collects the routes the user turned on, and `selectRoute` is now implemented **on top of** it, so the set and the selector cannot disagree. `resolveRouteForModel(model, route, enabled?)` applies the `anthropic.*` → `mantle` redirect **before** the mantle fallback, on when **both** routes are enabled, and **off** when the optional argument is absent, so every existing caller is unchanged. The override goes into `resolveModel` and `resolveModelRoute` too, as an optional fourth argument. The compatibility report's `F-07` and `F-08` moved to `match` on their own, because the harness derives its outcome from the measurement.

  ```bash
  git add src/provider tests/contracts
  git commit -m "fix(provider): the Bedrock+Mantle anthropic.* override"
  ```

**Note.** The compatibility harness's `F-07`/`F-08` probes **derive** their outcome from the measurement, so once this lands the harness will report `match` and `tests/compatibility/results.test.ts` will fail until the two report cells and the totals are updated. **The orchestrator owns `docs/compatibility/` and the harness** — this task must not edit them, and must report the new totals.

### CC-006 — Protocol drivers

**Files:** Create `src/provider/drivers/types.ts`, `src/provider/drivers/anthropic.ts`, `src/provider/drivers/bedrock.ts`, `src/provider/drivers/vertex.ts`, `src/provider/drivers/foundry.ts`, `src/provider/drivers/gateway.ts`, `src/provider/drivers/mantle.ts`, `src/provider/drivers/anthropicAws.ts`, `src/provider/drivers/anthropicGoogleCloud.ts`; Create `src/provider/drivers/index.ts`; Create `tests/contracts/drivers.test.ts`.

**Interfaces:**
- Consumes: `src/provider/registry.ts` (`resolveConnectionCredential` — the **only** path to a secret; `resolveCredential` is module-private), `src/provider/catalog.ts` (`CatalogModel`, `providerIdFor`), `src/provider/routes.ts` (`ResolvedBaseUrl`, `FOUNDRY_MUTUALLY_EXCLUSIVE_ERROR`, `FOUNDRY_MISSING_BASE_URL_ERROR`).
- Produces:
  ```ts
  export interface ProviderRequest {
    model: string;              // already resolved to the provider's model id
    maxTokens: number;
    messages: ProviderMessage[];
    system?: string;
    tools: ProviderTool[];
    stream: boolean;
    temperature?: number;
    thinking?: { type: 'enabled' | 'adaptive' | 'disabled'; budgetTokens?: number };
    betaFlags?: string[];
    extraHeaders?: Record<string, string>;
  }
  export type ProviderEvent =
    | { type: 'message_start'; messageId: string; model: string; usage?: Usage }
    | { type: 'text_delta'; text: string }
    | { type: 'thinking_delta'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; id: string; content: unknown; isError: boolean }
    | { type: 'message_stop'; stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal' }
    | { type: 'error'; message: string; status?: number; retryable: boolean };
  export interface ProviderDriver {
    readonly route: ProviderRoute;
    buildUrl(req: ProviderRequest, baseUrl?: string): string;
    buildHeaders(req: ProviderRequest, cred: string | undefined): Record<string, string>;
    buildBody(req: ProviderRequest, cred: string | undefined): { body: unknown; headers: Record<string, string> };
    parseStream(chunk: string, state: unknown): { events: ProviderEvent[]; state: unknown };
    parseNonStreaming(body: unknown): { events: ProviderEvent[] };
    classifyError(status: number, body: unknown): { message: string; retryable: boolean };
    calculateNonstreamingTimeout(maxTokens: number, modelLimit: number | undefined): number;
    betaFlagsFor(flags: string[]): string[];
  }
  export function driverFor(route: ProviderRoute): ProviderDriver;
  ```

**Design note — what is observed.** The route set, the client construction per route, the credential resolution order per route, the first-party request shape, **and the Bedrock, Vertex, Mantle, and Foundry wire shapes are all REA-observed** in the pinned binary. The provider adapters were re-derived from the target's own bundled modules — `chunk-1njnz05e.js` (Bedrock and Mantle), `chunk-jdnh8sjs.js` (Vertex), `chunk-m5c0c57d.js` (Foundry) — and the audit's §2.2a records the exact literals, the exact body mutations, the exact path rewrites, and the exact thrown error messages. Implement what the audit says, not what the public SDKs do; where they differ, the audit wins. This implementation's route set is exactly the eight REA-observed routes; a ninth "Anthropic-native Bedrock" variant is an AWS API capability, not a the reference agent route, and is out of scope.

- [x] **Step 1: Write the failing anthropic driver test** — `buildUrl` yields `<baseUrl>/v1/messages` for the standard path and `<baseUrl>/v1/messages?beta=true` when `betaFlags` is non-empty; `buildHeaders` sets `anthropic-version: 2023-06-01`, `content-type: application/json`, `x-api-key` for an api-key credential and `authorization: Bearer <token>` for a bearer credential, and never both.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, module not found.
- [x] **Step 3: Implement `src/provider/drivers/types.ts`** and `src/provider/drivers/anthropic.ts` to satisfy the test.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing retry test** — `classifyError` returns `retryable: true` for `408`, `409`, `429`, and any status `>= 500`; `retryable: false` for `400`, `401`, `403`, `404`; a `401` with a cached-token flag is retryable after invalidation.
- [x] **Step 6: Implement `classifyError`** in the anthropic driver and share the rule set via a helper the other drivers reuse.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing SSE test** — `parseStream` emits `message_start` once, then `text_delta` per `content_block_delta`, then `message_stop`; a `data:` frame carrying an `error` object emits `{ type: 'error' }` with `retryable` derived from the status.
- [x] **Step 9: Implement `parseStream`** with an explicit state object so a chunk boundary mid-frame does not lose data.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Write the failing per-route test** — for each of the eight routes, `driverFor(route).route === route`. The concrete wire shapes the drivers must produce:
  - **firstParty** — `POST <baseUrl>/v1/messages`; headers `x-api-key` **or** `authorization: Bearer`, never both; `anthropic-version: 2023-06-01`; `model` in the body; `stream` in the body. The target's own source shows **both** a plain `/v1/messages` path and a `/v1/messages?beta=true` variant; implement both and record the discrepancy rather than hard-coding the `?beta=true` marker behind a conditional.
  - **bedrock** — `POST <baseUrl>/model/<modelId>/invoke` (or `.../invoke-with-response-stream`); `model` **not** in the body; body field `anthropic_version: "bedrock-2023-05-31"`, set by the adapter when absent; `stream` **removed** from the body; the `anthropic-beta` **header** is moved into the body's `anthropic_beta` array, split on `,` and **trimmed**, and only when the body does not already carry it; the `beta` **search parameter is deleted**; the rewritten paths are exactly `/v1/complete`, `/v1/messages`, and `/v1/messages?beta=true`; a non-JSON body throws `Expected request body to be a JSON object for post <path>`. Auth is SigV4 (service `bedrock`, region `awsRegion`, `host` header replaced, `connection` header deleted, multi-valued query parameters preserved) unless a Bedrock bearer token is present, which takes precedence and suppresses SigV4. Bedrock streaming is **not** SSE — it is a binary `application/vnd.amazon.eventstream` whose frames carry a `chunk` member holding a JSON blob of the Anthropic event.
  - **mantle** — `POST <baseUrl>/v1/messages` with the Anthropic-native body; the base URL is `https://bedrock-mantle.<region>.api.aws/anthropic`; auth is a bearer token or SigV4 with the service name **`bedrock-mantle`**; betas travel in the `anthropic-beta` **header** together with `anthropic-version: 2023-06-01`.
  - **vertex** — `POST <host>/v1/projects/<project>/locations/<location>/publishers/anthropic/models/<model>:rawPredict` (or `:streamRawPredict`); body field `anthropic_version: "vertex-2023-10-16"`, set by the adapter when absent; `model` **not** in the body; `stream` **retained** in the body and used to select the endpoint suffix; the `beta` **search parameter is deleted**; `count_tokens` becomes `.../models/count-tokens:rawPredict`; a missing project throws `No projectId was given and it could not be resolved from credentials. The client should be instantiated with the 'projectId' option or the 'ANTHROPIC_VERTEX_PROJECT_ID' environment variable should be set.` Auth is a Google OAuth2 bearer with the `cloud-platform` scope and **never** an Anthropic API key.
  - **foundry** — `POST https://<resource>.services.ai.azure.com/anthropic/v1/messages`; the body's `model` is the **deployment name**, not a model id; auth is `x-api-key` **or** an Azure AD bearer with the `https://ai.azure.com/.default` scope, never both. `ANTHROPIC_FOUNDRY_BASE_URL` and `ANTHROPIC_FOUNDRY_RESOURCE` are **mutually exclusive** — the target throws `baseURL and resource are mutually exclusive` when both are supplied, and `Must provide one of the 'baseURL' or 'resource' arguments, or the ANTHROPIC_FOUNDRY_RESOURCE environment variable` when neither is. With only a resource, the base URL is `https://<resource>.services.ai.azure.com/anthropic/` **with a trailing slash**. The API key may be an async function; `authHeaders` awaits it. The adapter exposes **no models API**.
  - **anthropicAws** and **anthropicGoogleCloud** — Anthropic-native bodies with a workspace id header and, respectively, an AWS credential chain and Google cloud-platform auth.
  - **gateway** — the first-party gateway shape: `POST /v1/messages` and `POST /v1/messages/count_tokens`, a `cc-gateway/<version>` user agent, `workspace_id` in the body rejected with `400 invalid_request_error`, Bedrock `count_tokens` computed locally or answered `501 not_supported` with `x-should-retry: false`, and the upstream stream re-framed as SSE with keep-alive comments and a rewritten `message_start.message.model`.
- [x] **Step 12: Implement the seven remaining drivers** and `src/provider/drivers/index.ts`.
- [x] **Step 13: Run it to verify it passes** — expected: PASS.
- [x] **Step 13a: Write the failing beta-flag test** — a beta flag the upstream rejects must surface the upstream's `400` rather than being retried; a driver must translate a beta name whose spelling differs per platform instead of copying it verbatim, because Bedrock rejects the **whole** request for an unrecognized flag.
- [x] **Step 13b: Implement per-driver beta translation** in a `betaFlagsFor` table per driver, and add the failing test's assertion that a per-dialect beta list is trimmed before being placed in the body array.
- [x] **Step 13c: Write the failing timeout test** — `calculateNonstreamingTimeout` returns a value derived from `max_tokens` and the model's limit, and never exceeds the `600000` ms fallback; a request with an explicit timeout uses it unchanged.
- [x] **Step 13d: Implement `calculateNonstreamingTimeout`** on the driver, with the `600000` ms cap applied after the computation.
- [x] **Step 13e: Run it to verify it passes** — expected: PASS.
- [x] **Step 14: Commit.**
  ```bash
  git add src/provider/drivers tests/contracts/drivers.test.ts
  git commit -m "feat(provider): protocol drivers for all eight routes"
  ```

### CC-006b — Provider transport, retry loop, and signing

**Why this task exists.** The `CC-006` drivers build the *request* and *parse the response*, but nothing in the plan owns the **transport**: the HTTP client, the retry loop, the `parseResponse` call site, or the AWS SigV4 signer. The `CC-006` review found that `buildUrl`/`buildHeaders`/`buildBody` had no consumer in `src/`, that the route-specific SigV4 **service names** (`bedrock` versus `bedrock-mantle`) could not reach a transport, and that the "host header replaced, `connection` header deleted, multi-valued query parameters preserved" rules — which belong to the *signing* step — had nowhere to live. This task closes that hole.

**Files:** Create `src/provider/transport/http.ts`, `src/provider/transport/sigv4.ts`, `src/provider/transport/retry.ts`, `src/provider/transport/index.ts`; Create `tests/contracts/provider-transport.test.ts`.

**Interfaces:**
- Consumes: `src/provider/drivers/types.ts` (`ProviderDriver`, `ProviderRequest`, `ProviderEvent`, `parseResponse`, `AwsRequestContext`), `src/provider/drivers/index.ts` (`driverFor`), `src/provider/registry.ts` (`resolveConnectionCredential`).
- Produces:
  ```ts
  export interface TransportOptions {
    driver: ProviderDriver;
    fetchImpl?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  }
  export interface SendResult {
    events: ProviderEvent[];
    response: Response;
    status: number;
    requestId?: string;
  }
  export function sendProviderRequest(opts: TransportOptions, req: ProviderRequest, credential?: string): Promise<SendResult>;
  export function buildSignedHeaders(input: {
    method: string; url: URL; headers: Record<string, string>; body?: string;
    service: string; region: string; accessKeyId: string; secretAccessKey: string; sessionToken?: string;
    date?: Date;
  }): Promise<Record<string, string>>;
  export function retryDelayMs(attempt: number, response?: { status: number; headers: Headers }): number;
  ```

- [x] **Step 1: Write the failing transport test** — a request built by a driver is turned into a `fetch` call with the driver's URL, headers, and body; a streaming response is turned into `ProviderEvent[]` through `parseResponse`; a non-streaming JSON response is parsed and carries the non-enumerable `_request_id` / `_workspace_id`.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, module not found.
- [x] **Step 3: Implement `src/provider/transport/http.ts`** — call `driver.buildUrl` / `buildHeaders` / `buildBody`, issue the request, and feed the response through the driver's `parseStream` / `parseNonStreaming` (or the exported `parseResponse`). The transport must **not** resolve a credential; it receives one.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing retry test** — a retryable status is retried up to the driver's `maxRetries`; a non-retryable status is returned immediately; the delay honours `retry-after` and the driver's `x-should-retry` header; a `401` with the cached-token flag triggers a token refresh and one more attempt.
- [x] **Step 6: Implement `src/provider/transport/retry.ts`** with the audit's rule: `408`, `409`, `429`, and any status `>= 500` are retryable; `x-should-retry` overrides in both directions; `400`, `401`, `403`, `404` are not (except the cached-token `401`).
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing signing test** — the signed request replaces the `host` header with the URL's host, **deletes** the `connection` header, preserves multi-valued query parameters byte-for-byte, and carries the service name the **driver** wrote into `req.aws.service` (not a constant the transport knows).
- [x] **Step 9: Implement `src/provider/transport/sigv4.ts`** — a canonical-request signer over the driver's URL, headers, and body, using the service and region from the request context.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Write the failing scope test** — a Vertex or Foundry request's `tokenScope` reaches the token acquisition callback, so the scope is a live input rather than a constant.
- [x] **Step 12: Implement the token-acquisition seam** in `src/provider/transport/index.ts` — an `acquireToken(scope)` callback the transport invokes when the driver declares a scope.
- [x] **Step 13: Run it to verify it passes** — expected: PASS.
- [x] **Step 14: Commit.**
  ```bash
  git add src/provider/transport tests/contracts/provider-transport.test.ts
  git commit -m "feat(provider): transport, retry loop, and SigV4 signing"
  ```

### CC-007 — Permissions, rules, and approval

**Files:** Create `src/permissions/decision.ts`, `src/permissions/rules.ts`, `src/permissions/prompts.ts`; Create `tests/contracts/permission-decision.test.ts`, `tests/security/permission-rules.test.ts`.

**Interfaces:**
- Consumes: `src/config/loader.ts` (`SettingsLoadResult`).
- Produces:
  ```ts
  export type PermissionBehavior = 'allow' | 'deny' | 'ask';
  export type PermissionSource = 'classifier' | 'hook' | 'user_permanent' | 'user_temporary'
                              | 'user_abort' | 'user_reject' | 'unknown';
  export type PermissionReasonType = 'rule' | 'safetyCheck' | 'other';
  export interface PermissionDecision {
    behavior: PermissionBehavior;
    source: PermissionSource;
    reasonType: PermissionReasonType;
    reason?: string;
    updatedInput?: unknown;
    rule?: { content: string; source: string };
  }
  export interface ToolContext { toolName: string; input: unknown; toolUseId: string; sessionId: string; }
  export interface RuleSet { allow: string[]; deny: string[]; ask: string[]; }
  export function evaluateRules(rules: RuleSet, tool: ToolContext): PermissionDecision | undefined;
  export type PermissionMode = 'default' | 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk';
  export function checkPermission(ctx: ToolContext, opts: {
    rules: RuleSet; mode: PermissionMode;
    safetyCheck?: (ctx: ToolContext) => PermissionDecision | undefined;
  }): Promise<PermissionDecision>;
  export function resolveStartMode(opts: {
    flag?: PermissionMode; settingsDefault?: PermissionMode; autoAvailable: boolean; autoDisabledByPolicy: boolean;
  }): PermissionMode;
  export function describeReason(decision: PermissionDecision, toolName: string): string;
  ```

- [x] **Step 1: Write the failing decision test** — `evaluateRules` returns `deny` when a deny rule matches, `allow` when only an allow rule matches, `ask` when only an ask rule matches, and `undefined` when nothing matches so the caller can escalate.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, module not found.
- [x] **Step 3: Implement `src/permissions/decision.ts`** with the closed vocabularies exactly as written in Global Constraints.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing input-rewrite test** — a **hook** (not a rule) that returns a modified input causes the decision to carry `updatedInput`, and the *modified* input is what the tool receives. Assert both the decision field and the tool's observed input, and assert that a rewritten input that the tool's own validator rejects **denies** the call rather than executing it.
- [x] **Step 6: Implement `src/permissions/rules.ts`** as a pure predicate evaluator that returns a behavior and a reason and **never rewrites input** — a rule that silently changed what runs is exactly the defect the design must avoid. The rewrite path lives in the hook layer, and routes its `updatedInput` through the same `PermissionDecision.updatedInput` field.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing multi-operation test** — a Bash command `a && b` where `b` needs approval yields a reason naming only `b` (redirections stripped), and a count of how many parts need approval.
- [x] **Step 9: Implement `describeReason`** with the reason kinds `rule`, `subcommandResults`, `permissionPromptTool`, `sandboxOverride`, `workingDir`, `safetyCheck`.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Write the failing safety-check test** — a `PermissionRequest` hook that approves a WebFetch with arguments the tool cannot verify yields `reasonType: 'safetyCheck'` and `behavior: 'deny'`, and the reason text states that nothing was fetched.
- [x] **Step 12: Implement the safety-check hook in `src/permissions/prompts.ts`** — the hook approval carries a `classifierApprovable: false` marker in that case.
- [x] **Step 13: Run it to verify it passes** — expected: PASS.
- [x] **Step 14: Add a security test** asserting that a `bypassPermissions` mode still cannot bypass a `safetyCheck` denial.
- [x] **Step 15: Write the failing transport-dispatcher test** — a `can_use_tool` request whose `request_id` is **not a string** is dropped with no response, because no response is possible; a malformed `can_use_tool` is denied with a synthesized denial; a request whose `request_id` is already in flight is not dispatched a second time; a computer-folder prompt whose input is not exactly three string arguments is denied; a folder path or computer name containing a CR, LF, U+2028, or U+2029 is denied; a path that is not equal to its own normalized form is denied.
- [x] **Step 16: Implement the transport permission dispatcher** in `src/permissions/prompts.ts` with the target's observed validation, the in-flight deduplication map, and the repository-trust and computer-folder prompt paths.
- [x] **Step 17: Run it to verify it passes** — expected: PASS.
- [x] **Step 18: Write the failing mode test** — in `dontAsk` mode a call that would prompt is **denied**, `canUseTool` is never consulted, and a tool marked `requiresUserInteraction`, an `AskUserQuestion` request, a network-path read, or an org-ask connector tool is denied **even if an allow rule matches**. Deny rules block in every mode including `bypassPermissions`, and allow rules have no effect in `bypassPermissions`. The `manual` alias resolves to `default`.
- [x] **Step 19: Implement `dontAsk`** and the `manual` alias in `src/permissions/decision.ts`.
- [x] **Step 20: Write the failing start-mode test** — the flag beats `permissions.defaultMode`, which beats the built-in default; `auto` and `bypassPermissions` written into a settings file are ignored; the built-in default is `auto` for an interactive terminal session and `default` for a headless run, and falls back to `default` when auto mode is disabled by policy or unavailable.
- [x] **Step 21: Implement `resolveStartMode`** with those three availability overrides.
- [x] **Step 22: Run it to verify it passes** — expected: PASS.
- [x] **Step 23: Commit.**
  ```bash
  git add src/permissions tests/contracts/permission-decision.test.ts tests/security/permission-rules.test.ts
  git commit -m "feat(permissions): rule evaluation, decision vocabulary, safety checks"
  ```

### CC-007b — The `PreToolUse` permission seam

**Why this task exists.** `CC-012` implemented the hook side of the `PreToolUse` decision — `createPreToolUseApproval` and `mergePreToolUseApproval` in `src/extensions/hooks/runner.ts` — but the permission engine has no way to receive it. The plan's CC-012 design note requires that "a `PreToolUse` hook returning `allow` must not override a deny or ask rule, and a hook returning `deny` must hold in every mode including `bypassPermissions` — the target changed this behaviour in a later release without a deprecation warning, so this implementation must pick one and document it." This implementation's pick is the **stricter** of the target's two behaviors, and it cannot be enforced until the permission engine consults the hook.

**Files:** Modify `src/permissions/decision.ts`; Modify `src/permissions/prompts.ts`; Create `tests/contracts/permission-hook.test.ts`.

**Interfaces:**
- Consumes: `src/extensions/hooks/runner.ts` (`createPreToolUseApproval`, `mergePreToolUseApproval`) — read only; `src/extensions/hooks/registry.ts` (`HookSpec`).
- Produces: a `preToolUseHook?: (ctx: ToolContext) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>` member on `CheckPermissionOptions`; a call site in `checkPermission` **after the ask list and before the mode's semantics**.

- [x] **Step 1: Write the failing precedence test** — a `PreToolUse` hook returning `allow` does **not** override a deny rule, and does **not** override an ask rule; a `PreToolUse` hook returning `deny` holds in `default`, `plan`, `acceptEdits`, `auto`, `dontAsk` and `bypassPermissions`.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, the option does not exist.
- [x] **Step 3: Add the option and the call site** in `src/permissions/decision.ts` — the hook runs after the deny and ask lists, so its `allow` can never rescue a call the rules refuse, and its `deny` is returned immediately. A hook that returns `undefined` expresses no opinion and changes nothing.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing combination test** — when both a `PreToolUse` hook and the `PermissionRequest` seam are wired, the **stricter** of the two decisions wins: a `PreToolUse` `allow` and a `PermissionRequest` `deny` gives `deny`; a `PreToolUse` `deny` and a `PermissionRequest` `allow` gives `deny`.
- [x] **Step 6: Implement the combination** — the two seams must not be able to cancel each other.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing rewrite test** — a `PreToolUse` hook that rewrites the tool input has the **whole** permission check re-run against the **effective** input, and a rewritten input the tool's validator rejects **denies** the call.
- [x] **Step 9: Implement the rewrite handling** — the `createPermissionRequestHook` wrapper already applies the safety check and the tool's validator to a rewritten input, so the `PreToolUse` seam must go through the same path.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Commit.**
  ```bash
  git add src/permissions tests/contracts/permission-hook.test.ts
  git commit -m "feat(permissions): the PreToolUse hook seam"
  ```

**Design note — this implementation's pick.** The target changed this behaviour in a later release without a deprecation warning, so the target's own behavior at `2.1.303` is ambiguous from the outside. This implementation picks the **stricter** of the two: **an `allow` never overrides a deny or an ask rule, and a `deny` holds in every mode, `bypassPermissions` included.** This is a labelled implementation choice, recorded in the module header and in `docs/compatibility/permission-matrix.md`.

### CC-007c — Wire the `PreToolUse` seam into the tool runner

**Why this task exists.** `CC-007b` built the permission side of the `PreToolUse` seam and `CC-012` built the hook side, but **nothing connects them**: no tool call is actually gated by a `PreToolUse` hook, and the hooks module still cannot *produce* an `ask` or a `defer` for the permission layer. The `CC-007b` review found this and the `CC-007b` fix round reported the exact diffs.

**Files:** Modify `src/extensions/hooks/runner.ts`; Modify `src/tools/builtins/shared.ts`; Modify `src/tools/builtins/webfetch.ts`; Create `tests/contracts/pre-tool-use-wiring.test.ts`.

**Interfaces:**
- Consumes: `src/extensions/hooks/runner.ts` (`createPreToolUseApproval`, `mergePreToolUseApproval`, `HookDecisionValue`); `src/permissions/prompts.ts` (`createPreToolUseHook`, `verifyToolInput`); `src/permissions/decision.ts` (`PermissionDecision`, `ToolContext`, `checkPermission`).
- Produces: a `PreToolUseHookApproval` shape the hooks module can produce with an `ask` or a `defer`; a `preToolUseHook` member on `BuiltinToolDeps`; the tool runner consulting the seam.

**The hooks-side change (`src/extensions/hooks/runner.ts`).** The `PreToolUse` seam knows **four** decision values — `allow`, `ask`, `defer`, `deny` — so its approval is **not** the permission-request approval, which only ever sees `allow` and `deny`. A **new** exported interface:

```ts
export interface PreToolUseHookApproval {
  hookEventName: 'PreToolUse';
  decision: { behavior: HookDecisionValue; reason?: string };
  updatedInput?: unknown;
}
```

`mergePreToolUseApproval(results)` must return it: a **`defer` is no opinion** (the permission layer's normal path decides, so nothing is carried) and an **`ask` is carried** (the permission vocabulary has an exact word for it, and the call becomes the question the prompt asks). `createPreToolUseApproval(specs)` returns `(ctx) => Promise<PreToolUseHookApproval | undefined>`.

`PreToolUseHookApproval` must be assignable to the permission layer's `HookApproval`, so `createPreToolUseHook({ approval: createPreToolUseApproval(specs) })` compiles unchanged.

**The tool-runner-side change (`src/tools/builtins/shared.ts`).** `BuiltinToolDeps` gains an optional `preToolUseHook?: (ctx: ToolContext) => PermissionDecision | undefined | Promise<PermissionDecision | undefined>`, and `runToolCheck` passes it to `checkPermission` as `preToolUseHook: deps.preToolUseHook`. The tool layer's own `recheckHook` must consult **both** seams and keep only the **denial** from either — it is the second line of defence and owns the write path, so it stays stricter than the permission layer's rule.

**The stale headers.** `src/tools/builtins/shared.ts` and `src/tools/builtins/webfetch.ts` both say *"The safety check runs before the rule engine. `checkPermission` runs the safety check first…"*. That is no longer true: the safety check now runs **after** the hook seams, on the **effective** input — it must, to run once on the input the tool will act on. It still holds in every mode and still precedes the mode dispatch. Correct both headers.

- [x] **Step 1: Write the failing test** — a tool call whose `PreToolUse` hook denies it is refused in every mode, `bypassPermissions` included; a hook that approves it does **not** override a deny rule or an ask rule; and a hook that rewrites the input has the rewrite carried into the tool's effective input.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, nothing consults the seam.
- [x] **Step 3: Implement the hooks-side change** in `src/extensions/hooks/runner.ts` — the new approval shape, the `defer`-is-no-opinion rule, and the `ask` carried through.
- [x] **Step 4: Implement the tool-runner-side change** in `src/tools/builtins/shared.ts` — the `preToolUseHook` member, the `checkPermission` wiring, and the two-seam `recheckHook`.
- [x] **Step 5: Correct the two stale headers** in `src/tools/builtins/shared.ts` and `src/tools/builtins/webfetch.ts`.
- [x] **Step 6: Run it to verify it passes** — expected: PASS.
- [x] **Step 7: Write the failing assembly test** — a `PreToolUse` hook that returns `ask` reaches the permission layer as the pending question, carrying the hook's own reason and source; and a hook that returns `defer` reaches it as no opinion.
- [x] **Step 8: Implement the assembly** and confirm the hooks module's approval plugs straight into `createPreToolUseHook` with no adaptation.
- [x] **Step 9: Run it to verify it passes** — expected: PASS.
- [x] **Step 10: Commit.**
  ```bash
  git add src/extensions/hooks/runner.ts src/tools tests/contracts/pre-tool-use-wiring.test.ts
  git commit -m "feat(tools): wire the PreToolUse seam into the tool runner"
  ```

### CC-008 — Tool registry and built-in tools

**Files:** Create `src/tools/registry.ts`, `src/tools/builtins/*.ts`, `src/tools/runner.ts`; Create `tests/contracts/tool-registry.test.ts`.

**Interfaces:**
- Consumes: `src/permissions/decision.ts` (`PermissionDecision`, `checkPermission`).
- Produces:
  ```ts
  export interface ToolDefinition<I = unknown, O = unknown> {
    name: string;
    description: string;
    inputSchema: unknown;
    mutatesFiles: boolean;
    checkPermissions(input: I, ctx: ToolContext): Promise<PermissionDecision | undefined>;
    validateInput(input: I, ctx: ToolContext): Promise<{ ok: true } | { ok: false; message: string; errorCode: number }>;
    execute(input: I, ctx: ToolContext): Promise<O>;
    /**
     * Re-run the WHOLE permission check against a rewritten input.
     * A hook may rewrite the tool input; the rewrite must not escape the deny
     * list, the ask list, the allow scope, or the mode dispatch. The re-check
     * may only RESTRICT the call — the stricter of the two verdicts wins. The
     * re-check's hook keeps its denial but loses its approval and its rewrite,
     * because the approval was given for the original call.
     */
    recheckPermission(input: I, ctx: ToolContext): Promise<ToolRecheck>;
  }
  export interface ToolRecheck {
    decision: PermissionDecision | undefined;   // undefined = the tool expressed no opinion
    approvedPath?: string;                        // the path the check approved, as the call named it
  }
  export interface ToolRegistry {
    register(tool: ToolDefinition): void;
    get(name: string): ToolDefinition | undefined;
    list(): readonly ToolDefinition[];
  }
  export const FILE_MUTATING_TOOLS: readonly string[];  // ['Edit','Write','NotebookEdit']
  export interface ToolResultEnvelope {
    toolUseId: string;
    content: unknown;
    isError: boolean;
    permissionDecision?: { decision: PermissionBehavior; source: PermissionSource; reasonType?: PermissionReasonType };
    nonExecutionKind?: string;
    remedy?: string;
    userFeedback?: string;
  }
  export async function runTool(registry: ToolRegistry, name: string, input: unknown, ctx: ToolContext): Promise<ToolResultEnvelope>;
  ```

- [x] **Step 1: Write the failing registry test** — registering a tool makes it discoverable; `get` on an unknown name returns `undefined`; `list` returns registration order.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement `src/tools/registry.ts`** and `FILE_MUTATING_TOOLS`.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing runner test** — a tool whose `checkPermissions` denies produces an envelope with `isError: true` and the decision attached, and the tool's `execute` is **not** called; a tool whose `validateInput` fails produces `isError: true` with the validation message and the error code.
- [x] **Step 6: Implement `src/tools/runner.ts`** with the order: check permissions → validate input → execute → wrap the result. Record the permission decision on every envelope.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing built-in tool tests** — one per built-in tool covering its input schema rejection and its normal path: `Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `TodoWrite`, `NotebookEdit`, `Task`.
- [x] **Step 9: Implement the built-in tools** under `src/tools/builtins/`, one file per tool, each with a `checkPermissions` that consults the rules and a `validateInput` that returns typed error codes.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Commit.**
  ```bash
  git add src/tools tests/contracts/tool-registry.test.ts
  git commit -m "feat(tools): registry, runner, built-in tools"
  ```

### CC-009 — Session events, storage, resume, compaction

**Files:** Create `src/session/event.ts`, `src/session/store.ts`, `src/session/resume.ts`, `src/session/compaction.ts`; Create `tests/contracts/session-store.test.ts`, `tests/contracts/session-resume.test.ts`.

**Interfaces:**
- Consumes: `src/tools/registry.ts` (`ToolResultEnvelope`), `src/provider/drivers/types.ts` (`ProviderEvent`).
- Produces:
  ```ts
  export const SESSION_SCHEMA_VERSION = 1;
  export type SessionEvent =
    | { v: 1; t: 'user_message'; ts: number; id: string; text: string }
    | { v: 1; t: 'assistant_message'; ts: number; id: string; text: string }
    | { v: 1; t: 'tool_call'; ts: number; id: string; name: string; input: unknown }
    | { v: 1; t: 'tool_result'; ts: number; id: string; envelope: ToolResultEnvelope }
    | { v: 1; t: 'provider_event'; ts: number; id: string; event: ProviderEvent }
    | { v: 1; t: 'permission_request'; ts: number; id: string; toolName: string; decision?: PermissionDecision }
    | { v: 1; t: 'compaction'; ts: number; id: string; summary: string; replacedFrom: number };
  export interface SessionStore {
    create(opts: { cwd: string; sessionId?: string }): Promise<SessionHandle>;
    append(handle: SessionHandle, event: SessionEvent): Promise<void>;
    read(handle: SessionHandle): AsyncIterable<SessionEvent>;
    list(opts: { cwd: string; limit?: number }): Promise<SessionSummary[]>;
  }
  export interface SessionHandle { sessionId: string; path: string; }
  export interface SessionSummary { sessionId: string; path: string; startedAt: number; updatedAt: number; messageCount: number; }
  export function resumeEvents(events: SessionEvent[]): { context: ContextItem[]; }
  export function compact(events: SessionEvent[], opts: { keepLast: number }): { events: SessionEvent[]; summary: string | undefined };
  ```

**Design note.** The target's resume is **not a file replay**: it indexes messages by id, selects the newest leaf, and walks the parent chain backwards, then applies projections (compaction boundary, preserved segments, content replacements). File order is write order only; dead branches from a rewind stay in the file and are pruned. This implementation adopts the same shape, because the difference is observable: a user who rewinds and then resumes must see the rewound branch, not the later one. The target's compaction is a **boundary marker, not a deletion** — a system line with a `compact_boundary` subtype whose `logicalParentUuid` points at the last pre-compact message, with the summary in a separate line — and this implementation must match that, because a reimplementation that *deletes* the prefix cannot replay a preserved tail. The target also replaces oversized tool output with a stub plus a content-replacement entry so the large payload does not return to context on resume; this implementation needs the same mechanism or it will blow the context window on the first large file read.

- [x] **Step 1: Write the failing store test** — `append` writes one JSON object per line; `read` yields the same events in order; the file lives under `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`; a reader tolerates a torn final line by discarding it.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement `src/session/event.ts`** and `src/session/store.ts` with an append-only JSONL writer and a line-oriented reader that skips a trailing partial line. The project directory name is derived from the working directory path with non-alphanumeric characters replaced by `-`, truncated at 200 characters with a hash of the full path appended.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing version test** — reading a file whose first event has `v: 2` raises a `SessionVersionError` that names the found and supported versions; it does not silently drop events. Every record carries its own `version`, so a format change is visible per record.
- [x] **Step 6: Implement the version guard** in `read`.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing resume test** — given a file with a rewound branch (two children of one parent, the later one written first), `resumeEvents` reconstructs the branch ending at the newest leaf, not the branch that was written last; `tool_result` events pair to their `tool_call` by id.
- [x] **Step 9: Implement `src/session/resume.ts`** with the index → newest-leaf → walk-backwards algorithm, then apply the compaction-boundary and content-replacement projections.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Write the failing compaction test** — `compact` keeps the last `keepLast` events and emits a `compaction` event carrying the summary of the dropped prefix; the summary is produced by the provider and passed in, not generated locally; the pre-compact prefix is **skipped when reading**, not deleted from the file.
- [x] **Step 12: Implement `src/session/compaction.ts`**.
- [x] **Step 13: Write the failing oversized-output test** — a tool result whose serialized content exceeds a size limit is stored **verbatim** in the transcript together with a content-replacement entry, and the **stub is applied on read**, so the file keeps the data and the context does not. (Amended after the first fix round: the earlier wording — "stored as a stub" — contradicted the implemented design and would have lost the payload permanently.)
- [x] **Step 14: Implement the content-replacement mechanism** in `src/session/store.ts` and `resume.ts`.
- [x] **Step 15: Run it to verify it passes** — expected: PASS.
- [x] **Step 16: Write the failing carried-prompt test** — a prompt persisted for a later process is returned only when it is **bound** to the same session identity, is not older than the configured limit, is not dated in the future, and has not already been delivered. The outcome vocabulary is exactly `sent`, `bound`, `altered`, `no_row`, `job_has_run`, `too_old`, `future_dated`, and the test asserts each.
- [x] **Step 17: Implement the carried-prompt store** in `src/session/store.ts` with the binding, age, and delivery checks, and emit the outcome as the telemetry event name the target uses.
- [x] **Step 18: Run it to verify it passes** — expected: PASS.
- [x] **Step 19: Commit.**
  ```bash
  git add src/session tests/contracts/session-store.test.ts tests/contracts/session-resume.test.ts
  git commit -m "feat(session): JSONL event store, resume, compaction"
  ```

### CC-008b — Route the `Bash` tool through the sandbox

**Why this task exists.** `CC-008` built the `Bash` tool and `CC-017` built the sandbox, but nothing connects them: the `Bash` tool still runs `/bin/sh -c` directly and its header says "this implementation's sandbox itself is not implemented yet". The sandbox's `launchSandbox` has no caller, so the sandbox currently protects nothing. This task wires the two together.

**Files:** Modify `src/tools/builtins/bash.ts`; Modify `src/tools/builtins/shared.ts`; Modify `src/config/loader.ts`; Create `tests/security/bash-sandbox.test.ts`.

**Config wiring (added by the `CC-017` review).** `src/config/schema.ts` already parses and preserves `sandbox.filesystem`, so no schema change is needed; the gap is that nothing turns a settings document into a sandbox policy. `src/config/loader.ts` must add a `readonly sandboxPolicy: SandboxPolicy` member to `SettingsLoadResult`, built with `readSandboxPolicy(mergedDocument)`, and the `Bash` tool must pass it to `launchSandbox({ policy, … })`.

**Interfaces:**
- Consumes: `src/platform/sandbox/launcher.ts` (`launchSandbox`, the sandbox status), `src/platform/sandbox/policy.ts` (`SandboxPolicy`, `DEFAULT_SANDBOX_POLICY`, `readSandboxPolicy`, `evaluateSandbox`).
- Produces: the `Bash` tool routes its command through `launchSandbox` when the policy says the command is sandboxed, and runs it unconfined — with the reason recorded — when the policy says so.

- [x] **Step 1: Write the failing test** — a `Bash` call with the sandbox enabled runs through the launcher; a call the policy exempts runs unconfined and says so; a call whose sandbox cannot be started is refused when `failIfUnavailable` is set and runs unconfined when it is not; and `dangerouslyDisableSandbox` **never** skips a permission rule.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, the tool does not call the launcher.
- [x] **Step 3: Implement the wiring** in `src/tools/builtins/bash.ts` and `src/config/loader.ts` — add `SettingsLoadResult.sandboxPolicy` (built with `readSandboxPolicy`), resolve the policy, call `evaluateSandbox` **with the backend's real availability** as its fourth argument, and route the command through `launchSandbox` or run it directly, recording the reason, the exemptions and the `sandboxed` flag in the result. The tool's existing timeout, output cap, and environment handling stay as they are.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing safety test** — the sandboxed command cannot see the host's environment (the agent's credentials are not in it), and a denied sandbox leaves the tool's result reporting the refusal rather than a bare non-zero exit.
- [x] **Step 6: Implement the safety behavior** and correct the tool's header, which currently says the sandbox is not implemented.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Commit.**
  ```bash
  git add src/tools tests/security/bash-sandbox.test.ts
  git commit -m "feat(tools): route the Bash tool through the sandbox"
  ```

**Result:** the `Bash` tool runs through the sandbox. A sandboxed command runs through
`launchSandbox`; an exempt one runs unconfined **with the reason recorded**; a missing
backend obeys `failIfUnavailable`; the availability is probed **once**, so the policy and
the launcher cannot disagree; `SettingsLoadResult` carries a **required** `sandboxPolicy`;
and **neither** the sandboxed **nor** the unconfined path sees the agent's credentials.

Two rounds of review and a third verification found, and closed:

- the launcher's live output accessor leaking the **readiness token** as command output on every timed-out run;
- the CLI→policy wiring pinned only by a **source grep**, replaced with a real guard that builds a session and checks the policy reached the model;
- a sandboxed command that ran past its timeout **reported as stopped but left running** — the timeout path skipped the kill. The kill is now fired without blocking the report, and the test watches the host's process table;
- the **same defect class on the unconfined path** — it killed only the shell, so the command's own process was orphaned and survived. The command now leads its **own process group** and the whole group is stopped.

**Verified** by mutation in the final pass: removing the sandboxed timeout's kill turns
three tests red, making the unconfined path kill only the shell turns one red, and
reverting the unconfined path's notice reservation turns two red. The security suite is
green at **241 tests**.

**One residual:** the unconfined path runs the command itself rather than through the
launcher's own unconfined path, so no `SandboxStatus` is produced for an unconfined run.
The tool's own report carries the reason, the scope and the availability, and the
difference is now stated in `docs/compatibility/tool-surface.md`.

### CC-009b — The projected tool-result content must be a string

**Why this task exists.** The `CC-010` re-review found that a **failed** tool (an execution error or a validation error) leaves the transcript with an envelope whose content is an **object** — `{"type":"error","message":"the tool exploded","errorCode":12}`. The live path serialises it, so the same turn is fine, but the **cross-turn projection** in `src/session/resume.ts` passes `block.content` raw, so the **next** request carries a `tool_result` block whose content is an object. The Messages API's observed shape is `{tool_use_id, type:"tool_result", content:<string>}` — so the request after a failed tool is invalid. The `CC-010` fix round's "the next request is well-formed" claim holds for the refusal and interruption paths, but not for this one.

**Files:** Modify `src/session/resume.ts`; Modify `src/agent/context.ts`; Create `tests/contracts/tool-result-projection.test.ts`.

**Interfaces:** Consumes: `src/session/event.ts` (`SessionEvent`), `src/session/store.ts`; `src/agent/context.ts` (`conversationFromEvents`). Produces: a projected `tool_result` block whose `content` is always a **string**.

- [x] **Step 1: Write the failing test** — a transcript with a tool call whose result is an **error** envelope is projected into provider messages, and the `tool_result` block's content is a **string** — not the object.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, the content is the object.
- [x] **Step 3: Fix the projection** in `src/session/resume.ts` so the content is serialised the way the live path serialises it. The two paths must agree — **reuse** the live path's serialisation rather than writing a second one, so they cannot drift.
- [x] **Step 4: Run it to verify it fails** — expected: PASS.
- [x] **Step 5: Write the failing cross-path test** — the same transcript projected through `src/agent/context.ts`'s `conversationFromEvents` and through `src/session/resume.ts` must produce the **same** `tool_result` content. A serialization that differs between the two paths is the bug this task exists to remove.
- [x] **Step 6: Implement the shared serialisation** and confirm the two paths agree.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Commit.**
  ```bash
  git add src/session src/agent tests/contracts/tool-result-projection.test.ts
  git commit -m "fix(session): the projected tool-result content is always a string"
  ```

### CC-009c — The within-turn tool result is stubbed too

**Why this task exists.** The content-replacement mechanism exists so an oversized tool result does not come back into the **context**. `CC-009b` closed the gap on the two *projection* paths (the between-turns load and the cross-turn projection), but the **within-turn** push in `src/agent/loop.ts` still carries the raw envelope — so a 256 KiB+ tool result reaches the model **in the turn the tool ran**, which is the turn it matters most in.

**Files:** Modify `src/session/store.ts`; Modify `src/agent/loop.ts`; Modify `src/session/event.ts`; Create `tests/contracts/tool-result-stub.test.ts`.

**Interfaces:**
- Consumes: `src/session/store.ts` (`DEFAULT_MAX_TOOL_RESULT_BYTES`, `serializedSize`, `ToolResultStub`); `src/agent/context.ts` (`toolResultBlock`).
- Produces: an exported `contentReplacementStub(content: unknown, maxBytes?: number): ToolResultStub | undefined` in `src/session/store.ts`; an optional `readonly maxToolResultBytes?: number` on `SessionStore`; a within-turn tool result that is stubbed when it is oversized.

- [x] **Step 1: Write the failing test** — a tool whose result is over the limit is stubbed in the **within-turn** request: the request's `tool_result` block carries the stub, not the payload, and the payload is still in the transcript.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, the raw payload is in the request.
- [x] **Step 3: Export the stub rule from the store** — `contentReplacementStub(content, maxBytes)` returns the stub or `undefined`, and `recordsFor` uses it instead of building the stub inline, so there is **one** rule. Add `readonly maxToolResultBytes?: number` to `SessionStore` (optional, so the existing test doubles still compile).
- [x] **Step 4: Use it in the within-turn push** in `src/agent/loop.ts` — the result block carries the stub when the content is oversized, and the raw content when it is not.
- [x] **Step 5: Run it to verify it passes** — expected: PASS.
- [x] **Step 6: Write the failing consistency test** — the within-turn block, the between-turns load and the cross-turn projection must all produce the **same** stubbed content for the same transcript, and none of them may carry the payload.
- [x] **Step 7: Implement whatever that requires** and confirm the three paths agree.
- [x] **Step 8: Label the stub's wire form as a implementation choice** where the stub enters the context (`src/session/event.ts` and `src/session/store.ts`) — the audit does not pin the stub's shape.
- [x] **Step 9: Commit.**
  ```bash
  git add src/session src/agent tests/contracts/tool-result-stub.test.ts
  git commit -m "fix(session): the within-turn tool result is stubbed too"
  ```

### CC-003b — The settings merge is per top-level key

**Why this task exists.** Closing the REA's last open configuration question turned a
labelled choice into an **observed** rule, and the observed rule is not the one this
implementation had.

The target merges the settings tiers **per top-level key**, in the order
**user < project < local < flag < policy** (`Ps`), and the *value* rule is decided per
key by one helper:

| the key's value | the target's rule |
|---|---|
| `modelPicker` | the higher tier **replaces** |
| an **array** | the two arrays are **concatenated and de-duplicated** |
| an array, key `fallbackModel` | the higher tier **replaces** |
| an object, key `extraKnownMarketplaces` or `managedMcpServers` | a **one-level shallow merge** |
| anything else | the higher tier **replaces** the value **wholesale** |

There is **no per-leaf merge**: an ordinary object-valued setting is not merged key by
key, and the higher tier's object wins whole.

This implementation merges **per leaf** (`mergeDocuments` recurses into plain objects).
That was recorded as an implementation choice; it is a **divergence from an observed
rule**, and the label has to come off.

**Evidence.** `/home/shiva/opt/reference-agent-rea/analysis/findings-config-merge.md`,
which quotes the source: `Ps` in `chunk-16tfbg7w.js`, `Opn` and `rUr` and `S3` in
`chunk-c9s0jh80.js`, `me` and `Gge` in `chunk-4sn6hdt2.js`, and the block rule in the
target's own words in `chunk-6bp7hdav.js`.

**Files:** Modify `src/config/tiers.ts`; Modify `src/config/loader.ts`; Modify
`tests/contracts/settings-precedence.test.ts`; Modify
`docs/compatibility/settings-precedence.md`.

**Interfaces:**
- Consumes: `src/config/tiers.ts` (`SettingsSource`, `mergeDocuments`, `mergeBlockwise`,
  `mergeMergedSettings`, `TOP_LEVEL_KEY_ORDER`, `MERGED_KEY_ORDER`).
- Produces: `mergeSettingsByKey(low, high, key): unknown` — the observed per-key value
  rule — and `EFFECTIVE_SETTINGS_ORDER: readonly SettingsSource[]` — `Ps`, in increasing
  priority.

- [x] **Step 1: Write the failing test** — two tiers that define the same **object**
  setting: the higher tier's value wins **whole**, not key by key; two tiers that define
  the same **array** setting: the values are **concatenated** and de-duplicated; the two
  named object keys are **shallow**-merged one level; `fallbackModel` and `modelPicker`
  are replaced.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, the merge is per leaf.
- [x] **Step 3: Implement the per-key value rule** in `src/config/tiers.ts` — a function
  of `(existing, incoming, key)` that returns the merged value, and `undefined` for the
  default case, which the merge helper reads as "the incoming value replaces".
- [x] **Step 4: Replace the per-leaf merge** — `mergeDocuments` becomes a per-top-level-key
  merge that uses the value rule. The `__proto__`/`constructor`/`prototype` guard stays.
- [x] **Step 5: Apply the tier order** — the effective settings are composed in the
  order `user < project < local < flag < policy`.
- [x] **Step 6: Run it to verify it passes** — expected: PASS.
- [x] **Step 7: Update the conformance document** — the row's outcome becomes `match`,
  the "implementation choice" label comes off, and the observed rule is stated.
- [x] **Step 8: Commit.**
  ```bash
  git add src/config tests/contracts/settings-precedence.test.ts docs/compatibility/settings-precedence.md
  git commit -m "fix(config): the settings merge is per top-level key, as the target merges it"
  ```


**Result:** the settings merge is now the target's rule. `mergeSettingsValue` in
`src/config/tiers.ts` is the observed per-key value table — `modelPicker` and
`fallbackModel` are replaced, arrays are concatenated and de-duplicated, the two named
object keys are shallow-merged one level, and **everything else is replaced whole**.
`mergeDocuments` merges **per top-level key** and no longer recurses into plain objects.
`resolveBlock` and the CLI's `mergedTopLevelKey` now return the **merged** value — so an
array two tiers define is the concatenation of both — while the source they report is
still the highest tier that defines the key. `mergeMergedSettings` gives a merged key's
**unit** to the first source in the merged order that defines it, whole.

The tier composition order is the target's `Ps`: user, project, local, flag, policy,
increasing priority.

**Verification.** The twelve new tests were checked by **mutation** rather than by a
red-first run: restoring the per-leaf merge turns five of them red, and making the
resolver return the highest tier's value alone turns two more red. The suite is green at
**1837 tests** and `npx tsc --noEmit` is clean.

**Consequence.** The "implementation choice" label on the per-leaf merge is **off**: it
was a divergence from an observed rule, and the conformance document now says so.

**Note.** The compatibility harness measures the clone and reports the outcome; this
task must not edit `docs/compatibility/results.md` or `tests/compatibility/**` — the
orchestrator owns those and will update the totals when the harness reports.

### CC-010 — Agent runtime and turn orchestration

**Files:** Create `src/agent/loop.ts`, `src/agent/context.ts`, `src/agent/dispatch.ts`; Create `tests/contracts/agent-loop.test.ts`.

**Interfaces:**
- Consumes: `src/provider/drivers/types.ts` (`ProviderDriver`, `ProviderEvent`), `src/tools/registry.ts` (`ToolRegistry`, `runTool`), `src/session/event.ts` (`SessionEvent`).
- Produces:
  ```ts
  export interface TurnInput { prompt: string; sessionId: string; model: string; }
  export interface TurnResult { events: SessionEvent[]; stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'aborted' | 'error'; }
  export interface AgentRuntime {
    runTurn(input: TurnInput, signal?: AbortSignal): Promise<TurnResult>;
  }
  export function createAgentRuntime(deps: {
    driver: ProviderDriver; registry: ToolRegistry; store: SessionStore; permission: typeof checkPermission;
  }): AgentRuntime;
  export function toolCallsFrom(events: ProviderEvent[]): { id: string; name: string; input: unknown }[];
  export function groupToolCalls(calls: { id: string; name: string; input: unknown }[]): { parallel: boolean; groups: string[][] };
  ```

- [x] **Step 1: Write the failing loop test** — given a driver that emits `message_start`, a `tool_use`, and `message_stop`, the runtime appends the corresponding session events, runs the tool, appends the tool result, and issues a second provider request containing the tool result.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement `src/agent/loop.ts`** with the request → stream → tool-call → tool-result → request cycle, persisting every event through the store.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing ordering test** — two tool calls in one assistant message are executed in the order they appear, and each result is appended before the next provider request is issued.
- [x] **Step 6: Implement `src/agent/dispatch.ts`** with the ordering rule and the parallel-group classifier.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing abort test** — aborting mid-stream stops the loop, appends a `provider_event` with `type: 'error'` and `retryable: false`, and returns `stopReason: 'aborted'`.
- [x] **Step 9: Implement the abort path.**
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Commit.**
  ```bash
  git add src/agent tests/contracts/agent-loop.test.ts
  git commit -m "feat(agent): turn orchestration and tool dispatch"
  ```

### CC-010b — The tool calls of one message run concurrently when they are safe

**Why this task exists.** Closing the REA's open scheduling question turned a labelled
choice into an **observed** rule, and the observed rule is not the one this
implementation had.

The target's scheduler is **per tool, not per message**:

- every tool declares whether it is **concurrency safe**;
- **concurrency-safe** calls run **in parallel** — several are in flight at once;
- a call that is **not** concurrency safe runs **alone** and acts as a **barrier**: the
  queue stops at it, and nothing else starts until it has finished;
- the **next model request is issued only after every** tool call of that assistant
  message has produced its result — a slow tool holds the next request back;
- the results are **emitted** in block order for the non-safe calls and in completion
  order for the concurrency-safe ones.

The per-tool flags the target uses: `Glob`, `Grep`, the notebook-read tool, `WebFetch`
and `Read` are concurrency safe; the MCP-wait tool is not; `Bash` is safe only when the
call is read-only. A tool that does **not** declare the flag is **not** concurrency
safe — the target's own default, and it is what the read is wrapped in:
`Boolean(n.isConcurrencySafe(r.data))` inside a `try`, and `false` in the `catch`.

`Bash`'s flag is `isConcurrencySafe(e){return this.isReadOnly?.(e)??!1}`, so it needs a
**read-only classifier**. The target has one, and it also reports a reason when a call is
**not** read-only (`notReadOnlyReason`).

**The classifier's rule is established** — it was read from the source, and the record is
`/home/shiva/opt/reference-agent-rea/analysis/findings-read-only-classifier.md`. A shell
command is read-only when it **parses simply** and **every** command in it is either a
known read-only command or a write command invoked in a read-only way.

The target's decision sequence, in order:

1. too long → not read-only;
2. the command does not parse simply → not read-only;
3. it contains a **subshell** or a **compound statement** → not read-only;
4. it contains a **`&`** (backgrounding) → not read-only;
5. it makes a **bare assignment** to an environment variable that is not allowlisted → not read-only;
6. it contains an **unquoted variable expansion** → not read-only;
7. it contains a **Windows UNC path** → the target *asks* rather than deciding;
8. it is a compound `cd`+`git` command, or a git command that would need extra checks → not read-only;
9. every command in it passes the per-command test → **read-only**.

The **per-command test**: no writing redirect, no `/dev/tcp` or `/dev/udp` redirect, no
UNC path among the arguments, no environment variable outside the allowlist, no
dangerous argument, and the command itself is read-only.

The **read-only command tables** the target uses:

- `read` — `cd`, `ls`, `find`, `cat`, `head`, `tail`, `sort`, `uniq`, `wc`, `cut`, `paste`, `column`, `tr`, `file`, `stat`, `diff`, `awk`, `gawk`, `mawk`, `nawk`, `strings`, `hexdump`, `od`, `base64`, `nl`, `tac`, `man`, `rev`, `fold`, `expand`, `unexpand`, `fmt`, `comm`, `cmp`, `pr`, `numfmt`, `tsort`, `grep`, `egrep`, `fgrep`, `rg`, `git`, `jq`, `sha256sum`, `sha1sum`, `md5sum`;
- `create` — `mkdir`, `touch`;
- `write` — `rm`, `rmdir`, `mv`, `cp`, `sed`, `tee`;
- a **glob-safe** set — `ls`, `cat`, `head`, `tail`, `wc`, `stat`, `grep`, `egrep`, `fgrep`, `diff`, `du`, `df`, `echo`, `strings`, `hexdump`, `od`, `nl`, `cut`, `column`, `tr`, `tac`, `rev`, `cmp`, `basename`, `dirname`, `realpath`, `readlink`, `sha256sum`, `sha1sum`, `md5sum`, `cd`;
- a **pattern** set — `echo`, `claude -h`, `claude --help`, `uniq`, `pwd`, `whoami`, `node -v`, `node --version`, `python --version`, `python3 --version`, `history`, `alias`, `arch`, `ip addr`, `ifconfig`, and `jq` **unless** it is given a flag that writes or runs code.

The per-command argument rules the target applies: `ls` is read-only outright; `cd` only
with **at most one** argument; `find` is read-only **unless** an argument is `-delete`,
`-rm`, `-exec`, `-execdir`, `-ok`, `-okdir`, `-fprint0?`, `-fls`, `-fprintf` or
`-files0-from`; `git` is **not** read-only when the text contains ` -c ` or ` --exec-path=`;
`history`, `arch` and `ifconfig` only with their allowed argument shapes.

**This implementation already has the machinery**: `src/permissions/shell.ts` is the
shell lexer — the sub-commands, their redirections and their invocations — and the
classifier is built on it.

This implementation runs every tool call of a message **sequentially, in message
order**, and says so in its module header. That was recorded as an implementation
choice; it is a **divergence from an observed rule**.

**Evidence.** `/home/shiva/opt/reference-agent-rea/analysis/findings-tool-scheduling.md`,
which quotes the source: the scheduler `Rs` in `chunk-ehmvy572.js` (`canExecuteTool`,
`processQueue`, `executeTool`, `getRemainingResults`), the drain in the round loop, and
the per-tool `isConcurrencySafe` implementations in `chunk-4jsg44k7.js`.

**Files:** Modify `src/agent/loop.ts`; Modify `src/agent/dispatch.ts`; Modify
`src/tools/registry.ts`; Modify `tests/contracts/agent-loop.test.ts`; Modify
`tests/contracts/tool-registry.test.ts`.

**Interfaces:**
- Consumes: `src/agent/dispatch.ts` (`groupToolCalls`, `callsInPlan`), the tool
  registry's tool definitions.
- Produces: `isConcurrencySafe(tool, input): boolean` on a tool definition, and a
  scheduler that runs the safe calls in parallel and the unsafe ones alone.

- [ ] **Step 1: Write the failing test** — two concurrency-safe calls in one message
  **overlap** in time; a call that is not concurrency safe **never overlaps** with
  another; the next model request is issued only after **every** call has produced its
  result.
- [ ] **Step 2: Run it to verify it fails** — expected: FAIL, the calls are sequential.
- [ ] **Step 3: Read the target's read-only classifier** — the rule that decides whether
  a shell command is read-only, and the reason it reports when it is not. It is a
  **source reading**, and it is recorded before any code is written.
- [ ] **Step 4: Add the flag** to the tool definitions and to the registry's contract —
  the built-in tools get the flags the target uses, and a tool that does not declare the
  flag is **not** concurrency safe.
- [ ] **Step 5: Implement the classifier** and the Bash flag — a command the classifier
  calls read-only is concurrency safe; one it does not is not, and the reason is
  reported.
- [ ] **Step 6: Implement the scheduler** — a queue that starts the safe calls in
  parallel, breaks at the first unsafe call, and resumes when it finishes; the turn
  waits for **all** the results before it issues the next request.
- [ ] **Step 7: Run it to verify it passes** — expected: PASS.
- [ ] **Step 8: Update the module header** — the "sequential, in message order" note
  becomes the observed rule, with the per-tool flags.
- [ ] **Step 9: Commit.**
  ```bash
  git add src/agent src/tools tests/contracts/agent-loop.test.ts tests/contracts/tool-registry.test.ts
  git commit -m "fix(agent): the concurrency-safe tool calls of one message run in parallel"
  ```

**Note.** The compatibility harness measures the clone and reports the outcome; this
task must not edit `docs/compatibility/results.md` or `tests/compatibility/**` — the
orchestrator owns those and will update the totals when the harness reports.

### CC-011 — MCP and the control surface

**Files:** Create `src/extensions/mcp/client.ts`, `src/extensions/mcp/manager.ts`, `src/extensions/mcp/control.ts`; Create `tests/contracts/mcp-manager.test.ts`, `tests/contracts/mcp-control.test.ts`. (Amended during `CC-011`: `client.ts` was split into one-responsibility modules — `protocol`, `records`, `timeouts`, `transport`, `peer`, `negotiation`, `connection`, `config`, `capabilities`, `composition`, `fetch-variants`, `auth` — with every previous export still available from `client.ts`.)

**Interfaces:**
- Consumes: `src/provider/registry.ts` (`ProviderRegistry`), `src/tools/registry.ts` (`ToolRegistry`).
- Produces:
  ```ts
  export type McpServerType = 'stdio' | 'sdk' | 'http' | 'sse';
  export interface McpServerConfig { name: string; type: McpServerType; command?: string; args?: string[]; env?: Record<string, string>; url?: string; cwd?: string; }
  export interface McpServerState { name: string; status: 'connecting' | 'ready' | 'failed' | 'disabled'; tools: { name: string; title?: string }[]; error?: string; }
  export interface McpManager {
    connect(config: McpServerConfig): Promise<McpServerState>;
    disconnect(name: string): Promise<void>;
    states(): readonly McpServerState[];
    toolsFor(name: string): { name: string; title?: string }[];
  }
  export const LOCAL_CONNECT_BATCH_SIZE = 3;
  export const REMOTE_CONNECT_BATCH_SIZE = 20;
  export const CONTROL_REQUEST_SUBTYPES: readonly string[];
  export type ControlRequestSubtype = typeof CONTROL_REQUEST_SUBTYPES[number];
  export interface ControlCallbacks {
    onMcpAuthenticate?: (req: { redirectUri?: string }) => Promise<unknown>;
    onMcpOauthCallbackUrl?: (req: { callbackUrl?: string }) => Promise<unknown>;
    onMcpReconnect?: (req: unknown) => Promise<unknown>;
    onPermissionRequest?: (req: unknown, requestId: string) => void;
    onMessage?: (msg: unknown) => void;
  }
  export function dispatchControlRequest(req: { subtype: string; request_id: string }, cb: ControlCallbacks): Promise<{ subtype: 'success' | 'error'; response?: unknown; error?: string }>;
  export function dispatchCanUseTool(req: { request_id: unknown; tool_name: string; input: unknown; description?: string; decision_reason?: string }, cb: ControlCallbacks): Promise<{ dropped: boolean; reason?: string }>;
  ```

**Two dispatchers, not one.** The target's REA evidence contains **two distinct** control-request dispatchers, and the plan must not conflate them. The **host dispatcher** handles exactly the 23 subtypes listed above; `can_use_tool` is *not* one of them, because the target's own directional-policy table classifies `can_use_tool` as "agent-originated and cannot be sent by a host". The **transport permission dispatcher** is a separate component that receives `can_use_tool` requests arriving from a remote peer, and it has its own validation and deduplication rules. `dispatchControlRequest` and `dispatchCanUseTool` model the two separately.

**Protocol note — negotiate modern first.** The current MCP revision is `2026-07-28`, which is **stateless**: it retires the `initialize`/`initialized` handshake and the `Mcp-Session-Id` header, adds `server/discover` and `subscriptions/listen`, and carries protocol version, client identity, and capabilities in `_meta` on every request. This implementation must therefore **probe for the modern revision first** and fall back to the legacy `initialize` handshake only when the server does not support it — the target's own changelog records local stdio connections negotiating `2026-07-28` by default, with `MCP_PROTOCOL_NEGOTIATION=legacy` as the opt-out. This implementation provides the same opt-out. Two different version-error contracts must both be implemented: an invalid or missing `MCP-Protocol-Version` **header** on an HTTP transport is an HTTP `400 Bad Request` (server side), while an unsupported declared version is a JSON-RPC error `-32022` (`UnsupportedProtocolVersionError`) carrying a `supported` list, which the client then retries (client side). Neither may hang.

- [x] **Step 1: Write the failing manager test** — connecting a stdio server spawns the configured command with `shell: false`, pipes stdin/stdout, and marks the server `ready`; a server that exits during `tools/list` is marked `failed` with an error and does not block other servers.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement `src/extensions/mcp/client.ts`** and `manager.ts`.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing batching test** — connecting four local servers issues at most `LOCAL_CONNECT_BATCH_SIZE` (3) concurrent spawns; remote servers use `REMOTE_CONNECT_BATCH_SIZE` (20).
- [x] **Step 6: Implement the batch scheduler** in `manager.ts`.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing control test** — `dispatchControlRequest` handles each of the 23 host subtypes and rejects `can_use_tool` as a host-originated request; for `mcp_authenticate` with no `onMcpAuthenticate` registered it returns `{ subtype: 'error', error: 'mcp_authenticate is not supported in this context (callback not registered)' }`. Separately, `dispatchCanUseTool` with a `request_id` that is not a string drops the request with **no response**, because no response is possible.
- [x] **Step 9: Implement `src/extensions/mcp/control.ts`** with the closed subtype list and the callback-absence error text.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Commit.**
  ```bash
  git add src/extensions/mcp tests/contracts/mcp-manager.test.ts tests/contracts/mcp-control.test.ts
  git commit -m "feat(mcp): server manager and control-request surface"
  ```

### CC-009d — The session lookup's ordering and skip rules

**Why this task exists.** The REA's session-lookup residual was closed by source
reading, and the target's rule is richer than the one this implementation has. The
compatibility report called the clone's behaviour a *labelled implementation choice*; it
is a **divergence from an observed rule**.

**The target's rule.**

- The lookup lists the sessions of the current project directory, runs each candidate
  through a filter, and takes the **first** survivor.
- The candidates it **skips** are: **bookkeeping-only** sessions; **sidechain** sessions;
  **team** sessions; the `daemon` and `daemon-worker` session kinds; **SDK** sessions
  (the entrypoint is `sdk-cli`, `sdk-ts` or `sdk-py`, unless the current process is
  itself an SDK entrypoint); **`/loop`** slash-command sessions; a session whose recorded
  working directory is a **different directory with the same project slug**;
  **superseded** sessions; and a session that is **live in the background** — that one is
  *reported* through the background callback rather than continued.
- When the live-session list cannot be read, the rule changes shape: **every** session
  carrying a session kind or a continued-in id is skipped instead.
- The **sort key** is the session file's **modification time, descending**, tie-broken by
  the **creation time, descending**. There is no sequence number.

**This implementation's divergence.** It sorts by the **last record's** timestamp and skips
none of the candidates.

**Note.** The audit used to guess that the lookup skipped *headless* and *slash-command*
sessions. It skips neither in that way: a print session is marked only by its entrypoint,
and the only entrypoint filter is the SDK set, so **no** code excludes a `--print`
session; and the only slash-command exclusion is `/loop`. A **finished** background
session is still a candidate.

**Files:** Modify `src/session/store.ts`; Modify `src/session/resume.ts`; Modify
`tests/contracts/session-store.test.ts`; Modify `tests/contracts/session-resume.test.ts`;
Modify `docs/compatibility/session-format.md`.

**Interfaces:**
- Consumes: `src/session/store.ts` (the session listing and the summary), the session
  record's fields.
- Produces: `isResumableCandidate(summary, options): boolean` — the target's skip rules —
  and the **file mtime, then creation time** ordering.

- [ ] **Step 1: Write the failing test** — a bookkeeping-only, a sidechain, a team, a
  `daemon`, an SDK-entrypoint and a `/loop` session are **not** candidates; a live
  background session is **reported** rather than continued; and two sessions are ordered
  by the file's modification time, then its creation time.
- [ ] **Step 2: Run it to verify it fails** — expected: FAIL.
- [ ] **Step 3: Implement the skip rules** and the ordering.
- [ ] **Step 4: Run it to verify it passes** — expected: PASS.
- [ ] **Step 5: Update the conformance document** — the row's outcome and the text.
- [ ] **Step 6: Commit.**
  ```bash
  git add src/session tests/contracts/session-store.test.ts tests/contracts/session-resume.test.ts docs/compatibility/session-format.md
  git commit -m "fix(session): the session lookup skips what the target skips"
  ```

### CC-011b — The subagent definition lifecycle and the standalone skill scan

**Why this task exists.** The REA's extension-lifecycle residual was closed by source
reading, and the target's rules are now known. The compatibility report called both of
this implementation's surfaces *entirely its own*; they are now **observed**, and they
diverge.

**The target's rules.**

*The subagent definition lifecycle.*

- A subagent is a **markdown file with YAML frontmatter**, named `<name>.md`, inside an
  **`agents/` directory**. The target states the two user-facing locations itself:
  `.claude/agents/` for the project, and `~/.claude/agents/` for all projects; the
  managed and the plugin `agents/` directories are read too.
- Discovery is a **recursive `*.md` scan** of each `agents/` directory, with a bounded
  timeout, following symlinks and skipping a directory it has already visited.
- Parsing requires a `name` **and** a `description`; a file without the description is
  refused by name.
- **Nothing is persisted.** The raw scan and the parsed catalogue are memoised per
  process and dropped on a file-watch event, on the `/agents` command and on a plugin
  reload. Across a **restart** everything is re-read from disk, and a resumed session's
  main-thread agent is **reconstructed by name** against the freshly read catalogue — the
  target says so when the agent is no longer available.
- Invocation is the `Task` tool: it resolves the requested type against the active agent
  list and calls the definition's system prompt.

*The standalone skill directory scan.*

- Five roots are read: the **managed** directory, the **user** directory
  (`~/.claude/skills`), the **synced** subtree beneath it, every **project** ancestor's
  `.claude/skills`, and each **additional working directory**'s `.claude/skills`.
- The scan of a root is a **single `readdir`** — **depth 1, not recursive**. Each entry
  must be a directory or a symlink, and the skill file is the **fixed name `SKILL.md`**
  directly inside it.
- **Skipped:** an entry that is not a directory; the reserved entry name `synced`; an
  entry whose name contains `:` in the synced scan; an entry whose plugin is disabled; a
  `SKILL.md` that is not a regular file; a `SKILL.md` over **1 000 000 bytes**; and any
  file that fails to read or parse.
- The result is cached per process and invalidated by the same reload path the agent
  catalogue uses.

**Files:** Modify `src/extensions/skills/registry.ts`; Modify
`src/extensions/agents/` (or wherever the subagent definitions are read); Modify
`tests/contracts/extensions.test.ts`; Modify `docs/compatibility/extension-surface.md`.

**Interfaces:**
- Consumes: `src/extensions/skills/registry.ts` (`SkillRoot`, the registry), the
  subagent-definition reader.
- Produces: the target's **skip rules** for the skill scan, and a subagent catalogue that
  is **re-read across a restart** and **reconstructed by name** on resume.

- [ ] **Step 1: Write the failing test** — a `SKILL.md` over 1 MB, one that is not a
  regular file, an entry named `synced` and a disabled plugin's entry are **skipped**; a
  subagent definition without a `description` is **refused by name**; a definition
  changed on disk is **re-read**.
- [ ] **Step 2: Run it to verify it fails** — expected: FAIL.
- [ ] **Step 3: Implement the skill scan's skip rules.**
- [ ] **Step 4: Implement the subagent catalogue's lifecycle** — the recursive scan, the
  `name`+`description` requirement, the reload, and the by-name reconstruction on resume.
- [ ] **Step 5: Run it to verify it passes** — expected: PASS.
- [ ] **Step 6: Update the conformance document.**
- [ ] **Step 7: Commit.**
  ```bash
  git add src/extensions tests/contracts/extensions.test.ts docs/compatibility/extension-surface.md
  git commit -m "fix(extensions): the skill scan and the subagent catalogue match the target"
  ```

### CC-012 — Hooks

**Files:** Create `src/extensions/hooks/registry.ts`, `src/extensions/hooks/runner.ts`, `src/extensions/hooks/schema.ts`; Create `tests/contracts/hooks.test.ts`.

**Interfaces:**
- Consumes: `src/permissions/decision.ts` (`PermissionDecision`), `src/session/event.ts` (`SessionEvent`).
- Produces:
  ```ts
  export const HOOK_EVENTS: readonly string[];
  export type HookEvent = typeof HOOK_EVENTS[number];
  export type HookExecutionClass = 'runs_locally' | 'later' | 'low_value' | 'container_internal';
  export interface HookSpec { event: HookEvent; matcher?: string; command: string; timeoutMs?: number; type?: 'command' | 'mcp_tool'; server?: string; }
  export interface HookResult { hookEventName: HookEvent; additionalContext?: string; retry?: boolean; decision?: { behavior: 'allow' | 'deny'; reason?: string }; continue?: boolean; stopReason?: string; }
  export interface HookRegistry { register(spec: HookSpec): void; for(event: HookEvent): HookSpec[]; }
  export async function runHooks(specs: HookSpec[], event: HookEvent, input: unknown, signal?: AbortSignal): Promise<HookResult[]>;
  export function matchToolName(matcher: string, toolName: string): boolean;
  ```

**Design note.** The target's hook surface has three parts that this implementation must keep distinct: a set of **decision-capable** events, a per-event **execution classification** (locally / later / low-value / container-internal), and the **handler types** (`command`, `http`, `mcp_tool`, `prompt`, `agent`). The exit-code contract matters more than the event list: `0` is success and applies the JSON output, `2` is a blocking error on a blockable event, and anything else is a non-blocking error. A `PreToolUse` hook returning `allow` must **not** override a deny or ask rule, and a hook returning `deny` must hold in every mode including `bypassPermissions` — the target changed this behaviour in a later release without a deprecation warning, so this implementation must pick one and document it. Note also that two of the names the target's static analysis surfaced (`StatusLine`, `FileSuggestion`) are **settings-level display handlers, not hook events**; this implementation must not treat them as decision points.

- [x] **Step 1: Write the failing registry test** — `HOOK_EVENTS` contains exactly the 33 decision-capable and surfaced events; `register` then `for('PreToolUse')` returns only that event's hooks; a `mcp_tool` hook carrying a `server` is discoverable by server; `StatusLine` and `FileSuggestion` are **not** in `HOOK_EVENTS`.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement `src/extensions/hooks/registry.ts`** with the closed event list from Global Constraints and an explicit `displayHandler` list kept separate.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing matcher test** — a matcher containing only letters, digits, `_`, `-`, space, `,` and `|` is an **exact-string** match (or `|`-separated alternatives); any other matcher is an **unanchored JavaScript regular expression**. `matchToolName('Edit|Write', 'Write')` is true; `matchToolName('*', 'Bash')` is true; `matchToolName('Edit', 'Read')` is false; a matcher containing a character outside the allowed set is rejected.
- [x] **Step 6: Implement `matchToolName`** in `src/extensions/hooks/schema.ts` with the two-mode semantics, and reject a malformed matcher rather than silently treating it as a literal.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing runner test** — a `PermissionRequest` hook returning `decision.behavior === 'deny'` blocks the tool call; a hook returning `allow` does **not** override a deny or ask rule; a hook with severity `stop` denies all tool calls for the session; a hook that exits non-zero with something other than `2` produces a notice and leaves the session usable; exit code `2` on a blockable event blocks.
- [x] **Step 9: Implement `src/extensions/hooks/runner.ts`** with the exit-code contract and the deny > defer > ask > allow combination order.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Commit.**
  ```bash
  git add src/extensions/hooks tests/contracts/hooks.test.ts
  git commit -m "feat(hooks): hook registry, matchers, runner"
  ```

### CC-013 — Skills, subagents, plugins, marketplaces, IDE

**Files:** Create `src/extensions/skills/`, `src/extensions/subagents/`, `src/extensions/plugins/`, `src/integration/ide/`; Create `tests/contracts/extensions.test.ts`.

**Interfaces:** Consumes: `src/tools/registry.ts`, `src/extensions/hooks/registry.ts`. Produces: `SkillRegistry`, `SubagentRegistry`, `PluginManager`, `IdeBridge` with `list()`, `resolve(name)`, and `apply()` contracts; each returns items whose `source` is the discovery origin (project, local, user, plugin, mcp).

- [x] **Step 1: Write the failing discovery test** — a skill in a project `.claude/skills` directory is discovered and its source is `project`; a skill in `~/.claude/skills` has source `user`; a plugin-provided skill has source `plugin`; an MCP-provided skill has source `mcp`.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement the four registries** with a shared `discover()` shape returning `{ name, source, path }`.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing override test** — a local skill override of a synced skill is reported with `own: false` and the sync source is preserved, matching the target's `skillOverrides` behavior.
- [x] **Step 6: Implement the override resolution** using `MERGED_KEY_ORDER` from `src/config/tiers.ts`.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Commit.**
  ```bash
  git add src/extensions src/integration tests/contracts/extensions.test.ts
  git commit -m "feat(extensions): skills, subagents, plugins, IDE bridge"
  ```

### CC-013b — The collision semantics of a contributed name

**Why this task exists.** The `CC-013` review found that a plugin skill or subagent name that two **plugins** provide is **collided**: the first declared wins, the losers are named, and the resolved record carries `collidesWith`. A later review found two things wrong with it:

1. `collidesWith` lists the **winner's own** provider beside itself — `provider: 'demo', collidesWith: ['demo']` — so a real conflict between two different plugins cannot be told apart from **one** plugin packaging the same name twice, which is a different situation (a packaging bug, not a conflict) and which the warning itself now distinguishes.
2. The manager's `apply(plugin)` path never reported a collision at all: two `skills` directories in one plugin yielded two entries and no log.

**Files:** Modify `src/extensions/skills/registry.ts`; Modify `src/extensions/subagents/registry.ts`; Modify `src/extensions/plugins/registry.ts`; Modify `tests/contracts/extensions.test.ts`.

**Interfaces:** Consumes: the same registries as `CC-013`. Produces: a `collidesWith` that names the **other** providers, or is empty when the collision is one plugin's own duplication; a collision report on the `apply()` path.

- [x] **Step 1: Write the failing test** — one plugin that provides the same skill name twice reports the duplication with its **two paths**, and `collidesWith` names no provider; two plugins that provide the same name report the conflict with both providers.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement the semantics** — the field must distinguish the two situations, and the **same-source filter** and the **dedupe** must each be pinned.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing `apply()` test** — `PluginManager.apply(plugin)` on a plugin with two `skills` directories reports the duplication and yields **one** entry.
- [x] **Step 6: Implement the report** on the `apply()` path.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Commit.**
  ```bash
  git add src/extensions tests/contracts/extensions.test.ts
  git commit -m "fix(extensions): a contributed name's collision says what collided"
  ```

### CC-014 — CLI, headless mode, and output contracts

**Files:** Create `src/cli/args.ts`, `src/cli/command.ts`, `src/cli/headless.ts`, `src/cli/output.ts`; Create `tests/contracts/cli-surface.test.ts`.

**Interfaces:** Consumes: `src/agent/loop.ts` (`createAgentRuntime`), `src/session/store.ts`. Produces: `parseArgs(argv: string[]): ParsedArgs`, `runCommand(parsed: ParsedArgs): Promise<number>`, `runHeadless(opts: HeadlessOptions): AsyncIterable<HeadlessEvent>`.

- [x] **Step 1: Write the failing args test** — `--print`/`-p` takes one prompt argument, `--continue` and `--resume <id>` are mutually exclusive, `--output-format json|text|stream-json` is validated, and an unknown flag is an error with exit code 2.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement `src/cli/args.ts`** with a discriminated-union result.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing headless test** — `--print` with `--output-format json` writes exactly one JSON document to stdout and exits 0 on success, non-zero on a provider error; `--output-format stream-json` writes one JSON object per event.
- [x] **Step 6: Implement `src/cli/headless.ts`** and `output.ts`.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Commit.**
  ```bash
  git add src/cli tests/contracts/cli-surface.test.ts
  git commit -m "feat(cli): argument parsing, headless mode, output contracts"
  ```

### CC-015 — Interactive terminal UI

**Files:** Create `src/ui/app.ts`, `src/ui/render/messages.ts`, `src/ui/render/prompts.ts`, `src/ui/render/markdown.ts`; Create `tests/contracts/ui-render.test.ts`.

**Interfaces:** Consumes: the same domain interfaces as the headless path — the UI is a renderer over the runtime, not a second implementation. Produces: `renderMessages(events: SessionEvent[]): string[]`, `renderApprovalPrompt(decision: PermissionDecision, toolName: string): string`, `renderMarkdown(md: string): string`.

**Design note (library choice).** Ink 8 is the only viable option on Node 24: OpenTUI requires Node ≥ 26.4.0, and `blessed` has been unmaintained since 2015. Ink is also the only candidate with a real screen-reader story (`INK_SCREEN_READER=true` plus an ARIA subset), which matters because the target is expected to be usable with a screen reader. Three known Ink behaviours shape the implementation: the default `maxFps` is 30 and `incrementalRendering` is opt-in and off by default, so a streaming turn must enable it or it will re-render the whole frame at 30 Hz; Ink has **no** built-in markdown, so markdown rendering is this implementation's own job (the maintained option is `markdansi`, not the stale `ink-markdown`); and Ink redraws the whole visible terminal on every state change, so a full-screen TUI loses terminal scrollback. The target's own CLI is a scrollback-append TUI, so this implementation must **not** use Ink's alternate-screen mode — otherwise `/clear` semantics, terminal search, and scrollback all diverge from the target.

- [x] **Step 1: Write the failing render test** — `renderMessages` produces one block per assistant message, one per tool call with its result, and marks a denied tool call with its decision source and reason type.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement the renderers** as pure functions over session events.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing markdown test** — a partially-streamed markdown fragment renders as text rather than throwing or dropping the fragment; a fenced code block renders with its language preserved.
- [x] **Step 6: Implement `src/ui/render/markdown.ts`** using `markdansi` (or an equivalent), tolerating an incomplete fragment.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing screen-reader test** — with `INK_SCREEN_READER=true`, the rendered tree exposes an ARIA role and label for the message list, the input, and the approval prompt.
- [x] **Step 9: Implement the ARIA attributes** in `src/ui/app.ts`.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Write the failing scrollback test** — the app does **not** enter the alternate screen, so content written before the session start remains in the terminal's scrollback.
- [x] **Step 12: Implement the app shell** without `alternateScreen`, with `incrementalRendering` enabled and `maxFps` tuned for streaming.
- [x] **Step 13: Run it to verify it passes** — expected: PASS.
- [x] **Step 14: Commit.**
  ```bash
  git add src/ui tests/contracts/ui-render.test.ts
  git commit -m "feat(ui): interactive renderer over the shared runtime"
  ```

### CC-015b — The UI's strip-per-path sensitivity

**Why this task exists.** The `CC-015` re-review confirmed the control-sequence stripping is **correct and present on every path**, and that each of the seven claimed paths has a **distinct** named test that fails when that path's strip is removed. It found two gaps in the **test's sensitivity**, not in the shipped behavior:

1. substituting a **weaker** scanner — a CSI-only regex — at two of the block renderer's three strip sites leaves the suite green, because the hostile inputs at those two sites are CSI-only;
2. **five** further strip sites' removal is **masked** by the layer next door.

**Files:** Modify `src/ui/render/messages.ts`; Modify `src/ui/render/prompts.ts`; Modify `tests/contracts/ui-render.test.ts`.

- [x] **Step 1: Write the failing test** — a hostile input that carries an **OSC** sequence (not only a CSI one) reaches each of the strip sites, and a **weaker** scanner substituted at any one of them is caught.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL for the two sites the review named.
- [x] **Step 3: Widen the hostile inputs** at every strip site so the OSC form is covered, and give each of the five masked sites its **own** named test.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Verify the shared scanner is still the only one** — a second, weaker scanner anywhere in the renderers must fail a test.
- [x] **Step 6: Commit.**
  ```bash
  git add src/ui tests/contracts/ui-render.test.ts
  git commit -m "test(ui): every strip site carries a hostile input of its own"
  ```

### CC-014b — The interactive session host

**Why this task exists.** The Ink terminal UI was built in `CC-015` — the renderers, the ARIA roles and labels, the app shell — and it is **correct**, but **nothing mounts it**. `renderApp` has no production caller and `src/cli/command.ts` refuses an interactive run with *"The interactive terminal UI is not implemented here yet."* This implementation is therefore **headless-only in practice**, which is the largest functional gap between it and the product the plan describes.

**Files:** Create `src/cli/interactive.ts`; Modify `src/cli/command.ts`; Modify `src/cli/args.ts`; Create `tests/contracts/interactive-session.test.ts`.

**Interfaces:**
- Consumes: `src/ui/app.ts` (`renderApp`, `AppProps`, `PendingApproval`), `src/ui/render/messages.ts` (`renderConversation`), `src/agent/loop.ts` (`AgentRuntime`, `AgentRuntimeDeps.approveAsk`), `src/session/store.ts` (`createSessionStore`, `readAllSessionEvents`), `src/cli/commands/manager.ts` (`isManagerCommand`, `runManagerText`), `src/cli/args.ts` (`ParsedRunArgs`).
- Produces: `runInteractiveSession(parsed: ParsedRunArgs, context: InteractiveContext): Promise<number>` in `src/cli/interactive.ts`; `CommandOptions.runInteractive` is **defaulted** to it, so an interactive run works without a caller supplying the seam.

- [ ] **Step 1: Write the failing test** — an interactive session **mounts the app**, a submitted line **runs a turn**, the turn's records appear in the app's `events`, and a tool call that needs approval **raises the app's approval prompt** and the user's answer **decides the call**.
- [ ] **Step 2: Run it to verify it fails** — expected: FAIL, the interactive host does not exist.
- [ ] **Step 3: Implement the host** in `src/cli/interactive.ts` — it **owns the state** the controlled app renders: the session's records, the typed line, the pending approval and the status line. It mounts the app, and it drives a turn on submit.
- [ ] **Step 4: Run it to verify it passes** — expected: PASS.
- [ ] **Step 5: Write the failing approval test** — a tool call the rules do not cover reaches the app's approval prompt **with the tool's name and the decision's reason**, and the user's answer **resolves the call**; a denial is a denial.
- [ ] **Step 6: Implement the approval bridge** — the runtime's `approveAsk` seam is how the host learns that a call is pending and how the user's answer reaches it. The bridge must not deadlock: a turn that waits for an answer must be able to re-render the app while it waits.
- [ ] **Step 7: Run it to verify it passes** — expected: PASS.
- [ ] **Step 8: Write the failing slash-command test** — a line beginning with `/provider` or `/catalog` runs the manager instead of the model, and any other line is a prompt.
- [ ] **Step 9: Implement the slash command** — the manager's own helpers (`isManagerCommand`, `runManagerText`) already exist and are tested; the host calls them.
- [ ] **Step 10: Run it to verify it passes** — expected: PASS.
- [ ] **Step 11: Default the seam** in `src/cli/command.ts` — an interactive run uses the host unless the caller supplies its own `runInteractive`. The current refusal message becomes the fallback **only** when the app cannot mount (no TTY).
- [ ] **Step 12: Commit.**
  ```bash
  git add src/cli tests/contracts/interactive-session.test.ts
  git commit -m "feat(cli): the interactive session host"
  ```

**Design note.** The app is **controlled** — it takes `events`, `input`, `approval` and `status` as props and calls back — so the host is a small state machine over the session, and the Ink instance is a view of it. The turn runs while the app is mounted, so the host must be able to re-render **during** a turn: the approval is the case that matters, because the runtime waits for the user's answer mid-turn.

**Implementation choices.** The target's own interactive behavior — the prompt's wording, the keybindings, the layout — is **not** observed by the audit, so every one of them is a implementation choice and must be labelled as such in the module header.

### CC-016 — Provider manager surfaces (`/provider`, catalog browsing)

**Files:** Create `src/cli/commands/provider.ts`, `src/cli/commands/catalog.ts`, `src/ui/modals/providerPicker.ts`; Create `tests/contracts/provider-command.test.ts`.

**Interfaces:** Consumes: `src/provider/registry.ts`, `src/provider/catalog.ts`. Produces: `providerCommand(args: string[], registry: ProviderRegistry): Promise<CommandResult>` supporting `list`, `add`, `remove`, `use`, `test`; `catalogCommand(args: string[], registry: ProviderRegistry): Promise<CommandResult>` supporting `list`, `search`, `show`.

- [x] **Step 1: Write the failing command test** — `provider list` prints one row per connection with its id, name, route, base URL, and credential *status*; the output contains no credential value even when the underlying env var is set.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement `src/cli/commands/provider.ts`**.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing catalog test** — `catalog list` groups by family and shows the per-route model ids; `catalog search <query>` filters by id and display name; a model not served by the active route is shown as unavailable for that route rather than hidden.
- [x] **Step 6: Implement `src/cli/commands/catalog.ts`**.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing non-interactive test** — the same operations are available as `--provider list` style non-interactive flags with machine-readable output.
- [x] **Step 9: Implement the non-interactive form** and the `src/ui/modals/providerPicker.ts` picker.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Write the failing catalog-refresh test** — a catalog refresh that changes a model's provider ids **must not** change a connection's id, name, route, or credential reference; a user override of a catalog-owned field survives the refresh.
- [x] **Step 12: Implement the refresh contract** with the catalog and the connection table as separate records, so a refresh can rewrite catalog-owned metadata but never routing identity or a credential reference.
- [x] **Step 13: Run it to verify it passes** — expected: PASS.
- [x] **Step 14: Write the failing partial-credential test** — a connection whose credential cannot be resolved is reported as unusable **for that connection only**, and the other connections are unaffected; the active-connection resolution refuses to select an unusable one and names it in the error.
- [x] **Step 15: Implement the per-connection failure isolation** and the active-connection error message.
- [x] **Step 16: Run it to verify it passes** — expected: PASS.
- [x] **Step 17: Commit.**
  ```bash
  git add src/cli/commands src/ui/modals tests/contracts/provider-command.test.ts
  git commit -m "feat(provider): manager command and catalog browsing"
  ```

### CC-017 — Platform sandbox and native parity

**Files:** Create `src/platform/sandbox/policy.ts`, `src/platform/sandbox/launcher.ts`, `src/platform/sandbox/landlock.ts`, `src/platform/sandbox/seccomp.ts`, `src/platform/sandbox/proxy.ts`; Create `tests/security/sandbox.test.ts`.

**Interfaces:** Consumes: `src/tools/builtins/bash.ts` (the `Bash` tool). Produces: the `SandboxPolicy` type and the `DEFAULT_SANDBOX_POLICY` constant, with `enabled`, `enabledPlatforms`, `failIfUnavailable`, `allowUnsandboxedCommands`, `excludedCommands` and `filesystem`; `evaluateSandbox(policy, platform, command, availability): { decision: 'allow' | 'deny' | 'unconfined'; reason?: string; exemptions: readonly string[] }` — the fourth argument is **required** and carries the backend's real availability, so a host with no backend can never be reported as available by default; `launchSandbox(spec): { pid: number; cleanup(): Promise<void> }` with a `SandboxStatus` that reports `sandboxed` from the backend's **establishment report** (not a constant), the `exemptions` that were applied, the `enforcement` probe (the binary's version and setuid bit), and the `layers` actually in force. `readSandboxPolicy(document)` reads the `sandbox` block out of a merged settings document. (Amended after the first review round: the policy was originally exported three ways under the name `sandboxPolicy`; it now has one type name and one constant name, and the availability argument is explicit.)

**Design note — the enforcement boundary.** The target's own helper is a seccomp user-notification supervisor that reads the target's path arguments with `process_vm_readv` and resolves them with `readlinkat`. The kernel's own documentation says that this pattern **cannot be a security policy**: the target can rewrite pointer arguments while blocked waiting for the supervisor's response, and the UAPI header states outright that the seccomp notifier "cannot be used to implement a security policy."

**The target's supervisor is confirmed to observe rather than deny.** Its 27-record dispatch table is decoded: the records are `{u64 nr; u64 name_ptr; u8 meta[8]}`, the metadata bytes are argument indices (path, second path, flags/mode, dirfd, second dirfd) with `0xff` meaning "absent", and the intercepted syscalls are the path-taking filesystem calls. The response struct is written exactly three times - `memset(resp, 0, 24)`, `resp.id = notif.id`, and one 4-byte flags store - and **`resp.error` is never written**, so it stays `0`, which the kernel defines as "allow the system call to execute". Every intercepted syscall is therefore **permitted**; the supervisor resolves the path and logs it as a JSON line. The target's sandbox boundary is the namespace/mount/`PR_SET_NO_NEW_PRIVS` isolation established *before* the filter is installed, not the supervisor. This implementation therefore implements **five layers**, and the seccomp-notify supervisor is layer 5 — **observability and emulation, not enforcement**:
1. **Filesystem boundary** — a mount namespace plus user namespace with `PR_SET_NO_NEW_PRIVS`, every bind explicitly read-only or read-write, and **protected paths masked with a tmpfs rather than relying on an absent bind target** (a read-only bind on a path that does not exist is a no-op, which is exactly how the target's CVE-2026-25725 injected persistent hooks).
2. **Syscall surface** — a seccomp-BPF denylist that unconditionally blocks `ptrace`, `process_vm_readv`/`process_vm_writev`, `io_uring_setup`/`io_uring_register`/`io_uring_enter`, `bpf`, `mount`, `pivot_root`, and `setns` into foreign namespaces. Blocking `io_uring_setup` is the only reliable defense against the io-wq class, where worker threads bypass `seccomp_run_filters()` entirely.
3. **Path policy** — Landlock where ABI ≥ 1, bound to `O_PATH` descriptors rather than path strings, so a rename, symlink, or bind mount cannot walk a rule to a different object. **On the reference host (WSL2, kernel 6.6) Landlock reports ABI 3**: filesystem rights only, with no TCP/UDP network rights and no `LANDLOCK_SCOPE_*`. Network control must therefore come from layer 4, never from Landlock.
4. **Network** — remove the network namespace entirely and route through a host-side HTTP/SOCKS proxy over bind-mounted Unix sockets. The proxy enforces the domain allowlist, resolves and pins the address, and blocks loopback, link-local, and cloud-metadata ranges.
5. **Supervisor** — the seccomp-notify supervisor observes and emulates path-taking syscalls. Every path it authorizes must be re-checked against layers 1–3, and every read of target memory must be separated from its use by a `SECCOMP_IOCTL_NOTIF_ID_VALID` re-check. It must never `CONTINUE` a call whose arguments it read from target memory without that re-check.

**Residual risk to state plainly.** All five layers share one kernel; any kernel privilege-escalation reachable from the sandbox defeats every layer, and user namespaces widen that reachable surface. Only a microVM moves the boundary below the kernel. This implementation's documentation must say so rather than imply a stronger guarantee than it has.

- [x] **Step 1: Write the failing policy test** — `enabledPlatforms` excluding the current platform denies with the reason naming the platform; `enabled: false` denies; `failIfUnavailable: false` runs the shell unconfined but says so; `allowUnsandboxedCommands: true` and a matching `excludedCommands` entry runs unconfined; a non-matching command is sandboxed.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement `src/platform/sandbox/policy.ts`** with the exact reason strings the target uses.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing launcher test** — the `Bash` tool refuses to run when the sandbox is required and unavailable, unless `failIfUnavailable: false` is set; a protected path that does **not** exist at startup is still masked, so a sandboxed process cannot create it.
- [x] **Step 6: Implement the sandbox launcher** on Linux: user and mount namespaces, `PR_SET_NO_NEW_PRIVS`, an explicit read-only bind for the working tree, tmpfs masks over the protected configuration paths, and a seccomp-BPF filter with the denylist above.
- [x] **Step 7: Run it to verify it passes** — expected: PASS.
- [x] **Step 8: Write the failing Landlock test** — a rule bound to a path is not walked by a later rename or a symlink swap; the launcher degrades gracefully when `landlock_create_ruleset` reports an ABI below the required level, and reports the reduced protection in its status rather than pretending.
- [x] **Step 9: Implement `src/platform/sandbox/landlock.ts`** with ABI feature detection and an explicit reduced-protection status.
- [x] **Step 10: Run it to verify it passes** — expected: PASS.
- [x] **Step 11: Write the failing supervisor test** — the supervisor re-validates a notification id immediately before acting on arguments it read from target memory, and it never authorizes a path that layers 1–3 would deny.
- [x] **Step 12: Implement `src/platform/sandbox/seccomp.ts`** as observability and emulation, with the `ID_VALID` re-check enforced immediately before use.
- [x] **Step 13: Write the failing proxy test** — the proxy refuses a request to a loopback, link-local, or cloud-metadata address, and refuses a hostname whose resolved address is not in the allowlist.
- [x] **Step 14: Implement `src/platform/sandbox/proxy.ts`**.
- [x] **Step 15: Run it to verify it passes** — expected: PASS.
- [x] **Step 16: Commit.**
  ```bash
  git add src/platform tests/security/sandbox.test.ts
  git commit -m "feat(platform): layered sandbox policy, launcher, and supervisor"
  ```

### CC-018 — Packaging, installation, and update

**Files:** Create `scripts/build.ts`, `package.json` (build scripts), `docs/compatibility/packaging.md`; Create `tests/compatibility/packaging.test.ts`.

**Interfaces:** Consumes: the whole `src/` tree. Produces: a build that emits a self-contained executable and a documented install path.

- [x] **Step 1: Write the failing packaging test** — the built executable starts, prints its version, and runs `--print` against a fake driver; the build emits a single file with no runtime dependency on the host's Node.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL, no build script.
- [x] **Step 3: Implement the build** with `bun build --compile`, and re-validate every `node:` API the code uses under Bun — in particular `node:sqlite` is unavailable (Bun has `bun:sqlite`), which is why the session store is JSONL and not SQLite.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Write the failing install test** — the installed binary creates its configuration directory with restrictive permissions, and the first run reports the configuration directory it will use.
- [x] **Step 6: Implement the install path**, including a `CLAUDE_CONFIG_DIR`-style relocation and a first-run report.
- [x] **Step 7: Write `docs/compatibility/packaging.md`** recording the platform matrix: what is tested, what is untested, and the known limits (a Bun-built binary cannot run on Alpine by default, and the SEA alternative cannot ship on macOS x64).
- [x] **Step 8: Commit.**
  ```bash
  git add scripts package.json docs/compatibility/packaging.md tests/compatibility/packaging.test.ts
  git commit -m "build: self-contained executable and install path"
  ```

### CC-020 — The divergence layer: PRRICODE as a product of its own

**Why this task exists.** PRRICODE is built in two layers. The **first** is the parity
layer — the same architecture, the same observable behaviour, the same performance
envelope, with every claim traced to a named artifact in the evidence. That layer is
this plan. The **second** layer is the divergence: the identity, the surfaces and the
capabilities that make PRRICODE a product of its own rather than a reimplementation of
somebody else's.

**This milestone is the second layer, and its specification is not yet supplied.** The
owner of the project will provide the identity requirements; until they are, the
milestone cannot be implemented, and nothing in it may be invented. This entry exists
so the plan is **whole**: the work is queued, named and accounted for, rather than
implicit.

**Files:** the ones the divergence specification names. Nothing is decided here.

**Interfaces:** the ones the divergence specification names.

- [ ] **Step 1: Receive the divergence specification** — the identity, the surfaces and
  the capabilities that differ from the reference build. Until this step is done, every
  other step is blocked and **nothing may be guessed**.
- [ ] **Step 2: Write the failing test** — for each divergence, the test that shows the
  clone does **not** yet behave that way.
- [ ] **Step 3: Run it to verify it fails** — expected: FAIL.
- [ ] **Step 4: Implement the divergence** — the behaviour the specification names.
- [ ] **Step 5: Run it to verify it passes** — expected: PASS.
- [ ] **Step 6: Update the conformance documents** — a divergence is **not** a
  compatibility claim, so it is recorded in its own document and **not** as a row of the
  compatibility matrix. The matrix stays a statement about the parity layer.
- [ ] **Step 7: Commit.**
  ```bash
  git add <the paths the specification names>
  git commit -m "feat: the divergence layer"
  ```

**The rule this milestone obeys.** The compatibility matrix measures the **parity**
layer. A divergence must not be recorded as a compatibility row, and a compatibility row
must not be weakened to make room for one. The two are separate documents for exactly
that reason.

### CC-019 — Compatibility measurement and reporting

**Files:** Create `tests/compatibility/` scenarios; Create `docs/compatibility/results.md` (populate), `docs/compatibility/command-surface.md`, `docs/compatibility/provider-catalog.md`, `docs/compatibility/session-format.md`, `docs/compatibility/permission-matrix.md`, `docs/compatibility/extension-surface.md`.

**Interfaces:** Consumes: every earlier task's public surface plus the target contract rows in `docs/compatibility/feature-matrix.md`. Produces: a measured row per contract: `match | partial | mismatch | not-tested | unknown`, with the evidence class and the test that produced it.

- [x] **Step 1: Write the failing results test** — every feature-matrix row has exactly one results row, and every result row with `match` has a linked passing test. A row whose target evidence class is `unknown` may not be reported as `match`.
- [x] **Step 2: Run it to verify it fails** — expected: FAIL.
- [x] **Step 3: Implement the compatibility scenario harness** that runs each scenario against this implementation and records the outcome.
- [x] **Step 4: Run it to verify it passes** — expected: PASS.
- [x] **Step 5: Populate `docs/compatibility/results.md`** with the measured values and the command used to reproduce each.
- [x] **Step 6: Commit.**
  ```bash
  git add tests/compatibility docs/compatibility
  git commit -m "docs(compat): measured compatibility results"
  ```

---


**Result (fix round 2, after `CC-005b` and `CC-003b`):** The measured totals are **21 `match`**, **12 `partial`**, **6 `mismatch`**, **0 `not-tested`** and **3 `unknown`** over the 42 matrix rows. The six `mismatch` rows are `F-18` (this implementation's permission-feedback member names), `F-21` (this implementation's seventh permission reason kind), `F-24` (the target's observed `transcriptSource` marker), `F-34` (no native sandbox helper), `F-35` (no seccomp-notify listener) and `F-38` (the pure boolean-flag set). `F-07` and `F-08` moved to `match` when `CC-005b` implemented the target's observed Bedrock+Mantle routing of the `anthropic.*` models, and `F-04` moved to `match` when `CC-003b` implemented the target's observed per-top-level-key settings merge. The three `unknown` rows are `F-36` (no whole-image native inventory), `F-37` (the target's sandbox routing is unobserved) and `F-39` (the target's terminal UI is unobserved).

**One rule, applied to every row:** a **difference of any kind** from the target's *observed* behavior — including a member the target has and this implementation does not — is a `mismatch`. Every "What was measured" cell is the harness's own `detail` string and the results test compares the two. A probe that observes nothing this implementation produced, that compares a value with itself, or that asserts a constant, fails the suite, and a stale total fails it too.

## Execution handoff

**Plan complete and saved to `docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`.**

Recommended execution: **subagent-driven** — the tasks share a lot of interface surface (the provider registry, permission vocabulary, and session event schema are consumed by most later tasks), so a fresh implementer plus a fresh reviewer per task catches interface drift early, and a shipped mistake in the provider or permission layer would be expensive to unwind.

**Prerequisite:** `CC-001` in this plan must close the REA coverage audit first. The audit currently reports four requirement groups as partial, and those specific gaps are the exact inputs the tasks below need.
