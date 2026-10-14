# prricode Protocol Reference

prricode speaks JSON-RPC 2.0 over stdio. A client launches the server
(`prricode serve`) and exchanges newline-delimited JSON messages: requests on
stdin, responses and notifications on stdout. The protocol is versioned by a
schema fingerprint announced during the initialize handshake.

- Protocol version: `1`
- Schema fingerprint: `sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9`
- Server name/version: announced in `initialize` (`serverInfo`)

## Handshake

**`initialize`** — first call after connection.

Params:

| field | type | notes |
|---|---|---|
| `clientInfo` | `{ name, version }` | required |
| `capabilities` | object | optional client capability set |

Result:

| field | type | notes |
|---|---|---|
| `platformFamily` | string | e.g. `unix` |
| `platformOs` | string | e.g. `linux` |
| `sandboxAvailability` | string | `available` / `unavailable` / `restricted` |
| `schema` | `{ fingerprint, version }` | protocol identity |
| `serverInfo` | `{ name, version }` | |
| `userAgent` | string | |

## Message shape

```json
{"jsonrpc": "2.0", "id": 1, "method": "session/start", "params": { ... }}
{"jsonrpc": "2.0", "id": 1, "result": { ... }}
{"jsonrpc": "2.0", "id": 1, "error": { "code": -32020, "message": "session not found" }}
```

Notifications are objects with `jsonrpc` + `method` + `params` and no `id`.

## Capabilities

Clients may be granted (and must respect) these capability flags:

| capability | meaning |
|---|---|
| `userShell` | session may execute shell commands |
| `sessionMcp` | session may load MCP servers |
| `sessionListStream` | session list changes stream as notifications |
| `feedback` | feedback submission enabled |
| `computerUseSetup` | computer-use setup flow available |
| `computerUseHostSetup` | host-level computer-use setup available |

## Method groups

### Session lifecycle
| method | purpose |
|---|---|
| `session/start` | create session (workspace root, model, provider, approval mode, MCP servers) |
| `session/read` | read session items (paginated via `cursor`) |
| `session/list` | list sessions |
| `session/resume` | reload a session from durable storage |
| `session/setModel` | switch model/provider for a session |
| `session/setApprovalMode` | switch approval mode |
| `session/setReasoningEffort` | switch reasoning effort |
| `session/rename` / `session/fork` / `session/sideChat` | rename, fork, or open a side chat |
| `session/compact` | summarize older history to reclaim context |
| `session/userShell` | run a shell command in the session workspace |

### Session and turn params

**`session/start`** params:

| field | type | notes |
|---|---|---|
| `commandId` | `CommandId` | required; idempotency key for the call |
| `workspaceRoot` | string | optional; the session workspace |
| `modelId` | string | optional; starting model for the session |
| `providerId` | `ProviderId` | optional; overrides the server's provider |
| `approvalMode` | `ApprovalMode` | optional; `closed` (default), `open`, `auto`, `suggestive` |
| `sessionId` | `SessionId` | optional; resume an id instead of minting one |
| `config` | `{ mcpServers }` | optional; per-session MCP servers |

Result: `{ sessionId, ... }`.

**`session/setModel`** params — a full model selection, not a bare model id:

| field | type | notes |
|---|---|---|
| `commandId` | `CommandId` | required |
| `sessionId` | `SessionId` | required |
| `model` | `ModelSelection` | required; all four fields required |

`ModelSelection` is `{ modelId, providerId, profileId, displayLabel }`.
`providerId` is one of `echo`, `ollama`, `ollama-cloud`, `openrouter`,
`kilo`, `openai`, `custom`. `profileId` is a client-chosen slot label (e.g.
`"default"`); `model-profile` lists the models a provider exposes so a client
can fill the selection in. The call answers with the stored selection and
emits the `session/modelChanged` notification (`{ sessionId, modelId }`).

**`turn/start`** params: `{ commandId, sessionId, input: [TurnInputPart, …] }`
with optional `displayText`, `reasoningEffort`, `workspaceRoots`. The turn
streams `turn/item` notifications (assistant text deltas, `toolUse`,
`toolResult`, user echo) and ends with `turn/completed`
(`{ sessionId, turnId, content, inputTokens, outputTokens }`).

