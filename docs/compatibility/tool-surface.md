# Tool surface conformance

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.4 ("Agent loop and tool dispatch") and §2.5 ("Permissions").
**Owning task:** `CC-008` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Matrix rows:** F-17, F-18 in [`feature-matrix.md`](feature-matrix.md).

Every row names its **evidence class**: `REA observed`, `Documented only`, or `implementation choice`.

## The tool contract (implementation design, shaped by the audit)

```ts
interface ToolDefinition<I, O> {
  name: string;
  description: string;
  inputSchema: unknown;
  mutatesFiles: boolean;
  checkPermissions(input: I, ctx: ToolContext): Promise<PermissionDecision | undefined>;
  validateInput(input: I, ctx: ToolContext): Promise<{ ok: true } | { ok: false; message: string; errorCode: number }>;
  execute(input: I, ctx: ToolContext): Promise<O>;
  recheckPermission(input: I, ctx: ToolContext): Promise<ToolRecheck>;
}
```

`recheckPermission` re-runs the **whole** permission check against a rewritten input. It may only **restrict** the call — the stricter of the two verdicts wins — and the re-check's own hook keeps its **denial** but loses its **approval** and its **rewrite**, because the approval was given for the original call. This is a **implementation choice** with no target counterpart, and it exists because a hook that rewrites the input would otherwise be a permission bypass.

## The ten built-in tools

`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`, `WebFetch`, `TodoWrite`, `NotebookEdit`, `Task`.

**The set is a implementation choice.** The audit records the **file-mutating** set exactly — `Edit`, `Write`, `NotebookEdit` — and records `respondToPermissionRequest` and `can_use_tool` as the target's tool-facing surfaces, but it does not pin the whole tool surface. The plan's ten are therefore a plan-level decision.

The rule engine's path-field and read-tool tables must name only tools this implementation can run. They once carried an `LS` row for a tool that is not shipped, which made a user's `LS(...)` rule half-live; the tables and the built-in set now move together, and a regression test pins it.

## The runner's order and its failure envelopes

**The order is check permissions → validate input → execute.** Every failure still produces an envelope (`isError: true`) rather than throwing.

| Situation | Result | Evidence class |
|---|---|---|
| The check **denies** | An error envelope with the decision attached; `execute` is never called | REA observed |
| The **validation** fails | An error envelope with the typed error code and a message naming the offending field | REA observed |
| The tool expresses **no opinion** | Refused — fail closed | implementation choice (deliberate) |
| The check produces an unresolved **ask** | Refused; the session's approval service is the only way to settle it | implementation choice |
| A hook **rewrote** the input | The rewritten input is what executes | REA observed |
| A rewritten input the tool's **validator** rejects | Denied, with a hook-sourced decision and the typed code | REA observed |
| A hook rewrote the input and the rewrite is **not permitted** | The whole permission check runs again on the effective input; the stricter verdict wins | implementation choice |
| The path the check approved **changed** before the write | Refused with `nonExecutionKind: 'path_changed'` | implementation choice |

## The file-mutating path

`Write`, `Edit` and `NotebookEdit` resolve their path, and the resolution is **bracketed**: the path the check approved is re-resolved immediately before the execution, and the tools re-resolve again immediately before the write call. A swap between the two is refused.

**Scope, stated honestly.** The guarantee covers the file-mutating tools. A shell command's redirection target is checked by the rule engine against the file rules, but the shell resolves the target when it runs, so this implementation does **not** claim the same guarantee for a shell redirection.

This is the property the `CC-007` review found missing: the seam existed but was never called, so "re-resolve after the check" was a promise rather than a behaviour.

## The `Read` deny filter (REA observed)

`Glob` and `Grep` filter their results through the `Read(...)` rules, so a file reached through a **symlinked search path** is excluded when a deny rule fires on either the requested or the resolved path. This reproduces the target's own `2.1.251` fix.

## The `Bash` tool

Runs through `/bin/sh -c` with the **filtered** environment — the session's own environment from `BuiltinToolDeps.env`, filtered against the sandbox's allowlist, so a command never sees the agent's credentials — a 120 s default and 600 s maximum timeout, and `timeout: 0` refused by the validator.

