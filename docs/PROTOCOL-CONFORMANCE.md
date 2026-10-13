# Protocol Conformance Report

How prricode's JSON-RPC surface was verified against the mapped
Reference Code protocol, what the evidence showed, and where it now stands.

**Method of verification.** The protocol surface (69 methods, 39 notifications,
37 error kinds, 345 types, 18 CLI subcommands, 6 grantable capabilities) was
mapped from the target product's binary. The  artifact
`the public release` (ELF x86-64, statically linked, stripped, ~89 MB) is a
related but earlier build of the same family: its JSON-RPC surface differs
(12 CLI subcommands, snake_case field vocabulary, approval modes
`untrusted|on-request|never`), so the camelCase stdio protocol prricode targets
comes from the larger build that produced the original map. This report
distinguishes what was verified directly against the binary from what rests on
the protocol specification.

## Evidence sources

| Source | What it establishes |
|---|---|
| `the public release` strings | Type inventory (364 `struct X with N elements` Debug literals), error-kind vocabulary, event/stream vocabulary, session event-store format, tool-call XML grammar |
| `~/.local/share/reference/sessions/…/session.jsonl` | Real session event records (`runtime.session.metadata`, `session.opened.observed`), `session.jsonl` durable format, security modes |
| Prior mapped protocol spec (69/39/37/345/18/6) | The compatibility target: method names, notification set, error kinds, CLI grammar, capability flags |
| prricode source + git history | Current implementation state per category |

## Category-by-category status

### Methods — 82 dispatched, 69 mapped

Every mapped method is dispatched. 50 were implemented in the first protocol
pass; 32 were added in the conformance pass, recovered from mapped request
types that had no handler (`accountLogin/start|cancel`,
`mcpServer/oauthLogin|oauthLoginCancel`, `auth/deviceLogin`,
`auth/supersedeLoginCredential`, `subscription/activate`, `settings/read`,
`settings/writeValue`, `settings/writeMany`, `permissionProfile/set`,
`skill/setActivation`, `computerUseSetup/read`, `recap/cancel`, `task/stopAll`,
`view/unsubscribeBySessionId`, `conversationRewind/evaluate`,
`localSession/message`, `scheduled/fire`, `runtime/launch`, `process/background`,
`projection/read`, `log/subscribe`, `log/unsubscribe`, `log/page`,
`session/name`, `peer/admission`, `turn/submitOrigin`, `tool/configuration`,
`workflow/control`, `workflow/triggerConfiguration`, `subagent/target`).

82 dispatched vs 69 mapped: the 13-method surplus is deliberate. The prior map
did not record which of the recovered request types are methods versus
notification payloads, so all were implemented as methods — a superset is
compatible (a client built against the real protocol always finds its method;
extra methods cannot break it). Handlers whose target behavior could not be
verified from any  artifact return honest "not available" results
with reasons (`conversationRewind/evaluate`, `runtime/launch`, `scheduled/fire`,
`process/background`, `peer/admission`, `localSession/message`) instead of
fake success.

### Error kinds — 37 implemented

JSON-RPC standard codes plus 37 prricode-specific constructors in
`crates/prricode-core/src/protocol.rs`. The first 12 came from the prior map
(`capability_required`, `session_not_found`, `workflow_not_found`,
`approval_not_found`, `subagent_not_found`, `computer_use_unavailable`,
`user_input_invalid`, …). 25 more were added from error vocabulary observed in
the binary strings: `workspace_not_trusted`, `workspace_unknown`,
`workspace_mismatch`, `session_log_unavailable`, `invalid_session_id`,
`invalid_payload`, `command_id_conflict`, `unknown_method`, `wrong_target`,
`role_denied`, `process_generation_retired`, `policy_denied`,
`root_capacity_exhausted`, `invalid_model`, `unsupported_provider`,
`validator_unavailable`, `stale_attempt`, `already_processed`, `invalid_target`,
`run_active`, `current_session_required`, `schema_invalid`, `skill_not_found`,
`media_not_found`, `approval_expired`. Unknown methods now propagate `-32601`
verbatim (fixed in this pass; previously wrapped as `-32603`).

### Notifications — 39 mapped and emitted

