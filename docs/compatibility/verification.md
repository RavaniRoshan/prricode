# The verification suite — conformance

**The concept:** [`docs/DIVERGENCE-LAYER-2.md`](../DIVERGENCE-LAYER-2.md) §3 — the
honest-degradation contract: "a feature that cannot run **degrades with a clear
reason** — `enabled: false`, `unsupported: <why>` — and **never fakes success**" —
and §4, the Product Builder pipeline.
**The specification:** [`docs/protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) §6 — the
degradation contract — and [`docs/protocol/MODEL-LAYER.md`](../protocol/MODEL-LAYER.md)
§2, §5 and §6 — the shapes, the credentials and the one predicate; and
[`docs/protocol/MOTION.md`](../protocol/MOTION.md) — the motion and its frames.
**Owning task:** `CC-050` in
[`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**The implementation:** `scripts/verify-product.ts` — **one command**, four kinds.
**The test:** `tests/verification/` — **two files**, **thirty-five tests**.

---

## 0. The labels, and why this surface has no target rows

This surface is **our own design**. The pinned target has no counterpart for a
verification suite — or for a Product Builder pipeline, or for a model layer — so
there is nothing to compare it against and **no row in the compatibility matrix**.
A divergence is not a compatibility claim, and a compatibility row must not be
weakened to make room for one.

Every row of this document therefore carries the first layer's **clone-choice
label**:

| label | meaning | here |
|---|---|---|
| `Project requirement` | a product extension: the target does not have this behaviour, and nothing about it is a claim about the target | **every row of this document** |

and, inside the second layer, the label that says where the row comes from:

| label | meaning |
|---|---|
| `specified` | pinned by `docs/protocol/PROTOCOL.md`, `docs/protocol/MODEL-LAYER.md` or `docs/protocol/MOTION.md`, or by `docs/DIVERGENCE-LAYER-2.md` — the specification says it, and the implementation says it |
| `implementation choice` | the specification is silent, and the reading below is ours |

**The naming rule applies to every line of this document.** The suite names the
things it measures — a product, a provider, a golden — and no product and no
company is named, in this document or in the code it describes.

---

## 1. The four kinds

> **Deliverable:** one command that runs all four, and a report that says which
> passed. — the plan, `CC-050`

| the kind | what it measures | the command that runs it |
|---|---|---|
| **the product** | the end-to-end run — an idea in, a verified product out, through all eight stages — and the run's own verification, **executed** and compared with what the run claimed | `bun run scripts/verify-product.ts --kind product` |
| **the backend** | the protocol over a **real pipe**; the providers against a fake backend on a **real port**; the credential store's resolution and **where the secret came from**; and the five failures | `bun run scripts/verify-product.ts --kind backend` |
| **the frontend** | the rendered frames, compared against the **recorded goldens**, and the motion's **degraded** form against its own golden | `bun run scripts/verify-product.ts --kind frontend` |
| **visually** | the goldens themselves, and the **staleness check** | `bun run scripts/verify-product.ts --kind visual` |

All four: `bun run scripts/verify-product.ts`.

**The report** names every kind, every check, and what the check saw. **The exit
code** says the same thing: **zero** when every kind passed, **one** when a kind
failed, and **two** when a kind could not run.

---

## 2. The rules the suite lives by

| the rule | how it is kept | the test that pins it |
|---|---|---|
| **each kind must be able to fail** | every kind is driven in the state that must fail — an over-claiming run, a refusing backend, a tampered golden, a stale golden — and the test says which check went red | `the product kind › fails when a run that over-claims is accepted`; `the backend kind › fails when the backend refuses every request`; `the frontend kind › fails when a golden is not the picture that is drawn now`; `the visual kind › fails when a golden is stale` |
| **a kind that cannot run says so** | the shared shape — `enabled: false` and `unsupported: <why>` — and the kind's checks are **empty**, so it never reads as a pass and never skips quietly | `the frontend kind › reports that it could not run when the goldens are not recorded`; `… › reports that it could not run when the goldens machinery is not there`; `the visual kind › reports that it could not run when the goldens are not recorded`; `the product kind › reports that it could not run when there is no node to run the product own tests`; `the backend kind › reports that it could not run when there is no node to run the protocol server` |
| **never fake success** | a failure is measured as a failure **with its reason**, and a turn that failed is measured as a turn that produced **no events at all** | `the backend kind › measures the five failures, and each one degrades with its reason` |
| **the report says which passed** | `formatVerificationReport` names every kind and every check; the exit code is derived from the same report | `the report › names every kind, and says which passed`; `… › says why a kind could not run, and does not call it a pass` |
| **the suite does not believe the thing it measures** | the suite reads the run's **claim** and the run's **execution** itself, and does not take the product's own comparison for it | `the product kind › passes on an honest run, and on a run that over-claims` (the check `the over-claim is a real disagreement, and not a broken comparison`) |

---

## 3. The product

> **The product.** The e2e run above, and the report of what it produced. — the
> plan, `CC-050`

The product kind runs the product **twice**: once honestly, and once with a build
whose test fails while the run **claims** the criterion is met.

| the check | what the milestone requires | what was implemented | the check that pins it |
|---|---|---|---|
| the eight stages | "an idea in, a verified product out, through **all eight** stages" | the run's eight stage records, every one of them `completed` | `the run reaches all eight stages` |
| the eight documents | the run's own documents, "written down as well as reported" | the eight documents, and each of them on disk in the run's own directory | `the run produces the eight documents, and writes them down` |
| the verification is executed | "a criterion is met by **the test that covers it**" | the product's own test run, really run by **node**, in the product's own directory | `the verification is really executed` |
| every criterion is covered | "a criterion **nothing tests** is not met" | every criterion met, and every one of them covered by a test that passed | `every criterion is met by a test that covers it` |
| the claim agrees with the execution | "the result is **compared against what the run claimed**" | the run's own comparison, which the suite also reads for itself | `the run claim agrees with the execution` |
| the product is verified | "the product either is verified, or it is not, and it says which" | the run's own verdict | `the product is verified` |
| **an over-claim fails** | "a run that claims a criterion is met and does not meet it **fails**, it fails **at the stage that claimed it**" | the over-claiming run is refused **at `verify`**, and the suite reads the refusal | `a run that over-claims fails at the stage that claimed it` |
| **nothing is released** | "`ship` and `operate` are reported as `not-reached` — so **nothing is released**" | the two stages after the claim, both `not-reached` | `a run that over-claims releases nothing` |
| the over-claim is real | the suite does not take the product's comparison for it | the suite pairs the claim with the execution itself and finds the disagreement | `the over-claim is a real disagreement, and not a broken comparison` |

**The product kind's own seam** is `ProductRunner`: a caller can hand the kind a
run that behaved differently, and the kind says so. The suite's own test drives
it with a run that accepts an over-claim, and the kind goes red on **that check
alone**.

---

## 4. The backend

> **The backend.** The protocol over a real pipe; the providers against a fake
> backend that speaks both API shapes; the credential store's resolution; and the
> failures — each degrading with its reason rather than claiming success. — the
> plan, `CC-050`

### 4.1 The protocol, over a real pipe

| the check | what the milestone requires | what was implemented | the check that pins it |
|---|---|---|---|
| a real process | "a **real child process**, real frames" | the repository's own protocol server (`tests/fixtures/protocol-child.mjs`) is spawned, and the report names its **pid** | `the protocol answers over a real pipe` |
| a real exchange | the session, the turn and the events | a `session/create`, a `turn/start`, and the `event/message` that ends the turn — carrying the turn's own id | `the protocol answers over a real pipe` |
| the frames on the wire | "real frames" | the **raw** pipe: one JSON object per line, with the version and the id of the request it answers | `the frames on the wire are frames` |
| a refusal on the wire | "a frame that is not JSON is refused with a reason" | the server answers with `event/diagnostic` and the code `frame/malformed` | `a frame that is not JSON is refused with a reason` |
| a capability that is off | "a capability that cannot run **degrades with a clear reason**" | the server's own `model` capability is off, and the record says so | `a capability that is not enabled is reported, not worked around` |

### 4.2 The providers, against a fake backend

The fake backend is a **real HTTP server on a real port** — no network, no
stubbed function — and it speaks **every API shape the model layer has**: the
chat-completions shape, the messages shape and the responses shape. The paths
are the shapes' own, so the engine reaches each one where it would reach a real
provider.

| the check | what the milestone requires | what was implemented | the check that pins it |
|---|---|---|---|
| every shape answers | "a fake backend that speaks both API shapes" | one turn per shape, and each one produces text, a tool call, the usage and the end | `the providers are reached over a real socket` |
| a real socket | "a real HTTP server on a real port, no network" | the last request the backend received is a `POST` on a loopback URL | `the providers are reached over a real socket` |

### 4.3 The credential store, and where the secret came from

| the check | what the milestone requires | what was implemented | the check that pins it |
|---|---|---|---|
| the resolution | "the credential store's resolution, and **where the secret came from**" | a stored key resolved through an **encrypted file**, and the resolution reports `encrypted-file` | `the credential store resolves the secret, and says where it came from` |
| the environment is a peer | "the stored credentials, newest first, then the environment variables that are currently set" | with no stored key, the environment variable is the connection, and the source is `environment` | `the environment is a first-class peer of a stored key` |
| the provider carries no secret | "**The provider record has no secret field, ever**" | the secret is nowhere in the provider's own record | `the provider record carries no secret` |

### 4.4 The five failures

Each failure is measured for the thing that matters: it **degrades with its
reason**, and it **claims nothing** — the turn that failed produced **no events
at all**.

| the failure | the code it must degrade with | the check that pins it |
|---|---|---|
| a provider that is not connected | `model/not-connected` | `a provider that is not connected degrades with its reason` |
| a model that has become unavailable | `model/unavailable` | `a model that has become unavailable degrades with its reason` |
| an endpoint that refuses | `model/endpoint-refused` | `an endpoint that refuses degrades with its reason` |
| a credential that cannot be resolved | `model/credential-unresolved` | `a credential that cannot be resolved degrades with its reason` |
| an overlay the model does not offer | `model/overlay-unknown` | `an overlay the model does not offer degrades with its reason` |

**The backend kind's own seam** is `FakeBackendFactory`: the suite's own test
drives it with a backend that refuses everything, and the kind goes red on
**the providers are reached over a real socket** — while the refusal check stays
green, because the endpoint that refuses still degrades with its reason.

---

## 5. The frontend

> **The frontend.** The rendered frames, compared against the recorded goldens;
> and the motion's degraded form, compared against its own golden. — the plan,
> `CC-050`

| the check | what the milestone requires | what was implemented | the check that pins it |
|---|---|---|---|
| every golden is the picture drawn now | "a change to what the user sees is a failing test and not a surprise" | the picture drawn now, compared with the recorded bytes, for each of the six goldens | `the "<name>" frame is the picture that is drawn now` |
| the degraded form is its own golden | "the motion's **degraded** form, compared against its own golden" | the degraded golden's picture, and the reason beside it — the motion is off, and the picture carries the reason | `the degraded form has a golden of its own` |

**The goldens are the terminal surface's own** (`tests/visual/goldens.ts`), and
the suite draws them through that machinery — a second copy of the drawing would
measure the copy.

---

## 6. The goldens, visually

> **Visually.** The frame goldens themselves, and a check that the goldens are
> *current* — a golden that was not regenerated deliberately is a failure, so a
> stale picture cannot pass. — the plan, `CC-050`

| the check | what the milestone requires | what was implemented | the check that pins it |
|---|---|---|---|
| every golden is recorded | "the frame goldens themselves" | the record and the picture, for each of the six goldens | `the "<name>" golden is recorded` |
| **every golden is current** | "a golden that was not regenerated deliberately is a **failure**, so a stale picture cannot pass quietly" | the record's fingerprint against the fingerprint of the sources that draw it | `the "<name>" golden is current` |
| the record describes the picture | the record and the picture are kept apart, and each is checked | the record's own hash against the picture recorded beside it | `the "<name>" record describes the picture beside it` |

---

## 7. The mutations — what each kind measured, and what turned it red

**A kind that cannot go red is a claim, not a check.** So each kind was measured
against a broken thing, and the broken thing was reverted afterwards. The table
is the record.

| the kind | the mutation | what went red |
|---|---|---|
| **the product** | `src/product/verification.ts` — the comparison's `agreed` was forced to `true`, so an over-claiming run is accepted | `a run that over-claims fails at the stage that claimed it` **and** `a run that over-claims releases nothing` — the run went on to `ship` instead of stopping at `verify` |
| **the backend** | `src/model/engine.ts` — the `model/endpoint-refused` throw was swallowed, so a refusing endpoint is not refused | `an endpoint that refuses degrades with its reason` |
| **the frontend** | `src/ui/surface/prompt.ts` — the composer's rule character was changed, so the picture the user sees is not the golden | `the "prompt-shimmer" frame is the picture that is drawn now` **and** `the "degraded" frame is the picture that is drawn now` |
| **visually** | `src/ui/theme.ts` — a line was added to the theme that changes **no** picture, so only the drawing's fingerprint moves | the six `the "<name>" golden is current` checks — and **the frontend kind stayed green**, because the picture itself had not changed |

**The last row is the point of the staleness check**: a picture that has not
changed but whose drawing has is still a **stale golden**, and it fails.

---

## 8. What the suite does not do, and why

| what | why |
|---|---|
| the **first layer's** compatibility matrix | the matrix is `CC-019`'s, and the orchestrator owns `docs/compatibility/results.md` and `tests/compatibility/`. This suite is **ours**, and it measures the second layer |
| the **first layer's** own tests | they are the first layer's, and they are green. The suite here measures the **second layer**: the product, the backend, the frontend and the goldens |
| a **new** golden of its own | a golden is a **picture**, and the pictures are the terminal surface's. The suite compares against them; it does not draw a second set |
| a **deployment's** model backend and approval transport | the product takes the backends as options, and the suite supplies its own — a fake backend on a real port, and a rule that decides without asking |
| the **retry policy**, the **model catalogue's** refresh over a network, the **credential store's** real keychain | the model layer names them as not done. The suite measures what is there, and it never pretends the rest is |

---

## 9. The report, verbatim

```
the verification suite

the product — passed
  ok   the run reaches all eight stages — 8 stage(s): concept, clarify, specify, plan, build, verify, ship, operate
  ok   the run produces the eight documents, and writes them down — 8 document(s), all of them on disk
  ok   the verification is really executed — 2 test file(s) ran, and every one of them passed
  ok   every criterion is met by a test that covers it — criterion 1: met, criterion 2: met
  ok   the run claim agrees with the execution — the run claimed what the product does, and the product does what the run claimed
  ok   the product is verified — the run run_mvizp1lp_1 is verified
  ok   a run that over-claims fails at the stage that claimed it — the run claimed 1 acceptance criterion/criteria were met, and the product's own test run does not meet it: the failure is explained in one line of plain words (the test that covers it failed: test/explain.test.mjs (the test file failed with the exit code 1: 2 of 2 test(s) failed: diff: 'simple' | ))
  ok   a run that over-claims releases nothing — ship: not-reached, operate: not-reached
  ok   the over-claim is a real disagreement, and not a broken comparison — the run claimed 1 criterion/criteria that the product own test run does not meet

the backend — passed
  ok   the protocol answers over a real pipe — the server is the process 302839, the session is session_1, the turn is turn_1
  ok   a capability that is not enabled is reported, not worked around — the model capability of the protocol server is off, and the record says so
  ok   the frames on the wire are frames — the answer carried the version 1, the id 4242 and a result
  ok   a frame that is not JSON is refused with a reason — the server answered with "event/diagnostic" and the code frame/malformed
  ok   the providers are reached over a real socket — chat: answered, messages: answered, responses: answered; the last request was POST /v1/responses on http://127.0.0.1:34391/v1
  ok   the credential store resolves the secret, and says where it came from — the secret came from the encrypted-file
  ok   the environment is a first-class peer of a stored key — the secret came from the environment
  ok   the provider record carries no secret — the provider names an integration, and the secret is nowhere in the record
  ok   a provider that is not connected degrades with its reason — model/not-connected: the provider "not-connected" has no connection
  ok   a model that has become unavailable degrades with its reason — model/unavailable: the model "unavailable/the-model" is turned off
  ok   an endpoint that refuses degrades with its reason — model/endpoint-refused: the endpoint refused the request with 500: {"error":{"message":"the backend refused the request"}}
  ok   a credential that cannot be resolved degrades with its reason — model/credential-unresolved: the credential "cred_external" is the external reference "a-reference", whose secret is managed somewhere else and is not held here
  ok   an overlay the model does not offer degrades with its reason — model/overlay-unknown: the model "overlay/the-model" offers no overlay named "high"

the frontend — passed
  ok   the "prompt-shimmer" frame is the picture that is drawn now — 90 byte(s) of picture, the same as the golden
  ok   the "state-transition" frame is the picture that is drawn now — 77 byte(s) of picture, the same as the golden
  ok   the "stage-advance" frame is the picture that is drawn now — 77 byte(s) of picture, the same as the golden
  ok   the "overlay-in" frame is the picture that is drawn now — 358 byte(s) of picture, the same as the golden
  ok   the "overlay-out" frame is the picture that is drawn now — 336 byte(s) of picture, the same as the golden
  ok   the "degraded" frame is the picture that is drawn now — 611 byte(s) of picture, the same as the golden
  ok   the degraded form has a golden of its own — the motion is off, and the picture carries the reason: the output is not an interactive terminal, so no frame can be drawn

the goldens, visually — passed
  ok   the "prompt-shimmer" golden is recorded — the record and the picture are both there
  ok   the "prompt-shimmer" golden is current — the drawing is unchanged (04e79ef67e7d)
  ok   the "prompt-shimmer" record describes the picture beside it — the record and the picture agree (367488e21a7f)
  ok   the "state-transition" golden is recorded — the record and the picture are both there
  ok   the "state-transition" golden is current — the drawing is unchanged (1a39524ac6a2)
  ok   the "state-transition" record describes the picture beside it — the record and the picture agree (4a7b4b9f6a2)
  ok   the "stage-advance" golden is recorded — the record and the picture are both there
  ok   the "stage-advance" golden is current — the drawing is unchanged (2dfcae1ef791)
  ok   the "stage-advance" record describes the picture beside it — the record and the picture agree (8c6a006e968e)
  ok   the "overlay-in" golden is recorded — the record and the picture are both there
  ok   the "overlay-in" golden is current — the drawing is unchanged (1a96bccd3893)
  ok   the "overlay-in" record describes the picture beside it — the record and the picture agree (49c24549a4c2)
  ok   the "overlay-out" golden is recorded — the record and the picture are both there
  ok   the "overlay-out" golden is current — the drawing is unchanged (1a96bccd3893)
  ok   the "overlay-out" record describes the picture beside it — the record and the picture agree (cfea278bec67)
  ok   the "degraded" golden is recorded — the record and the picture are both there
  ok   the "degraded" golden is current — the drawing is unchanged (493c38de3443)
  ok   the "degraded" record describes the picture beside it — the record and the picture agree (7da093361631)

the suite: 4 of 4 kind(s) passed
```

**The exit code was zero.**
