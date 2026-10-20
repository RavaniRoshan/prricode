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
- The `defaultMode` tier order follows the **observed** `TOP_LEVEL_KEY_ORDER` (`policySettings`, `flagSettings`, `userSettings`); the project-side tiers do not define a `defaultMode`. The **rule-list** order is `policySettings`, `flagSettings`, `localSettings`, `projectSettings`, `userSettings` — the observed `MERGED_KEY_ORDER` with the two unplaced tiers added. The rule-list **combination** (concatenating every tier's lists rather than "first source that defines the key wins") is a **implementation choice**, fail-safe, and labelled.
- A machine-admin (`policySettings`) deny beats a user allow, because the deny list is scanned across all tiers before any allow.

## Host-level gates (REA observed)

- `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` blocks **every prompt and tool call** when the personal configuration has problems, and the message names the offending file paths.
- A hook failure of severity `stop` denies all tool calls with the reason *"A problem with your own settings or hooks is blocking tool calls"*.

## Hooks and the safety check (REA observed)

- A `PreToolUse` / `PermissionRequest` hook that returns `allow` does **not** override a deny or an ask rule. This implementation's `checkPermission` runs the deny list **before** the hook.
- A hook approval whose arguments the tool cannot verify produces a **`safetyCheck` denial** whose message states that nothing was fetched, and it is **not** reported as a user denial.
- A hook's `updatedInput` is what the tool receives, and a rewritten input the tool's own validator rejects **denies** the call.
- A hook approval may replace the **generic prompt** (the no-rule-matched case) only. It may **not** replace a `subcommandResults` escalation — the hook cannot approve the sub-commands a partially matching allow rule did not cover.
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

## Conformance table

| Audit claim | Evidence class | Pinned by |
|---|---|---|
| The decision vocabulary is exactly the four closed sets | REA observed | `tests/contracts/permission-decision.test.ts` — "vocabulary" |
| Precedence is deny → ask → allow, first match wins, specificity irrelevant | REA observed | same file — "precedence" |
| A rule never rewrites the tool input | implementation choice | same file — "vocabulary" (compile-time `updatedInput?: never` pin) |
| Compound commands split on all seven operators, with no sub-command cap | implementation choice | `tests/security/permission-rules.test.ts` — the 51-part and 501-part tests |
| An allow rule needs every sub-command; deny/ask fire on any | implementation choice | same file |
| Quoted text is not stripped; a quoted operator is not a separator | implementation choice | same file |
| The four path anchors, with `/path` anchored per settings source | Documented only | same file |
| Allow needs requested **and** resolved; deny fires on either | Documented only | same file |
| A glued redirect target is caught | implementation choice | same file — the redirect tests |
| A deny rule on a primary content field degrades to an ask | implementation choice | same file |
| Deny blocks in every mode; allow has no effect in `bypassPermissions`; ask still prompts there | REA observed | `tests/contracts/permission-decision.test.ts` — "modes" |
| `dontAsk` denies rather than prompts, never consults `canUseTool`, and denies the four always-denied categories | REA observed | same file — "modes" |
| `plan` never auto-approves an edit, by effect not by tool name | implementation choice | same file — "modes" |
| `acceptEdits` auto-approves inside the working directory or an added directory, and still prompts for `rm` on a critical path | REA observed + implementation choice (the critical-path list) | same file |
| Start-mode precedence, the settings-file rule, and the three availability overrides | REA observed | same file — "start mode" |
| The `defaultMode` tier order follows the observed `TOP_LEVEL_KEY_ORDER` | implementation choice | same file |
| The rule-list combination is concatenation, not "first source wins" | implementation choice | same file |
| A machine-admin deny beats a user allow | implementation choice (fail-safe) | same file |
| The host gates: the personal-config restriction and the `stop`-severity hook failure | REA observed | `tests/security/permission-rules.test.ts` |
| The safety check denies with `reasonType: 'safetyCheck'`, never a user source | REA observed | `tests/contracts/permission-decision.test.ts` — "safety check" |
| A hook runs after the deny list and never overrides it | REA observed | same file — "hook rewrite" |
| A hook approval cannot replace a `subcommandResults` escalation | implementation choice | same file |
| `classifierApprovable: false` cannot be laundered by the auto review | implementation choice | same file |
| The approval prompt shows the command text and the resolved destinations | implementation choice | `tests/security/permission-rules.test.ts` — "the approval prompt" |
| The transport dispatcher's shape, including the dropped non-string `request_id` | REA observed | same file — "dispatcher" |
| The computer-folder and repository-trust names are configuration, and an unrecognised one is refused | implementation choice (unpinned) | same file — "dispatcher" |
| The "don't ask again" rule computation and its 5-rule cap | Documented only (the write is not implemented) | `tests/contracts/permission-decision.test.ts` |
