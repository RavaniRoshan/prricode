# prricode — Product Requirements Document

**The Product Builder: concept in, running product out.**

Status: Draft for founder review · Date: 2026-10-14 · Owner: RavaniRoshan
Audience: founder first, engineering team (1–3) second.

---

## 1. Problem & evidence

AI coding agents made generation faster. They did not make software delivery
faster.

Harvard researchers Fiona Chen and James Stratton, using Jellyfish engineering
telemetry (~300M work events, 718 firms, ~726,000 workers, January 2021 –
March 2026), found that adopting AI coding agents raised:

- lines of code ~30%
- commits ~20%
- pull requests ~23%

while **resolved Jira issues and epics showed no statistically significant
gain**. Downstream metrics worsened:

- PR submission → merge time rose 49% (3.45 days on a 7.03-day baseline)
- change requests nearly doubled
- comments per PR rose 35%
- the share of workers doing review rose 14%

At the March 2026 cutoff, AI wrote only **23.3% of review comments** and
**10.8% of PRs** — the review surface is almost entirely unclaimed.

**Caveats (stated honestly):** this is a working paper, not peer-reviewed, and
it is observational. It shows output stalled while review stretched — it does
not prove causation. We treat it as directional evidence, not settled science.

**Implication for this product:** every agent on the market optimizes the step
that is not the bottleneck. The opening is downstream — verification, review,
integration, delivery, operation.

## 2. Positioning & non-goals

**One-line positioning:** prricode treats "done" as a contract to verify, not a
diff to trust.

Supporting lines:

- "Concept in, running product out."
- "CI/CD for intent."
- "The agent is the engine. The acceptance layer is the product."

**This is not a coding agent.** A coding agent is something you open on a
normal day to change part of a codebase. prricode takes the whole job — the way
a software developer does — not a slice of it. The unit of work is not a code
edit; it is a shipped, verified outcome.

**Non-goals (explicit):**

- Not another code-generation agent. Generation is a commodity stage, not the
  product.
- Not a spec-documentation tool. Specs are the machine-readable contract that
  the pipeline verifies against — not a deliverable you read.
- Not brownfield-first in v0.1. Brownfield is the larger market and the harder
  problem; it is a later milestone, not the initial bet. (v0.1.1 adds the
  foundation: a deterministic workspace survey that makes the spec, the plan,
  the gates, and the property tests run against the project that is already
  there.)
- Not a model provider. Any provider, always — table stakes, not a
  differentiator, since the whole executor category is already model-agnostic.

## 3. Users & scenarios

**Primary user:** a technical solo founder or a small team (2–5) who has more
product ideas than delivery capacity, and who is willing to trade edit-level
control for shipped outcomes.

**Secondary users:** (a) an engineering lead who wants the review artifact, not
the code dump; (b) the non-technical co-founder who can specify intent and
approve gates but cannot review a diff.

**Entry scenarios (three ways in):**

1. **Rough idea** — "I want a service that turns RSS feeds into daily podcast
briefings." Nothing else.
2. **Documents** — a PRD, a set of markdown docs, a Jira board export.
3. **Conversation only** — the user talks; prricode interviews.

All three converge on the same stage-1 output: a structured concept with
resolved ambiguity, success criteria, and non-goals.

## 4. Product surface (TUI-first)

prricode looks like a coding agent because the interaction model is the right
one: a composer, streaming turns, visible tool calls, inline approvals. The
difference is what the agent *does* with your input — it runs a pipeline, not a
single turn.

**What the TUI shows that a coding agent does not:**

- **Pipeline rail** — the current stage (Concept → Clarify → Specify → Plan →
  Build → Verify → Ship → Operate) with per-stage gate status, always visible.
- **Spec & plan views** — requirements (EARS), the task graph, and waves
  rendered as data, not prose walls.
- **Wave progress** — which tasks run concurrently, which are gated.
- **Verification verdicts** — gate results as machine-checkable pass/fail with
  evidence, inline.
- **The acceptance dossier** — the reviewable artifact: what changed, what was
  verified and how, evidence, residual risk, and what was explicitly *not*
  tested.
