# Our protocol surface

**Our own JSON-RPC over stdio.** This is the specification `CC-043` implements. It is
written before the code, so that the code is measured against something.

The **naming rule** applies to everything here: no third-party product or company is
referenced, named or cited — in this document, in the code, in the comments, or in the
identifiers. The vocabulary below is ours.

---

## 1. Why this protocol, and where it sits

The target's arrangement is the one we keep: **one process hosts the agent loop, the
tools, the permissions and the user interface**, and it reaches the outside world
through two boundaries — a network client to the model, and a **subprocess** for the
tools it does not implement.

Our protocol sits on that second boundary, and it is used in **both** directions:

- **PRRICODE is the server** for the clients that drive it — an editor, a pipeline
  runner, another agent.
- **PRRICODE is the client** for the tool providers it does not implement — a process
  that speaks this protocol over stdio and answers `tool/call`.

One vocabulary, both roles. The two sides are peers, and neither is privileged.

---

## 2. The transport

**Newline-delimited JSON over stdio.** One JSON object per line, UTF-8, `\n`-terminated.

A line-delimited framing is chosen over a length-prefixed one because a stream must
survive a reader that attaches late, and a line is the unit every tool already knows
how to print. The **message size limit is 8 MiB**; a larger frame is refused with the
`frame/too-large` error rather than truncated.

Three message kinds, distinguished by their members:

| kind | the members that mark it |
|---|---|
| a **request** | `id` and `method` |
| a **response** | `id` and either `result` or `error` |
| a **notification** | `method` and no `id` |

A request's `id` is a string or a number, and **never reused** within a session. A
notification has no `id` and is never answered.

Every frame carries `v`, the protocol version, as a major version string. A peer that
receives a major version it does not implement answers with `protocol/unsupported` and
the versions it does.

---

## 3. The frame

```jsonc
// a request
{ "v": "1", "id": 1, "method": "turn/start", "params": { "prompt": "…" } }

// a successful response
{ "v": "1", "id": 1, "result": { "turnId": "turn_1" } }

// a failed response
{ "v": "1", "id": 1, "error": { "code": "approval/denied", "message": "…", "data": { "tool": "…" } } }

// a notification
{ "v": "1", "method": "event/message", "params": { "turnId": "turn_1", "text": "…" } }
```

**The error's `code` is stable and machine-readable** — a kebab-case path whose first
segment is the area. The `message` is for a person and is never parsed. The `data` is
whatever the area needs, and is optional.

**A response must carry either `result` or `error`, never both and never neither.** A
frame that does not is refused as `frame/malformed`.

---

## 4. The method vocabulary

Six areas. Every method is `area/verb`.

| area | the methods | the direction |
|---|---|---|
| `session/*` | `session/create`, `session/status`, `session/cancel`, `session/dispose` | a client calls |
| `turn/*` | `turn/start`, `turn/abort` | a client calls |
| `tool/*` | `tool/list`, `tool/describe`, `tool/call` | **both** — a client calls a provider's, and PRRICODE calls a provider's |
| `model/*` | `model/list`, `model/describe`, `model/select` | a client calls |
| `approval/*` | `approval/request`, `approval/answer`, `approval/pending` | a client calls; a provider may call `approval/request` against a client |
| `capability/*` | `capability/describe` | a client calls |
| `event/*` | `event/message`, `event/tool`, `event/stage`, `event/diagnostic` | a peer **notifies** |

**`event/*` is notification-only.** A turn's progress is never polled; the peer that
started the turn receives the events.

---

## 5. The session lifecycle

```
   create ──► active ──► (turn/start) ──► running ──► idle ──► disposed
                 │                          │                    ▲
                 └──────── turn/abort ──────┴────────────────────┘
```

- **`session/create`** returns a session id and the **capability record** for everything
  that is enabled in this session — so a client learns at once what this agent can do.
- **`turn/start`** returns a turn id at once and then the turn's events arrive as
  notifications. The turn's end is an `event/message` carrying the turn's final state,
  or a `turn/failed` notification.
- **`turn/abort`** stops the turn. The turn still ends, with the state it reached.
- **`session/dispose`** releases the session. A disposed session answers nothing, and
  every later call is `session/disposed`.

**A turn is never implicitly retried across providers.** If the model a turn selected
becomes unavailable, the turn **fails loudly** with `model/unavailable`. The agent does
not fall back silently — a turn that ran against a different model than the one asked
for is a different turn.

---

## 6. The capability record — and the degradation contract

**Every capability reports the same shape.** One record, asked of anything:

```jsonc
{
  "enabled": true,
  "unsupported": null,          // the reason, when it is not enabled
  "…": "…",                     // the capability's own fields, beneath the shared pair
}
```

When a capability cannot run, it reports:

```jsonc
{ "enabled": false, "unsupported": "a running IDE with its extension installed" }
```

**The reason is a sentence that names what is missing.** It is never empty, never a
placeholder, and never a success. A capability that is enabled and does nothing is a
**bug**, and the degradation contract exists to make it impossible to ship quietly.

**The first layer's typed capability refusals become this shape's data.** Where the
first layer raised a typed error naming the capability it needed, the second layer
*reports* the same fact, and a caller can ask any capability the same question.

---

## 7. Approvals

**Approvals are rules**, the way the first layer's permissions are — `allow`, `ask`,
`deny` — so a matching rule decides without asking, and a rule persists.

On top of that:

- **`approval/request`** is sent when a rule says *ask*. It names the tool, the call and
  the reason, and it carries the request id the answer must quote.
- **`approval/answer`** carries `allow` or `deny` and the request id. **An answer for an
  unknown request id is dropped** and reported as `approval/unknown`, never applied to
  the wrong request.
- **An answer is attributed to the peer that gave it**, so a client that answers on the
  user's behalf is recorded as the answerer, not as the user.
- **A denial is final.** It is not re-asked within the turn.

---

## 8. The stages and the pipeline

The pipeline's stages are **pluggable**, and a stage is reached the same way whatever
it is:

- in-process, registered through a typed interface;
- a package the agent loads;
- a process speaking this protocol over stdio, answering `tool/call`.

A stage's **advance** is an `event/stage` notification carrying the stage's id, the
stage's state, and — when the stage is not proceeding — the same
`{ enabled: false, unsupported: <why> }` shape. **A stage that cannot run says so and
the pipeline reports which stage and why**, rather than skipping it silently.

---

## 9. The rules this protocol keeps

- **Never fake success.** A method either returns a result, or returns an error with a
  reason, or reports a capability as not enabled with a reason. There is no third thing.
- **Never fall back silently.** The model a turn selected is the model it runs against,
  or the turn fails.
- **Every refusal names what is missing.** `unsupported` is a sentence.
- **A frame is either understood or refused.** A malformed frame is an error, not a
  shrug.
- **The protocol surface is ours.** It is versioned, it is small, and it is not derived
  from anyone else's.
