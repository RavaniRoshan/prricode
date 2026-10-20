# Permission matrix

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.5 "Permissions".
**Owning task:** `CC-007` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Matrix rows:** F-19 … F-23 in [`feature-matrix.md`](feature-matrix.md).

Every row names its **evidence class**: `REA observed` (established from the pinned binary), `Documented only` (external product documentation, not the pinned binary), or `implementation choice` (a decision this implementation makes).

## The decision vocabulary (REA observed)

| Field | Values |
|---|---|
| `behavior` | `allow` · `deny` · `ask` |
| `source` | `classifier` · `hook` · `user_permanent` · `user_temporary` · `user_abort` · `user_reject` · `unknown` |
| `reasonType` | `rule` · `safetyCheck` · `other` |
| reason kind | `rule` · `subcommandResults` · `permissionPromptTool` · `sandboxOverride` · `workingDir` · `safetyCheck` |

This implementation adds one reason kind, **`noRuleMatch`**, to distinguish "no rule matched" from the audit's `permissionPromptTool` ("a **named tool** requires approval for this command"). That is a **implementation addition**.

## Rule evaluation

| Behavior | Evidence class | Notes |
|---|---|---|
| Precedence is deny → ask → allow | REA observed | |
| The **first** match wins and **specificity is irrelevant** | REA observed | A broad deny beats a narrower allow; an allow can never carve an exception out of a deny. |
| Rules are **pure predicates** — they never rewrite the tool input | implementation choice, deliberate | Only **hooks** rewrite input. A rule that silently changed what runs would be a security defect. |
| Compound commands split on `&&`, `\|\|`, `;`, `\|`, `\|&`, `&`, and newlines, each sub-command matched independently | Documented only | The pinned binary's splitting is not derived; the shape comes from the product documentation. |
| **No sub-command cap** | implementation choice, deliberate | The target had a 50-sub-command cap that silently skipped every deny check. This implementation has no cap and never degrades to a generic ask. |
| An allow rule fires only when **every** sub-command matches; deny/ask fire on **any** | implementation choice | The strictest reading of the documented rule. |
| Quoted text is never stripped and a quoted operator is not a separator | implementation choice | The target once stripped single-quoted text before checking, so `git push --receive-pack='$(…)'` passed. |
| Bash rules match **command text, not program identity** | Documented only | The product documentation says outright that these are "not a security boundary around the program". This implementation does not claim otherwise. |
| A `Tool(param:value)` rule on a tool's primary content field is ignored, with a warning | Documented only (unpinned) | The sentence could not be located in the plan, the audit, or the research. A **deny** rule in that position is **degraded to an ask**, not dropped — degrading is this implementation's choice. |
| The four path anchors: `//path` (fs root), `~/path` (home), `/path` (**relative to the settings source**), `path`/`./path` (working directory) | Documented only | |
| Allow rules require **both** the requested and the resolved path to match; deny rules fire if **either** matches | Documented only | The asymmetry is deliberate. |
| The path is **re-resolved after** the check | implementation choice, **not yet enforced** | The seam (`reResolvePath`) exists in `src/permissions/paths.ts`; the **write path** is `CC-008`'s. Until then this is a promise, not a behaviour. |
| A single-segment deny/ask path pattern matches at any depth **below the anchor** | implementation choice | |
| `!` negation is scoped to the same list **and** the same tier | implementation choice, **narrower** than the documented "same settings file" | Narrower is fail-safe: it is what keeps an allow from carving an exception out of a deny. |
| Redirect targets are checked as file operations (write redirects against the edit/write tools, read redirects against the read tools) | Documented only | This implementation splits the **glued** target off the operator, so `>/etc/passwd` is caught. |
| The "don't ask again" affordance persists one rule per sub-command needing approval, capped at 5 rules, to `.claude/settings.local.json` | Documented only | This implementation implements the **computation** and the cap; the **file write is not implemented** and is labelled so. |

## The mode matrix (REA observed)

| Rule class | `default` | `acceptEdits` | `plan` | `auto` | `dontAsk` | `bypassPermissions` |
|---|---|---|---|---|---|---|
| `deny` | blocks | blocks | blocks | blocks | blocks | **blocks** |
| `allow` | allows | allows | **never auto-approves an edit** | review decides | — | **no effect** |
| `ask` | prompts | prompts | prompts | **still prompts** (the classifier may deny, but its allow never converts an ask into an allow) | **denies** | **still prompts** |

