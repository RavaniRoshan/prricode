# The verification report

**One place that says what was built, what was checked, how it was checked, and what
the check said.** Every number here was produced by a command in this repository, and
every command is re-runnable.

---

## 1. The first layer — the clone

The first layer is a true clone of a pinned reference build. Its bar is a
**machine-checkable** one:

> Every surface the target has is **enumerated**, every entry is **classified** —
> observed with a file and an offset, or named as a gap with a reason — and nothing the
> target has is **unaccounted for**.

### The compatibility report

```
bun run scripts/regenerate-report.ts
```

| outcome | rows | what it means |
|---|---|---|
| `match` | **36** | the row's whole contract is compared, and it matches |
| `partial` | **0** | — |
| `mismatch` | **3** | a difference of any kind from an *observed* behaviour |
| `not-tested` | **3** | the project's own extensions, for which the target has no counterpart |
| `unknown` | **0** | — |

The three `mismatch` rows are the two **mechanism** differences — the target's sandbox
helper and supervisor are native ELF programs and this implementation's are in-process,
so the behaviour is the target's and the mechanism is not — and the four named
differences in what a headless run writes. The three `not-tested` rows are the
multi-provider manager, the credential-as-reference model and the manager's surfaces:
the target has no such surface, so calling them a `match` would be false.

### The completeness verifier

```
bun run scripts/verify-rea.ts
```

It **re-derives** the target's own inventories from its source and fails when the
target has an entry the record does not name. Thirteen surfaces:

| the surface | entries | the surface | entries |
|---|---|---|---|
| the tool registry | 85 | the hook event matrix | 33 |
| the browser tool bundle | 22 | the value-taking flags | 85 |
| the telemetry vocabulary | 3 084 | the boolean flags | 45 |
| the environment-variable surface | 1 285 | the optional-value flags | 14 |
| the settings document | 183 | the repeatable flags | 11 |
| the native inventory | 2 | the command tokens | 10 |
| | | the session subcommands | 6 |
| | | the carve-out flags | 3 |

> **the record accounts for every entry the target has**

Three of those surfaces — the settings document, the seven flag sets and the hook-event
list — were re-derived **after** their implementations were written, and each matched
**exactly**.

---

## 2. The second layer — the product

PRRICODE: an autonomous AI coding agent for the terminal, driving a **JSON-RPC protocol
over stdio** against any OpenAI-compatible model backend, extending into the **Product
Builder pipeline** — concept → clarify → specify → plan → build → verify → ship →
operate. The concept and the decisions are in `docs/DIVERGENCE-LAYER-2.md`.

### What was built

| the milestone | what it is |
|---|---|
| `CC-043` | the **protocol surface** — 13 modules, our own frame kinds, a stable error code beside a human message, six method areas, one capability record asked of anything |
| `CC-044` | the **model layer** — 18 modules, a provider as *data*, the dialect seam, the fetched catalogue over a shipped snapshot, the named overlays, the derived connections |
| `CC-045` | the **pipeline** — 16 modules, one stage interface with **three deliveries**, and the eight built-in stages |
| `CC-046` | the **approvals** — the first layer's own rule language, over the call in its turn, with no second rule engine |
| `CC-047` | the **motion system** — 7 modules, one vocabulary of seven motions, four closed-form easings, a quantised frame, the capability detected once |
| `CC-048` | the **terminal surface** — the motion on the prompt, the states, the stage and the overlays, and the **golden frames** |
| `CC-049` | the **product** — the run, the wiring, and the verification that is really executed |
| `CC-050` | the **verification suite** — one command, four kinds, one report |

### The verification suite

```
bun run scripts/verify-product.ts
```

**Four kinds, each a thing that can fail.** The suite peaks at **85 MB** and finishes in
**0.9 s**; its exit code is **0** when every kind passed, **1** when a kind failed, and
**2** when a kind could not run.

| the kind | what it checks | the mutation that turned it red |
|---|---|---|
| **the product** | the eight stages, the eight documents on disk, the verification really executed, every criterion met by a test that covers it, the claim agreeing with the execution, and **an over-claiming run failing at `verify` and releasing nothing** | forcing the comparison's verdict → red on two checks |
| **the backend** | the protocol over a **real pipe**, the frames read off the **raw** wire, the providers against a **real HTTP server on a real port** speaking all three API shapes, the credential store and **where the secret came from**, and the five failures each degrading with its reason | swallowing the endpoint-refused throw → red |
| **the frontend** | each of the six rendered frames compared **byte for byte** with its golden, and the degraded form against **its own** golden | changing one character of the composer's rule → red on two frames |
| **visually** | every golden recorded, **current** (the record's fingerprint against the sources that draw it), and described by the record beside it | a line added to the theme that changes **no** picture → red on all six currency checks, while **the frontend kind stayed green** — the isolation that proves the staleness check is its own thing |

**A kind that cannot run reports that it could not run** — `enabled: false` and
`unsupported: <why>` — with **no checks at all**, so it never reads as a pass and never
skips quietly.

> **the suite: 4 of 4 kind(s) passed**

---

## 3. The whole repository

| the check | the command | the result |
|---|---|---|
| the test suite | `npx vitest run --maxWorkers=4` | **63 files, 3 115 tests, green** |
| the types | `npx tsc --noEmit` | **clean** |
| the naming rule | `npx vitest run tests/contracts/naming.test.ts` | **green** — no third-party product or company anywhere |
| the clone's completeness | `bun run scripts/verify-rea.ts` | **the record accounts for every entry the target has** |
| the product's verification | `bun run scripts/verify-product.ts` | **4 of 4 kinds passed**, exit 0 |

---

## 4. What is not claimed

The report is the point of this document, so here is what it does **not** say:

- The first layer's three `mismatch` rows are **not** closed. The sandbox helper and
  its supervisor are **native programs** here, and the behaviour — not the mechanism —
  is the target's.
- The first layer's whole-image native inventory was established **from the image's
  payload index**, not from a whole-image scan. The scan timed out three times; the
  index answered it.
- The environment catalogue is a **lower bound**: a name read in a loop over an array
  literal is not seen by the derivation.
- The second layer's surfaces have **no compatibility row**, and that is deliberate —
  the target has no counterpart for them, and a divergence is not a compatibility claim.
- The `model` and `approval` capabilities **follow their backends and their rules**,
  never a hand-written flag. A capability that cannot run says so, with a reason.

---

## 5. Reproducing all of it

```bash
bun run scripts/regenerate-report.ts    # the clone's report
bun run scripts/verify-rea.ts            # the clone's completeness
bun run scripts/verify-product.ts        # the product's verification
npx vitest run --maxWorkers=4            # everything
npx tsc --noEmit                         # the types
```

The goldens are regenerated deliberately and never by a test:

```bash
bun run tests/visual/regenerate.ts
```
