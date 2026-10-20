# Measured compatibility results

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Contract list:** [`feature-matrix.md`](feature-matrix.md) — 42 rows, `F-01` … `F-40` plus `F-15b` and `F-17b`.
**Owning task:** `CC-019` in [`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**Measured by:** [`tests/compatibility/scenarios.ts`](../../tests/compatibility/scenarios.ts) — the scenario harness.
**Checked by:** [`tests/compatibility/results.test.ts`](../../tests/compatibility/results.test.ts) — the results test, and [`tests/compatibility/references.test.ts`](../../tests/compatibility/references.test.ts) — the conformance-reference check.

## What this file is

One row per **contract**: the 42 rows of the feature matrix. Each row carries the **measured** outcome, the evidence class the measurement was made under, the test that produced it, the **pinning test** of the owning task, and the **command that reproduces the measurement**.

Nothing here is a claim about this implementation that was not run. Every row was measured by executing a scenario against this implementation; a scenario that could not run is recorded as `not-tested`, and a row whose target evidence the audit never established is recorded as `unknown`.

**The prose of the table is the harness's.** The "What was measured" cell of a row is the `detail` string the probe returned, and the results test compares the two: a cell that was written by hand instead of measured fails the test. Every sentence **in a row of the table** is therefore a sentence the harness wrote, and it says what that row's probe measured and nothing else. The prose **below** the table is the writer's, and it summarises the rows above and nothing more.

**A measurement is not a rubber stamp.** A probe records what it read with `observe` or `observeCall`, and the harness records **where each value came from**. A value this implementation **produced** is the return of a call to a reimplementation export, a value this implementation handed over a channel, a **member** of one of those, or a reimplementation export that is **not a bare constant** — a primitive this implementation merely exports is a bare constant, and reading one is not reading this implementation's behaviour. The results test then requires that every scenario observed **something this implementation produced** and compared one of those values against a **different** value: the harness reads the probe's own source and refuses a comparison of a value **with itself** (`expect(c).toBe(c)`), and it refuses an object compared with its own reference — including through an **alias**, which the source check cannot see. One form it cannot see: a **primitive** reached through an alias is indistinguishable at runtime from the ordinary form (a primitive compared with the constant it must equal), and that is a limit of the check, stated here rather than papered over. A probe that asserts a constant measures nothing, and the report may not carry one.

## The outcome vocabulary

| Outcome | Meaning |
|---|---|
| `match` | This implementation's behaviour was measured and equals the target's **observed** behaviour. |
| `partial` | This implementation's behaviour was measured and matches the target's on the part the target established, but not on all of it — or the target's surface is only partly established. |
| `mismatch` | This implementation's behaviour was measured and **differs** from the target's **observed** behaviour. A divergence from an observed behaviour is a mismatch, never a partial. |
| `not-tested` | The scenario **could not run** here. It is a gap in the measurement, never a pass and never a failure. |
| `unknown` | The target's behaviour was **not established**, so nothing was compared. This implementation's own behaviour was exercised, but no target claim was checked. |

## The rule the report obeys

The feature matrix's own **compatibility-reporting rule** decides what a row
may be reported as:

> A row may be reported as `match` in `docs/compatibility/results.md` only when its evidence class is `REA observed` **and** a test in the owning task passes. A row whose target evidence is `unknown` or `partial` may be reported as `partial`, `not-tested`, or `unknown` — never as `match`.

The report applies **one** classification rule of its own to **every** row,
and the totals are derived from it:

> **The classification rule.** A row's outcome follows from the **comparison
> the probe made**:
>
> - `match` — every part of the target's behaviour the audit **observed** and
>   the probe compared is equal, and nothing the row's contract establishes is
>   left uncompared.
> - `mismatch` — the comparison found a **difference** from the target's
>   **observed** behaviour. A difference of **any kind** counts: a different
>   name, a different value, a different member, a different kind, and a
>   member the target has and this implementation does not. A divergence from an
>   observed behaviour is a mismatch, never a partial — whatever the matrix's
>   evidence class is, and whatever else the same row reproduces.
> - `partial` — the parts that were compared are equal, and the **residual is
>   a part the target's evidence does not establish** (an unobserved
>   behaviour, an underived rule) **or a part of an established behaviour that
>   this implementation implements but the row's probe does not compare**; or
>   the row is a **project requirement** the implementation meets, where the
>   target has no such surface at all.
> - `unknown` — the target's behaviour was **not established**, so nothing was
>   compared. A **implementation choice** row is `unknown`: this implementation's behaviour is
>   its own and the target's is unobserved.
> - `not-tested` — the scenario **could not run** here.

Three consequences follow, and the results test enforces the first two — the third is a rule of the report's own vocabulary, which the harness checks by way of the matrix's rule that a `match` is permitted only for an `observed` row:

- A **project requirement** row (`F-10`, `F-11`, `F-40`) is reported `partial`. The target has **no** such surface, this implementation implements the extension, and the pinning test passes — but no target behaviour is matched, and the matrix forbids the word `match` here.
- A **implementation choice** row (`F-37`, `F-39`) is reported `unknown`. The target's behaviour at `2.1.303` was not established by the audit, so there was nothing to compare against.
- A **divergence from an observed behaviour** is reported `mismatch`, whatever the matrix's evidence class is. **Eight** rows are `mismatch` for that reason: `F-07`, `F-18`, `F-21`, `F-24`, `F-25`, `F-34`, `F-35` and `F-38`

**The pinning test is not run here.** The matrix's rule asks for "a test in
the owning task [that] passes". This suite does not run it: the results test
resolves the title the owning task pins to a **declared** `it`, `test` or
`describe` title in that task's file, and the task's own suite — which the
repository's `npx vitest run` runs — is what runs the test. What this suite
re-runs, on every row, is the **scenario**: the measurement is re-made and the
report is checked against it.

## The totals

The totals are the report's own rows, counted: the results test recomputes
them and fails when they disagree.

| Outcome | Rows |
|---|---|
| `match` | 18 |
| `partial` | 12 |
| `mismatch` | 8 |
| `not-tested` | 0 |
| `unknown` | 4 |
| **Total** | **42** |

## The measured rows

| Row | Area | Feature | Evidence class | Outcome | What was measured | Linked test | Pinning test | Reproduce |
|---|---|---|---|---|---|---|---|---|
| F-01 | CLI | CLI entry, flags, subcommands | REA observed | partial | The parser reproduces the target's structure — `--flag=value`, `--` ending the flags, the repeatable set, the short-flag-cluster rule and the six subcommands — but the audit enumerates only the flags this implementation's own surface needs, so the flag surface is partial. | `tests/compatibility/scenarios.test.ts` — "F-01 cli entry and flags" | `tests/contracts/cli-surface.test.ts` — "ends the flag parsing at --" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-01 cli entry and flags" |
| F-02 | CLI | Headless (`--print`) and output formats | REA observed | partial | The headless rule and the three output formats are reproduced; the audit pins the formats and not the documents a run writes. | `tests/compatibility/scenarios.test.ts` — "F-02 headless print and the output formats" | `tests/contracts/cli-surface.test.ts` — "writes exactly one JSON document and exits 0 on success" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-02 headless print and the output formats" |
| F-03 | Configuration | Configuration file tiers | REA observed | match | The five tiers and the four observed orderings — the top-level, the merged, the source enumeration and the project-side set — are reproduced exactly. | `tests/compatibility/scenarios.test.ts` — "F-03 the five settings tiers" | `tests/contracts/settings-precedence.test.ts` — "declares the two distinct orderings and the project-side set" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-03 the five settings tiers" |
| F-04 | Configuration | Configuration precedence algorithm | REA observed | match | Both observed precedence orderings, the whole-block override and the per-top-level-key merge are reproduced; an object a higher tier defines replaces the lower tier's whole, and an array two tiers define is the concatenation of both. | `tests/compatibility/scenarios.test.ts` — "F-04 the two precedence orderings" | `tests/contracts/settings-precedence.test.ts` — "keeps the two orderings genuinely different" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-04 the two precedence orderings" |
| F-05 | Configuration | Settings scope isolation and suppression | REA observed | match | The personal-config suppression, the linked-away project tier and the machine-admin policy read mode are all reproduced. | `tests/compatibility/scenarios.test.ts` — "F-05 scope isolation and suppression" | `tests/contracts/settings-precedence.test.ts` — "suppresses exactly the project-side sources when personal config is restricted" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-05 scope isolation and suppression" |
| F-06 | Providers | Eight provider routes and their adapters | REA observed | match | The eight route names and their adapters are reproduced exactly. | `tests/compatibility/scenarios.test.ts` — "F-06 the eight provider routes" | `tests/contracts/provider-registry.test.ts` — "names exactly the eight routes the target declares" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-06 the eight provider routes" |
| F-07 | Providers | Provider-owned model catalog | REA observed | mismatch | The built-in catalog carries all 22 of the target's rows, nine of them served by all eight routes, and a route that does not serve a model is absent rather than unknown. One difference remains: the target's fallback predicate is provider_ids[route] === null, and an omitted key is not null, so the target does not treat that row as unserved by gateway and resolves it to gateway — this implementation's not-served test is an absent key, a superset, so it falls back to mantle instead. The omitted key is this implementation's own transcription of the target's literal; the predicate is the audit's. | `tests/compatibility/scenarios.test.ts` — "F-07 the provider-owned model catalog" | `tests/contracts/provider-catalog.test.ts` — "carries every row of the target catalog" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-07 the provider-owned model catalog" |
| F-08 | Providers | Route selection (exactly one active route) | REA observed | match | The dispatch order, the single active route and the target's per-model override are reproduced. | `tests/compatibility/scenarios.test.ts` — "F-08 route selection" | `tests/contracts/provider-registry.test.ts` — "keeps the target dispatch order, with gateway first and firstParty last" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-08 route selection" |
| F-09 | Providers | Per-provider endpoint policy (base-URL variables, vendor-host patterns) | REA observed | match | Every route's base-URL variable list and the vendor-host patterns are reproduced, in the audit's order. | `tests/compatibility/scenarios.test.ts` — "F-09 the per-provider endpoint policy" | `tests/contracts/provider-registry.test.ts` — "declares one policy per route with the target base-URL variables" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-09 the per-provider endpoint policy" |
| F-10 | Providers | Multi-provider connection manager | Project requirement | partial | The project requirement is met — N concurrent connections, each with a reference — but the target has no such registry, so no target behaviour is matched. | `tests/compatibility/scenarios.test.ts` — "F-10 the connection registry" | `tests/contracts/provider-registry.test.ts` — "lists the connections it holds" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-10 the connection registry" |
| F-11 | Providers | Credential handling as references only | Project requirement | partial | The project requirement is met — a credential is a reference and a status is presence only — but the target has no such model, so no target behaviour is matched. | `tests/compatibility/scenarios.test.ts` — "F-11 credentials as references only" | `tests/security/provider-credentials.test.ts` — "never returns the credential value" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-11 credentials as references only" |
| F-12 | Request | Request construction (URL, headers, body, auth) | REA observed | match | The URL, the headers, the body and the authentication are the target's observed shapes. | `tests/compatibility/scenarios.test.ts` — "F-12 request construction" | `tests/contracts/drivers.test.ts` — "sets the anthropic version and the content type" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-12 request construction" |
| F-13 | Request | Retry, timeout, and error classification | REA observed | partial | The retry set, the 600000 ms fallback and the error classification are the target's observed rules. Measured: the retry set, the fallback and the classification. The 401 cache invalidation and the x-should-retry header are established by the audit and implemented here, but this probe does not compare them. | `tests/compatibility/scenarios.test.ts` — "F-13 retry timeout and error classification" | `tests/contracts/drivers.test.ts` — "retries 408, 409, 429 and every 5xx" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-13 retry timeout and error classification" |
| F-14 | Request | Response parsing and streaming | REA observed | partial | The non-streaming body and the SSE stream parse into the same events, and the SDK's extended agent.* vocabulary is tolerated. Measured: the non-streaming body, one SSE frame, and the extended vocabulary. The audit also records the 204 and binary paths, the content-length branch, the text() helper and the non-enumerable request and workspace members, which are implemented but not compared here. | `tests/compatibility/scenarios.test.ts` — "F-14 response parsing and streaming" | `tests/contracts/drivers.test.ts` — "parses a non-streaming body into the same events" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-14 response parsing and streaming" |
| F-15 | Request | Local gateway as a second request path | REA observed | match | The gateway user agent, the workspace-id rejection and the count-tokens path — local for a Bedrock upstream, `501 not_supported` otherwise — are the target's observed behaviour. | `tests/compatibility/scenarios.test.ts` — "F-15 the local gateway" | `tests/contracts/drivers.test.ts` — "sets the anthropic version and the content type" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-15 the local gateway" |
| F-15b | Request | The transport, the retry loop, and SigV4 signing | REA observed | match | The two SigV4 service names and the region are the target's observed values. The signing scope string this implementation builds is the standard AWS form, not an observed value: the audit observes the service names and the region, not the scope's shape. | `tests/compatibility/scenarios.test.ts` — "F-15b the transport the retry loop and sigv4" | `tests/contracts/provider-transport.test.ts` — "signs with the service name the driver wrote into the request, not a constant" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-15b the transport the retry loop and sigv4" |
| F-16 | Agent | Agent turn request and continuation | REA observed | partial | A refused call is answered with the target's observed <tool_use_error> wrapper and is_error: true, and the wrapper carries the decision and its reason type; the wording inside the wrapper is this implementation's. Measured: the refusal envelope. The turn request and the continuation are established by the audit and implemented here, but this probe does not compare them. | `tests/compatibility/scenarios.test.ts` — "F-16 the agent turn and its continuation" | `tests/contracts/agent-loop.test.ts` — "a denied call is refused, answered with a tool_use_error, and ends the turn" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-16 the agent turn and its continuation" |
| F-17 | Agent | Tool-call scheduling and dispatch order | REA observed | match | The target's scheduling is reproduced: a call that is concurrency safe runs in parallel with the run of safe calls before it, a call that is not concurrency safe stands alone and stops the run, a tool that does not declare the flag is not concurrency safe, and the next model request waits for every call's result. | `tests/compatibility/scenarios.test.ts` — "F-17 tool-call scheduling order" | `tests/contracts/agent-loop.test.ts` — "collects the tool calls of a turn in the order they appear" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-17 tool-call scheduling order" |
| F-17b | Agent | The projected tool-result content is a string | REA observed | match | The projected block is `{tool_use_id, type, content:<string>}` with `is_error: true` added only for a failure. | `tests/compatibility/scenarios.test.ts` — "F-17b the projected tool-result content is a string" | `tests/contracts/tool-result-projection.test.ts` — "carries no is_error member on a success" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-17b the projected tool-result content is a string" |
| F-18 | Agent | Tool result shaping and permission feedback | REA observed | mismatch | The permission feedback rides along in the tool result, but this implementation names the members permissionDecision {decision, source, reasonType} and nonExecutionKind, where the target names permission_decision {decision, source, reason_type}, non_execution_kind, user_feedback and remedy. Three differences: the members are renamed, the target's user_feedback has no counterpart here, and the target's id is this implementation's toolUseId. The wording of the decision and its reason type are the target's. | `tests/compatibility/scenarios.test.ts` — "F-18 tool-result shaping and permission feedback" | `tests/contracts/tool-registry.test.ts` — "produces an error envelope with the decision attached when the check denies" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-18 tool-result shaping and permission feedback" |
| F-19 | Permissions | Permission decision vocabulary | REA observed | match | The behaviour, source and reason-type vocabularies are the target's closed sets: this implementation's own strictness table enumerates the three behaviours, and every one of the target's seven sources and three reason types is carried through the prompt unchanged. | `tests/compatibility/scenarios.test.ts` — "F-19 the permission decision vocabulary" | `tests/contracts/permission-decision.test.ts` — "uses only the closed behavior, source and reason-type vocabularies" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-19 the permission decision vocabulary" |
| F-20 | Permissions | Rule precedence and modes | REA observed | partial | Deny wins over allow, and a deny blocks in every mode this implementation has, the five the audit names and a sixth of its own. The precedence between the ask and allow lists — deny, then ask, then allow — is this implementation's own, because the audit records that rule as unknown. | `tests/compatibility/scenarios.test.ts` — "F-20 rule precedence and the modes" | `tests/security/permission-rules.test.ts` — "lets a broad deny beat a narrower allow" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-20 rule precedence and the modes" |
| F-21 | Permissions | Decision reasons and the file-mutating tool set | REA observed | mismatch | The file-mutating set is exactly Edit, Write and NotebookEdit, and this implementation produces the audit's `rule` and `subcommandResults` reason kinds; this implementation adds a seventh kind, `noRuleMatch`, that the target's six do not carry. | `tests/compatibility/scenarios.test.ts` — "F-21 the reason kinds and the file-mutating set" | `tests/contracts/permission-decision.test.ts` — "names the tool for a permission-prompt-tool reason" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-21 the reason kinds and the file-mutating set" |
| F-22 | Permissions | Host-level gates | REA observed | match | The personal-config restriction and the `stop`-severity hook failure both deny every call. | `tests/compatibility/scenarios.test.ts` — "F-22 the host-level gates" | `tests/security/permission-rules.test.ts` — "denies every call when the personal configuration has problems and the restriction is set" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-22 the host-level gates" |
| F-23 | Permissions | Remote permission transport (`can_use_tool`) | REA observed | partial | The transport dispatcher's shape, its dropped non-string request id and its direction rules are reproduced. Measured: the dispatcher's shape, the dropped request id and the direction rules. The malformed-deny classification, the in-flight de-duplication and the trust and folder validation are established by the audit and implemented here, but this probe does not compare them. | `tests/compatibility/scenarios.test.ts` — "F-23 the remote permission transport" | `tests/contracts/mcp-control.test.ts` — "drops a can_use_tool request whose request_id is not a string, with no response" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-23 the remote permission transport" |
| F-24 | Sessions | Session storage layout and transcript format | REA observed | mismatch | The layout — JSONL under `<configDir>/projects/<project>/<sessionId>.jsonl`, with the project name derived from the working directory — is reproduced, but the record format is this implementation's own versioned one and the target's observed `transcriptSource` marker, `ccr-api` or `local-jsonl`, is not exposed: no record of this implementation's carries such a member. | `tests/compatibility/scenarios.test.ts` — "F-24 the session storage layout" | `tests/contracts/session-store.test.ts` — "keeps the transcript under <configDir>/projects/<encoded-cwd>/<sessionId>.jsonl" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-24 the session storage layout" |
| F-25 | Sessions | Resume semantics | REA observed | mismatch | The exact-title match, the ambiguity error that lists the candidates, the drop guard and the interrupted-turn rule are reproduced; so are the lookup's ordering — the file's modification time, then its creation time — and its skip rules, where a /loop session is skipped and a print session is not. One difference remains: a candidate that is live in the background is reported and the lookup continues with nothing, where the target drops such a candidate and carries on with the next one; the target's report-and-stop case is the different candidate that was continued into a live session. | `tests/compatibility/scenarios.test.ts` — "F-25 resume semantics" | `tests/contracts/session-resume.test.ts` — "reconstructs the branch that ends at the newest leaf, not the one written last" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-25 resume semantics" |
| F-26 | Sessions | Cross-restart prompt carry-over | REA observed | match | All seven of the target's outcome names are produced — `bound`, `sent`, `altered`, `no_row`, `too_old`, `future_dated` and `job_has_run` — and the binding rule is reproduced: a prompt is bound once and never delivered twice. | `tests/compatibility/scenarios.test.ts` — "F-26 the cross-restart carried prompts" | `tests/contracts/session-store.test.ts` — "reports every outcome of the vocabulary" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-26 the cross-restart carried prompts" |
| F-27 | Sessions | Compaction | — | unknown | This implementation implements the boundary marker and the summary model, but the target's own compaction behaviour was never established: the audit records the compaction trigger conditions as unknown and its ordering as not resolved, so there is nothing observed to compare this against. | `tests/compatibility/scenarios.test.ts` — "F-27 compaction" | `tests/contracts/session-resume.test.ts` — "skips the pre-compact prefix when reading and does not delete it from the file" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-27 compaction" |
| F-28 | Extensions | MCP control-request surface | REA observed | match | The host dispatcher handles exactly the 23 observed subtypes, and `can_use_tool` is not among them. | `tests/compatibility/scenarios.test.ts` — "F-28 the mcp control-request surface" | `tests/contracts/mcp-control.test.ts` — "is exactly the 23 host subtypes" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-28 the mcp control-request surface" |
| F-29 | Extensions | Directional control-request policy | REA observed | match | The three refused directions and their wordings are reproduced. | `tests/compatibility/scenarios.test.ts` — "F-29 the directional control-request policy" | `tests/contracts/mcp-control.test.ts` — "rejects every agent-originated subtype by direction" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-29 the directional control-request policy" |
| F-30 | Extensions | MCP transport and batching | REA observed | match | The stdio transport spawns with `shell: false`, the pipe stdio and the merged environment, and the 3/20 batching is the target's observed value. | `tests/compatibility/scenarios.test.ts` — "F-30 the mcp transport and its batching" | `tests/contracts/mcp-manager.test.ts` — "uses 3 for local servers and 20 for remote ones" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-30 the mcp transport and its batching" |
| F-31 | Extensions | MCP server lifecycle | REA observed | partial | This implementation's batched connect returns one state per configuration, in the order the configurations were given, and a failed server is a state and not a crash. The audit observes the target's client lifecycle — the connect, the identity-epoch eviction, the negotiation, the capabilities, the timeouts, the teardown and the reconnect — and those are implemented, but the batched state list is this implementation's own shape and is not compared here. | `tests/compatibility/scenarios.test.ts` — "F-31 the mcp server lifecycle" | `tests/contracts/mcp-manager.test.ts` — "evicts a failed memo and retries the server" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-31 the mcp server lifecycle" |
| F-32 | Extensions | Hook event matrix and handler contract | REA observed | partial | The 33 events, the two display handlers outside that set and the per-event classification are reproduced. Measured: the event set, the display handlers and the per-event classification. The mcp_tool hook type and the per-model severity thresholds are established by the audit and implemented here, but this probe does not compare them. | `tests/compatibility/scenarios.test.ts` — "F-32 the hook event matrix" | `tests/contracts/hooks.test.ts` — "lists exactly the thirty-three hook events" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-32 the hook event matrix" |
| F-33 | Extensions | Skills, subagents, plugins, marketplaces, IDE | REA observed | match | This implementation parses a plugin manifest and rules an IDE action, and the standalone skill scan and the subagent catalogue now match the target: the scan reads a root one level deep and takes the fixed file name SKILL.md, the byte limit is a million, the reserved names are refused, a subagent definition's name comes from its frontmatter rather than its file name, a definition without a description is refused, and the name is validated the way the target validates it. | `tests/compatibility/scenarios.test.ts` — "F-33 skills subagents plugins marketplaces and the ide" | `tests/contracts/extensions.test.ts` — "applies what a plugin contributes" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-33 skills subagents plugins marketplaces and the ide" |
| F-34 | Platform | Native sandbox helper | REA observed | mismatch | This implementation's syscall denylist includes `io_uring_setup` and its mount plan masks the protected paths, but this implementation establishes the sandbox with an external `bubblewrap` binary and ships no native helper, where the target's `apply-seccomp` helper is a native worker that does the namespace, mount and `prctl` work itself. | `tests/compatibility/scenarios.test.ts` — "F-34 the native sandbox helper" | `tests/security/sandbox.test.ts` — "denies the syscall surface the plan requires, including io_uring_setup" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-34 the native sandbox helper" |
| F-35 | Platform | Native seccomp notification supervisor | REA observed | mismatch | The 27-record dispatch table and the observe-never-deny rule are reproduced, but this build installs no seccomp-notification listener: its filter program carries no `SECCOMP_RET_USER_NOTIF` action, so the supervisor is never attached to a kernel notification. | `tests/compatibility/scenarios.test.ts` — "F-35 the seccomp notification supervisor" | `tests/security/sandbox.test.ts` — "observes without denying: the response error stays zero and the call continues" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-35 the seccomp notification supervisor" |
| F-36 | Platform | Whole-image native inventory | — | unknown | The whole-image native inventory produced no Evidence record — the audit records three attempts that timed out — so the target's native image was never established and nothing was compared; this implementation's own native surface is the external `bubblewrap` binary. | `tests/compatibility/scenarios.test.ts` — "F-36 the whole-image native inventory" | — | npx vitest run tests/compatibility/scenarios.test.ts -t "F-36 the whole-image native inventory" |
| F-37 | Platform | The `Bash` tool's sandbox routing | **implementation choice** (the target's routing is unobserved) | unknown | The target's routing is unobserved: the audit records the sandboxOverride reason kind, and this implementation's routing is its own. The dangerouslyDisableSandbox flag is this implementation's, not the audit's. | `tests/compatibility/scenarios.test.ts` — "F-37 the bash tool's sandbox routing" | `tests/security/bash-sandbox.test.ts` — "runs the command unconfined when the sandbox is switched off, even with the flag" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-37 the bash tool's sandbox routing" |
| F-38 | Command line | The command-line surface | REA observed | mismatch | The parser's structure, the three flag sets, the repeatable set, the optional-value boolean, the short-flag-cluster rule, the command tokens, the pattern and the validation messages are reproduced. One difference remains: the target's boolean flags consume the next token when it does not look like a flag — so -r/--resume takes an optional value — while this implementation keeps its boolean set pure and gives the token to the positionals. The audit does not enumerate the boolean set's members, so the difference is stated for the rule; the flag this implementation treats as boolean is --continue. | `tests/compatibility/scenarios.test.ts` — "F-38 the command-line surface" | `tests/contracts/cli-surface.test.ts` — "keeps the optional value of --resume" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-38 the command-line surface" |
| F-39 | Command line | The interactive terminal UI | **implementation choice** (the audit records no TUI drawing at all) | unknown | The audit records no TUI drawing at all, so the target's terminal UI at 2.1.303 was not established and nothing was compared; this implementation's renderer is its own. | `tests/compatibility/scenarios.test.ts` — "F-39 the interactive terminal ui" | `tests/contracts/ui-render.test.ts` — "produces one block per assistant message" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-39 the interactive terminal ui" |
| F-40 | Provider | The multi-provider manager surfaces | **project requirement** (a project extension, not part of the reference agent) | partial | The project requirement is met — the `/provider` command, the catalog browser, the connection switch and the two credential columns — but the target has no such surface, so no target behaviour is matched. | `tests/compatibility/scenarios.test.ts` — "F-40 the multi-provider manager surfaces" | `tests/contracts/provider-command.test.ts` — "provider list prints one row per connection with its id, name, route, base URL, and credential status" | npx vitest run tests/compatibility/scenarios.test.ts -t "F-40 the multi-provider manager surfaces" |

## The conformance documents

The per-area conformance tables live beside this one, and every row of them names its **evidence class**, the **matrix row** it backs, and the test that pins it:

| Document | Covers |
|---|---|
| [`command-surface.md`](command-surface.md) | the parser, the flag sets, the validation messages, this implementation's CLI choices, the output contracts |
| [`provider-catalog.md`](provider-catalog.md) | the eight routes, the catalog, the adapters, the manager surfaces |
| [`session-format.md`](session-format.md) | the storage layout, the record format, resume, compaction, the carried prompts |
| [`permission-matrix.md`](permission-matrix.md) | the decision vocabulary, the rules, the modes, the hooks, the transport |
| [`extension-surface.md`](extension-surface.md) | the MCP control surface, the hooks, the skills, the plugins, the subagents, the IDE |
| [`sandbox-surface.md`](sandbox-surface.md) | the five layers, the policy, the decision mapping, the environment |
| [`tool-surface.md`](tool-surface.md) | the built-in tools, the runner, the write path |
| [`settings-precedence.md`](settings-precedence.md) | the settings tiers and the observed orderings |

**Every reference in those documents is checked mechanically** by
[`tests/compatibility/references.test.ts`](../../tests/compatibility/references.test.ts):
all **285** "Pinned by" cells resolve to a file this repository has, and the
**229** titles they quote resolve to a **declared** `it`, `test` or `describe`
title in that file — **222** verbatim, **3** after normalising the typography
(`the target's` matches the source's `the target’s`), and **4** written with an
ellipsis, which the check reads as "and then some" and requires the fragment
to be the **beginning** of a declared title. The check is a check of the
**declarations**, not of the words: a comment that repeats a title does not
declare it, and a reference that names a test nobody declared fails. The
**113** cells that quote no title are checked for the file's existence only.