- `dontAsk` denies `AskUserQuestion`, MCP tools marked `requiresUserInteraction`, network-path reads, and org-ask connector tools **even if allow-listed**, and never consults `canUseTool`.
- `acceptEdits` auto-approves the edit/write tool set plus `mkdir, touch, rm, rmdir, mv, cp, sed` — but only for paths inside the working directory or an **added** directory, and only after a symlink check. `rm`/`rmdir` on a **critical path** still prompt. The critical-path list is a **implementation choice** (root, home, the working directory and its ancestors, `~/.claude`, `~/.ssh`, `~/.aws`, `<cwd>/.git`); the audit names none.
- `plan` tests the **effect** of a call (does it mutate files), not the tool name — so `Bash(sed -i *)` is not auto-approved.
- **Start-mode precedence**: `--permission-mode` flag → `permissions.defaultMode` → built-in default. `auto` and `bypassPermissions` written into a settings file are **ignored**. The built-in default is `auto` for an interactive terminal session and `default` for a headless run, subject to three overrides: a settings file with `disableAutoMode: "disable"`, a HIPAA-configured session, and a session where auto mode is unavailable.
- **Implementation choice (`CC-014`).** The CLI is the only production caller of `resolveStartMode`, and it threads all three overrides:
  - `disableAutoMode: "disable"` in the **merged** settings document disables auto mode. The merge is the settings loader's own: the highest tier that defines the key wins (`TIER_PRECEDENCE`).
  - a HIPAA-configured session is a merged settings document whose `hipaa` member is `true`, or an object whose `enabled` member is `true`. **The audit names the override but not its key**: the key is this implementation's own.
  - auto mode being **unavailable** has **no signal** in this implementation: the CLI has no availability probe, so `autoAvailable` is the constant `true` and this override never fires. **Reported, not hidden.**
