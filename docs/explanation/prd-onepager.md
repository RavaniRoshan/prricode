# prricode — The Product Builder (one-pager)

**Concept in, running product out.**

prricode is an open-source, model-agnostic system that carries an idea end to
end: conversation → specification → plan → build → verification → delivery →
operation. It takes the whole job, the way a software developer does — not a
slice of it.

**The bet:** AI agents made code generation ~30% faster while resolved work
stayed flat and review time rose 49% (Jellyfish telemetry via Chen &
Stratton, 2026, working paper). Generation isn't the bottleneck — verification
and delivery are. Every agent optimizes the step that doesn't matter.

**What's different (ruthlessly):**

| Claim | Real? |
|---|---|
| Last mile to production — infra, CI/CD, deploy, observability, rollback | **Yes — the white space.** Nobody carries a concept to a live, operated product. |
| Verification as the product — independent adversarial verifier, acceptance dossier | **Yes — the moat.** The builder never judges its own work. |
| Cost per delivered outcome as a first-class metric | **Yes.** Tokens + CI + reviewer minutes per shipped unit. |
| Layered spec model (EARS, waves) | **Table stakes.** Kiro/Spec Kit/SpecShip already did this. |
| Model-agnostic | **Table stakes.** OpenCode/Cline/OpenHands already did this. |

**The UX trick:** the TUI looks like any coding agent — composer, streaming,
tools, approvals. What's different is underneath: a gated pipeline (Concept →
Clarify → Specify → Plan → Build → Verify → Ship → Operate) where each stage
exits only on a machine-checkable verdict, and the reviewable artifact is an
acceptance dossier, not a diff.

**Autonomy rule:** full autonomy where an oracle exists; human judgement where
it doesn't. Approval gates only at irreversible moments (deploy, spend,
publish).

**Success metric:** issues and epics resolved — not lines of code.

**v0.1 scope (one sentence):** a non-engineer types a rough idea and gets a
complete, EARS-checked specification and a wave-scheduled build plan back —
inside the TUI.

**Open source, MIT, multi-provider:** any model behind the same harness.