- **Approval prompts only at irreversible moments** — deploy, spend, publish.
  Not at every edit.

**Interaction stance:** minimise human input, maximise autonomy, but place
human approval at the irreversible moments rather than at every step.

## 5. Pipeline architecture

Eight stages, each with entry/exit gates. A stage advances only when its exit
gate passes; a failed gate feeds the stage back, not forward.

| # | Stage | Input | Exit gate (machine-checkable unless noted) |
|---|---|---|---|
| 1 | **Concept / Intake** | idea, docs, or conversation | Concept card exists: problem, user, value, non-goals, success criteria |
| 2 | **Clarify** | concept card | No unresolved ambiguity markers; success criteria are testable |
| 3 | **Specify** | clarified concept | Every requirement is EARS-form and has ≥1 acceptance criterion; specs parse and cross-reference |
| 4 | **Plan** | spec | Task graph is acyclic, wave-scheduled, every task traces to a requirement |
| 5 | **Build** | task | Per-task gate: typecheck + build + tests pass |
| 6 | **Verify** | built change | Independent verifier verdict: property tests + static + runtime/security gates pass, with evidence |
| 7 | **Ship** | verified change | Deploy succeeds; health checks green; acceptance dossier generated *(deploy gate is human-approved by default)* |
| 8 | **Operate** | live product | Observability present; rollback triggers defined; production failure reopens the originating issue |

**Business layer** (market/competitive research, pricing, landing page, GTM
scaffolding) runs alongside stages 1–7 as a separate track. It has the weakest
oracles in the system and is human-gated by default.

## 6. The layered spec model

Specs are living, versioned, machine-checkable artifacts — the source of truth
for the whole pipeline. Change a requirement and the design, tasks, and
verification regenerate against it.

**Core (the three-file spec model the category converged on, so its vocabulary is reusable):**

- `requirements.md` — user stories + acceptance criteria in **EARS notation**:
  "WHEN [condition] THE SYSTEM SHALL [behaviour]". Each requirement is a
  property to verify.
- `design.md` — architecture, sequence diagrams, data models, interfaces, error
  handling, testing strategy.
- `tasks.md` — dependency-ordered, discrete tasks; grouped into **waves**
  (independent tasks run concurrently; dependent tasks gate).
- **Steering files** — persistent project context carried across stages.

**Extensions (what makes it a product spec, not a feature spec):**

| Spec | Contents |
|---|---|
| Product spec | problem, users, value, success metrics, non-goals |
| Backend spec | services, data stores, contracts, migrations |
| Frontend spec | flows, states, components, accessibility |
| Infra spec | environments, IaC, CI/CD, secrets, scaling |
| Non-functional spec | security, performance, accessibility, cost, compliance — as first-class verified gates |
| Task graph | dependency-ordered, wave-scheduled, requirement-traceable |

## 7. Verification & acceptance (the moat)

**The rule:** the agent that built the code cannot be the one that judges it.
The verifier runs with a fresh context and receives the spec, the diff, and the
evidence — never the builder's reasoning, conversation, or intent.

**Verification methods, in order of oracle strength:**

1. **Gate runner** — typecheck, build, tests. Binary verdicts, always on.
2. **Property-based tests derived from requirements** — each EARS requirement
   generates ≥1 property; tests are generated against the *requirement text*,
   not the implementation.
3. **Static analysis** — types, linters, dependency/security scanning.
4. **Runtime checks** — endpoint responds, browser flows (where applicable).
5. **Security review** — adversarial pass over the diff against the
   non-functional spec.

Every verdict is emitted as a machine-checkable record (gate, pass/fail,
evidence pointer) — never prose. Prose is for humans *after* the verdict.

**The acceptance dossier** replaces the diff as the reviewable artifact:

1. What changed (traceable to requirements)
2. What was verified and how (gate, method, evidence)
3. Residual risk
4. What was explicitly *not* tested and why

