# The protocol surface — conformance

**The specification:** [`docs/protocol/PROTOCOL.md`](../protocol/PROTOCOL.md). The
specification is the design; this document says what was built against it, and
where the specification left a choice open, which reading was taken and why.
**Owning task:** `CC-043` in
[`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**The implementation:** `src/protocol/` — thirteen modules.
**The test:** `tests/contracts/protocol.test.ts`, over a **real pipe**: the server is
a **real child process** (`tests/fixtures/protocol-server.ts`) and the client is
the same module the server is built from.

---

## 0. The labels, and why this surface has no target rows

This surface is **our own design**. The pinned target has no counterpart for it,
so there is nothing to compare it against and **no row in the compatibility
matrix** — a divergence is not a compatibility claim, and a compatibility row
must not be weakened to make room for one.

Every row of this document therefore carries the first layer's **clone-choice
label**:

| label | meaning | here |
|---|---|---|
| `Project requirement` | a product extension: the target does not have this behaviour, and nothing about it is a claim about the target | **every row of this document** |

and, inside the second layer, the label that says where the row comes from:

| label | meaning |
|---|---|
| `specified` | pinned by `docs/protocol/PROTOCOL.md` — the specification says it, and the implementation says it |
| `implementation choice` | the specification is silent, and the reading below is ours |

The two are orthogonal: a row is `Project requirement` **and** `specified`, or
`Project requirement` **and** `implementation choice`. The second column is the
honest one — it says which parts of the surface are the specification's promise
and which parts are ours, so a later milestone can move a row from the second
column to the first without guessing.

---

## 1. The transport

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the framing | newline-delimited JSON over stdio, one JSON object per line, UTF-8, `\n`-terminated (`PROTOCOL.md` §2) | `encodeFrame` writes one JSON object and one `\n`; `createProtocolConnection` reads lines and never joins two frames into one | `the transport › a frame is one JSON object per line, and the line is terminated` |
| the size limit | the message size limit is **8 MiB**; a larger frame is refused with `frame/too-large` rather than truncated | `MAX_FRAME_BYTES` is `8 * 1024 * 1024`, counted in **UTF-8 bytes**; the encoder refuses to write an over-long frame, and the reader refuses one **while it is still being read**, so the buffer stays bounded | `the transport › the size limit is eight mebibytes`; `the malformed cases are refused with a reason › a frame over the size limit is refused rather than truncated`; `… › a client refuses to put a frame over the size limit on the wire` |
| the refusal of an over-long frame | "rather than truncated" | the bytes already read are **dropped**, the rest of the line is discarded as it arrives, and the connection keeps serving | `… › a frame over the size limit is refused rather than truncated` (the connection survives the refusal) |
| the version | every frame carries `v`, the protocol version, as a major version string; a peer that receives a major version it does not implement answers with `protocol/unsupported` and the versions it does | `PROTOCOL_VERSION` is `"1"`; `SUPPORTED_PROTOCOL_VERSIONS` is the list the refusal carries | `the malformed cases are refused with a reason › an unknown protocol version is refused with the versions this build speaks` |

**Implementation choice — the count of the bytes.** The specification says "8 MiB"
and does not say what is counted. The count is over the **UTF-8 bytes of the JSON
text**, without the terminating newline, because the limit is about how much a
reader has to hold and a character is not a byte.

**Implementation choice — the version string.** The specification gives the shape
("a major version string") and not the number. The number is `"1"`, and the list
of accepted majors is a *list* so that a second major can be added without
changing the shape of anything that reads it.

**Implementation choice — a frame with no usable `v`.** A frame whose `v` is
missing, or is not a string, is `frame/malformed`: there is no version to be
unsupported. A frame whose `v` is a string this build does not implement is
`protocol/unsupported`. The distinction is in `readFrame` and in the peer, and
it is pinned by `… › a frame with no version at all is refused as malformed`.

---

## 2. The frame

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the three kinds | a request is `id` and `method`; a response is `id` and either `result` or `error`; a notification is `method` and no `id` | `readFrame` classifies exactly that way, and reports the kind | `the transport › the three frame kinds are told apart by their members` |
| the response's answer | a response must carry either `result` or `error`, **never both and never neither**; a frame that does not is refused as `frame/malformed` | both cases are refused, with the id the frame carried, so the peer learns which answer was refused | `the malformed cases are refused with a reason › a response with neither a result nor an error is refused`; `… › a response with both a result and an error is refused` |
| the id | a request's `id` is a string or a number, and **never reused** within a session | the peer allocates from a counter that only ever goes up, and the ids are the ones the answers carry | `the protocol surface over a real pipe › an answer carries the id of the request it answers`; `… › the ids are never reused within a session` |
| the error | the `code` is stable and machine-readable, a kebab-case path whose first segment is the area; the `message` is for a person and is never parsed; the `data` is optional | `ProtocolErrorPayload` is `{ code, message, data? }`; every code the protocol can produce is listed in `PROTOCOL_ERROR_CODES`, and **nothing in this repository parses a message** | the refusal tests below, which read the `code` of every refusal |

**Implementation choice — a request that carries an answer.** The specification
does not name the case. A frame that carries a `method` **and** a `result` or an
`error` is refused as `frame/malformed`: a request may not answer itself, and a
frame that means two things is not understood. This is the reading that keeps
"a frame is either understood or refused" true.

**Implementation choice — the areas of the codes.** The first segment of a code
names the area. The specification's own examples use `frame/*` and `protocol/*`,
which are **not** method areas, so the protocol has areas of its own: `frame`
(a frame that cannot be understood), `protocol` (the version) and `method` (the
method vocabulary — a method that does not exist, a notification-only method
that was called, a method whose parameters do not fit it, a method whose handler
failed, a method this build does not implement). The six method areas and the
notification area are `session`, `turn`, `tool`, `model`, `approval`,
`capability` and `event`.

---

## 3. The refusals — every malformed case, and what it is answered with

The specification's rule is short: **"A frame is either understood or refused. A
malformed frame is an error, not a shrug."** The implementation refuses in one
of two ways, and which one depends on whether the frame can be attributed to a
request:

| the case | the code | how the refusal is delivered | the test |
|---|---|---|---|
| a frame that is not JSON | `frame/malformed` | an `event/diagnostic` notification — the frame carried no id to answer | `… › a frame that is not JSON is refused, and the connection survives` |
| a frame over the size limit | `frame/too-large` | an `event/diagnostic` notification | `… › a frame over the size limit is refused rather than truncated` |
| a response with neither a result nor an error | `frame/malformed` | an **error response carrying the frame's id** | `… › a response with neither a result nor an error is refused` |
| a response with both a result and an error | `frame/malformed` | an **error response carrying the frame's id** | `… › a response with both a result and an error is refused` |
| an unknown method | `method/unknown` | an **error response carrying the request's id** | `… › an unknown method is refused with a reason` |
| a notification-only method called as a request | `method/notification-only` | an **error response carrying the request's id** | `… › a notification-only method is refused when it is called` |
| an unknown protocol version | `protocol/unsupported`, with the versions this build speaks | an **error response carrying the request's id** | `… › an unknown protocol version is refused with the versions this build speaks` |
| a frame with no usable `v` | `frame/malformed` | an **error response carrying the frame's id** | `… › a frame with no version at all is refused as malformed` |
| a response whose id matches no request in flight | `frame/unknown-id` | the peer's **diagnostic channel** — there is nobody to answer | (the peer's own report) |

**Implementation choice — the refusal that cannot be attributed.** The
specification does not say how a refusal reaches the peer when the refused frame
carries no id — a line that is not JSON has no id at all, and an over-long frame
cannot be parsed far enough to find one. The reading is the **`event/diagnostic`
notification**: it is the vocabulary's own diagnostic channel, and it is the only
way to say something that is not an answer without inventing a fourth frame kind.
The specification's three frame kinds are therefore intact.

A diagnostic is **never answered with a diagnostic**, so two peers cannot make
each other talk in circles, and a refusal that *is* attributable is answered as
an error response and is not repeated as a diagnostic.

**Implementation choice — the client refuses to put a bad frame on the wire.** A
client that asks for a method outside the vocabulary, or that would send a frame
over the size limit, is refused **locally**: the call throws, and nothing is
written. The specification does not say who must catch it, and a peer that
refuses its own frame is one refusal nearer the cause. Both are pinned
(`… › a client refuses to call a method that is not of the vocabulary` and
`… › a client refuses to put a frame over the size limit on the wire`).

---

## 4. The method vocabulary

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the areas | six areas, every method is `area/verb` | seven areas, twenty-one methods — the reading is in §4.1 | `the honest-report rule › the methods of the vocabulary are the ones the specification names` |
| the direction | `event/*` is **notification-only**; a turn's progress is never polled | `NOTIFICATION_ONLY_METHODS` holds the four `event/*` methods and `turn/failed`; a peer refuses to *call* one and refuses to *notify* with a request method | `… › a notification-only method is refused when it is called` |
| `tool/*` | **both** directions — a client calls a provider's, and PRRICODE calls a provider's | the same peer serves the method in either role, so the vocabulary is one and the roles are two | `the protocol surface over a real pipe › the two sides are peers` (the raw exchange in §6) |
| the areas' methods | the table's twenty methods | every one of them is served or refused with a reason; none is left out | `the honest-report rule › every method of the vocabulary answers in one of the three ways` |

### 4.1 The count: "Six areas" against a table of seven rows

The specification's prose says **"Six areas"** and its table lists **seven**
rows: `session`, `turn`, `tool`, `model`, `approval`, `capability` and `event`.

**The reading.** The six are the areas a **client calls** — the six rows whose
direction column reads "a client calls" — and the seventh row, `event/*`, is the
**notification** area, the one row whose direction column reads "a peer
**notifies**". All seven are implemented, and the count is not a limit on the
vocabulary.

**Why this reading.** It is the only one that keeps every promise the
specification makes. The `event/*` rules are stated in detail and in more than
one place — "`event/*` is notification-only", and the turn's end is "an
`event/message` carrying the turn's final state" — so a reading that dropped the
row would break the specification rather than interpret it. And the direction
column distinguishes the six from the seventh on its own.

**The count of the methods.** The table's twenty methods, plus `turn/failed` —
which the specification names in §5 ("or a `turn/failed` notification") and does
not list. It is a method of the `turn` area, and it is **notification-only**,
because a turn that has already been answered cannot be failed by a second
answer.

---

## 5. The session and the turn

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| `session/create` | returns a session id and the capability record for everything that is enabled in this session | `{ sessionId, state, capabilities }`, and the capabilities are **every** capability this server knows, each in the shared shape | `the protocol surface over a real pipe › a test client and a test server talk to each other over a real pipe`; `the capability record › one shape is asked of anything` |
| the lifecycle | create → active → (turn/start) → running → idle → disposed; turn/abort returns to idle | the four states are `active`, `running`, `idle` and `disposed`, and the moves are the diagram's | `… › an aborted turn still ends, with the state it reached` (the session is `idle` again) |
| `turn/start` | returns a turn id at once, and the turn's events arrive as notifications | `{ turnId }` is answered before the turn runs; the events follow as `event/*` notifications | `… › a turn returns its id at once, and its events arrive as notifications` |
| the turn's end | an `event/message` carrying the turn's final state, or a `turn/failed` notification | the end is one or the other, and never both | `… › a turn returns its id at once…`; `… › a turn that fails fails loudly, and is not retried` |
| `turn/abort` | stops the turn; the turn still ends, with the state it reached | the abort ends the turn at once, with the state `aborted`, and the handler's later settling does not end it twice | `… › an aborted turn still ends, with the state it reached` |
| `session/dispose` | releases the session; a disposed session answers nothing, and every later call is `session/disposed` | the session is kept, not forgotten, so a later call is refused with `session/disposed` — and not with `session/unknown`, which is a different fact | `… › a disposed session refuses every later call` |
| the turn is never retried | a turn that runs against a different model than the one asked for is a different turn | a turn whose model is unavailable fails loudly with `model/unavailable`, and nothing else is tried | `… › a turn that fails fails loudly, and is not retried` |
| `session/cancel` | the specification lists the method and does not describe it | it cancels the session's running turn and reports whether there was one | `the honest-report rule › every method of the vocabulary answers in one of the three ways` |

**Implementation choice — "a disposed session answers nothing".** The two
clauses of that sentence are read together: the disposed session does **no work**
— it runs no turn and produces no event — and every later call against it is
refused with `session/disposed`. A refusal with a reason is the one thing a
released session is allowed to do, and it is the reading that keeps the promise
that a caller always learns why.

**Implementation choice — the capabilities `session/create` returns.** The
specification says "the capability record for everything that is enabled in this
session". It is read as **every** capability the server knows, each in the shared
shape — the enabled ones with `unsupported: null`, the disabled ones with their
reason. The clause that follows it is the promise: "so a client learns at once
what this agent can do". A client that is shown only the enabled capabilities
learns what the agent can do and **not** what it cannot, and it has to ask a
second time to find out. The reading keeps the promise and the degradation
contract in one round trip.

**Implementation choice — `turn/abort` ends the turn at once.** The
specification says the turn "still ends, with the state it reached". The abort
therefore ends the turn at the moment it is accepted: the turn's final event
carries `aborted`, and a handler that settles later does not end it a second
time. Waiting for the handler would make the turn's end depend on the handler's
good manners, and the specification does not say the abort waits.

**Implementation choice — `session/cancel`.** The specification lists the method
and does not describe it. It cancels the session's running turn — the same thing
`turn/abort` does to one turn — and answers with `{ sessionId, state, cancelled }`,
so a caller learns whether there was anything to cancel. An empty cancellation is
reported, not pretended away.

---

## 6. The two sides are peers

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| one vocabulary, both roles | PRRICODE is the server for its clients and the client for the tool providers it does not implement; the two sides are peers and neither is privileged | one `createProtocolPeer` is both halves: the server and the client are the same exchange with different methods registered on it | the raw exchange in §6.1 |
| the ids of the two directions | a request's id is never reused within a session | each peer allocates its own ids from its own counter, and the frame's **kind** tells a request from an answer | §6.1 |

### 6.1 The two directions on one channel

The two directions allocate their ids from **separate counters**, so a request
this peer sends and a request this peer receives may carry the same number.
That is not an ambiguity: a **response always answers a request the receiver
sent**, and the frame's kind tells a request from an answer, so the two
directions never have to be coordinated. The specification's promise is that an
id is **never reused** — and neither peer ever reuses one.

The test writes a request on the raw pipe, reads the server's own request frame
(the `approval/request` the server sends when the tool needs an approval), and
answers it; the two exchanges are told apart correctly even though the ids
coincide.

---

## 7. The capability record, and the degradation contract

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| one shape | every capability reports the same shape: `enabled`, `unsupported`, and the capability's own fields beneath the pair | `CapabilityRecord` is exactly that, and `capability/describe` answers with it for **any** capability | `the capability record › one shape is asked of anything` |
| the degraded shape | `{ "enabled": false, "unsupported": "a running IDE with its extension installed" }` | the same, and the reason is a **sentence**: at least two words, never a placeholder from `PLACEHOLDER_REASONS` | `… › a capability that cannot run names what is missing`; `… › a record that breaks the contract cannot be built` |
| the reason | never empty, never a placeholder, and never a success | `capabilityRecord` refuses to build a record that breaks it, and the registry refuses to register one | `… › a record that breaks the contract cannot be built`; `… › the default registry reports every capability in the same shape` |
| a capability that is enabled and does nothing is a bug | an enabled capability carries **no** reason, and the contract is checked where the record is built | `capabilityRecord(true, 'a reason')` throws | `… › a record that breaks the contract cannot be built` |
| one shape asked of anything | a caller can ask any capability the same question | `capability/describe` takes a name and answers with the record; an unknown name is refused with `capability/unknown` | `… › a capability nobody has is refused with a reason` |
| a method of an area that is off | a method either returns a result, or returns an error with a reason, or reports the capability as not enabled with a reason | the method answers with the **capability's record** — not with a result that pretends the work was done, and not with an error that hides the fact | `… › a method whose capability is not enabled reports the record, not a success` |

**Implementation choice — the capability names.** The specification does not
enumerate the capabilities; it says the record is "asked of anything". The
default registry carries the protocol's own (`protocol`, `session`,
`capability`, `event`), the product's (`turn`, `tool`, `model`, `approval`,
`sandbox`, `computer-use`, `pipeline`), and each disabled one names what is
missing. The names are the product's own, and they are data: a deployment that
has a model backend replaces the `model` record with one that is enabled.

**Implementation choice — the check on a reason.** "A sentence that names what
is missing" cannot be checked for meaning by a program. What **can** be checked
is checked: the reason is not empty, it is not one of the placeholders
(`unknown`, `unsupported`, `n/a`, `none`, `todo`, …), and it has more than one
word — so a bare word cannot pass as a reason. The naming of what is missing is
a duty the text carries, and the default registry's reasons are written to it.

**Implementation choice — the gate.** A method's area's capability is the gate,
and the embedder owns it. A server with a `tool/call` handler and a `tool`
capability that is off answers with the record, because the record is what says
whether the tool area can run. The one capability the **server** owns is `turn`,
and it follows the turn runner: a server with a turn runner enables it, a server
without one reports the reason.

---

## 8. The approvals

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the request | `approval/request` is sent when a rule says *ask*; it names the tool, the call and the reason, and it carries the request id the answer must quote | the request carries `requestId`, `tool`, `call` and `reason`, and the answer quotes the `requestId` | `the approvals › an answer is attributed to the peer that gave it` |
| the answer | `approval/answer` carries `allow` or `deny` and the request id | the answer carries `requestId` and `decision`, and nothing else decides the approval | `… › an answer is attributed to the peer that gave it` |
| an unknown request id | an answer for an unknown request id is **dropped** and reported as `approval/unknown`, never applied to the wrong request | the answer is refused with `approval/unknown`, and no approval is applied | `… › an answer for an unknown request id is dropped and reported` |
| the attribution | an answer is attributed to the peer that gave it, so a client that answers on the user's behalf is recorded as the answerer, not as the user | the answer is recorded with the **peer's** identity — the name the client gave in `session/create` — and the confirmation carries it | `… › an answer is attributed to the peer that gave it` |
| a denial is final | it is not re-asked within the turn | a decided request cannot be decided again: the second answer is refused with `approval/decided`, and the decision stands | `… › a denial is final` |
| the rules | approvals are rules — allow, ask, deny — so a matching rule decides without asking, and a rule persists | **not here.** The rule model and the decision point are the approvals milestone (`CC-046`); this milestone owns the mechanics the protocol needs | — |

**Implementation choice — the two refusals.** An answer for an id nobody is
waiting on is `approval/unknown`; an answer for a request that has **already**
been decided is `approval/decided`. The specification names only the first, and
the two say different things: one request does not exist, the other exists and
its decision is final. Calling the second "unknown" would be a lie about a
request that is known.

**Implementation choice — the answerer.** The answerer is the identity of the
**peer** that sent the answer. The peer names itself when it creates a session
(`session/create` carries `client`), and that name is the answerer of every
approval answered on the connection. A client that answers on the user's behalf
is therefore recorded as the client — which is what the specification asks for.

**Implementation choice — the exchange's shape.** `approval/request` and
`approval/answer` are both **requests**, because the specification's direction
column puts the approval area among the methods a client calls. The request is
answered with an acknowledgement (`{ requestId, status: 'pending' }`) and the
decision travels in the `approval/answer`, which is answered with the decision
and the answerer. The two-step exchange is what lets the answer be attributed
and lets an unknown request id be **reported**: a notification has nowhere to
report to.

---

## 9. The stages

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| a stage's advance | an `event/stage` notification carrying the stage's id, the stage's state, and — when the stage is not proceeding — the same `{ enabled: false, unsupported: <why> }` shape | the notification carries `stageId`, `state`, `enabled` and `unsupported` | `the protocol surface over a real pipe › a stage that cannot run says so, in the shared shape` |
| a stage that cannot run | says so, and the pipeline reports which stage and why, rather than skipping it silently | the stage's id is in the notification, and the reason names what is missing | `… › a stage that cannot run says so, in the shared shape` |
| the three deliveries | in-process, a package, or a process speaking this protocol over stdio, answering `tool/call` | **not here.** The stage interface and the three deliveries are the pipeline milestone (`CC-045`); this milestone provides the protocol the third delivery speaks | — |

---

## 10. The rules the protocol keeps

| the rule | how it is kept | the test |
|---|---|---|
| **Never fake success.** A method either returns a result, or returns an error with a reason, or reports the capability as not enabled with a reason. There is no third thing. | the method path is a property of the server, and the test calls **every** method of the vocabulary and checks which of the three it is | `the honest-report rule › every method of the vocabulary answers in one of the three ways` |
| **Never fall back silently.** | a turn whose model is unavailable fails loudly with `model/unavailable`, and nothing else is tried | `… › a turn that fails fails loudly, and is not retried` |
| **Every refusal names what is missing.** | the reason is checked where the record is built and again where it is registered | `the capability record › a record that breaks the contract cannot be built` |
| **A frame is either understood or refused.** | every malformed case has its own code, its own delivery, and its own test | §3 |
| **The protocol surface is ours.** | it is versioned, it is small, and it is not derived from anyone else's — and the naming rule keeps it that way | `tests/contracts/naming.test.ts` |

---

## 11. What was not done, and why

| what | why |
|---|---|
| the **rule model** — allow, ask, deny, and the matching that decides whether an approval is asked for at all | the approvals milestone (`CC-046`). This milestone owns the protocol's mechanics; the rules are the product's decision point |
| the **model layer** — the catalogue, the selection, the credential | the model layer milestone (`CC-044`). The `model` capability is off by default, and the methods of that area answer with the record |
| the **pipeline** — the stage interface, the eight stages, the three deliveries | the pipeline milestone (`CC-045`). The `event/stage` notification and the stage's capability record are here, because they are the protocol's own |
| the **agent loop** — what a turn actually does | the first layer's own loop (`src/agent/`). This milestone owns the turn's *protocol*: the id at once, the events, the failure, the abort |
| a **compatibility row** for the protocol surface | a divergence is not a compatibility claim. The target has no counterpart for this surface, and the report is a statement about the parity layer |

---

## 12. The readings, in one place

Every place the specification left a choice open, and the reading taken:

| # | the ambiguity | the reading | why |
|---|---|---|---|
| 1 | "Six areas" against a table of seven rows | the six are the areas a client calls; `event/*` is the notification area, and all seven are implemented | the direction column distinguishes them, and the `event/*` rules are stated in more than one place — dropping the row would break the specification |
| 2 | the method `turn/failed`, which §5 names and the table does not list | a method of the `turn` area, notification-only | a turn that has already been answered cannot be failed by a second answer |
| 3 | the refusal that cannot be attributed to a request | an `event/diagnostic` notification, and the peer's diagnostic channel | the vocabulary's own diagnostic channel, and the only way to say something that is not an answer without a fourth frame kind |
| 4 | what "a disposed session answers nothing" means | it does no work, and every later call is refused with `session/disposed` | a refusal with a reason is the one thing a released session may do, and it keeps the promise that a caller always learns why |
| 5 | "the capability record for everything that is enabled in this session" | every capability the server knows, each in the shared shape | a client that is shown only the enabled ones cannot learn what it cannot do, and the promise is that it learns "at once" |
| 6 | whether `turn/abort` waits for the turn's work to stop | the abort ends the turn at once, and the handler's later settling does not end it twice | the specification says the turn still ends; waiting would make the end depend on the handler's good manners |
| 7 | the refusals for an approval that is already decided | `approval/decided`, and not `approval/unknown` | the request is known, and its decision is final; the two refusals say different things |
| 8 | the two directions' ids on one channel | separate counters, told apart by the frame's kind | a response always answers a request the receiver sent, and neither peer ever reuses an id |
| 9 | what the size limit counts | the UTF-8 bytes of the JSON text, without the newline | the limit is about how much a reader holds, and a character is not a byte |
| 10 | a frame with no usable `v` | `frame/malformed`, not `protocol/unsupported` | there is no version to be unsupported |
