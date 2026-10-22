# The pipeline surface — conformance

**The concept:** [`docs/DIVERGENCE-LAYER-2.md`](../DIVERGENCE-LAYER-2.md) §4 and §6 —
the Product Builder pipeline, and the decision that **the stages are pluggable**.
**The specification:** [`docs/protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) §8 — the
three deliveries, and the `event/stage` notification.
**Owning task:** `CC-045` in
[`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**The implementation:** `src/pipeline/` — **sixteen modules**: six at the top (`stage`,
`services`, `registry`, `process`, `pipeline`, `index`) and ten under `stages/` (the eight
built-in stages, the format they read, and the barrel).
**The test:** `tests/contracts/pipeline.test.ts` — **thirty-one tests**, over a **real child
process** for the third delivery.

---

## 0. The labels, and why this surface has no target rows

This surface is **our own design**. The pinned target has no counterpart for it, so there
is nothing to compare it against and **no row in the compatibility matrix** — a divergence
is not a compatibility claim, and a compatibility row must not be weakened to make room
for one.

Every row of this document therefore carries the first layer's **clone-choice label**:

| label | meaning | here |
|---|---|---|
| `Project requirement` | a product extension: the target does not have this behaviour, and nothing about it is a claim about the target | **every row of this document** |

and, inside the second layer, the label that says where the row comes from:

| label | meaning |
|---|---|
| `specified` | pinned by `docs/protocol/PROTOCOL.md` §8 or by `docs/DIVERGENCE-LAYER-2.md` — the specification says it, and the implementation says it |
| `implementation choice` | the specification is silent, and the reading below is ours |

The two are orthogonal: a row is `Project requirement` **and** `specified`, or `Project
requirement` **and** `implementation choice`. The second column is the honest one — it says
which parts of the surface are the specification's promise and which parts are ours, so a
later milestone can move a row from the second column to the first without guessing.

---

## 1. The stage interface — one interface, three deliveries

> **How a stage plugs in.** One interface, three deliveries. A stage may be in-process, a
> package, or a process speaking our protocol over stdio, and the pipeline does not know
> the difference. — `docs/DIVERGENCE-LAYER-2.md` §6

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the interface | a stage is reached the same way whatever it is | `PipelineStage` — an `id`, a `title`, the `requires` list, and a `run(input, context)` | `one stage interface, three deliveries › a stage of the in-process delivery passes the stage contract` (and the two other deliveries) |
| the in-process delivery | "in-process, registered through a typed interface" | `registerStage(stage)` takes a `PipelineStage` and hands it to the pipeline as it is | `… › a stage of the in-process delivery passes the stage contract` |
| the package delivery | "a package the agent loads" | `loadPackageStage(source)` imports a **module** — or takes one — and reads its stage out of a `createStage`, a `stage` or a default export; the export may be the stage or a **factory** | `… › a stage of the package delivery passes the stage contract`; `… › the package delivery loads a module and takes its stage` |
| the process delivery | "a process speaking this protocol over stdio, answering `tool/call`" | `createProcessStage(options)` starts the program, speaks our protocol to it over its pipes, and calls `tool/call` with the stage's input | `… › a stage of the process delivery passes the stage contract`; `… › the process delivery speaks the protocol over a real pipe` |
| the pipeline does not tell them apart | "the pipeline does not know the difference" | the runner calls `stage.run(input, context)` and **nothing else**; the `delivery` is metadata on the registration, and the runner never reads it | `… › the pipeline cannot tell the deliveries apart` |
| a delivery that cannot be loaded | — | a package that exports no stage, or a stage that is not a stage, is refused **with a reason** (`StageLoadError`) and is never registered as if it had worked | `… › a package that exports no stage is refused with a reason` |

**Implementation choice — the package's contract.** The specification says "a package the
agent loads" and does not say what a package looks like. The reading is: **a package is a
module**, and the loader looks in three places — a `createStage` export, a `stage` export,
and a default export. The export may be the stage itself or a factory that builds it. The
package need not import anything of ours, and the loader needs to know nothing about it:
**a stage is an interface, and the interface is the contract.** The test's package fixture
(`tests/fixtures/stage-package.mjs`) is written that way on purpose — it imports **nothing**
from this repository, so what the shared test measures is the contract and not our
implementation of it.

**Implementation choice — the process's exchange.** The specification names `tool/call` and
nothing else, and it does not say what the call carries. The reading is the one the
protocol's own fixture already uses: the parameters are `{ "name": <the stage's id>,
"arguments": <the stage's input> }`, and the answer carries the stage's outcome —
`{ "stageId", "state": "completed", "output": … }` or `{ "stageId", "state": "refused",
"reason": … }`. The pipeline is the **client** here, because PRRICODE is the client for
the tool providers it does not implement.

**Implementation choice — one process per call.** The stage process is started for the call
and stopped after it. A stage is a short unit of work, and a process left behind is a
process nobody asked for. The child's **stderr** is reported through the diagnostics
channel, so a stage that fails can say why in its own words.

---

## 2. The pipeline runs, and reports every stage

> **A stage that cannot run says so and the pipeline reports which stage and why**,
> rather than skipping it silently. — `docs/protocol/PROTOCOL.md` §8

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the shape | concept → clarify → specify → plan → build → verify → ship → operate | `PIPELINE_STAGE_IDS`, in that order, and the runner walks it | `the eight built-in stages › the pipeline has the eight stages of the Product Builder, in order` |
| the report | "the pipeline reports which stage and why" | every one of the eight is in `run.records`, with its state: `completed`, `refused` or `not-reached` | `… › a stage the pipeline does not have is reported, not skipped`; `… › a stage that cannot run says so, and the pipeline reports which stage and why` |
| a stage nobody supplied | "rather than skipping it silently" | the run **refuses at that stage** and says which one is missing: `no stage is registered for "<stage>"` | `… › a stage the pipeline does not have is reported, not skipped` |
| the stages after a refusal | — | they are reported as `not-reached`, with the reason naming the stage the run stopped at | `… › a stage that cannot run says so, and the pipeline reports which stage and why` |
| a stage that throws | — | the run refuses **that** stage with the message it threw, and the stages after it are reported as not reached. A stage never takes the run down | `… › a stage that cannot run says so, and the pipeline reports which stage and why` (the refusal path) |
| a cancelled run | — | `pipeline.cancel()` aborts the signal the stage holds; the run stops at the next stage and **reports** it — `the run was cancelled before "<stage>" began` — and the stages after it are reported as not reached | `the pipeline runs › a run that is cancelled stops and says so` |
| the run end to end | "turning an idea into a verified, shippable product" | with the seams present, all eight stages complete and the run carries the eight documents | `the pipeline runs › the pipeline runs end to end` |

**Implementation choice — the run stops at the first refusal.** The specification says a
stage that cannot run is reported rather than skipped; it does not say what happens to the
stages after it. The reading is that they **cannot run** — each of them consumes the
document the refused stage did not produce — so running them would be pretending. They
are therefore reported as `not-reached`, with the reason, and the run's own state is
`refused` with `failedAt` and `reason` naming the stage. **A stage that is skipped is a
stage that was reported.**

---

## 3. The advance — the `event/stage` notification

> A stage's **advance** is an `event/stage` notification carrying the stage's id, the
> stage's state, and — when the stage is not proceeding — the same `{ enabled: false,
> unsupported: <why> }` shape. — `docs/protocol/PROTOCOL.md` §8

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the advance | the stage's id and the stage's state | `stageEventParams(event)` builds `{ stageId, state, enabled, unsupported }` — the shape the protocol's own fixture already sends | `the pipeline runs › a stage's advance is an `event/stage` notification carrying the id, the state and the shared shape` |
| the shared pair | "when the stage is not proceeding" | a stage that is proceeding carries `enabled: true` and `unsupported: null`; a stage that is not carries `enabled: false` and the reason | `… › a stage that is not proceeding carries the shared shape` |
| the two advances | — | every stage that is reached advances **twice**: `running` and then its outcome | `… › a stage's advance is an `event/stage` notification carrying the id, the state and the shared shape` |