### Turns
| method | purpose |
|---|---|
| `turn/start` | submit input (text and/or image parts) for a turn |
| `turn/cancel` | cancel the active turn |
| `turn/interrupt` | interrupt model generation without cancelling the turn |
| `turn/steer` | inject input into the running turn |
| `turn/unqueue` | remove a queued input |

### Goals
| method | purpose |
|---|---|
| `goal/set` | set the session goal; drives autonomous continuation |
| `goal/edit` | replace the objective |
| `goal/pause` / `goal/resume` | pause/resume autonomous progression |
| `goal/clear` | clear the goal |

### Workflows
| method | purpose |
|---|---|
| `workflow/cancel` | cancel a workflow run |
| `workflow/pause` / `workflow/resume` | pause/resume a run |
| `workflow/childControl` | `skip` or `retry` a child step (with `attempt`) |

### Pipeline
The product-builder pipeline (concept -> clarify -> specify -> plan -> build ->
ship, with the agent-arranged deploy and the operate log after the release).
Pipeline state persists per session in the settings table under the
`pipeline:<sessionId>` key; once a build starts, that state also carries the
build's `runId`, which resolves the session's verification report, ship
record, and operate log.

| method | purpose |
|---|---|
| `pipeline/conceptSet` | start the pipeline from a raw idea; returns the concept plus the first clarifier question |
| `pipeline/specRead` | read the latest spec draft and the current stage |
| `pipeline/planRead` | read the wave-scheduled task plan and the current stage |
| `pipeline/verifyRead` | read the session's verification report (gates, verdicts, residual risk, not-tested) |
| `pipeline/shipRead` | read the session's latest ship record (repo, tag, release URL, install steps) |
| `pipeline/operateRead` | read the session's operate log (ship, deploy, rollback, health events) |

`pipeline/conceptSet` params: `{ sessionId, idea }` (optional `commandId`).
Result: `{ commandId, concept, question }` — `concept` is the Concept JSON
(`problem`, `audience`, `value`, `nonGoals`, `successCriteria`, `ambiguities`,
`stack`); `question` is the first clarifier question, or `null` when the
concept is already unambiguous. The question also arrives as a notification
(see below).

`pipeline/specRead` params: `{ sessionId }`. Result: `{ spec, stage }` — `spec`
is the latest Spec JSON (`concept`, `requirements`, `design`, `tasks`,
`version`), or an empty draft (version 1, no requirements) when the pipeline
has not started; `stage` is the current stage label (`concept`, `clarify`,
`specify`, `plan`, `build`).

`pipeline/planRead` params: `{ sessionId }`. Result: `{ waves, stage }` —
`waves` is an array of waves, each an array of task ids in dependency order
(empty until the plan exists); `stage` is the current stage label.

`pipeline/verifyRead` params: `{ sessionId }`. Result: `{ report }` — the
verification report (`run_id`, `gates`, `requirements`, `not_tested`,
`residual_risk`; gate entries carry `command`, `exit_code`, `passed`,
`evidence_tail`, `duration_ms`; requirement entries carry `requirement_id`,
`verdict` (`pass`/`fail`/`unverified`), `evidence`) or `null`. Resolution:
the `runId` stored in the session's pipeline state when that run has a
persisted dossier, otherwise the most recent `dossier:<runId>` row in the
data dir (v0.2 does not scope dossiers by session). The rendered
`acceptance-dossier.md` for a run lives in its run directory; the TUI opens
it from the verify rail with `/dossier`.

`pipeline/shipRead` params: `{ sessionId }`. Result: `{ ship }` — the latest
`ShipRecord` (`run_id`, `repo`, `release_url`, `tag`, `install_steps`,
`rolled_back_from`, `created_at`) or `null`. Resolution: the `runId` stored
in the session's pipeline state when that run has a persisted
`ship:<runId>` row, otherwise the most recent such row (v0.3 does not scope
ship rows by session, matching `verifyRead`). The record has no field that
could carry deploy material: credential values never leave the deploy child
process's environment, are never persisted, and never reach this method.

`pipeline/operateRead` params: `{ sessionId }`. Result: `{ events }` — the
operate log entries, oldest first (`run_id`, `kind`, `detail`, `at`), read
from `<data_dir>/operate/<runId>.jsonl`. The run id resolves exactly as the
ship record's (the pipeline state's `runId`, else the session id), with the
most recent log in the data dir's operate directory as the fallback, so a
session that never operated reads an empty list rather than an error. The
log records that a ship, deploy, rollback, or health check happened — never
the secret material; every detail is redacted at the boundary.