Every conformance row also names the **matrix row** it backs, and the check
requires that row to be one the feature matrix has.

## The honest gaps

The rows that are **not** a `match`, and why.

### `not-tested` — the scenario could not run

No row is `not-tested`: every scenario in this report ran.

### `unknown` — the target's behaviour was never established

| `F-27` | This implementation implements the boundary marker and the summary model, but the target's own compaction behaviour was never established: the audit records the compaction trigger conditions as unknown and its ordering as not resolved, so there is nothing observed to compare this against. |
| `F-36` | The whole-image native inventory produced no Evidence record — the audit records three attempts that timed out — so the target's native image was never established and nothing was compared; this implementation's own native surface is the external `bubblewrap` binary. |
| `F-37` | The target's routing is unobserved: the audit records the sandboxOverride reason kind, and this implementation's routing is its own. The dangerouslyDisableSandbox flag is this implementation's, not the audit's. |
| `F-39` | The audit records no TUI drawing at all, so the target's terminal UI at 2.1.303 was not established and nothing was compared; this implementation's renderer is its own. |

### `partial` — measured, and matched on part of the contract

| `F-01` | The parser reproduces the target's structure — `--flag=value`, `--` ending the flags, the repeatable set, the short-flag-cluster rule and the six subcommands — but the audit enumerates only the flags this implementation's own surface needs, so the flag surface is partial. |
| `F-02` | The headless rule and the three output formats are reproduced; the audit pins the formats and not the documents a run writes. |
| `F-10` | The project requirement is met — N concurrent connections, each with a reference — but the target has no such registry, so no target behaviour is matched. |
| `F-11` | The project requirement is met — a credential is a reference and a status is presence only — but the target has no such model, so no target behaviour is matched. |
| `F-13` | The retry set, the 600000 ms fallback and the error classification are the target's observed rules. Measured: the retry set, the fallback and the classification. The 401 cache invalidation and the x-should-retry header are established by the audit and implemented here, but this probe does not compare them. |
| `F-14` | The non-streaming body and the SSE stream parse into the same events, and the SDK's extended agent.* vocabulary is tolerated. Measured: the non-streaming body, one SSE frame, and the extended vocabulary. The audit also records the 204 and binary paths, the content-length branch, the text() helper and the non-enumerable request and workspace members, which are implemented but not compared here. |
| `F-16` | A refused call is answered with the target's observed <tool_use_error> wrapper and is_error: true, and the wrapper carries the decision and its reason type; the wording inside the wrapper is this implementation's. Measured: the refusal envelope. The turn request and the continuation are established by the audit and implemented here, but this probe does not compare them. |
| `F-20` | Deny wins over allow, and a deny blocks in every mode this implementation has, the five the audit names and a sixth of its own. The precedence between the ask and allow lists — deny, then ask, then allow — is this implementation's own, because the audit records that rule as unknown. |
| `F-23` | The transport dispatcher's shape, its dropped non-string request id and its direction rules are reproduced. Measured: the dispatcher's shape, the dropped request id and the direction rules. The malformed-deny classification, the in-flight de-duplication and the trust and folder validation are established by the audit and implemented here, but this probe does not compare them. |
| `F-31` | This implementation's batched connect returns one state per configuration, in the order the configurations were given, and a failed server is a state and not a crash. The audit observes the target's client lifecycle — the connect, the identity-epoch eviction, the negotiation, the capabilities, the timeouts, the teardown and the reconnect — and those are implemented, but the batched state list is this implementation's own shape and is not compared here. |
| `F-32` | The 33 events, the two display handlers outside that set and the per-event classification are reproduced. Measured: the event set, the display handlers and the per-event classification. The mcp_tool hook type and the per-model severity thresholds are established by the audit and implemented here, but this probe does not compare them. |
| `F-40` | The project requirement is met — the `/provider` command, the catalog browser, the connection switch and the two credential columns — but the target has no such surface, so no target behaviour is matched. |