---

## 4. The degradation contract, in the stages

> Every capability reports the same shape. […] When a capability cannot run, it reports
> `{ "enabled": false, "unsupported": "a running IDE with its extension installed" }`.
> — `docs/protocol/PROTOCOL.md` §6

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| one shape | every capability reports the same shape | a stage that is **not proceeding** carries a `CapabilityRecord` — `{ enabled: false, unsupported: <the reason> }` — and the reason is the same sentence | `the degradation contract › the model capability is off in this build…`; `… › the approval capability is off in this build…` |
| the reason | "a sentence that names what is missing" | the reason is checked where the refusal is made: `capabilityRecord` refuses an empty reason, a placeholder and a single word. **A stage cannot refuse with something that says nothing** | `the degradation contract › the model capability is off in this build…` |
| never fake success | "A stage either produces its output, or refuses with a reason, or reports the capability as not enabled with a reason. There is no third thing." | a stage has exactly two outcomes: `completed` with an output, or `refused` with the shared shape. The runner refuses an outcome it cannot read rather than treating it as a success | `the eight built-in stages › …refuses…` (each stage's own refusal) |
| the model capability | "the `model` capability is off in your build" — the model layer is another milestone's work | the `model` capability is **off** with the reason `no model backend is connected`, and the three stages that would use it — `specify`, `plan`, `build` — refuse with it | `the degradation contract › the model capability is off in this build, and the stages that would use it report it` |
| the approvals | "the approval *rules* are another milestone's; the mechanics exist" | the `approval` capability is **off** with the reason `no approval rules are configured`, and the `ship` stage asks the seam and is refused with that reason | `the degradation contract › the approval capability is off in this build, and a stage that needs one is refused with a reason` |
| an enabled capability | "A capability that is enabled and does nothing is a **bug**" | the capability records are **not written by hand**: each one follows the backend it belongs to, and a seam with no backend is disabled with the reason that names what is missing | `the degradation contract › an enabled capability is not a promise that does nothing` |

**Implementation choice — one shape for every refusal.** The specification says the shared
shape is carried "when the stage is not proceeding". The reading is that this covers
**every** way of not proceeding — a capability that is off, a seam that refused, and an
input the stage cannot use — so there is one shape for "not proceeding" and a reason in
it. The **state** in the run's report is the same for all three (`refused`), and the
reason says which one it was.

**Implementation choice — a cancelled run.** The specification says nothing about
cancellation. The reading is that a cancelled run is **reported** like every other
ending: the signal reaches the stage that is running, the run stops at the next stage,
and the report says `the run was cancelled before "<stage>" began`. A cancelled pipeline
stays cancelled — starting another run does not undo the cancellation.

---

## 5. The eight built-in stages

Each stage has a **defined input**, a **defined output** and a **defined refusal**.

| the stage | its input | its output | its refusal | the test that pins it |
|---|---|---|---|---|
| **`concept`** | the run's **brief** | the document: the idea, its title, and the problem it names | *the run carries no idea to work from* | `the eight built-in stages › the concept stage turns the idea into a concept`; `… › the concept stage refuses an idea that is not there` |
| **`clarify`** | the concept's document | the open questions, each with the assumption it holds down | *the concept stage produced nothing to clarify* | `… › the clarify stage asks the questions the concept leaves open`; `… › the clarify stage refuses a concept that is not there` |
| **`specify`** | the concept's document | the **requirements**, each with the **acceptance criterion** that shows it is met | *the model is not connected*; *the model named no requirement for the specification*; *the requirements and the criteria do not pair* | `… › the specify stage writes a specification`; `… › the specify stage refuses an answer it cannot use` |
| **`plan`** | the specification's requirements and criteria | the **steps**, each naming the criterion it delivers | *the model is not connected*; *the plan names a step that delivers no acceptance criterion* | `… › the plan stage orders the work` |
| **`build`** | the plan's steps | the **files** — a path, the content, and the criterion delivered | *the model is not connected*; *the build named a file that carries no acceptance criterion* | `… › the build stage produces the artefacts` |
| **`verify`** | the specification's criteria and the build's files | the **checks** — one per criterion, each with its verdict — and whether the whole passed | *there is nothing to verify*; *there is nothing to verify against* | `… › the verify stage checks the criteria against the artefacts`; `… › the verify stage refuses to verify nothing` |
| **`ship`** | the verification's verdict and the build's files | the **release** — the files, under the run's id | *nothing was verified*; *the product did not pass verification*; *the approval was refused* | `… › the ship stage releases what was verified`; `… › the ship stage refuses to release what did not pass verification` |
| **`operate`** | the release | the **runbook**, and the files to watch | *there is nothing to operate* | `… › the operate stage records what to watch`; `… › the operate stage refuses to operate nothing` |

**Implementation choice — what a stage may invent.** The three generative stages (`specify`,
`plan`, `build`) ask the **model** for a document and parse it. A model that answered with
something the stage cannot read is **not** completed with half an answer: the stage
refuses, and says which part was missing. A stage that filled in what the model did not
say would be faking the model's work.

**Implementation choice — the format the model answers in.** The specification says nothing
about it, and a document has to have a shape. The reading is a line-based one: a line is
a **name** and a **value**, separated by the first space, and the value is the rest of the
line. `requirement` / `accept`, `step` / `satisfies`, `artefact` / `content` /
`satisfies`. The `satisfies` value is a **one-based** index into the specification's
criteria, so a step and the criterion it delivers cannot drift apart.

**Implementation choice — how a criterion is checked.** The `verify` stage checks each
criterion against the files the build produced: a criterion is met when **a file delivers
it**. That is a real check with a real answer — a criterion no file delivers **fails**,
and the stage says so. The stage does not re-run the product's own tests: that is the
verification the product milestone (`CC-049`) carries out, and this stage is the
**pipeline's** check, over the documents the pipeline holds.

**Implementation choice — what `operate` does.** It **records** the operating work; it does
not perform it. Nothing there watches a process, schedules a job or opens a dashboard — the
stage says what would have to be watched, and the product is what does it.

---

## 6. The rules this surface keeps

| the rule | how it is kept | the test |
|---|---|---|
| **Never fake success.** A stage either produces its output, or refuses with a reason, or reports the capability as not enabled with a reason. There is no third thing. | the outcome is one of two shapes, and the runner refuses an outcome it cannot read | every stage's refusal test, and `the eight built-in stages › the pipeline has the eight stages of the Product Builder, in order` |
| **Never skip a stage silently.** | the report carries all eight, and a stage nobody supplied is a refusal | `one stage interface, three deliveries › a stage the pipeline does not have is reported, not skipped` |
| **Every refusal names what is missing.** | the reason is a sentence, checked where the refusal is made | `the degradation contract › the model capability is off in this build…` |
| **The pipeline does not know how a stage arrived.** | the runner calls `run` and nothing else; the three runs are compared | `one stage interface, three deliveries › the pipeline cannot tell the deliveries apart` |
| **The protocol surface is ours.** | it is versioned, it is small, and it is not derived from anyone else's — and the naming rule keeps it that way | `tests/contracts/naming.test.ts` |

---

## 7. What was not done, and why

| what | why |
|---|---|
| the **model layer** — the catalogue, the selection, the credential, and the backend the three generative stages ask | the model layer milestone (`CC-044`). The `model` capability is **off** in this build, and the stages that would use it say so, in the shared shape |
| the **approval rules** — allow, ask, deny, and the matching that decides whether an approval is asked for at all | the approvals milestone (`CC-046`). The protocol's approval *mechanics* exist (`src/protocol/approvals.ts`); the rules do not, and a stage that needs an approval asks the seam and is refused with a reason |
| the **product** — the pipeline driven by a turn, the stage changes rendered in the terminal, the verification the product carries out | the product milestone (`CC-049`) and the terminal surface (`CC-048`). This milestone owns the pipeline and its stages |
| **the model's own protocol** — how a model backend answers a stage's request | the model layer milestone (`CC-044`). The seam here is one method — `complete(request)` — and a backend is anything that answers it |
| **a compatibility row** for the pipeline surface | a divergence is not a compatibility claim. The target has no counterpart for this surface, and the report is a statement about the parity layer |

---

## 8. The readings, in one place

Every place the specification left a choice open, and the reading taken:

| # | the ambiguity | the reading | why |
|---|---|---|---|
| 1 | what a package is | a **module**, carrying its stage in a `createStage` export, a `stage` export or a default export; the export may be the stage or a factory | the specification says "a package the agent loads" and nothing more, and a module is the smallest thing that can be loaded |
| 2 | what the process's `tool/call` carries | `{ "name": <the stage's id>, "arguments": <the stage's input> }`, and the answer carries the outcome in one of two shapes | the protocol names `tool/call` and does not define its parameters; the parameters the protocol's own fixture already uses are the ones kept |
| 3 | what happens to the stages after a refusal | they are reported as `not-reached`, with the reason, and the run is `refused` | they consume a document that does not exist, and running them would be pretending |
| 4 | whether a stage that throws stops the run | it refuses **that** stage with the message it threw, and the run carries on to the report | a stage that throws is a stage that did not produce an output, and the report must say which and why |
| 5 | whether a refusal carries a capability record | **every** refusal carries the shared shape, not only the ones caused by a capability being off | the specification says the shared shape is carried "when the stage is not proceeding", and that covers every way of not proceeding |
| 6 | what a stage may invent | nothing: a model answer the stage cannot read is a **refusal**, not half a document | a stage that filled in what the model did not say would be faking the model's work |
| 7 | the format the model answers in | a line-based one — a name and a value, separated by the first space — and a one-based criterion index | a document has to have a shape, and an index that cannot drift is what lets `verify` check each criterion |
| 8 | how a criterion is checked | a criterion is met when **a file delivers it** | a check that can fail is a check; the pipeline's check is over the documents the pipeline holds |
| 9 | what `operate` does | it records the operating work; it does not perform it | a stage that claimed to be operating something would be faking it |
| 10 | one process per call, or one for the run | **one per call** | a stage is a short unit of work, and a process left behind is a process nobody asked for |
| 11 | what a cancelled run does | it is **reported** like every other ending, and a cancelled pipeline stays cancelled | a cancellation nobody can see is a cancellation that did not happen |
