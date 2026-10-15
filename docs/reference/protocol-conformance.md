# Protocol Conformance Report

What prricode's JSON-RPC surface is, what is complete, what is deliberately
partial, and what degrades honestly. Every number below is checkable with the
commands in **Reproduce**.

The surface prricode targets is specified as **69 methods, 39 notifications,
37 error kinds, 345 types, 18 CLI subcommands, 6 grantable capabilities**, with
a schema fingerprint that identifies the protocol version at the handshake.

## What defines the surface

| Source | What it establishes |
|---|---|
| The protocol specification (69/39/37/345/18/6) | The compatibility target: method names, notification set, error kinds, CLI grammar, capability flags |
| `crates/prricode-core` (`types.rs`, `protocol.rs`) | The wire types: params, results, enums, the 37 error-kind constructors, `AgentEvent` and its notification mapping |
| prricode source + git history | Current implementation state per category, including which handlers are honest stubs |

## Category-by-category status

### Methods — 82 dispatched, 69 specified

Every specified method is dispatched. 50 were implemented in the first protocol
pass; 32 more were added in the conformance pass, recovered from request types
that had no handler (`accountLogin/start|cancel`,
`mcpServer/oauthLogin|oauthLoginCancel`, `auth/deviceLogin`,
`auth/supersedeLoginCredential`, `subscription/activate`, `settings/read`,
`settings/writeValue`, `settings/writeMany`, `permissionProfile/set`,
`skill/setActivation`, `computerUseSetup/read`, `recap/cancel`, `task/stopAll`,
`view/unsubscribeBySessionId`, `conversationRewind/evaluate`,
`localSession/message`, `scheduled/fire`, `runtime/launch`, `process/background`,
`projection/read`, `log/subscribe`, `log/unsubscribe`, `log/page`,
`session/name`, `peer/admission`, `turn/submitOrigin`, `tool/configuration`,
`workflow/control`, `workflow/triggerConfiguration`, `subagent/target`).

82 dispatched vs 69 specified: the 13-method surplus is deliberate. The
specification does not record which of the recovered request types are methods
versus notification payloads, so all were implemented as methods — a superset is
compatible (a client always finds its method; extra methods cannot break it).
Handlers whose behavior is not implemented return honest "not available"
results with reasons (`conversationRewind/evaluate`, `runtime/launch`,
`scheduled/fire`, `process/background`, `peer/admission`, `localSession/message`)
instead of fake success.

### Error kinds — 37 implemented

JSON-RPC standard codes plus 37 prricode-specific constructors in
`crates/prricode-core/src/protocol.rs` (`capability_required`,
`session_not_found`, `workflow_not_found`, `approval_not_found`,
`subagent_not_found`, `computer_use_unavailable`, `user_input_invalid`,
`workspace_not_trusted`, `workspace_unknown`, `workspace_mismatch`,
`session_log_unavailable`, `invalid_session_id`, `invalid_payload`,
`command_id_conflict`, `unknown_method`, `wrong_target`, `role_denied`,
`process_generation_retired`, `policy_denied`, `root_capacity_exhausted`,
`invalid_model`, `unsupported_provider`, `validator_unavailable`,
`stale_attempt`, `already_processed`, `invalid_target`, `run_active`,
`current_session_required`, `schema_invalid`, `skill_not_found`,
`media_not_found`, `approval_expired`, …). Unknown methods propagate `-32601`
verbatim.

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

The specification counts 345 schema types. Our protocol layer implements the
type surface the 69 methods transitively need: all params/results/enums in
`prricode-core`, the server request types (~90), and provider types. The
remaining internal engine types are dispositioned explicitly and queryably:
`prricode_core::internals::inventory()` maps every family to either
**Implemented** (the concept exists in prricode under our own naming — these
types had no protocol-wire presence, so mirroring their names would add
compatibility debt, not conformance) or **Flagged** (a `// future work:` entry
naming what is not built). See `docs/explanation/internals-disposition.md`.

### CLI — 18 subcommands, real bodies

All 18 subcommands (`resume`, `exec`, `config`, `export`, `trace`,
`model-profile`, `skills`, `voice`, `plugins`, `sandbox`, `schema`, `serve`,
`session-message`, `mcp`, `auth`, `login`, `logout`, `init`) parse and execute.
Real behavior: TOML config read/write, skill discovery and import, bwrap
probing, **prricode's own credential store** (`auth token/status`), SQLite
session export/trace/resume, plugin and marketplace management, MCP server
registry, starter-config scaffolding.