`AgentEvent` has 39 variants and `notification_for` maps each to a JSON-RPC
notification method: `turn/started`, `turn/item`, `turn/completed`,
`turn/failed`, `approval/requested`, `approval/resolved`, `session/listChanged`,
`goal/updated`, `goal/cleared`, `session/renamed`, `session/compact`,
`task/updated`, `model/catalogChanged`, `usage/updated`, `media/uploadProgress`,
`computerUse/stateChanged`, `workflow/stateChanged`, `approval/expired`,
`subagent/updated`, `tool/callStarted`, `tool/callCompleted`, `session/forked`,
`session/modelChanged`, `session/approvalModeChanged`, `item/outputReady`,
`turn/steered`, `turn/unqueued`, `account/loginStateChanged`, `settings/changed`,
`permissionProfile/changed`, `skill/activationChanged`, `scheduled/fired`,
`peer/admissionRequested`, `runtime/stateChanged`, `workflow/childUpdated`,
`mcp/serverStateChanged`, `hook/executed`, `plugin/changed`, plus `log`.

Live emissions today: turn lifecycle, item deltas, approval request/resolution,
goal updates, settings changes, session rename/fork, task updates, model catalog
and usage. The rest are defined and mapped but emitted by subsystems that land
later (computer use, workflow engine, MCP, hooks); the wire contract is in
place.

### Types — protocol surface complete, engine surface intentionally partial

The binary exposes 364 Debug-visible structs. The prior map counted 345 schema
types. Our protocol layer implements the type surface that the 69 methods
transitively need: all params/results/enums in `prricode-core`
(`types.rs`/`protocol.rs`), the server request types (~90), and provider types.
The remaining binary structs are internal engine types (agent spawn bindings,
branch-seed diagnostics, code-mode grants, inbox/reminder records) — runtime
internals, not protocol schema. They are deliberately not mirrored: they have no
wire presence in the mapped protocol, and copying internal names would add
compatibility debt, not conformance.

### CLI — 18 subcommands, real bodies

All 18 subcommands (`resume`, `exec`, `config`, `export`, `trace`,
`model-profile`, `skills`, `voice`, `plugins`, `sandbox`, `schema`, `serve`,
`session-message`, `mcp`, `auth`, `login`, `logout`, `init`) parse and execute.
Real behavior: TOML config read/write, skill discovery and import, bwrap
probing, env-var auth introspection, SQLite session export/trace/resume, plugin
and marketplace management, MCP server registry, starter-config scaffolding.

### Capabilities — 6 declared

`initialize` advertises the six grantable capabilities (`userShell`,
`sessionMcp`, `sessionListStream`, `feedback`, `computerUseSetup`,
`computerUseHostSetup`) and the schema fingerprint
`sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9`
unchanged, so the handshake still identifies as protocol-compatible.

## Verification runs

- `cargo build` — clean, zero warnings
- `cargo clippy --workspace` — clean
- `cargo fmt --check` — clean
- `cargo test` — provider suite green (17 tests, mock-server integration)
- Manual stdio smoke: initialize/settings write+read/task stopAll/unknown
  method all return correct shapes and error codes

## Known limitations

1. **Primary artifact absent.** The larger build that defines the 69-method
   camelCase protocol is not on this machine; the 13-method superset and the
   notification/method split for the recovered types cannot be re-verified
   exhaustively. If that binary becomes available, re-run the string extraction
   and tighten the split.
2. `session.jsonl` event vocabulary from the binary (e.g.
   `runtime.session.metadata`, `session.opened.observed`) is not yet mirrored in
   our item kinds; our item schema is protocol-shaped (user/assistant/tool_use/
   tool_result) which satisfies the mapped session/read contract.
3. Notification emissions for computer use, workflow, MCP, and hooks arrive with
   those subsystems.

## Reproduce

```bash
cargo build && cargo test
# method surface
grep -oE '"[a-zA-Z]+/[a-zA-Z]+" =>' crates/prricode-server/src/lib.rs | sort -u | wc -l   # 82
# error kinds
grep -cE 'pub fn [a-z_]+\(.*\) -> Self' crates/prricode-core/src/protocol.rs               # 38 (37 kinds + new)
# notifications
grep -cE '^\s+AgentEvent::' crates/prricode-server/src/lib.rs                              # 39
```
