# Measured compatibility results

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Contract list:** [`feature-matrix.md`](feature-matrix.md) — 42 rows, `F-01` … `F-40` plus `F-15b` and `F-17b`.
**Owning task:** `CC-019` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Measured by:** [`tests/compatibility/scenarios.ts`](../../tests/compatibility/scenarios.ts) — the scenario harness.
**Checked by:** [`tests/compatibility/results.test.ts`](../../tests/compatibility/results.test.ts) — the results test.

## What this file is

One row per **contract**: the 42 rows of the feature matrix. Each row carries the **measured** outcome, the **evidence class** the measurement was made under, the **test that produced it**, the **pinning test** of the owning task, and the **command that reproduces the measurement**.

Nothing here is a claim about this implementation that was not run. Every row was measured by executing a scenario against this implementation; a scenario that could not run is recorded as `not-tested`, and a row whose target evidence the audit never established is recorded as `unknown`.

## The outcome vocabulary

| Outcome | Meaning |
|---|---|
| `match` | This implementation's behaviour was measured and equals the target's **observed** behaviour. |
| `partial` | This implementation's behaviour was measured and matches the target's on the part the target established, but not on all of it — or the target's surface is only partly established. |
| `mismatch` | This implementation's behaviour was measured and **differs** from the target's observed behaviour. |
| `not-tested` | The scenario **could not run** here. It is a gap in the measurement, never a pass and never a failure. |
| `unknown` | The target's behaviour was **not established**, so nothing was compared. This implementation's own behaviour was exercised, but no target claim was checked. |

## The rule the report obeys

The feature matrix's own **compatibility-reporting rule**:

> A row may be reported as `match` in `docs/compatibility/results.md` only when its evidence class is `REA observed` **and** a test in the owning task passes. A row whose target evidence is `unknown` or `partial` may be reported as `partial`, `not-tested`, or `unknown` — never as `match`.

The results test enforces it, and two consequences follow:

- A **project requirement** row (`F-10`, `F-11`, `F-40`) is reported `partial`. The target has **no** such surface, this implementation implements the extension, and the pinning test passes — but no target behaviour is matched, and the matrix forbids the word `match` here.
- A **implementation choice** row (`F-37`, `F-39`) is reported `unknown`. The target's behaviour at `2.1.303` was not established by the audit, so there was nothing to compare against.

## The totals

| Outcome | Rows |
|---|---|
| `match` | 23 |
| `partial` | 16 |
| `mismatch` | 0 |
| `not-tested` | 1 |
| `unknown` | 2 |
| **Total** | **42** |

## The measured rows