**Why this is the moat:** verification is only as good as its oracle. Tests
generated by the same model that wrote the code turn sycophantic — which is
why the verifier is independent by construction, and why every claim in the
dossier carries evidence a human can check.

## 8. Last mile: ship & operate

Every existing tool stops at "PR ready to merge" or "runs locally." None
carries the concept to a live, operated product. This is the genuine white
space.

- **Ship** — provision infrastructure (IaC), wire CI/CD, deploy, produce the
  PR *with the acceptance dossier attached*. The deploy gate is
  human-approved by default (irreversible + external side effects).
- **Operate** — observability and alerting configured as part of the pipeline,
  auto-rollback on regression signals, and a closed loop: if a shipped change
  breaks in production, the originating issue reopens with the failure
  evidence.
- **v0.1 scope for this section** (single sentence): *greenfield products only,
  one deploy target (a static site plus one API backend), human-approved
  deploys, rollback = redeploy previous known-good version.*

## 9. Business layer

The part nobody else touches: from market research to go-to-market, so the
output is a product, not a repository.

- Market/competitive research against a named competitor set
- Pricing scaffolding (tiers, limits, a pricing page draft)
- Landing page + docs site scaffolding

**Honesty note:** this layer's oracles are weak (there is no test for "is this
price correct"). It stays human-gated until a verifiable proxy exists.

## 10. Autonomy vs verifiability model

Karpathy's rule for autonomous loops applies directly: *if you can't evaluate
it, you can't automate it.* The architecture must be honest about which stages
have oracles.

| Stage | Oracle exists? | Autonomy |
|---|---|---|
| Build (typecheck/build/tests) | Yes — machine-checkable | Full autonomy |
| Verify (property tests, gates) | Yes — machine-checkable verdicts | Full autonomy, independent verifier |
| Plan (graph acyclicity, traceability) | Yes — structural checks | Full autonomy |
| Specify (EARS parse, coverage) | Partially — structural yes, quality no | Autonomous with clarifier loop; human gate at first spec |
| Clarify (ambiguity resolution) | Partially — resolved markers yes, right questions no | Autonomous interview; human confirms the concept card |
| Concept (is this the right product) | **No** | Human judgement |
| Ship (deploy) | Partially — health checks yes, safety no | **Human approval gate (default)** |
| Operate (rollback) | Yes — regression signals | Autonomous execution of the pre-agreed rollback |
| Business (price, GTM) | **No** | Human judgement |

Pretending every stage is verifiable is how you ship slop at machine speed.

## 11. Metrics

Success is measured in delivered work, not activity:

- **Primary: issues and epics resolved** — the number the study found flat.
- Rework rate (change requests per merged change)
- Review time and PR-to-merge time
- Incidents in production per shipped change
- **Cost per delivered outcome** — tokens + CI minutes + reviewer minutes,
  tracked end-to-end and optimised down

Explicitly **not** a metric: lines of code, commit count, PR count.

## 12. Architecture: what exists vs what's new

prricode already runs the engine: a TUI that looks like a coding agent, a
tool-calling agent loop, sandboxed execution, a workflow engine, sessions, and
multi-provider models. The Product Builder adds a *contract layer* between the
same surfaces:

| Pipeline stage | Exists today | New for the Product Builder |
|---|---|---|
| Intake | TUI composer, sessions | Concept intake + doc import (PRD/issues/diagram files) |
| Clarify | — | Interview agent (ambiguity, non-goals, success criteria) |
| Specify | — | `prricode-spec`: EARS requirements, layered specs, steering, versioned + regenerable |
| Plan | `prricode-workflow` (ordered steps) | Task graph: dependency-ordered, wave-scheduled, requirement-traceable |
| Build | agent loop, 9 tools, bwrap sandbox, subagents | Per-task sandboxed executors; milestone gates before advance |
| Verify | — | `prricode-verify`: independent verifier agent (fresh context, builder hidden), property tests, static/runtime/security gates |
| Ship | — | `prricode-ship`: IaC, CI/CD wiring, deploy runbooks, **acceptance-dossier generator** |
| Operate | — | Observability/alerting config, rollback triggers, failure → issue re-open |
| Business | — | Research/pricing/GTM scaffolding (human-gated) |
| Economics | usage/read (tokens) | Cost-per-outcome ledger: tokens + CI + reviewer minutes per delivered unit |

