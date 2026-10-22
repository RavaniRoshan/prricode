# The product surface — conformance

**The concept:** [`docs/DIVERGENCE-LAYER-2.md`](../DIVERGENCE-LAYER-2.md) §4 — the
purpose is stated plainly: "**turning an idea into a verified, shippable
product**", and the pipeline's shape is *concept → clarify → specify → plan →
build → verify → ship → operate*.
**The specification:** [`docs/protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) §6 — the
degradation contract — and §7 — approvals are rules; and §8 — the stages and the
pipeline.
**Owning task:** `CC-049` in
[`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**The implementation:** `src/product/` — **eight modules**.
**The test:** `tests/e2e/product.test.ts` — **eighteen tests**, over a **real HTTP
server on a real port**, through the model layer's own engine.

---

## 0. The labels, and why this surface has no target rows

This surface is **our own design**. The pinned target has no counterpart for a
Product Builder pipeline, so there is nothing to compare it against and **no row
in the compatibility matrix** — a divergence is not a compatibility claim, and a
compatibility row must not be weakened to make room for one.

Every row of this document therefore carries the first layer's **clone-choice
label**:

| label | meaning | here |
|---|---|---|
| `Project requirement` | a product extension: the target does not have this behaviour, and nothing about it is a claim about the target | **every row of this document** |

and, inside the second layer, the label that says where the row comes from:

| label | meaning |
|---|---|
| `specified` | pinned by `docs/protocol/PROTOCOL.md` §6, §7 or §8, or by `docs/DIVERGENCE-LAYER-2.md` — the specification says it, and the implementation says it |
| `implementation choice` | the specification is silent, and the reading below is ours |

The two are orthogonal: a row is `Project requirement` **and** `specified`, or
`Project requirement` **and** `implementation choice`.

**The naming rule applies to every line of this document.** The surface is named
— a product, a stage, a release, an approval — and no product and no company is
named, in this document or in the code it describes.

---

## 1. The wiring — the two seams

> Every capability reports the same shape. […] When a capability cannot run, it
> reports `{ "enabled": false, "unsupported": "<why>" }`. — `docs/protocol/PROTOCOL.md` §6

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the capability is not written by hand | "A capability that is enabled and does nothing is a **bug**" | the `model` capability is **on** only when the model layer's own predicate says the provider is connected (`providerAvailability`), and the `approval` capability is **on** only when a rule is configured. A backend that is not there means the capability is off, with the reason | `the capabilities follow their backends › turns the model capability off when no backend is connected`; `… › turns the approval capability off when no rule is configured` |
| the model backend | "the model backend: any OpenAI-compatible backend — the backend's absence is reported, not worked around" | the product asks the **model layer's** predicate, and only then hands a backend to the seam. The provider that is not connected is named in the product's own diagnostics | `… › turns the model capability off when no backend is connected` |
| the generative work goes through the engine | "one engine speaks every provider" | the three generative stages ask the seam, and the seam is the **model layer's engine** — the same `run(selection, request)` every other caller uses. A stage is not changed, and a stage does not know what answered it | `the product, end to end › asks the model for the three generative documents, through the model layer` (the backend is asked **three** times — one per stage) |
| a model failure | "a turn either produces events, or it fails with a reason that says which thing was missing" | the model layer's reason is carried through **unchanged**, so a stage refused for a model that is not connected says *that* | `… › turns the model capability off when no backend is connected` (the reason the stage gives) |
| a model that says nothing | "**never fakes success**" | an answer with no text is a **refusal** with a reason — the seam says the model answered with no text, rather than handing an empty document to a stage | `the product refuses what it cannot use › refuses a model that answers with nothing` |
| the approvals | "a matching rule decides without asking" | the decision point is the approvals layer's own `ApprovalGate`; the seam maps its three outcomes — `allowed`, `denied`, `refused` — onto the seam's two answers and its one refusal | `the capabilities follow their backends › decides a release with a matching rule, without asking anybody` |
| a rule decides without asking | "a matching rule decides without asking" | the questions are **counted**: **zero**. The rule decided, and nobody was asked | `… › decides a release with a matching rule, without asking anybody` |
| an approval nobody answers | "**An approval that cannot be asked for is not an approval that was granted**" | the gate's refusal is carried through as the stage's refusal, and the run stops **at the release**, naming the reason | `… › refuses a release that nobody answers, with the reason` |
| a denied release | — | a denial is a `deny` answer, and the stage refuses to release what was denied | `src/product/approvals.ts` (the seam's mapping) |

**The capability records are the pipeline's own** (`createStageServices`): the
product hands the services a backend or hands it nothing, and the records follow.
The product never writes a record by hand, so an enabled capability always has
something behind it.

---

## 2. The product refuses what it cannot use

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| a model that answers with nothing | "**never fakes success**" | the seam refuses with the reason, the stage refuses with it, and the stages after it are reported as `not-reached` | `the product refuses what it cannot use › refuses a model that answers with nothing` |
| a file outside the product's own directory | — | the path is refused with a reason and the file is **not written**; the `build` stage refuses, and the stages after it are `not-reached` | `the product refuses what it cannot use › refuses a file the model named outside the product own directory` |

---

## 3. The run — the eight stages, and the eight documents

> A stage that cannot run says so and the pipeline reports which stage and why,
> rather than skipping it silently. — `docs/protocol/PROTOCOL.md` §8

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the whole thing runs | "turning an idea into a verified, shippable product" | all **eight** stages complete, and the run carries the **eight documents** they produce | `the product, end to end › turns an idea into a verified product, through all eight stages` |
| the documents | — | one document per stage, in the pipeline's order, and each one is **written down** (`documents/<stage>.json`) as well as reported | `… › writes the product, its documents and its release down` |
| the product's files | — | the files the build produced are **written**, with the text the build gave them, and the release is recorded (`release.json`) | `… › writes the product, its documents and its release down` |
| a stage that cannot run | "the pipeline reports which stage and why" | the run stops at the stage that could not run, the reason names it, and the stages after it are reported as `not-reached` | `… › turns the model capability off when no backend is connected`; `… › refuses a release that nobody answers, with the reason` |
| a file outside the product's own directory | — | a path that is absolute, or that climbs out with `..`, is **refused with a reason** and is not written | `the product refuses what it cannot use › refuses a file the model named outside the product own directory` |
| the stages are pluggable | "the stages are pluggable" | the product registers the **eight built-in stages**, and it registers its **own** `build` and `verify` — the stages are the pipeline's, and the product's wiring wraps them | `src/product/product.ts` (the stage registration) |

**The product's `build` stage** is the built-in one plus one thing: the files it
produced are **written**. A file that was only described was never built, and the
verification runs against the files — not against the description of them.

**The product's `verify` stage** is the built-in one plus the execution (§3).

---

## 4. The verification — the checks, really executed

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the criteria are met by the files | "the verification the stages carry out real" | a criterion is met by **the test that covers it**: a test file the build produced that names the criterion, **run**, and passed. The coverage is the build's own — the `satisfies` number the file carries | `the product, end to end › runs the tests of the product, and takes their verdict` |
| a criterion nothing tests | — | it is **not met**, and it says so: "no test covers this acceptance criterion, and a criterion that nothing tests is not met" | `the verification is executed, and compared with what the run claimed › fails a run that claims a criterion nothing tests` |
| the product's own test run happens | "the artefacts the pipeline produced are **run and tested**, not merely written" | every test file the build produced is **run**, in a process of its own, in the product's own directory, and the verdict is the runner's own — the process's **exit code** and the tests the runner **reported** | `… › runs the tests of the product, and takes their verdict`; `… › fails a run that claims a criterion is met and does not meet it` (the failing test's verdict is the runner's) |
| a test file that runs no test | — | it is **not passed**: the runner counts the file itself as a test when the file has none, and it says so — the reported test's name is **the file's own path**. So the product asks whether the runner reported a test **other than the file** | `the verification is executed, and compared with what the run claimed › does not accept a test file that runs no test` |
| a test file that cannot be run | — | it is **not passed**, and the runner's own report of the failure is carried into the detail | `… › does not accept a test file that cannot be run` |
| a report this build cannot read | — | the **exit code** is the verdict, and the file is reported as passed. A report this build cannot read is not evidence of an empty file, and it must not fail a product that works | `src/product/testrun.ts` (the `tests.length === 0` path) |

**The tests are really run, and the proof is the failure.** The test that covers
the second criterion is made to fail, and the run's verdict changes with it: a
test that was never run could not have failed. The test reads the runner's own
report — the exit code — and not a file and a judgement.

---

## 5. The claim, and the comparison

> **A run that claims a criterion is met and does not meet it must fail.**

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the claim | — | the **claim** is the pipeline's own check over the documents the run holds: a criterion is met when a file delivers it. It is kept, whole, beside the execution | `the verification is executed, and compared with what the run claimed › fails a run that claims a criterion is met and does not meet it` (the claim says **met**, and the execution says **not met**) |
| the comparison | "the result is compared against what the run claimed" | the two are compared criterion by criterion, and the comparison carries what was **over-claimed** and what was **under-claimed** | `… › fails a run that claims a criterion is met and does not meet it` |
| an over-claim | "a run that claims a criterion is met and does not meet it must **fail**" | the **stage that claimed it refuses**, the run stops there, and the stages after it — `ship` and `operate` — are reported as `not-reached`. **Nothing is released** | `… › fails a run that claims a criterion is met and does not meet it` (the run's `failedAt` is `verify`, and `ship` is `not-reached`) |
| the reason | "a reason that names what is missing" | the reason names the criterion **and why** the execution did not meet it | `… › fails a run that claims a criterion nothing tests` (the reason carries "no test covers this acceptance criterion") |
| an under-claim | — | it is **reported** and it is **not** a failure: a run that is too careful has not faked anything | `src/product/verification.ts` (the `underClaimed` list) |
| the agreement | — | when the claim and the execution agree, the comparison says so: "the run claimed what the product does, and the product does what the run claimed" | `… › agrees with a run that claimed exactly what the product does` |

**The claim is never quietly replaced.** The verification stage's own output
carries **both**: the executed `checks` and the `claimed` ones, beside the
comparison. A reader of the report can see what the run said and what the
product did, and the difference is named.

---

## 6. The command

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the product says which it is | "The product either is verified, or it is not, and it says which" | the report's first line says `the product: verified` or `the product: not verified`, and it names every stage — including the ones that were not reached | `the command › says the product is verified, and leaves the exit code at zero`; `… › reports every stage, including the ones that were not reached` |
| the exit code | — | **zero** when the product is verified and **one** when it is not; a failed run's report goes to the error output | `… › says the product is not verified, and leaves the exit code at one` |

---

## 7. The rules this surface keeps

| the rule | how it is kept | the test |
|---|---|---|
| **Never fake success.** The product either is verified, or it is not, and it says which. | the verdict is computed from the **execution** and the **comparison**, never from the claim; a run that over-claims is refused at the stage that claimed it | `the verification is executed, and compared with what the run claimed › fails a run that claims a criterion is met and does not meet it` |
| **The criteria are met by the files, not asserted.** | the only evidence that a criterion is met is a test that covers it, **run**, and passed | `… › runs the tests of the product, and takes their verdict` |
| **A failure is a failure.** | a stage that cannot run stops the run, and the run names the stage and the reason | `the capabilities follow their backends › turns the model capability off when no backend is connected`; `… › refuses a release that nobody answers, with the reason` |
| **The capability follows the backend.** | the records are the pipeline's own, and the product hands the services a backend only when the model layer's predicate says the provider is connected | `the capabilities follow their backends › turns the model capability off when no backend is connected`; `… › turns the approval capability off when no rule is configured` |
| **A rule decides without asking.** | the questions are counted, and the count is **zero** | `… › decides a release with a matching rule, without asking anybody` |
| **A name is a name.** | every lookup of a caller-supplied key in a plain object is guarded with `Object.hasOwn`; a stage named `__proto__` is an ordinary name | the pipeline's own test (`tests/contracts/pipeline.test.ts`) — the product adds no lookup of its own |
| **The protocol surface is ours.** | it is versioned, it is small, and it is not derived from anyone else's — and the naming rule keeps it that way | `tests/contracts/naming.test.ts` |

---

## 8. What was not done, and why

| what | why |
|---|---|
| the **terminal surface** — the run driven from a screen, the stage changes rendered as they happen | the terminal surface is `CC-048`, and the motion is `CC-047`. The product is a **library and a command**, and it hands the run's advances to a caller through `onStage` |
| the **verification suite** — the four kinds, and the one command that runs them | the verification suite is `CC-050`. This milestone is what it will measure: the product's own run, over a real backend |
| the **wiring of a deployment's own model backend and approval transport** to the command line | the model layer's and the approvals' configuration is theirs, and the first layer's command line is the first layer's. The product takes the backends as options, and the command takes the product |
| a **file the model named outside the product's own directory** | it is refused with a reason. A product that writes wherever it is told to is a product that writes over things it was never asked to write |
| a **multi-line file** | the pipeline's build format carries a file's text on **one line** (`content <the text of the file, on one line>`), and that format is the pipeline's own — `src/pipeline/stages/build.ts` is not this milestone's to change. A product whose files are one line each is a limitation of the format, and it is recorded here rather than hidden |
| a **compatibility row** for the product surface | a divergence is not a compatibility claim. The target has no counterpart for this surface, and the report is a statement about the parity layer |

---

## 9. The readings, in one place

Every place the specification left a choice open, and the reading taken:

| # | the ambiguity | the reading | why |
|---|---|---|---|
| 1 | what "verified" means | three things, and all three are the run's own: the **whole run** completes, the **checks are executed** against the files, and the **product's own tests** are run | the concept says "verified, shippable", and the milestone says the verification is real and the result is compared with the claim. A product that only ran the pipeline would be a product that asserted its own success |
| 2 | how a criterion is met | by **the test that covers it**, and the test must have **passed** | a criterion that nothing demonstrates is not met. The pipeline's own check — "a file delivers it" — is a statement about the documents, and it is exactly the claim the execution is compared with |
| 3 | what "a test that covers it" is | a **test file** the build produced that names the criterion — the `satisfies` number the file carries | the coverage is the build's own, and it is the same number the pipeline's check uses, so the claim and the execution are about the same criteria |
| 4 | what counts as a test file | a file whose name carries `.test.` or `.spec.`, or a file under a `test`, `tests` or `spec` directory | the pipeline's format says what a file is **for**, not what it is called, and the reading has to be ours |
| 5 | how the tests are run | **one process per file**, in the product's own directory, and the verdict is the process's **exit code** and the tests the runner **reported** | the verification has to know which file passed and which did not, and which file ran a test at all. The runner's own report is per file; a combined report would have to be parsed, and its format belongs to the runner |
| 6 | a test file that runs no test | it is **not passed** | the runner counts the file itself as a test when the file has none, and it says so: the reported test's name is the file's own path. The product reads the runner's report and asks whether the runner reported a test **other than the file** — and a file that ran none is not a file that passed |
| 7 | where the claim is compared | **at the `verify` stage**, so the stages after it are never reached | a claim that is wrong must stop the run where it is wrong. A product that released first and corrected itself afterwards would have released something it knew was unverified |
| 8 | what an under-claim does | it is **reported** and it is **not** a failure | the rule is against faking success. A run that is too careful has not faked anything, and failing it would punish the honest case |
| 9 | which verdict the release follows | the **execution's** | the truth about the product is what the tests found; the claim is what the run said about it, and the two are kept apart |
| 10 | where the product's files go | the **workspace** the run is given, and nowhere else — a path that is absolute, or that climbs out with `..`, is refused | the paths come from a model's answer, and a model's answer is data |
| 11 | what the documents are | the **stage's own output**, one per stage, in the pipeline's order, written down as well as reported | the documents are what the stages produced; the product does not rewrite them |
| 12 | the approval's subject | the **stage's id** is the tool, and the stage's own words are the call's arguments; the turn is the run's, and the model is the run's | the rules are the first layer's, and they match a tool call. The pipeline's seam asks about a stage's subject, so the subject is mapped onto a call — and the run's turn is what makes a denial final for the run |
| 13 | who the answerer is | a rule is named (`the approval rule 'ship' from settings`), and a person is the **peer** that answered | the pipeline's release summary says who approved it, and the answer has to be attributable |
| 14 | the run's id | the product's own, unique per run, and it is the release's id | two runs must not share an id, and the release belongs to the run that made it |
| 15 | the command's exit code | **zero** when the product is verified, **one** when it is not | a command that exited zero on a run that did not verify would be the one lie this product is not allowed to tell |