| Row | Area | Feature | Evidence class | Outcome | What was measured | Linked test | Pinning test | Reproduce |
|---|---|---|---|---|---|---|---|---|
| F-01 | CLI | CLI entry, flags, subcommands | REA observed | partial | The parser reproduces the target's structure and the six subcommands, but the audit enumerates only the flags this implementation's own surface needs, so the flag surface is partial. | `tests/compatibility/scenarios.test.ts` — "F-01 cli entry and flags" | `tests/contracts/cli-surface.test.ts` — "ends the flag parsing at --" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-01 cli entry and flags"` |
| F-02 | CLI | Headless (`--print`) and output formats | REA observed | partial | The headless rule and the three output formats are reproduced; the audit pins the formats and not the documents a run writes. | `tests/compatibility/scenarios.test.ts` — "F-02 headless print and the output formats" | `tests/contracts/cli-surface.test.ts` — "writes exactly one JSON document and exits 0 on success" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-02 headless print and the output formats"` |
| F-03 | Configuration | Configuration file tiers | REA observed | match | The five tiers and both observed orderings are reproduced exactly. | `tests/compatibility/scenarios.test.ts` — "F-03 the five settings tiers" | `tests/contracts/settings-precedence.test.ts` — "declares the two distinct orderings and the project-side set" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-03 the five settings tiers"` |
| F-04 | Configuration | Configuration precedence algorithm | REA observed | partial | Both observed orderings and the whole-block override are reproduced; the audit does not derive the target's per-key merge for ordinary keys. | `tests/compatibility/scenarios.test.ts` — "F-04 the two precedence orderings" | `tests/contracts/settings-precedence.test.ts` — "keeps the two orderings genuinely different" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-04 the two precedence orderings"` |
| F-05 | Configuration | Settings scope isolation and suppression | REA observed | match | The personal-config suppression, the linked-away project tier and the machine-admin policy read mode are all reproduced. | `tests/compatibility/scenarios.test.ts` — "F-05 scope isolation and suppression" | `tests/contracts/settings-precedence.test.ts` — "suppresses exactly the project-side sources when personal config is restricted" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-05 scope isolation and suppression"` |
| F-06 | Providers | Eight provider routes and their adapters | REA observed | match | The eight route names and their adapters are reproduced exactly. | `tests/compatibility/scenarios.test.ts` — "F-06 the eight provider routes" | `tests/contracts/provider-registry.test.ts` — "names exactly the eight routes the target declares" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-06 the eight provider routes"` |
| F-07 | Providers | Provider-owned model catalog | REA observed | match | The built-in catalog carries all 22 of the target's rows with their per-route ids; the target's literal is pinned by digest. | `tests/compatibility/scenarios.test.ts` — "F-07 the provider-owned model catalog" | `tests/contracts/provider-catalog.test.ts` — "carries every row of the target catalog" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-07 the provider-owned model catalog"` |
| F-08 | Providers | Route selection (exactly one active route) | REA observed | match | The dispatch order and the single active route are reproduced exactly. | `tests/compatibility/scenarios.test.ts` — "F-08 route selection" | `tests/contracts/provider-registry.test.ts` — "keeps the target dispatch order, with gateway first and firstParty last" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-08 route selection"` |
| F-09 | Providers | Per-provider endpoint policy (base-URL variables, vendor-host patterns) | REA observed | match | The base-URL variable lists and the vendor-host patterns are reproduced, in the audit's order. | `tests/compatibility/scenarios.test.ts` — "F-09 the per-provider endpoint policy" | `tests/contracts/provider-registry.test.ts` — "declares one policy per route with the target base-URL variables" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-09 the per-provider endpoint policy"` |
| F-10 | Providers | Multi-provider connection manager | Project requirement | partial | The project requirement is met — N concurrent connections, each with a reference — but the target has no such registry, so no target behaviour is matched. | `tests/compatibility/scenarios.test.ts` — "F-10 the connection registry" | `tests/contracts/provider-registry.test.ts` — "lists the connections it holds" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-10 the connection registry"` |
| F-11 | Providers | Credential handling as references only | Project requirement | partial | The project requirement is met — a credential is a reference and a status is presence only — but the target has no such model, so no target behaviour is matched. | `tests/compatibility/scenarios.test.ts` — "F-11 credentials as references only" | `tests/security/provider-credentials.test.ts` — "never returns the credential value" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-11 credentials as references only"` |
| F-12 | Request | Request construction (URL, headers, body, auth) | REA observed | match | The URL, the headers, the body and the authentication are the target's observed shapes. | `tests/compatibility/scenarios.test.ts` — "F-12 request construction" | `tests/contracts/drivers.test.ts` — "sets the anthropic version and the content type" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-12 request construction"` |
| F-13 | Request | Retry, timeout, and error classification | REA observed | match | The retry set, the 600000 ms fallback and the error classification are the target's observed rules. | `tests/compatibility/scenarios.test.ts` — "F-13 retry timeout and error classification" | `tests/contracts/drivers.test.ts` — "retries 408, 409, 429 and every 5xx" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-13 retry timeout and error classification"` |
| F-14 | Request | Response parsing and streaming | REA observed | partial | The SSE and the non-streaming paths parse into the same events, but the audit does not resolve the per-resource `parseResponse` callee. | `tests/compatibility/scenarios.test.ts` — "F-14 response parsing and streaming" | `tests/contracts/drivers.test.ts` — "parses a non-streaming body into the same events" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-14 response parsing and streaming"` |
| F-15 | Request | Local gateway as a second request path | REA observed | match | The gateway user agent, the workspace-id rejection and the local count-tokens path are the target's observed behaviour. | `tests/compatibility/scenarios.test.ts` — "F-15 the local gateway" | `tests/contracts/drivers.test.ts` — "sets the anthropic version and the content type" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-15 the local gateway"` |
| F-15b | Request | The transport, the retry loop, and SigV4 signing | REA observed | match | The two SigV4 service names and the signing scope are the target's observed values. | `tests/compatibility/scenarios.test.ts` — "F-15b the transport the retry loop and sigv4" | `tests/contracts/provider-transport.test.ts` — "signs with the service name the driver wrote into the request, not a constant" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-15b the transport the retry loop and sigv4"` |
| F-16 | Agent | Agent turn request and continuation | REA observed | match | The turn's request, the refusal envelope and the continuation are the target's observed shapes. | `tests/compatibility/scenarios.test.ts` — "F-16 the agent turn and its continuation" | `tests/contracts/agent-loop.test.ts` — "a denied call is refused, answered with a tool_use_error, and ends the turn" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-16 the agent turn and its continuation"` |
| F-17 | Agent | Tool-call scheduling and dispatch order | REA observed | partial | This implementation schedules the calls of a turn sequentially in the order they appear; the target's concurrent order is not resolved by the audit. | `tests/compatibility/scenarios.test.ts` — "F-17 tool-call scheduling order" | `tests/contracts/agent-loop.test.ts` — "collects the tool calls of a turn in the order they appear" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-17 tool-call scheduling order"` |
| F-17b | Agent | The projected tool-result content is a string | REA observed | match | The projected block is `{tool_use_id, type, content:<string>}` with `is_error: true` added only for a failure. | `tests/compatibility/scenarios.test.ts` — "F-17b the projected tool-result content is a string" | `tests/contracts/tool-result-projection.test.ts` — "carries no is_error member on a success" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-17b the projected tool-result content is a string"` |
| F-18 | Agent | Tool result shaping and permission feedback | REA observed | match | The permission feedback the tool result carries uses the target's observed field names. | `tests/compatibility/scenarios.test.ts` — "F-18 tool-result shaping and permission feedback" | `tests/contracts/tool-registry.test.ts` — "produces an error envelope with the decision attached when the check denies" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-18 tool-result shaping and permission feedback"` |
| F-19 | Permissions | Permission decision vocabulary | REA observed | match | The behaviour, source and reason-type vocabularies are the target's closed sets. | `tests/compatibility/scenarios.test.ts` — "F-19 the permission decision vocabulary" | `tests/contracts/permission-decision.test.ts` — "uses only the closed behavior, source and reason-type vocabularies" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-19 the permission decision vocabulary"` |
| F-20 | Permissions | Rule precedence and modes | REA observed | match | Deny, then ask, then allow; the first match wins; and the six modes behave as the target does. | `tests/compatibility/scenarios.test.ts` — "F-20 rule precedence and the modes" | `tests/security/permission-rules.test.ts` — "lets a broad deny beat a narrower allow" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-20 rule precedence and the modes"` |
| F-21 | Permissions | Decision reasons and the file-mutating tool set | REA observed | match | The audit's six reason kinds are all present and the file-mutating set is exactly Edit, Write and NotebookEdit; this implementation adds a seventh kind, `noRuleMatch`. | `tests/compatibility/scenarios.test.ts` — "F-21 the reason kinds and the file-mutating set" | `tests/contracts/permission-decision.test.ts` — "names the tool for a permission-prompt-tool reason" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-21 the reason kinds and the file-mutating set"` |
| F-22 | Permissions | Host-level gates | REA observed | match | The personal-config restriction and the `stop`-severity hook failure both deny every call. | `tests/compatibility/scenarios.test.ts` — "F-22 the host-level gates" | `tests/security/permission-rules.test.ts` — "denies every call when the personal configuration has problems and the restriction is set" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-22 the host-level gates"` |
| F-23 | Permissions | Remote permission transport (`can_use_tool`) | REA observed | match | The transport dispatcher's shape, its dropped non-string request id and its direction rules are reproduced. | `tests/compatibility/scenarios.test.ts` — "F-23 the remote permission transport" | `tests/contracts/mcp-control.test.ts` — "drops a can_use_tool request whose request_id is not a string, with no response" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-23 the remote permission transport"` |
| F-24 | Sessions | Session storage layout and transcript format | REA observed | partial | The layout — JSONL under `<configDir>/projects/<project>/<sessionId>.jsonl`, with the project name derived from the working directory — is reproduced, but the record format is this implementation's own versioned format and the target's `transcriptSource` marker is not. | `tests/compatibility/scenarios.test.ts` — "F-24 the session storage layout" | `tests/contracts/session-store.test.ts` — "keeps the transcript under <configDir>/projects/<encoded-cwd>/<sessionId>.jsonl" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-24 the session storage layout"` |
| F-25 | Sessions | Resume semantics | REA observed | partial | The selection rules the audit establishes — the exact-title match, the ambiguity error, the attach short-circuit, the drop guard and the interrupted-turn rule — are reproduced; the store-level ordering inside the lookup is not resolved by the audit. | `tests/compatibility/scenarios.test.ts` — "F-25 resume semantics" | `tests/contracts/session-resume.test.ts` — "reconstructs the branch that ends at the newest leaf, not the one written last" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-25 resume semantics"` |
| F-26 | Sessions | Cross-restart prompt carry-over | REA observed | match | The seven-name outcome vocabulary and the binding rule are reproduced. | `tests/compatibility/scenarios.test.ts` — "F-26 the cross-restart carried prompts" | `tests/contracts/session-store.test.ts` — "reports every outcome of the vocabulary" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-26 the cross-restart carried prompts"` |
| F-27 | Sessions | Compaction | REA observed | partial | This implementation implements the boundary marker and the summary model the audit observes, but the boundary-and-projection model is inference, not an observed relation. | `tests/compatibility/scenarios.test.ts` — "F-27 compaction" | `tests/contracts/session-resume.test.ts` — "skips the pre-compact prefix when reading and does not delete it from the file" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-27 compaction"` |
| F-28 | Extensions | MCP control-request surface | REA observed | match | The host dispatcher handles exactly the 23 observed subtypes, and `can_use_tool` is not among them. | `tests/compatibility/scenarios.test.ts` — "F-28 the mcp control-request surface" | `tests/contracts/mcp-control.test.ts` — "is exactly the 23 host subtypes" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-28 the mcp control-request surface"` |
| F-29 | Extensions | Directional control-request policy | REA observed | match | The three refused directions and their wordings are reproduced. | `tests/compatibility/scenarios.test.ts` — "F-29 the directional control-request policy" | `tests/contracts/mcp-control.test.ts` — "rejects every agent-originated subtype by direction" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-29 the directional control-request policy"` |
| F-30 | Extensions | MCP transport and batching | REA observed | match | The stdio transport and the 3/20 batching are the target's observed values. | `tests/compatibility/scenarios.test.ts` — "F-30 the mcp transport and its batching" | `tests/contracts/mcp-manager.test.ts` — "uses 3 for local servers and 20 for remote ones" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-30 the mcp transport and its batching"` |
| F-31 | Extensions | MCP server lifecycle | REA observed | partial | This implementation implements a lifecycle with a memo, a retry and a teardown, but the audit traces only the configuration write, so the full target lifecycle is not reproduced. | `tests/compatibility/scenarios.test.ts` — "F-31 the mcp server lifecycle" | `tests/contracts/mcp-manager.test.ts` — "evicts a failed memo and retries the server" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-31 the mcp server lifecycle"` |
| F-32 | Extensions | Hook event matrix and handler contract | REA observed | match | The 33 events, the two display handlers outside that set and the per-event classification are reproduced. | `tests/compatibility/scenarios.test.ts` — "F-32 the hook event matrix" | `tests/contracts/hooks.test.ts` — "lists exactly the thirty-three hook events" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-32 the hook event matrix"` |
| F-33 | Extensions | Skills, subagents, plugins, marketplaces, IDE | REA observed | partial | This implementation implements the five subsystems, but the audit records their names and storage and not their behaviour, so the target's behaviour is not reproduced. | `tests/compatibility/scenarios.test.ts` — "F-33 skills subagents plugins marketplaces and the ide" | `tests/contracts/extensions.test.ts` — "applies what a plugin contributes" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-33 skills subagents plugins marketplaces and the ide"` |
| F-34 | Platform | Native sandbox helper | REA observed | partial | The observable guarantees are reproduced — the filesystem boundary, the syscall denylist including `io_uring_setup`, and the masked protected paths — but this implementation builds the policy in TypeScript over bubblewrap and ships no native helper. | `tests/compatibility/scenarios.test.ts` — "F-34 the native sandbox helper" | `tests/security/sandbox.test.ts` — "denies the syscall surface the plan requires, including io_uring_setup" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-34 the native sandbox helper"` |
| F-35 | Platform | Native seccomp notification supervisor | REA observed | partial | The 27-record dispatch table and the observe-never-deny rule are reproduced, but this build ships no seccomp-notify listener: the status reports `layers.supervisor` as false. | `tests/compatibility/scenarios.test.ts` — "F-35 the seccomp notification supervisor" | `tests/security/sandbox.test.ts` — "observes without denying: the response error stays zero and the call continues" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-35 the seccomp notification supervisor"` |
| F-36 | Platform | Whole-image native inventory | Unknown | not-tested | The whole-image native inventory produced no Evidence record: three attempts timed out (330 s, 360 s, 900 s) | `tests/compatibility/scenarios.test.ts` — "F-36 the whole-image native inventory" | — | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-36 the whole-image native inventory"` |
| F-37 | Platform | The `Bash` tool's sandbox routing | Implementation choice | unknown | The target's routing is unobserved: the audit records the `sandboxOverride` reason kind and the `dangerouslyDisableSandbox` flag, and this implementation's routing is its own. | `tests/compatibility/scenarios.test.ts` — "F-37 the bash tool's sandbox routing" | `tests/security/bash-sandbox.test.ts` — "runs the command unconfined when the sandbox is switched off, even with the flag" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-37 the bash tool's sandbox routing"` |
| F-38 | Command line | The command-line surface | REA observed | partial | The parser's structure, the three flag sets, the repeatable set, the optional-value boolean, the short-flag-cluster rule, the command tokens, the patterns and the validation messages are reproduced; the rest of the boolean set is deliberately kept pure, which is a deviation from the audit's rule. | `tests/compatibility/scenarios.test.ts` — "F-38 the command-line surface" | `tests/contracts/cli-surface.test.ts` — "keeps the optional value of --resume" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-38 the command-line surface"` |
| F-39 | Command line | The interactive terminal UI | Implementation choice | unknown | The audit records no TUI drawing at all, so the target's terminal UI at 2.1.303 was not established and nothing was compared; this implementation's renderer is its own. | `tests/compatibility/scenarios.test.ts` — "F-39 the interactive terminal ui" | `tests/contracts/ui-render.test.ts` — "produces one block per assistant message" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-39 the interactive terminal ui"` |
| F-40 | Provider | The multi-provider manager surfaces | Project requirement | partial | The project requirement is met — the `/provider` command, the catalog browser, the picker, the credential status vocabulary and the two credential columns — but the target has no such surface, so no target behaviour is matched. | `tests/compatibility/scenarios.test.ts` — "F-40 the multi-provider manager surfaces" | `tests/contracts/provider-command.test.ts` — "provider list prints one row per connection with its id, name, route, base URL, and credential status" | `npx vitest run tests/compatibility/scenarios.test.ts -t "F-40 the multi-provider manager surfaces"` |