Pipeline notifications ride the existing `turn/item` notification: each
pipeline item carries `kind: "pipeline_question"`, `role: "assistant"`, a
`stage` label carrying the plain stage name (e.g. `"stage":"clarify"`), and
text content holding the clarifier question. Clients must ignore unknown
notifications.

### Approvals
| method | purpose |
|---|---|
| `approval/listPending` | list pending approval requests |
| `approval/decide` | answer a pending request (`choiceId` for `requirementId`) |

### Computer use
| method | purpose |
|---|---|
| `computerUseSetup/check` | permission state (accessibility, input monitoring, screen recording) and setup phase |
| `computerUseSetup/start` | begin/re-run the permission setup flow |
| `computerUseSettings/read` | read settings (computer control, screenshots, blocked apps) |
| `computerUseSettings/update` | update settings |

### Subagents and tasks
| method | purpose |
|---|---|
| `subagent/sendMessage` | message a subagent |
| `subagent/close` | close a subagent |
| `task/background` / `task/stop` / `task/list` | background-task control |

### Models, usage, media
| method | purpose |
|---|---|
| `model/list` | list visible models for the active provider |
| `usage/read` | aggregate token usage and cost for the session |
| `media/upload` | chunked upload (base64 chunks, reassembled by `uploadId`) |
| `userInput/answer` | answer a question the agent asked mid-turn |
| `recap/request` | request a session recap summary |

### Skills, plugins, hooks, feedback, views, logs
| method | purpose |
|---|---|
| `skill/list` / `skill/import` | list skills; import from a source path or URL |
| `plugin/list` / `plugin/install` | plugin inventory and install |
| `hook/list` | configured hooks |
| `feedback/submit` | submit feedback |
| `view/page` / `view/subscribe` / `view/unsubscribe` | read and stream session views |
| `item/readOutput` | read a stored item's output payload |

## Error kinds

Standard JSON-RPC codes plus these prricode-specific codes:

| code | meaning |
|---|---|
| `-32010` | capability required (`data.capability` names it) |
| `-32020` | session not found |
| `-32030` | workflow not found |
| `-32040` | approval not found |
| `-32050` | subagent not found |
| `-32060` | computer use unavailable |
| `-32070` | user input invalid |
| `-32603` | internal error |

## Core types

- `SessionId`, `TurnId`, `CommandId`, `ApprovalId`, `SubagentId`, `TaskId`,
  `WorkflowRunId`, `UploadId`, `UserInputId` — UUIDv7 identifiers.
- `TurnInputPart` — `{ type: "text", text }` or `{ type: "image", data, mediaType }`.
- `SessionItem` — `{ id, kind, role?, content? }`; content parts are
  `text`, `toolUse` (`{ name, input }`), or `toolResult` (content parts).
- `ApprovalMode` — `closed`, `open`, `auto`, `suggestive`.
- `ModelSelection` — `{ modelId, providerId, profileId, displayLabel }`; all
  four fields required (see `session/setModel`).
- `ReasoningEffort` — `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
- `ComputerUsePermission` — `granted`, `missing`, `unknown`.
- `ComputerUseSetupPhase` — `dormant`, `inProgress`, `restartRequired`, `readyForTarget`, `stopped`.
- `ComputerUseChoice` — `ask`, `alwaysAllow`.
- `SkillSource` — `bundled`, `imported`, `project`.

## Notifications

The server emits JSON-RPC notifications (no `id`) for streaming state. The
runtime notification set (turn lifecycle, item deltas, approval requests,
session list changes) is documented in `docs/ARCHITECTURE.md` as the runtime
matures; clients must ignore unknown notifications.

## CLI surface

`prricode` ships the same command grammar as the server protocol, for
terminal use: `resume`, `exec`, `config`, `export`, `trace`, `model-profile`,
`skills`, `voice`, `plugins`, `sandbox`, `schema`, `serve`, `session-message`,
`mcp`, `auth`, `login`, `logout`, `init`.

Global flags: `--provider`, `--model`, `--base-url`, `--reasoning-effort`,
`--approval-mode`, `--permission-profile`, `--worktree`,
`--context-compaction-strategy`, `--data-dir`.
