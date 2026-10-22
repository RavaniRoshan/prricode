# The approval surface — conformance

**The specification:** [`docs/protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) §7 —
"Approvals are rules", the way the first layer's permissions are — `allow`,
`ask`, `deny` — so a matching rule decides without asking, and a rule
persists; on top of that, the request names the tool, the call and the reason,
the answer carries the decision and the request id, **an answer is attributed
to the peer that gave it**, and **a denial is final**.
The specification says what was built against it, and where it left a choice
open, which reading was taken and why.
**Owning task:** `CC-046` in
[`docs/superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md`](../superpowers/plans/2026-10-19-reference-agent-2.1.303-implementation.md).
**The implementation:** `src/approvals/` — five modules.
**The test:** `tests/contracts/approvals.test.ts` — **seventeen tests**.

---

## 0. The labels, and why this surface has no target rows

This surface is **our own design**. The pinned target has an approval surface
of its own, and the first layer reproduces it — that is
[`docs/compatibility/permission-matrix.md`](permission-matrix.md), and it
measures the **rules**. This document measures the **second layer's** rule
model, its **decision point** and the **protocol** around them, and the second
layer's approval surface is not a copy of the first layer's: it is the
product's own, built on the first layer's foundations.

So there is nothing to compare this surface against and **no row in the
compatibility matrix**: a divergence is not a compatibility claim, and a
compatibility row must not be weakened to make room for one. The rules
themselves are measured where they were measured before — in the permission
matrix — and the **equivalence** between them and this layer's rules is a
**test** (§1).

Every row of this document therefore carries the first layer's **clone-choice
label**:

| label | meaning | here |
|---|---|---|
| `Project requirement` | a product extension: the target does not have this behaviour, and nothing about it is a claim about the target | **every row of this document** |

and, inside the second layer, the label that says where the row comes from:

| label | meaning |
|---|---|
| `specified` | pinned by `docs/protocol/PROTOCOL.md` §7 — the specification says it, and the implementation says it |
| `implementation choice` | the specification is silent, and the reading below is ours |

The two are orthogonal: a row is `Project requirement` **and** `specified`, or
`Project requirement` **and** `implementation choice`.

**The naming rule applies to every line of this document.** The surface is
named — an approval, a rule, a decision — and no product and no company is
named, in this document or in the code it describes.

---

## 1. The rules are the first layer's

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the rule shape | "Approvals are rules, the way the first layer's permissions are — `allow`, `ask`, `deny`" | the rule set **is** the first layer's `RuleSet` — the three lists, the working directory, the settings directories, the per-rule attribution | `the approval rules are the first layer's rules › a rule written for the first layer's permissions behaves the same way here` |
| the rule language | "the way the first layer's permissions are" | the first layer's syntax (`Tool`, `Tool(matcher)`, `Tool(param:value)`, `!` negation), the first layer's parser (`parseRule`), the first layer's matcher (`evaluateListOutcome`) and the first layer's path anchors | `… › a rule written for the first layer's permissions behaves the same way here`; `… › the layer has no rule language of its own` |
| the precedence | "a matching rule decides without asking" | the first layer's own order — `deny` → `ask` → `allow`, and the first rule **in a list** that matches is the rule that matched | `… › a matching allow rule decides without asking`; `… › a matching deny rule decides without asking` |
| the subject | "what a tool call is, and whether it needs a human" | the call, **in the turn it belongs to**: the tool, the call's arguments, and the turn's **model** | `… › a rule may match on a model` |
| the equivalence | — | the approval layer's verdict **is** the first layer's own `evaluateRules` over the same rules and the same call, with "nothing matched" read as *ask* | `… › a rule written for the first layer's permissions behaves the same way here` |

**The equivalence is proved by construction and by test.** The approval layer
does not have a rule language: `src/approvals/rules.ts` imports the first
layer's matcher, and the test runs the first layer's own `evaluateRules` over
the same rules and the same call and compares the two verdicts, case by case
— a bare allow rule, a deny rule, an ask rule, a compound command an allow
rule covers only in part, and a call no rule covers.

**A second rule engine would have a pattern language of its own**, and the
test says so: no module under `src/approvals/` contains a regular expression,
and the rule module imports the first layer's.

---

## 2. The decision point — three ways out

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| a matching rule decides | "a matching rule decides without asking" | `ApprovalGate.decide` returns as soon as a rule decides — and the test counts the questions the transport was asked: **zero** | `the approval rules are the first layer's rules › a matching allow rule decides without asking`; `… › a matching deny rule decides without asking` |
| an unmatched call asks | the ask is what the rules are for | a call no rule covers is asked about; the request names the tool, the call and the reason | `… › an unmatched call asks`; `… › an ask rule asks, and the answer resolves it` |
| the answer resolves it | "`approval/answer` carries `allow` or `deny` and the request id" | the outcome is `allowed` or `denied`, and it carries the decision, the answerer and the request id the answer quoted | `… › an ask rule asks, and the answer resolves it`; `… › an unmatched call asks` |
| a denial is final | "**A denial is final.** It is not re-asked within the turn." | the denial is recorded against the turn, and the same call in the same turn is **not asked about again** — the test counts one question for two decisions | `the decision point › a denial is final and is not re-asked within the turn` |
| the scope of the finality | "within the turn" | the turn, the session when the call belongs to no turn, and the life of the gate when it belongs to neither | `the decision point › a denial in one turn does not silence the next turn` |
| a partially covered command | — | an allow rule that covers only part of a compound command approves nothing, and the parts it did not cover are named — the first layer's escalation, in the first layer's order | `the decision point › an allow rule that covers only part of a command is asked` |
| never fake success | "A decision either resolves, or refuses with a reason, or reports the capability as not enabled with a reason. There is no third thing." | **three** outcomes: `allowed`, `denied` and `refused`. A build with no transport, a deployment whose approval capability is off, a peer that failed and a peer that never answered are all a **refusal with a reason** | `the decision point › an approval that cannot be asked for is a refusal with a reason`; `… › an approval nobody answers is a refusal with a reason` |

**The three ways out, and only three.** An approval that could not be asked
for is **not** an approval that was granted: it is a refusal, and it says
why. There is no fourth outcome, and the outcome's `decidedBy` says which of
the three happened — `rule`, `answer` or `nobody`.

---

## 3. The approval that travels over the protocol

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| the request | "sent when a rule says *ask*. It names the tool, the call and the reason, and it carries the request id the answer must quote" | the request is the protocol's own `ApprovalRequest` — the tool, the call, the reason, the request id, and the session and turn when the call belongs to them | `the approval rules are the first layer's rules › an ask rule asks, and the answer resolves it` |
| the attribution | "**An answer is attributed to the peer that gave it**, so a client that answers on the user's behalf is recorded as the answerer, not as the user" | the outcome carries the `answerer` the protocol recorded — the peer, not the user it answered for. The test runs the **real protocol** — the real framing, the real peer, the real registry — and reads the answerer | `the approval that travels over the protocol › the answer is attributed to the peer that gave it` |
| the mechanics | "an answer for an unknown request id is dropped and reported `approval/unknown`" | the mechanics are the **protocol's** (`src/protocol/approvals.ts`, `CC-043`) and are not reimplemented here: the pending set, the dropped answer and the final answer are the protocol's own, and they are measured by the protocol's own test | `tests/contracts/protocol.test.ts` (the protocol surface's own test) |
| the capability | "reports the capability as not enabled with a reason" | the transport reports whether an approval can be asked at all; the `approval` area of the protocol is off until a deployment turns it on, and a disabled capability is a **refusal carrying the capability's own reason** | `the decision point › an approval that cannot be asked for is a refusal with a reason` |

**The transport is a seam.** `ApprovalTransport` is the only way the decision
point asks, and the protocol's server is one implementation of it
(`protocolApprovalTransport`): the server owns the request id, the pending set
and the wire, and the answer it reports back carries the peer that gave it.

---

## 4. A rule persists

| | what the specification says | what was implemented | the test that pins it |
|---|---|---|---|
| a rule persists | "so a matching rule decides without asking, and a rule persists" | an approval is written to a **store**, and the next decision for the same call is made **by the rule** — with the test counting the questions: **zero** | `a rule persists › the rule decides the next time, and no question is asked`; `… › the persisted rule asks nobody` |
| the rule's text | the first layer's rules | the first layer's own computation (`persistentAllowRules`) — one rule per sub-command that needed approval, capped at the first layer's five | `… › the rule decides the next time, and no question is asked` |
| the rule matches the call | — | a persisted **path** rule is anchored to the filesystem root, so that it matches the very call that was approved — the first layer's `/path` anchor resolves against the *settings source*, which would point somewhere else | `… › a persisted path rule is anchored so that it matches the call that was approved` |
| the persisted rule's place | — | the caller's rules come **first** in every list, and the persisted rules follow, so a persisted rule never displaces a rule the user wrote | `… › the rule decides the next time, and no question is asked` |
| a persisted rule does not override a deny | the first layer's precedence | the precedence is the first layer's: `deny` → `ask` → `allow`, so a persisted approval cannot rescue a call a deny rule blocks | `… › a persisted rule does not override a deny rule` |
| where the rules are kept | — | a **seam** (`ApprovalRuleStore`), with a file implementation that writes one JSON document **atomically** — a temporary file and a rename | `… › the rule decides the next time, and no question is asked` |

---

## 5. The rules the layer keeps

| the rule | how it is kept | the test |
|---|---|---|
| **Never fake success.** A decision either resolves, or refuses with a reason, or reports the capability as not enabled with a reason. There is no third thing. | the outcome has **three** members — `allowed`, `denied`, `refused` — and a refusal always carries a sentence that says what was missing | `the decision point › an approval that cannot be asked for is a refusal with a reason`; `… › an approval nobody answers is a refusal with a reason` |
| **The naming rule.** | the layer names the capability — an approval, a rule, a decision — and no product and no company | `tests/contracts/naming.test.ts` |
| **No second rule engine.** | the layer calls the first layer's matcher; it has no pattern language of its own | `the approval rules are the first layer's rules › the layer has no rule language of its own` |
| **A key that came from data stays data.** | a rule text is caller-supplied data, so the per-rule attribution map is **defined** rather than assigned: a rule text that names `__proto__` is an own data property and never a prototype | the map is built by `defineRuleSource`; the lookup of a rule's tier is the first layer's own `Object.hasOwn` check |
| **Never fake success — in the store.** | a store that cannot be **read** refuses the decision, because a decision made of rules nobody can read is a decision made of nothing; a store that cannot be **written** does not undo the decision, and the failure is reported in the outcome | `a rule persists › the rule decides the next time, and no question is asked` (the write path) |

---

## 6. What was not done, and why

| what | why |
|---|---|
| the **permission modes** — `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` | the approval layer has **rules**, not modes. The modes are the first layer's, and they belong to the first layer's decision layer; an approval asks a human or it does not |
| the **hooks** — `PreToolUse` and `PermissionRequest` | the first layer's, and they rewrite the tool input; an approval is a rule and a human's answer, and neither rewrites anything |
| the **safety check** and the tool's own validation | the first layer's, and they run on the write path, which the tool runner owns |
| the **wire vocabulary** of a deployment's own approval channel | the protocol surface is ours and the transport is a seam: a deployment supplies its own transport, and the request it carries is the protocol's |
| **where the rules are kept** | the store is a seam, and the file implementation is one of it. The deployment's own configuration decides where its rules live; this milestone does not extend the settings document |
| the **agent loop** that calls the decision point | the pipeline (`CC-045`) and the agent loop own the call. This milestone owns the decision point they call |
| a **compatibility row** for the approval surface | a divergence is not a compatibility claim. The target's counterpart is the first layer's permission surface, measured in `docs/compatibility/permission-matrix.md` |

---

## 7. The readings, in one place

Every place the specification left a choice open, and the reading taken:

| # | the ambiguity | the reading | why |
|---|---|---|---|
| 1 | a call no rule covers | it **asks** | "a matching rule decides without asking" reads as the rule's being the thing that decides *without* asking — so a call no rule covers is asked about. It is also the first layer's `default` mode, and the safe direction |
| 2 | the subject of a rule | the call **in the turn it belongs to** | the model layer is landed, and a rule may name the model a call runs against. The turn's model is an **additional** field of the subject: the call's own fields always win |
| 3 | how the model is named in a rule | with the first layer's own parameter form — `Tool(model:…)` | the parameter form is the first layer's language, and the model's field is not one of the first layer's primary content fields, so the rule is matched and not degraded |
| 4 | the finality's scope | the **turn**; the session when the call belongs to no turn; the gate's life when it belongs to neither | the specification says "within the turn", and the two wider scopes are the natural readings of a call that belongs to no turn |
| 5 | what a denial is recorded against | the tool and the call's arguments, written out in a stable order — or the call's own id, when the caller has one | the denial has to recognise the same call, and the arguments are what the call *is* when it has no id |
| 6 | whether an approval is remembered within the turn | **no** — only a denial is | the specification makes the *denial* final and says nothing about an approval. The way an approval becomes permanent is the rule it persists |
| 7 | what is persisted | the **allow** rules the first layer's own computation produces, and only those | the first layer's "don't ask again" affordance persists allow rules. A denial is final within the turn and is not written down: the human refused *this* call, and a rule refusing every call of that shape afterwards would be a larger decision than the one that was made |
| 8 | where a persisted path rule points | the **filesystem root** (`//path`) | the first layer's `/path` anchor resolves against the *settings source*, so a rule written from an absolute path would point somewhere else and would not match the call that was approved |
| 9 | a store that cannot be read | the decision is **refused**, with the reason | the rules are what the decision is made of; a decision made of rules nobody can read is a decision made of nothing |
| 10 | a store that cannot be written | the decision **stands**, and the failure is reported in the outcome | the human allowed the call, and refusing it now would be wrong. The rule that could not be kept is reported, and the next time the call will be asked about again |
| 11 | the reason text | the second layer's own wording | the wording is ours; the matching it reports is the first layer's. The first layer's `describeReason` names *permission* rules, and this is a different surface |
| 12 | how long the gate waits | sixty seconds by default, and the wait ends in a refusal | an approval nobody answers is not an approval that was granted |
| 13 | the request ids | `approval_1`, `approval_2`, … per gate, and the prefix is the caller's | the protocol's ids must be unique within a peer, and a deployment with several gates gives them different prefixes |