## The conformance documents

The per-area conformance tables live beside this one, and every row of them names its evidence class and the test that pins it:

| Document | Covers |
|---|---|
| [`command-surface.md`](command-surface.md) | the parser, the flag sets, the validation messages, this implementation's CLI choices, the output contracts |
| [`provider-catalog.md`](provider-catalog.md) | the eight routes, the catalog, the adapters, the manager surfaces |
| [`session-format.md`](session-format.md) | the storage layout, the record format, resume, compaction, the carried prompts |
| [`permission-matrix.md`](permission-matrix.md) | the decision vocabulary, the rules, the modes, the hooks, the transport |
| [`extension-surface.md`](extension-surface.md) | the MCP control surface, the hooks, the skills, the plugins, the subagents, the IDE |
| [`sandbox-surface.md`](sandbox-surface.md) | the five layers, the policy, the decision mapping, the environment |
| [`tool-surface.md`](tool-surface.md) | the built-in tools, the runner, the write path |
| [`settings-precedence.md`](settings-precedence.md) | the settings tiers and the two orderings |

## The honest gaps

The rows that are **not** a `match`, and why.

### `not-tested` — the scenario could not run

| Row | Why |
|---|---|
| `F-36` | **Whole-image native inventory.** The whole-image Ghidra inventory of the pinned ELF produced **no** Evidence record: three attempts timed out (330 s, 360 s, 900 s). There is no inventory to compare this implementation against, so the scenario is recorded as `not-tested` rather than as a failure. |