### `mismatch` — measured, and different from the target's observed behaviour

A divergence from an **observed** target behaviour is a mismatch, never a
partial, and a difference of **any kind** counts — a name, a value, a member,
a kind, or a member the target has and this implementation does not. Eight rows are
measured as one.

| `F-07` | The built-in catalog carries all 22 of the target's rows, nine of them served by all eight routes, and a route that does not serve a model is absent rather than unknown. One difference remains: the target's fallback predicate is provider_ids[route] === null, and an omitted key is not null, so the target does not treat that row as unserved by gateway and resolves it to gateway — this implementation's not-served test is an absent key, a superset, so it falls back to mantle instead. The omitted key is this implementation's own transcription of the target's literal; the predicate is the audit's. |
| `F-18` | The permission feedback rides along in the tool result, but this implementation names the members permissionDecision {decision, source, reasonType} and nonExecutionKind, where the target names permission_decision {decision, source, reason_type}, non_execution_kind, user_feedback and remedy. Three differences: the members are renamed, the target's user_feedback has no counterpart here, and the target's id is this implementation's toolUseId. The wording of the decision and its reason type are the target's. |
| `F-21` | The file-mutating set is exactly Edit, Write and NotebookEdit, and this implementation produces the audit's `rule` and `subcommandResults` reason kinds; this implementation adds a seventh kind, `noRuleMatch`, that the target's six do not carry. |
| `F-24` | The layout — JSONL under `<configDir>/projects/<project>/<sessionId>.jsonl`, with the project name derived from the working directory — is reproduced, but the record format is this implementation's own versioned one and the target's observed `transcriptSource` marker, `ccr-api` or `local-jsonl`, is not exposed: no record of this implementation's carries such a member. |
| `F-25` | The exact-title match, the ambiguity error that lists the candidates, the drop guard and the interrupted-turn rule are reproduced; so are the lookup's ordering — the file's modification time, then its creation time — and its skip rules, where a /loop session is skipped and a print session is not. One difference remains: a candidate that is live in the background is reported and the lookup continues with nothing, where the target drops such a candidate and carries on with the next one; the target's report-and-stop case is the different candidate that was continued into a live session. |
| `F-34` | This implementation's syscall denylist includes `io_uring_setup` and its mount plan masks the protected paths, but this implementation establishes the sandbox with an external `bubblewrap` binary and ships no native helper, where the target's `apply-seccomp` helper is a native worker that does the namespace, mount and `prctl` work itself. |
| `F-35` | The 27-record dispatch table and the observe-never-deny rule are reproduced, but this build installs no seccomp-notification listener: its filter program carries no `SECCOMP_RET_USER_NOTIF` action, so the supervisor is never attached to a kernel notification. |
| `F-38` | The parser's structure, the three flag sets, the repeatable set, the optional-value boolean, the short-flag-cluster rule, the command tokens, the pattern and the validation messages are reproduced. One difference remains: the target's boolean flags consume the next token when it does not look like a flag — so -r/--resume takes an optional value — while this implementation keeps its boolean set pure and gives the token to the positionals. The audit does not enumerate the boolean set's members, so the difference is stated for the rule; the flag this implementation treats as boolean is --continue. |

## How to reproduce

Each row's **Reproduce** column names the command that measures that row alone:

```bash
npx vitest run tests/compatibility/scenarios.test.ts -t "F-03 the five settings tiers"
```

The whole report is checked — and re-measured — by:

```bash
npx vitest run tests/compatibility/results.test.ts
```

The results test re-runs every scenario and fails when the report disagrees
with the measurement, when a row is missing, when a `match` has no passing
test, when a row the matrix forbids is reported as a `match`, when a "What was
measured" cell is not the harness's own words, when a scenario measured
nothing, when the report's **totals** do not follow from its own rows, when
the matrix's own **Test ref** names a file the repository does not have, when
the owning task's **pinning test** is not a declared title, or when two rows
claim the same scenario.

The conformance documents' references are checked by:

```bash
npx vitest run tests/compatibility/references.test.ts
```
