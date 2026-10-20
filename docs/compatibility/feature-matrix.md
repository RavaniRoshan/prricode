# Feature and compatibility matrix

**Generated from:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §3.
**Target:** `the pinned reference build @ 2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.

## Evidence classes

| Class | Meaning |
|---|---|
| `REA observed` | Directly present in the pinned artifact's static structure, with a cited Evidence record. |
| `Documented only` | Stated in official product documentation. **Not** evidence about the pinned binary; the documentation may describe a later release. |
| `Runtime observed` | Observed by executing the target. Only `--version` has been executed, so this class is currently empty. |
| `Project requirement` | A product extension. The target does not have this behavior. |
| `Inference` | Strongly implied by the analyzed structure but not directly established. |
| `Unknown` | Not established by the analyzed scope. |

## Status vocabulary

`observed` · `partial` · `unknown` · `inferred` · `not applicable` (for project requirements that the target lacks).

## Matrix

| ID | Group | Requirement | Status | Evidence class | Evidence / source | Implementation status | Owning task | Test ref |
|---|---|---|---|---|---|---|---|---|
| F-01 | CLI | CLI entry, flags, subcommands | partial | REA observed | `ev_832ea3e8e470482e2ec3bbd279dd59e9e16762fa2aeba40f34e61bcb90bdcf2b`, `ev_55449a84611a36ea464f40e34521dc3eda4ed244d6ff37baa2fc163d64070fe5` |  implemented | CC-014 | `tests/contracts/cli-surface.test.ts` |
| F-02 | CLI | Headless (`--print`) and output formats | partial | REA observed | same as F-01 |  implemented | CC-014 | `tests/contracts/cli-surface.test.ts` |
| F-03 | Configuration | Configuration file tiers | observed | REA observed | `ev_832ea3e8e470482e2ec3bbd279dd59e9e16762fa2aeba40f34e61bcb90bdcf2b`; tier constants `C7s`, `Ble`, `D_`, `VD` | implemented | CC-003 | `tests/contracts/settings-precedence.test.ts` |
| F-04 | Configuration | Configuration precedence algorithm | observed | REA observed | same as F-03; the per-top-level-key merge and its per-key value rule, closed by source reading: the order `Ps` (user, project, local, flag, policy) and the value table — arrays concatenate and de-duplicate, `extraKnownMarketplaces` and `managedMcpServers` shallow-merge one level, `fallbackModel` and `modelPicker` replace, everything else replaces wholesale | implemented | CC-003 | `tests/contracts/settings-precedence.test.ts` |
| F-05 | Configuration | Settings scope isolation and suppression | observed | REA observed | `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG` suppression of `projectSettings`/`localSettings`; project tier skipped when it resolves to the user settings path; `machine_admin` read mode for `policySettings` | implemented | CC-003 | `tests/contracts/settings-precedence.test.ts` |
| F-06 | Providers | Eight provider routes and their adapters | observed | REA observed | `ev_bdec53e06db82d41c30a893877f3506acd62d206c7a9e75c06d1f9b54ecc8012` |  implemented | CC-006 | `tests/contracts/drivers.test.ts` |
| F-07 | Providers | Provider-owned model catalog | observed | REA observed | `chunk-w4f5s3e0.js` catalog literal: `schema_version`, `pricing_tiers`, `models[]` with `provider_ids` across eight providers |  implemented | CC-005 | `tests/contracts/provider-catalog.test.ts` |
| F-08 | Providers | Route selection (exactly one active route) | observed | REA observed | selector `xe()` and per-model override `wd(model)` | implemented | CC-004 | `tests/contracts/provider-registry.test.ts` |
| F-09 | Providers | Per-provider endpoint policy (base-URL variables, vendor-host patterns) | observed | REA observed | per-provider endpoint policy literal in `chunk-w4f5s3e0.js` | implemented | CC-004 | `tests/contracts/provider-registry.test.ts` |
| F-10 | Providers | Multi-provider connection manager | not applicable | Project requirement | No user-managed registry observed. The target has a built-in catalog and one active route. |  implemented | CC-004, CC-016 | `tests/contracts/provider-registry.test.ts`, `tests/contracts/provider-command.test.ts` |
| F-11 | Providers | Credential handling as references only | not applicable | Project requirement | Project rule: the catalog must not select or read secrets. | implemented | CC-004 | `tests/security/provider-credentials.test.ts` |
| F-12 | Request | Request construction (URL, headers, body, auth) | observed | REA observed | `ev_bdec53e06db82d41c30a893877f3506acd62d206c7a9e75c06d1f9b54ecc8012` |  implemented | CC-006 | `tests/contracts/drivers.test.ts` |
| F-13 | Request | Retry, timeout, and error classification | observed | REA observed | `shouldRetry` (401 cache invalidation, `x-should-retry`, 408/409/429/5xx), `calculateNonstreamingTimeout`, `makeStatusError` |  implemented |  CC-006, CC-006b |  `tests/contracts/drivers.test.ts`, `tests/contracts/provider-transport.test.ts` |
| F-14 | Request | Response parsing and streaming | observed | REA observed | the default `parseResponse` (`ai`) is read in full: streaming → `SSEParser.fromSSEResponse`; 204 → `null`; JSON → `buildMessage(await response.json(), response)`; the extended SSE event vocabulary (`agent.*`, `session.*`, `span.*`, `user.*`) is enumerated |  implemented | CC-006 | `tests/contracts/drivers.test.ts` |
| F-15 | Request | Local gateway as a second request path | observed | REA observed | `cc-gateway/2.1.303` user agent, `workspace_id` rejection, Bedrock `count_tokens` locally, SSE re-framing |  implemented | CC-006 | `tests/contracts/drivers.test.ts` |
| F-15b | Request | The transport, the retry loop, and SigV4 signing | observed | REA observed | the audit's retry set (`408`, `409`, `429`, `>= 500`, `x-should-retry` in both directions), the cached-token `401` refresh, the `retry-after` handling, the SigV4 service name the driver wrote (`bedrock` vs `bedrock-mantle`), and the token scope reaching the acquisition callback |  implemented | CC-006b | `tests/contracts/provider-transport.test.ts` |
| F-16 | Agent | Agent turn request and continuation | observed | REA observed | a refused call is answered with a `<tool_use_error>…</tool_use_error>` tool result with `is_error: true` (this implementation matches the target here); `client.beta.messages.create({ ...req, stream: true }, { signal, headers }).withResponse()` in `chunk-4jsg44k7.js` |  implemented | CC-010 | `tests/contracts/agent-loop.test.ts` |
| F-17 | Agent | Tool-call scheduling and dispatch order | observed | REA observed | the scheduling is observed: a call that is concurrency safe runs in parallel with the run of safe calls before it, a call that is not concurrency safe stands alone and stops the run, a tool that does not declare the flag is not concurrency safe, and the next model request waits for every call's result; tool-use/tool-result shaping observed in `chunk-ftzv5yw1.js` |  implemented | CC-010 |  `tests/contracts/agent-loop.test.ts`, `tests/contracts/tool-result-projection.test.ts` |
| F-17b | Agent | The projected tool-result content is a string | observed | REA observed | the tool-result block is `{tool_use_id, type:"tool_result", content:<string>}` with `is_error: true` added **for a failure** — a success carries no `is_error` member; the **stub's** wire form and the failed tool's error-envelope text are **implementation choices**; `mapToolResultToToolResultBlockParam` and the tool-result shaping observed in `chunk-ftzv5yw1.js` | implemented | CC-009b, CC-009c | `tests/contracts/tool-result-projection.test.ts`, `tests/contracts/tool-result-stub.test.ts` |
| F-18 | Agent | Tool result shaping and permission feedback | observed | REA observed | `permission_decision {decision, source, reason_type}`, `non_execution_kind`, `remedy`, `user_feedback` |  implemented | CC-008, CC-010 | `tests/contracts/tool-registry.test.ts` |
| F-19 | Permissions | Permission decision vocabulary | observed | REA observed | behavior `allow`/`deny`/`ask`; source `classifier`/`hook`/`user_permanent`/`user_temporary`/`user_abort`/`user_reject`/`unknown`; reason type `rule`/`safetyCheck`/`other` |  implemented | CC-007 | `tests/contracts/permission-decision.test.ts` |
| F-20 | Permissions | Rule precedence and modes | observed | REA observed | `permissions.allow`/`deny`/`ask`; `defaultMode`; modes `default`, `acceptEdits`, `bypassPermissions`, `plan`, `auto` |  implemented | CC-007 | `tests/security/permission-rules.test.ts` |
| F-21 | Permissions | Decision reasons and the file-mutating tool set | observed | REA observed | reason kinds `rule`, `subcommandResults`, `permissionPromptTool`, `sandboxOverride`, `workingDir`, `safetyCheck`; tools `Edit`, `Write`, `NotebookEdit` |  implemented | CC-007 | `tests/contracts/permission-decision.test.ts` |
| F-22 | Permissions | Host-level gates | observed | REA observed | `CLAUDE_CODE_RESTRICT_PERSONAL_CONFIG`; hook failure of severity `stop` denies all tool calls |  implemented | CC-007 | `tests/security/permission-rules.test.ts` |
| F-23 | Permissions | Remote permission transport (`can_use_tool`) | observed | REA observed | `TransportPermissionDispatcher`: subtype filter, non-string `request_id` dropped, malformed request denied, in-flight dedup, repository-trust and computer-folder prompt validation |  implemented | CC-007, CC-011 | `tests/contracts/permission-decision.test.ts` |
| F-24 | Sessions | Session storage layout and transcript format | observed | REA observed | `~/.claude` 55-subdirectory listing; JSONL transcripts under a `projects` subtree; `transcriptSource` of `ccr-api` / `local-jsonl` |  implemented | CC-009 | `tests/contracts/session-store.test.ts` |
| F-25 | Sessions | Resume semantics | partial | REA observed | the **selection** is established — a session id or an exact title, the ambiguity error listing the candidates with their modification times, the attach short-circuit, `--resume-session-at` with its drop guard, and the structured resumed state; what remains is the **store-level ordering rule** inside the lookup (which candidates are skipped — live background, headless, SDK, and slash-command sessions), which is not observed |  implemented | CC-009 | `tests/contracts/session-resume.test.ts` |
| F-26 | Sessions | Cross-restart prompt carry-over | observed | REA observed | outcomes `sent`, `bound`, `altered`, `no_row`, `job_has_run`, `too_old`, `future_dated` |  implemented | CC-009 | `tests/contracts/session-store.test.ts` |
| F-27 | Sessions | Compaction | partial | REA observed | Compaction event and summary model observed; the boundary/projection model is inference |  implemented | CC-009 | `tests/contracts/session-resume.test.ts` |
| F-28 | Extensions | MCP control-request surface | observed | REA observed | 23 handled subtypes in `chunk-0j25qbd0.js`; MCP callback absence error text |  implemented | CC-011 | `tests/contracts/mcp-control.test.ts` |
| F-29 | Extensions | Directional control-request policy | observed | REA observed | rejection table in `chunk-081t8575.js` |  implemented | CC-011 | `tests/contracts/mcp-control.test.ts` |
| F-30 | Extensions | MCP transport and batching | observed | REA observed | stdio spawn with `shell: false`; `MCP_SERVER_CONNECTION_BATCH_SIZE` 3, `MCP_REMOTE_SERVER_CONNECTION_BATCH_SIZE` 20; `initialize`/`tools/list`/`tools/call` |  implemented | CC-011 | `tests/contracts/mcp-manager.test.ts` |
| F-31 | Extensions | MCP server lifecycle | partial | REA observed | configuration write verification observed; the full lifecycle is not traced |  implemented | CC-011 | `tests/contracts/mcp-manager.test.ts` |
| F-32 | Extensions | Hook event matrix and handler contract | observed | REA observed | 30+ events with per-event execution classification; decision-capable subset; `mcp_tool` hook type; per-model severity thresholds |  implemented | CC-012 | `tests/contracts/hooks.test.ts` |
| F-33 | Extensions | Skills, subagents, plugins, marketplaces, IDE | partial | REA observed | named subsystems and storage directories observed; behavior not traced |  implemented | CC-013 | `tests/contracts/extensions.test.ts` |
| F-34 | Platform | Native sandbox helper | observed | REA observed | `ev_03f243709e8d7a715417e1b5423040b0699e83e080e8a3e34d2bab35c52b75b0` — 29 named callees, namespaces, mounts, `prctl`, seccomp filter and listener, `execvp` |  implemented | CC-017 | `tests/security/sandbox.test.ts` |
| F-35 | Platform | Native seccomp notification supervisor | partial | REA observed | `ev_675b0f67ffcb65b3210844369bc84963d66b4e552360bc61aa68ae7987fcaf7d` (16 named callees), `ev_7f3b70f348ad82e0462ade7bb1e07dec88154d51f868884e8f809f20d40c5ef8` (27-record table at `0x6c749c0`); per-syscall policy unresolved |  implemented | CC-017 | `tests/security/sandbox.test.ts` |
| F-36 | Platform | Whole-image native inventory | unknown | — | three timed-out attempts (330 s, 360 s, 900 s) | not started | CC-001 | — |
| F-37 | Platform | The `Bash` tool's sandbox routing | implementation choice | **implementation choice** (the target's routing is unobserved) | the target's `sandboxOverride` decision reason kind and the `dangerouslyDisableSandbox` flag are observed; this implementation's routing, its filtered environment, its refusal shape and the rule that the flag never overrides a policy **error** are this implementation's | implemented | CC-008b | `tests/security/bash-sandbox.test.ts` |
| F-38 | Command line | The command-line surface | observed | REA observed | the parser's structure, the three flag sets, the repeatable set, the optional-value boolean, the short-flag-cluster rule, the command tokens, the session-id pattern, the cloud ref, the URI arguments, the headless rule and the validation messages in `chunk-0y0ptpy9.js` | implemented | CC-014 | `tests/contracts/cli-surface.test.ts` |
| F-39 | Command line | The interactive terminal UI | implementation choice | **implementation choice** (the audit records no TUI drawing at all) | the block markers, the block format and its indentation, the denial marker, the sandbox status lines, the unmatched-tool-result report, the tool summary, the code-block label, the control-sequence stripping, the ARIA labels and roles (list, listitem, listbox, option, textbox), the approval-choice wording and the frame rate are this implementation's | implemented | CC-015 | `tests/contracts/ui-render.test.ts` |
| F-40 | Provider | The multi-provider manager surfaces | project requirement | **project requirement** (a project extension, not part of the reference agent) | the `/provider` command, the catalog browser, the picker, the credential status vocabulary (`resolved \| unresolved \| unreadable \| refused`) and the two credential columns are this implementation's | implemented | CC-016 | `tests/contracts/provider-command.test.ts` |

## Totals

| Status | Count |
|---|---|
| observed | 26 |
| partial | 10 |
| unknown | 1 |
| inferred | 0 |
| not applicable (project requirement) | 2 |
| implementation choice | 2 |
| project requirement | 1 |
| **Total rows** | **42** |

`F-27` is counted as partial rather than observed because the compaction *event* is observed but the boundary-and-projection *model* is inferred from the tool-result shaping code, not from a resolved relation.

## Compatibility-reporting rule

A row may be reported as `match` in `docs/compatibility/results.md` only when its evidence class is `REA observed` **and** a test in the owning task passes. A row whose target evidence is `unknown` or `partial` may be reported as `partial`, `not-tested`, or `unknown` — never as `match`.