The CLI is a superset of the smallest earlier command set in the family and
matches the specified 18-subcommand surface; the approval modes are
`closed|open|auto|suggestive`.

### Capabilities — 6 declared

`initialize` advertises the six grantable capabilities (`userShell`,
`sessionMcp`, `sessionListStream`, `feedback`, `computerUseSetup`,
`computerUseHostSetup`) and the schema fingerprint
`sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9`
unchanged, so the handshake identifies as protocol-compatible.

## Property tests

The verifier's oracle is stronger than "the build is green". Each EARS
requirement generates a property test the workspace can actually run, written
into `tests/generated/` and executed as a `property` gate alongside
typecheck/build/test.

Only what a criterion states **literally and checkably** becomes an assertion:

- a count ("the suite shall have at least three tests") counts the workspace's
  own test functions across py/rs/js/ts
- a file claim ("`app.py` shall exist") checks the file

Anything that would require guessing how to run the product — output contents,
exit codes, timing — generates a test that **skips loudly**, so the run reports
that requirement as unverified rather than passing vacuously. A generated test
that passed because it asserted nothing would be worse than no test at all.

The generated count mirrors `prricode_verify::properties::count_workspace_tests`
in Rust, so the two sides cannot drift.

## Delivery economics

Every verification pass records what the run cost and what it delivered for
it, as its own persisted row and the last section of the dossier:

- **Build tokens** — the model tokens the build turns spent
- **Gate wall time** — the milliseconds the per-task gates consumed
- **Delivered units** — requirements total / verified / failed / unverified
- **Per verified requirement** — tokens and gate seconds per verified unit

The two currencies stay separate on purpose: blending tokens with seconds
would hide which one is expensive. When nothing was verified the rate is
reported as *not computable* rather than divided by zero.

Read it back with `pipeline/verifyRead` (`economics` alongside `report`), see
it in the TUI rail (`verify: gates 3/3 · verdicts 1P/0F/1U · 9.0k tok/req`),
or read `acceptance-dossier.md` in the run directory.

## Verification runs

- `cargo build` — clean, zero warnings
- `cargo clippy --workspace --all-targets` — clean at `-D warnings`
- `cargo fmt --check` — clean
- `cargo test --workspace` — 226 tests green (mock-server HTTP integration,
  scripted providers, real temp-workspace tool execution, gate runs)
- Live provider runs — catalog, tool-calling turn, `session/setModel`, the
  credential store, and the build → verify → dossier chain (see
  `docs/how-to/run-the-tests.md`)
- Manual stdio smoke: initialize / settings write+read / task stopAll / unknown
  method all return correct shapes and error codes

## Known limitations

1. **Superset split.** The 13 methods beyond the specified 69 exist because the
   specification does not record which recovered request types are methods
   versus notification payloads. If a conformance oracle becomes
   available, re-check the split.
2. `session.jsonl`-style event vocabulary is not mirrored in our item kinds;
   our item schema is protocol-shaped (user/assistant/tool_use/tool_result),
   which satisfies the mapped `session/read` contract.
3. Notification emissions for computer use, workflow, MCP, and hooks arrive with
   those subsystems.

## TUI surface — spec-matched

- Keymap: Return submits the composer, `ctrl+j`/`ctrl+m`/`shift+enter` newline,
  `ctrl+r` history search, `ctrl+p`/`ctrl+n` history navigation, `ctrl+g` edit
  in `$VISUAL`/`$EDITOR`, `ctrl+l` clear terminal, `alt+b`/`alt+f` word moves,
  `ctrl+k`/`ctrl+y` kill/yank, `ctrl+t` transpose, `esc` close/cancel,
  `ctrl+v` paste images.
- Approval outcomes: `allow:approved`, `allow:approved_for_session`,
  `allow:session_policy_amendment`, `approval timed out`, `denied by user` —
  realized as y/a/n inline approval with a workspace-scoped allow list and a
  timeout that denies rather than hangs.
- Slash commands: `/model`, `/sessions`, `/settings`, `/provider`, `/help`,
  `/new`, `/resume`, `/clear`, `/export`, `/quit`, `/exit` — all implemented in
  the TUI command bar, plus the Product Builder set (`/concept`, `/spec`,
  `/plan`, `/build`, `/ship`, `/deploy`, `/operate`, `/dossier`).

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