### `unknown` — the target's behaviour was never established

| Row | Why |
|---|---|
| `F-37` | **The `Bash` tool's sandbox routing.** The audit observes the target's `sandboxOverride` decision reason and its `dangerouslyDisableSandbox` flag; it does not observe which commands the target runs sandboxed. This implementation's routing — an excluded platform, a switched-off sandbox, and a missing backend with `failIfUnavailable` off all run the command **unconfined**, and only a missing backend with `failIfUnavailable` on refuses it — is this implementation's own. Nothing was compared. |
| `F-39` | **The interactive terminal UI.** The audit records **no TUI drawing at all**, so the target's terminal UI at `2.1.303` was never established. This implementation's renderer — its block markers, its denial marker, its approval wording — is its own, and is pinned by `tests/contracts/ui-render.test.ts`. Nothing was compared. |

### `partial` — measured, and matched on part of the contract

| Row | Why |
|---|---|
| `F-01` | The parser's structure and the six subcommands are reproduced; the audit enumerates only the flags this implementation's own surface needs, so the **flag surface** is partial. |
| `F-02` | The headless rule and the three output formats are reproduced; the audit pins the formats and **not** the documents a run writes. |
| `F-04` | Both observed orderings and the whole-block override are reproduced; the audit does not derive the target's **per-key merge** for ordinary keys. |
| `F-10` | **Project requirement.** The registry holds N concurrent connections, each with a credential *reference*; the target has no such registry, so no target behaviour is matched. |
| `F-11` | **Project requirement.** A credential is a reference and a status is presence only; the target has no such model, so no target behaviour is matched. |
| `F-14` | The SSE and the non-streaming paths parse into the same events; the audit does not resolve the **per-resource `parseResponse` callee**. |
| `F-17` | This implementation schedules the calls of a turn sequentially in the order they appear; the target's **concurrent order** is a bounded REA residual. |
| `F-24` | The **layout** is reproduced (JSONL under `<configDir>/projects/<project>/<sessionId>.jsonl`), but the record format is this implementation's own versioned format and the target's `transcriptSource` marker (`ccr-api` / `local-jsonl`) is **not**. |
| `F-25` | The selection rules the audit establishes are reproduced; the **store-level ordering** inside the session lookup is not resolved by the audit. |
| `F-27` | This implementation implements the boundary marker and the summary model the audit observes, but the **boundary-and-projection model is inference**, not an observed relation. |
| `F-31` | This implementation implements a lifecycle with a memo, a retry and a teardown; the audit traces only the **configuration write**, so the full target lifecycle is not reproduced. |
| `F-33` | This implementation implements the five subsystems; the audit records their **names and storage and not their behaviour**, so the target's behaviour is not reproduced. |
| `F-34` | The **observable guarantees** are reproduced — the filesystem boundary, the syscall denylist including `io_uring_setup`, the masked protected paths — but this implementation builds the policy in TypeScript over bubblewrap and ships **no native helper**. |
| `F-35` | The 27-record dispatch table and the observe-never-deny rule are reproduced, but this build ships **no seccomp-notify listener**: the status reports `layers.supervisor` as `false`. |
| `F-38` | The parser's structure, the three flag sets, the repeatable set, the optional-value boolean, the short-flag-cluster rule, the command tokens, the patterns and the validation messages are reproduced; the **rest of the boolean set is deliberately kept pure**, which is a deviation from the audit's rule. |
| `F-40` | **Project requirement.** The `/provider` command, the catalog browser, the picker, the credential status vocabulary and the two credential columns are all implemented; the target has no such surface, so no target behaviour is matched. |

### `mismatch` — none

No row was measured as a **mismatch**: every scenario that ran held the claim it made. This implementation's deliberate divergences are reported as `partial` with the reason named above, not as a mismatch against an observed target behaviour — a divergence from an **unobserved** target is not a mismatch.

## How to reproduce

Each row's **Reproduce** column names the command that measures that row alone:

```bash
npx vitest run tests/compatibility/scenarios.test.ts -t "F-03 the five settings tiers"
```

The whole report is checked — and re-measured — by:

```bash
npx vitest run tests/compatibility/results.test.ts
```

The results test re-runs every scenario and fails when the report disagrees with the measurement, when a row is missing, when a `match` has no passing test, when a row the matrix forbids is reported as a `match`, or when two rows claim the same scenario.