The command runs **inside the sandbox** when the session carries a sandbox policy, and **unconfined** when the policy says so — an excluded platform, a switched-off sandbox, an excluded command, or a missing backend with `failIfUnavailable` off. The result says which: `sandboxed`, `sandboxReason`, `sandboxEstablishmentReason`, `sandboxExemptions`, `sandboxExemptionScope` and `sandboxAvailability`. See [`sandbox-surface.md`](sandbox-surface.md).

**Two things are implementation choices and are labelled as such:** the shell is `sh` per call rather than the target's persistent shell session, and the timeout values are unpinned by the audit. `dangerouslyDisableSandbox` is accepted but never skips a rule check.

**A Bash rule matches command text, not program identity.** `Bash(curl *)` does not stop `/usr/bin/curl` or `sh -c 'curl …'`. This implementation matches text and says so rather than implying a stronger guarantee.

## The `Task` tool

Delegates through a `deps.delegate` seam and reports a typed `taskUnavailable` failure when there is no delegate. The **delegation scheduler is not observed** in the audit, so this implementation does not invent one; `CC-010` owns the runtime.

## Unpinned surfaces (implementation choices, labelled in the code)

- The `nonExecutionKind` vocabulary: `unknown_tool`, `permission_denied`, `permission_unresolved`, `permission_check_failed`, `validation_error`, `path_changed`, `execution_failed`. The audit pins the *field*, not the values.
- The error codes, **except** `7` (invalid path) and `14` (a suppressed write), which the audit names. The numbering is implementation-internal; its gaps are not an alignment with any target table.
- The tool **output** shapes — `{type:'text', text, files, truncated}` for `Glob`, `{text, stdout, stderr, exitCode, truncated}` for `Bash` — and the `ToolErrorContent` `{type:'error', message, errorCode}`. These reach the model and the session log, and the audit pins only the tool-result *metadata*.
- **Implementation choice (`CC-008b`).** The `Bash` output gained the sandbox members — `sandboxed`, `sandboxReason`, `sandboxEstablishmentReason`, `sandboxExemptions`, `sandboxExemptionScope`, `sandboxAvailability` — and `timedOut`. The audit records no such members; they are this implementation's, and the shape is additive.
- `Grep`'s bounds (a 512-character pattern, a 1 MiB file, 2 000 examined files), `Glob`'s result cap, and `WebFetch`'s timeout and byte cap.

## Conformance table

| Claim | Evidence class | Pinned by |
|---|---|---|
| The file-mutating set is exactly `Edit`, `Write`, `NotebookEdit`, derived from the permission module | REA observed | `tests/contracts/tool-registry.test.ts` — "derives the file-mutating tool set from the permission module" |
| The runner's order is check → validate → execute | REA observed | same file — "the tool runner" |
| A denial produces an envelope with the decision attached, and `execute` is not called | REA observed | same file |
| A validation failure produces the typed code and a message naming the field | REA observed | same file |
| A tool with no opinion fails closed | implementation choice | same file |
| An unresolved ask is refused | implementation choice | same file |
| A hook rewrite is what executes, and a validator-rejected rewrite denies | REA observed | same file |
| A rewrite triggers the whole re-check, and the stricter verdict wins | implementation choice | same file — the ask / allow-scope / `acceptEdits` rewrite tests and the negative control |
| The path the check approved is re-resolved before the write, and a swap is refused | implementation choice | same file — the "path was re-resolved" tests |
| Every built-in consults the rule engine | REA observed | same file — "the built-in tools and the rule engine" |
| No tool rewrites its own input | implementation choice (deliberate) | same file |
| `Glob`/`Grep` apply the `Read` deny rules through a symlinked search path | REA observed | same file |
| The approval prompt shows the resolved destination | implementation choice | `tests/security/permission-rules.test.ts` — "the approval prompt" |
| A Bash rule matches command text, not program identity | Documented only | same file |
| The malformed-call path reaches the audit's `errorCode: 7` / `3` end-to-end | REA observed | `tests/contracts/tool-registry.test.ts` — the end-to-end malformed cases |
| The rule engine's tool tables name only shipped tools | implementation choice | `tests/security/permission-rules.test.ts` — "the rule engine's tool tables" |