- The `defaultMode` tier order follows the **observed** `TOP_LEVEL_KEY_ORDER` (`policySettings`, `flagSettings`, `userSettings`); the project-side tiers do not define a `defaultMode`. The **rule-list** order is `policySettings`, `flagSettings`, `localSettings`, `projectSettings`, `userSettings` — the observed `MERGED_KEY_ORDER` with the two unplaced tiers added. The rule-list **combination** (concatenating every tier's lists rather than "first source that defines the key wins") is a **implementation choice**, fail-safe, and labelled.
- A machine-admin (`policySettings`) deny beats a user allow, because the deny list is scanned across all tiers before any allow.

## Host-level gates (REA observed)

- `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` blocks **every prompt and tool call** when the personal configuration has problems, and the message names the offending file paths.
- A hook failure of severity `stop` denies all tool calls with the reason *"A problem with your own settings or hooks is blocking tool calls"*.

## Hooks and the safety check

- A `PreToolUse` / `PermissionRequest` hook that returns `allow` does **not** override a deny or an ask rule. This implementation's `checkPermission` runs the deny list **before** the hook. **Implementation choice** (the pick) — see the `PreToolUse` seam table below.
- A hook approval whose arguments the tool cannot verify produces a **`safetyCheck` denial** whose message states that nothing was fetched, and it is **not** reported as a user denial.
- A hook's `updatedInput` is what the tool receives, and a rewritten input the tool's own validator rejects **denies** the call.
- A hook approval may replace the **generic prompt** (the no-rule-matched case) only. It may **not** replace a `subcommandResults` escalation — the hook cannot approve the sub-commands a partially matching allow rule did not cover.
- A hook that rewrites the input triggers a **whole** re-check of the rewritten input — the same rules and the same mode — and the re-check may only **restrict** the call. A rewrite therefore cannot escape the deny list, the ask list, the allow scope, or the mode dispatch. The re-check's own hook is **consulted again** with the rewritten input and keeps its **denial** and its **approval**; only its **rewrite** is dropped, because the rewrite has already been applied. The safety check and the tool's validator are **not** run again — they judged the rewritten input once. A hook that **approves and rewrites** therefore bypasses the generic prompt: the approval is kept, and the rewritten input is what the tool receives.
- An approval carrying `classifierApprovable: false` cannot be laundered by an `auto` classifier: the result is `ask`, not `allow`.

## The remote transport dispatcher (REA observed)

- Only the `can_use_tool` subtype is accepted.
- A `request_id` that is **not a string** is dropped with **no response** — no response is possible.
- A malformed `can_use_tool` is denied with a synthesized denial.
- An in-flight `request_id` is not dispatched twice.
- A computer-folder prompt whose input is not exactly three string arguments is denied; a path or computer name containing CR, LF, U+2028 or U+2029 is denied; a path not equal to its own normalized form is denied.
- The computer-folder and repository-trust **tool names are configuration the transport layer supplies**, not constants. The audit names neither, so the default is unpinned; a request that looks like a computer-folder prompt but carries an unrecognised name is **refused rather than forwarded unvalidated**. The narrowing is a **implementation choice** and its residual false positive (a peer tool that takes a path plus two strings) is named in the module header.

## Known failure modes this implementation does not reproduce

Each of these was a real defect in an earlier the reference agent release. This implementation avoids them, and each avoidance is pinned by a named test.

| Failure mode | How this implementation avoids it |
|---|---|
| Compound-command allow bypass | Every sub-command is split and matched independently, with no cap. |
| Over-correction (whole chain must match an allow) | An allow fires only when every sub-command matches. |
| Single-quote stripping before checking | Quoted text is kept and matched; an operator inside quotes is not a separator. |
| Symlink TOCTOU between the check and the write | Allow needs requested **and** resolved to match; deny fires on either. The post-check re-resolution is `CC-008`'s. |
| "SymJack" — the approval prompt shows the literal command | The prompt shows the command text **and** the resolved destinations, and only path-shaped arguments are resolved. |
| A hook as a permission bypass | A hook may rewrite the input, but the rewritten input must pass the tool's validator or the call is denied; a hook `allow` never overrides a deny or an ask. |
| Project settings trusted / `bypassPermissions` bypassing a deny | Deny rules are evaluated before the mode dispatch, so `bypassPermissions` cannot bypass them. |
| Bash rules mistaken for a program boundary | This implementation matches command text and **says so** rather than implying a stronger guarantee. |
| Auto mode treated as a security boundary | The review fails closed on no verdict, and it is a caller-supplied seam — this implementation performs no server-side review and no local model call. |

## The `PreToolUse` hook seam

The target changed this behavior in a later release without a deprecation warning, so the target's own behavior at `2.1.303` is ambiguous from the outside. This implementation picks the **stricter** of the two.

| Rule | Evidence class |
|---|---|
| A `PreToolUse` hook returning `allow` does **not** override a deny rule | **implementation choice** (the pick) — the audit records the strictness merge for two **hook results**, not the hook-vs-rule **ordering** |
| A `PreToolUse` hook returning `allow` does **not** override an ask rule | **implementation choice** (the pick), same correction |
| A `PreToolUse` hook returning `deny` holds in **every** mode, `bypassPermissions` included | **implementation choice** (the pick), same correction |
| A `PreToolUse` hook that returns `undefined` expresses no opinion and changes nothing | **implementation choice** |
| A `PreToolUse` `ask` is the pending question — the prompt is consulted, and it carries the hook's own **reason** and **source** | **implementation choice** |
| A `PreToolUse` `defer` is no opinion — the normal permission path decides | **implementation choice** |
| The `PreToolUse` seam and the `PermissionRequest` seam merge by **strictness**, so neither can cancel the other | **implementation choice** |
| A tie in that merge goes to the `PermissionRequest` seam, because it is the later event | **implementation choice** |
| A `PreToolUse` rewrite is re-checked with the **whole** permission check against the **effective** input, and a rewritten input the tool's validator rejects **denies** the call | **implementation choice** for the re-check; "the rewrite is what the tool receives" is REA observed |
| The re-check keeps the hook's **approval** and its **denial** and drops only its **rewrite**; a deny rule, an ask rule or a mode refusal covering the effective input still wins | **implementation choice** |
| A rewrite is never lost: the decision that leaves the check records the effective input, and the user's answer to the prompt carries it | **implementation choice** |
| The safety check runs **once** for an unrewritten call and **twice** for a rewritten one — once in the tool's own check, once in the tool layer's re-check | **implementation choice** |
| A `PreToolUse` `defer` drops the hook's rewrite with it — a deferral is no opinion, so nothing is carried and the call acts on the input the model made | **implementation choice** |
| The rewrite rides along on an `ask` — the question is about the rewritten call, so `decision.updatedInput` is the rewritten input | **implementation choice** |
| The tool layer's re-check keeps **only a denial**, so an approving-and-rewriting hook cannot approve a call no rule covers: the re-check leaves the generic `noRuleMatch` ask, the call escalates to the prompt, and with no prompt it is **refused** (`permission_unresolved`) — even though the permission layer allowed it and the hook approved it. A call a rule *does* cover is unaffected | **implementation choice** |
| Both layers consult the `PreToolUse` seam **first**, so when both seams deny the refusal names the `PreToolUse` denial in both layers | **implementation choice** |
| The `PreToolUse` seam is consulted **three** times for a rewritten call (the original input in the check, the effective input in the permission layer's re-check, the effective input in the tool layer's re-check) and **once** for a call that is not rewritten | **implementation choice** |
| A hook that throws **denies** the call | **implementation choice** |

The permission layer owns its own strictness table (`allow: 1`, `ask: 2`, `deny: 3`); the hooks module's four-value **type** is imported **type-only** (erased at compile time), so only the table is the permission layer's own.

**Pinned by:** `tests/contracts/permission-hook.test.ts` and `tests/contracts/pre-tool-use-wiring.test.ts`.

## Conformance table

| Audit claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| The decision vocabulary is exactly the four closed sets | REA observed | F-19 | `tests/contracts/permission-decision.test.ts` — "uses only the closed behavior, source and reason-type vocabularies" |
| Precedence is deny → ask → allow, first match wins, specificity irrelevant | REA observed | F-20 | same file — "rule precedence" |
| A rule never rewrites the tool input | implementation choice | F-20 | same file — "never rewrites the tool input from a rule" (compile-time `updatedInput?: never` pin) |
| Compound commands split on all seven operators, with no sub-command cap | implementation choice | F-20 | `tests/security/permission-rules.test.ts` — the 51-part and 501-part tests |
| An allow rule needs every sub-command; deny/ask fire on any | implementation choice | F-20 | same file |
| Quoted text is not stripped; a quoted operator is not a separator | implementation choice | F-20 | same file |
| The four path anchors, with `/path` anchored per settings source | Documented only | F-20 | same file |
| Allow needs requested **and** resolved; deny fires on either | Documented only | F-20 | same file |
| A glued redirect target is caught | implementation choice | F-20 | same file — the redirect tests |
| A deny rule on a primary content field degrades to an ask | implementation choice | F-20 | same file |
| Deny blocks in every mode; allow has no effect in `bypassPermissions`; ask still prompts there | REA observed | F-20 | `tests/contracts/permission-decision.test.ts` — "the permission modes" |
| `dontAsk` denies rather than prompts, never consults `canUseTool`, and denies the four always-denied categories | REA observed | F-20 | same file — "denies rather than prompts in dontAsk", "never consults canUseTool in dontAsk" |
| `plan` never auto-approves an edit, by effect not by tool name | implementation choice | F-20 | same file — "never auto-approves a file edit in plan mode, even with a matching allow rule" |
| `acceptEdits` auto-approves inside the working directory or an added directory, and still prompts for `rm` on a critical path | REA observed + implementation choice (the critical-path list) | F-20 | same file |
| Start-mode precedence, the settings-file rule, and the three availability overrides | REA observed | F-20 | same file — "resolveStartMode" |
| The start mode's flag beats `permissions.defaultMode`, which beats the built-in default | REA observed | F-20 | `tests/contracts/permission-decision.test.ts` — "prefers the flag over the settings default", "prefers the settings default over the built-in default" |
| `auto` and `bypassPermissions` written into a settings file are ignored | REA observed | F-20 | same file — "ignores auto and bypassPermissions written into a settings file" |
| The built-in default is `auto` for an interactive terminal session and `default` for a headless run | REA observed | F-20 | same file — "starts in auto for an interactive session when auto mode is available", "starts in default for a headless run" |
| The override: a settings file with `disableAutoMode: "disable"` falls back to `default` | REA observed | F-20 | same file — "falls back to default when auto mode is disabled by policy" |
| The override: a HIPAA-configured session falls back to `default` | REA observed | F-20 | same file — "falls back to default for a HIPAA-configured session" |
| The override: a session where auto mode is unavailable falls back to `default` | REA observed | F-20 | same file — "falls back to default when auto mode is unavailable" |
| An **explicit** `auto` flag is honoured even when auto mode is unavailable | REA observed | F-20 | same file — "honours an auto flag even when auto mode is unavailable" |
| The CLI threads all three start-mode overrides, and the HIPAA key and the unavailable signal are this implementation's | **implementation choice** | F-20 | `tests/contracts/cli-surface.test.ts` — the start-mode tests |
| The `defaultMode` tier order follows the observed `TOP_LEVEL_KEY_ORDER` | implementation choice | F-20 | same file |
| The rule-list combination is concatenation, not "first source wins" | implementation choice | F-22 | same file |
| A machine-admin deny beats a user allow | implementation choice (fail-safe) | F-19 | same file |
| The host gates: the personal-config restriction and the `stop`-severity hook failure | REA observed | F-19 | `tests/security/permission-rules.test.ts` |
| The safety check denies with `reasonType: 'safetyCheck'`, never a user source | REA observed | F-21 | `tests/contracts/permission-decision.test.ts` — "the safety check" |
| A hook runs after the deny list and never overrides it | REA observed | F-19 | same file — "the hook rewrite path" |
| A hook approval cannot replace a `subcommandResults` escalation | implementation choice | F-19 | same file |
| `classifierApprovable: false` cannot be laundered by the auto review | implementation choice | F-18 | same file |
| The approval prompt shows the command text and the resolved destinations | implementation choice | F-18 | `tests/security/permission-rules.test.ts` — "the approval prompt" |
| A hook rewrite triggers the **whole** permission re-check, and the stricter of the two verdicts wins | implementation choice | F-23 | `tests/contracts/tool-registry.test.ts` — the rewrite tests (ask-covered path, allow scope, `acceptEdits` working directory, and the negative control) |
| The path the check approved is the path that is re-resolved, and a swap between the two is refused | implementation choice | F-23 | same file — "refuses a write whose path was re-resolved to another target after the check", "refuses a write whose rewritten path was swapped while the re-check ran" |
| The transport dispatcher's shape, including the dropped non-string `request_id` | REA observed | F-21 | `tests/contracts/permission-decision.test.ts` — "the transport permission dispatcher" |
| The computer-folder and repository-trust names are configuration, and an unrecognised one is refused | implementation choice (unpinned) | F-19 | `tests/contracts/mcp-control.test.ts` — "the transport permission dispatcher" |
| The "don't ask again" rule computation and its 5-rule cap | Documented only (the write is not implemented) | F-19 | `tests/contracts/permission-decision.test.ts` |

## The `PreToolUse` seam — conformance

The `PreToolUse` seam's own table above lists this implementation's **pick** rule by rule. This table is the same list, condensed, with the test that pins each rule. The measured outcome of the row is in [`results.md`](results.md).

| Claim | Evidence class | Matrix row | Pinned by |
| --- | --- | --- | --- |
| A `PreToolUse` `allow` never overrides a deny or an ask rule, and a `PreToolUse` `deny` holds in every mode | REA observed (the mechanism) + **implementation choice** (the pick) | F-19 | `tests/contracts/permission-hook.test.ts` — "does not let a PreToolUse approval override a deny rule", "does not let a PreToolUse approval override an ask rule", "holds a PreToolUse denial in every mode, bypassPermissions included" |
| A `PreToolUse` hook that expresses no opinion changes nothing, and a `defer` is no opinion | **implementation choice** | F-19 | same file — "changes nothing when the PreToolUse hook expresses no opinion", "treats a deferral as no opinion, so the normal permission path decides" |
| A `PreToolUse` `ask` is the pending question, and it carries the hook's own reason and source | **implementation choice** | F-19 | same file — "makes a PreToolUse question the pending question", "carries the hook's reason and source into the pending question" |
| The two hook seams merge by **strictness**, so neither can cancel the other | **implementation choice** | F-19 | same file — the "the merge of the two hook seams" block |
| A `PreToolUse` rewrite is re-checked with the **whole** permission check against the **effective** input, and the rewritten input is what the tool receives | **implementation choice** (the re-check) + REA observed (the rewrite) | F-19 | same file — the "the PreToolUse rewrite" block |
| A rewritten input the tool's own validator rejects **denies** the call | REA observed | F-19 | same file — "denies the call when the rewritten input is rejected by the tool validator" |
| A hook that throws denies the call | **implementation choice** | F-18 | same file — "denies the call when the PreToolUse hook throws" |
| The `PreToolUse` seam is wired into the **tool runner** and into the runtime's permission service | **implementation choice** | F-19 | `tests/contracts/pre-tool-use-wiring.test.ts` — "wires the registry’s hooks into the tool layer" |
| The seam is consulted **three** times for a rewritten call and **once** for a call that is not rewritten, and the safety check runs twice for a rewritten call | **implementation choice** | F-19 | same file — "consults the PreToolUse seam three times for a rewritten call", "consults the seam once for a call that is not rewritten", "runs the safety check twice for a rewritten call" |
| The tool layer's re-check keeps only a **denial**, so an approving-and-rewriting hook cannot approve a call no rule covers | **implementation choice** | F-18 | same file — "refuses the call the permission layer allowed and the hook approved", "keeps the approval of neither seam" |