**Architectural rules (binding):**

1. The verifier never shares context with the builder — isolation by
   construction, not by prompt.
2. Every gate emits machine-checkable verdicts, not prose.
3. Specs are the source of truth: changing a requirement regenerates design,
   tasks, and verification.
4. The dossier, not the diff, is what a human reviews.
5. Everything stays protocol-compatible — the TUI and the JSON-RPC surface
   remain the same two entry points; new capabilities are tools and views, not
   a new protocol.

## 13. Risks & hard parts

| Risk | Stance in this PRD |
|---|---|
| Auto-defining "done" fails silently | Every gate is a verdict with evidence; a spec with no verifiable criteria blocks stage 3, not the pipeline |
| Verifier is only as good as its oracle | Independent verifier by construction; property tests generated from requirement text, never from the implementation |
| Verification costs more than the review it replaces | Cost-per-outcome is a first-class metric; verifier model tier is configurable per stage |
| Teams won't accept unattended deploys | Deploy gate is human-approved by default; every autonomous step produces a checkable artifact |
| Spec layer is crowded | We do not compete on documents; the moat is verification + last mile |
| Autonomy without verification manufactures unreviewed code | The pipeline's core loop is build → independently verify → only then advance |
| Weak business-layer oracles | Human-gated until a verifiable proxy exists; never automated on vibes |

## 14. Prior art

| Category | What exists | Where it stops |
|---|---|---|
| Spec-driven agentic IDEs and CLIs | requirements / design / tasks files, EARS notation, dependency waves, steering files, hooks, property-based testing | Spec + implementation |
| Agent-agnostic SDD toolkits | specify → plan → tasks → implement with dozens of agent integrations | Implementation |
| Adversarial-validation harnesses | recon → plan → build → validate with anti-slop gates | Validation, not operation |
| Coding executors | agentic coding with swappable models | Code edits / PRs |

**The spec layer is solved. The last mile is not.** prricode differentiates on
verification economics and the carry-to-production, not on documents.

## 15. Open questions & decisions

Defaults pre-filled so the PRD is actionable before the founder answers; each
has an owner and a due milestone.

| # | Question | Default (if unanswered) | Owner |
|---|---|---|---|
| 1 | Smallest verifiable unit of "product" shipped autonomously? | Landing page + one API backend + tests + dossier (greenfield) | Founder |
| 2 | Where do human approval gates go, and how few? | Ship (deploy), spend, publish; everything else autonomous | Founder |
| 3 | Can the business layer be made verifiable? | No — stays human-gated | Founder |
| 4 | Moat if specs commoditise? | Verification + acceptance dossiers + last mile + cost-per-outcome | Founder |
| 5 | Greenfield only, or brownfield too? | Greenfield first; brownfield evaluated after v0.3 | Founder |
| 6 | Which deploy target(s) for v0.1? | One static host + one backend host; provider selected at spec time | Founder |
| 7 | Verifier model tier | Same provider, separate context, cheaper model allowed | Eng |

## 16. Milestones

- **v0.1 — Concept to spec (greenfield):** intake + clarifier + spec model +
  task graph. Demo: a rough idea becomes a complete, EARS-checked spec and a
  wave-scheduled plan inside the TUI.
- **v0.2 — Build & verify with gates:** task executors + gate runner +
  independent verifier + property tests. Demo: the pipeline builds a small
  greenfield app and produces a passing verdict with evidence.
- **v0.3 — Ship & operate:** one deploy target, human-approved deploy,
  observability, rollback, failure→issue loop. Demo: concept to a live URL
  with a rollback drill.
- **v0.4 — Business layer + economics:** research/pricing/GTM scaffolding and
  the cost-per-outcome ledger wired end to end.

---

*End of PRD. See `docs/explanation/prd-onepager.md` for the positioning card.*
