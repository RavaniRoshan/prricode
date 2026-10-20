# Session format and resume semantics

**Target:** the pinned reference build `2.1.303`, Linux x86-64, SHA-256 `375988f457756524234695cf2d8f64ace99c5f68682e47ea24862a843c191450`.
**Source of truth:** [`docs/reverse-engineering/COVERAGE-AUDIT.md`](../reverse-engineering/COVERAGE-AUDIT.md) §2.6 "Sessions, persistence, and resumption".
**Owning task:** `CC-009` (the schema, the version policy, the migration path) and `CC-019` (the measured results).
**Matrix rows:** F-24 … F-27 in [`feature-matrix.md`](feature-matrix.md).

> **This implementation's session format is not the target's.** The target states outright that its transcript entry format is internal and "changes between versions, so scripts that parse these files directly can break on any release". This implementation therefore defines its **own** versioned format and does not claim compatibility with the target's file layout. What *is* reproduced is the target's **behavior**: the selection rules, the attach-versus-replay behavior, the drop guard, the interrupted-turn rule, and the tool-call pairing.

## Storage layout

| Element | Value | Evidence class |
|---|---|---|
| Transcript | `<configDir>/projects/<project>/<sessionId>.jsonl` — one JSON object per line, **append-only** | REA observed (the target's layout) |
| Project directory name | the working directory path with non-alphanumeric characters replaced by `-`; truncated at 200 characters with a 16-hex-character SHA-256 of the full path appended | REA observed (the replacement rule); the truncation and hash are the plan's |
| Carried prompts | `<configDir>/carried-prompts.jsonl` | implementation choice |
| Session id | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` — validated before it becomes a file name, so no id can escape the project directory | implementation choice (the target's own rule is unobserved) |

## The two path rules

A session is named by **two** things, and each has its own rule. Both rules exist so that a name a caller supplied cannot reach outside the store.

### The id is a file name, and it is validated

The session id is the transcript's **file name**: `<project>/<sessionId>.jsonl`. The pattern is `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`, and the id is checked **before** it becomes a file name — so no id can escape the project directory, and a caller-supplied id is **data**, never a lookup into an inherited member.

The **resolution** of a `--resume` target is the same rule the audit records, in this order:

1. the **id** — an exact match against the store's summaries;
2. the **title** — an exact match, and exactly one match resolves;
3. more than one title match is the target's ambiguity error, which lists the candidates with their modification times;
4. a value that is neither yields the target's own wording, and a value that *looks* like an id but is not in the store yields `No conversation found with session ID: <id>`.

### A handle is checked where it is used

A handle names a session **and** a path, and a caller can build one by hand. The store therefore checks the handle **where it is used**: the session id must be usable as a file name, and the path must be the transcript of that id inside a project directory this store opened. A hand-built handle therefore cannot read or write an arbitrary file.

A **transcript path** is the second way to name a session. The path's segments are scanned for a session id, and the **last** such segment is the one that wins — a transcript's file name is the session it holds. A path that is not a transcript of the store is refused rather than read.

## The record format

`SESSION_SCHEMA_VERSION = 1`. Every record carries its own `v`, and the reader checks it **per record**, not only on the first.

The record variants are: a **message** record (user, assistant, tool call, tool result), `provider_event`, `permission_request`, and `content_replacement`. Two members are additions over a minimal design and are labelled as such in the source:

- **`parentId`** — the record this one continues. A rewind starts a new chain from the rewind point, so the abandoned branch stays in the file and is pruned on resume. Absent links mean one chain, in file order.
- **`content_replacement`** — a record naming a target whose payload was replaced.

## The version policy

1. A record whose `v` is unknown is **refused**, never silently dropped. The error names both the found and the supported versions (`SessionVersionError`).
2. The check is enforced in **two** places: the reader, and `resumeEvents` (so a list that did not come from the store is also refused).
3. A **torn final line** — a process killed mid-append — is **discarded** by the reader, and the records before it are kept. A *complete* final line without a trailing newline is kept.
4. A **corrupt line in the middle** is a real error and is raised as a `SessionFormatError` whose message names `path:line`. Only the *final* line may be torn.
5. The **migration path** is a **reader-side rewrite** of the append-only file — never an in-place edit, and never a silent re-interpretation. A future version adds a reader that understands both versions and rewrites the file when it next appends.

## Resume semantics (target-observed, reproduced)

### Selecting a session

`--resume` accepts **a session id or a session title**.

- A title is matched **exactly**. Exactly one match resolves.
- **More than one match is an error** that lists the candidates with their modification times: `Error: --resume "<value>" matches <n> sessions. Pass one of these session IDs to disambiguate:` followed by one `  <id>  (modified <ISO timestamp>)` line per candidate.
- Zero matches yields `Error: --resume requires a valid session ID or session title when used with --print. Usage: agent -p --resume <session-id|title>`, plus `. Provided value "<value>" is not a UUID and does not match any session title.` when a value was supplied.
- A session id that is not in the store yields `No conversation found with session ID: <id>` and exit code 1.

This implementation's `SessionSummary` carries an optional `title` and an optional `modifiedAt` so the ambiguity error is expressible. The title is **derived from the first user message**, because this implementation's vocabulary has no title record — a implementation choice, labelled.

### Attaching versus replaying

When a transcript path or a session id names a **live** session, the target **attaches** to it rather than replaying it. This implementation reproduces the shape: a live session is handed off, and a `forkSession` flag **bypasses** the short-circuit, so a fork always loads a copy.

### Resuming at a message

`--resume-session-at <message-uuid>` resumes at a specific message.

- A uuid that is not present is refused with `No message found with message.uuid of: <uuid>` and the failure reason `processing_error`.
- A **drop guard** refuses a resume that would discard entries not attributable to the named turn: `resuming at <uuid> would discard entries not attributable to turn <turn>: <reason>`, with the failure reason `drop_guard_refused`. This implementation's reading of the rule: a discard that would **split** a tool turn is refused; a turn discarded **whole** is allowed. The target's exact rule is unobserved — this is this implementation's reading of the audit's gloss, and it is labelled.

### The resume point and the branch

- The **resume point** is the last assistant message that contains a `tool_use`, falling back to the last message overall.
- The **branch** is the chain that ends at the **newest leaf**, where "newest" is the greatest timestamp and a tie is won by the record **written last**. The file order is write order only: a rewound branch stays in the file and is pruned on resume.

### Tool-call pairing and the interrupted turn

- A `tool_use` is **answered** by the `tool_result` with the same id, and the pending id is **removed** the moment its result arrives.
- An assistant message **has tool calls** when any content block is a `tool_use`.
- The **interrupted-turn** rule walks the list **backward** from the end, collecting the `tool_use_id` of every `tool_result` seen in a user message; the walk continues backward while the message is an assistant message; and if any of that message's `tool_use` blocks has an id **not** in the collected set, the session ends with an unanswered tool call. The kind is reported as `none` or `pending_tool_use`.

### The structured resumed state

The resume result carries: `turnInterruptionState` (with a `kind`), `supersededToolUseIds`, `supersededToolNames`, `answeredToolUseIds`, `rescueSuppressed`, `deferredToolUse`, `planModeOnResume`, `resumedAsFork`, and `adoptedSessionId` (a resumed session may adopt a different id). `planModeOnResume` is carried in by the caller, because this implementation's vocabulary has no plan-mode record — a implementation choice.

### Telemetry

`tengu_session_resumed`, with `entrypoint` ∈ `file` | `cli_flag` | `print`.

- success: `{ name, entrypoint, success: true, resume_duration_ms, interruption_kind? }`
- failure: `{ name, entrypoint, success: false, failure_reason, error_name, error_code? }`

The failure-reason vocabulary is `not_found_explicit_id`, `processing_error`, `load_error`, `drop_guard_refused`, `worker_state_unread`.

## The `--continue` behavior

`--continue` takes **no** session id: the store selects the **newest** session for the working directory. This implementation's two failure messages are the target's:

- `No conversation found to continue` — there is nothing to continue.
- `The agent exited: could not continue the previous session (<reason>). Run agent --resume to pick a session, or start a new one.` — the failure happened **before** the restore.
- `The agent exited: startup failed after restoring the previous session (<reason>).` — the failure happened **after** the restore.

A session that is **already running in the background** is **reported** rather than silently continued.

The telemetry is the target's: `tengu_continue` with `{success}` and `resume_duration_ms`, or `{success: false, error_name}`.

> **Implementation choice.** The **store-level ordering rule** inside the lookup — which candidate sessions are skipped (a live background session, a headless one, an SDK one, a slash-command one) — **was not traced**: it lives in a module outside the retained scope. This implementation selects the newest session and reports a background-running one. That is a **labelled implementation choice**, not an observed behavior.

**Pinned by:** `tests/contracts/session-store.test.ts` and `tests/contracts/session-resume.test.ts` — the continue tests.

## Compaction

Compaction is a **boundary marker, not a deletion**.

- The pre-compact prefix is **skipped** when reading and stays in the file.
- The summary is produced by the provider and passed in; this implementation never generates one locally.
- The boundary is located by the marker's **parent link** on the branch's record chain — not by an index — so a non-message record in the compacted prefix cannot shift it.
- The marker's parent may be a non-message record; the check is against the whole chain.

## The content replacement

An oversized tool result is stored **verbatim** in the file, with a separate `content_replacement` record naming the target. The transcript keeps the data; the **context** does not.

The replacement is applied on **every** path that turns a transcript into a context, and **all three produce the same stubbed content**:

| Path | Where |
|---|---|
| the **within-turn** push | `src/agent/loop.ts` |
| the **between-turns** load | `src/agent/context.ts` (`conversationFromEvents`) |
| the **cross-turn** projection | `src/session/resume.ts` (`resumeEvents`) |

There is exactly **one** rule — `contentReplacementStub`, exported from `src/session/store.ts` — and the limit is the **store's** `maxToolResultBytes`, not a constant. The default is 256 KiB serialized — a implementation choice. The **stub's wire form** is a implementation choice too: the audit pins that the payload does not come back into the context, and not what the stub looks like.

At the boundary the rule is `bytes <= maxBytes` → the raw content; one byte over → the stub.

## The carried prompts

A prompt persisted for a later process is returned only when it is **bound** to the same session, is fresh, and has not already been delivered.

| Outcome | Meaning | Evidence class |
|---|---|---|
| `sent` | already delivered — a refusal | implementation choice |
| `bound` | taken as it stands | implementation choice |
| `altered` | taken, and the stored text was altered | implementation choice |
| `no_row` | absent, or bound to another session | implementation choice |
| `job_has_run` | refusal | implementation choice |
| `too_old` | refusal | implementation choice |
| `future_dated` | refusal | implementation choice |

The store is append-only, the last row per id wins, and a prompt is not delivered twice. The telemetry event is the target's, `tengu_carried_prompts_taken`. The age limit is 1 hour — a implementation choice; the target's threshold is unobserved.

## Conformance table

| Claim | Evidence class | Pinned by |
|---|---|---|
| The transcript is append-only JSONL under `<configDir>/projects/<project>/<sessionId>.jsonl` | REA observed | `tests/contracts/session-store.test.ts` — "writes one JSON object per line and reads the same events back in order", "keeps the transcript under …" |
| The project directory name is derived from the working directory, truncated, and hashed | REA observed + implementation choice (truncation and hash) | same file — "derives the project directory name …", "truncates a long project directory name and appends a hash of the full path" |
| A session id cannot escape the project directory, and a caller-supplied id is data | implementation choice | same file — the id-validation tests |
| A handle is checked where it is used, so a hand-built handle cannot reach an arbitrary file | implementation choice | same file — "refuses a handle that does not point at a transcript of the store" |
| A torn final line is discarded; a complete final line is kept | implementation choice | same file — the two torn-line tests |
| A corrupt line in the middle raises and names `path:line` | implementation choice | same file — "raises a format error for a corrupt line in the middle of the file" |
| An unknown record version is refused, per record, naming both versions | implementation choice | same file — "refuses a record whose version it does not know, and names both versions", "sees a format change per record, not only on the first one" |
| The oversized tool result is kept in the file and stubbed in the context | REA observed (the mechanism) + implementation choice (the limit) | `tests/contracts/session-store.test.ts`, `tests/contracts/session-resume.test.ts`, `tests/contracts/tool-result-projection.test.ts`, `tests/contracts/tool-result-stub.test.ts` — the content-replacement tests |
| All three paths that project a transcript into a context apply the replacement and produce the same stubbed content | implementation choice | `tests/contracts/tool-result-stub.test.ts` — the three-paths-agree tests |
| The limit is the **store's** `maxToolResultBytes`, not a constant | implementation choice | same file — the store's own limit test |
| A title match is exact, an ambiguous title is an error listing the candidates, and an unknown title or id has the target's wording | REA observed | same file — the target-resolution tests |
| The drop guard refuses a resume that would split a tool turn | REA observed (the mechanism) + implementation choice (the exact rule) | same file — the drop-guard tests |
| The resume point is the last assistant message with a tool use, else the last message | REA observed | `tests/contracts/session-resume.test.ts` — the two resume-point tests |
| A leaf tie is won by the record written last | implementation choice | same file — "wins a leaf tie with the one that was written last" |
| `--continue` selects the newest session, reports a background-running one, and uses the target's two failure messages | REA observed (the messages and the newest-session rule) + **implementation choice** (the store-level ordering rule was not traced) | `tests/contracts/session-store.test.ts` — the continue tests |
| The interrupted turn is detected by the backward walk | REA observed | `tests/contracts/session-resume.test.ts` — the two interrupted-turn tests |
| A `tool_use` is answered by the `tool_result` with the same id, and the pending id is removed on arrival | REA observed | `tests/contracts/session-resume.test.ts` — "pairs a tool_result with the tool_call it answers", "keeps a tool call whose result never arrived pending" |
| The compaction boundary skips the prefix and does not delete it, and the boundary is located by the parent link | REA observed (the mechanism) + implementation choice (the model) | `tests/contracts/session-resume.test.ts` — the compaction tests |
| The summary is passed in, never generated locally | REA observed | `tests/contracts/session-resume.test.ts` — "never produces a summary locally" |
| The carried-prompt vocabulary is exactly the seven names, the bound check is enforced, and a prompt is not delivered twice | REA observed (the vocabulary) + implementation choice (the semantics) | `tests/contracts/session-store.test.ts` — the carried-prompt tests |
| The telemetry event names are the target's | REA observed | same file — "emits the target's telemetry event with the outcome" |
| A transcript path names a session by the **last** session-id segment it holds | implementation choice | `tests/contracts/cli-surface.test.ts` — "scans a path for a session-id segment" |
