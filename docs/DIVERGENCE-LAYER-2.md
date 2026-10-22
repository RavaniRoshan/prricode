# The second layer: the concept, saved and not started

**This is a record of an intention, not a plan and not a start.** The first layer — the
true clone of the target's behaviour — is not complete yet, and this layer does not
begin until it is. Nothing in this file is implemented. It exists so that the idea is
not lost, and so that whoever plans the second layer starts from what was said rather
than from what they can reconstruct.

---

## 1. The concept

> **PRRICODE** — an autonomous AI coding agent for the terminal, built as an open-source
> Rust workspace. It drives a JSON-RPC protocol over stdio, runs a tool-calling agent
> loop against any OpenAI-compatible model backend, and extends into the Product Builder
> pipeline: concept → clarify → specify → plan → build → verify → ship → operate,
> turning an idea into a verified, shippable product.

## 2. The standing rules

**Licensing.** MIT. All code is our own.

**The naming rule.** Never reference, name, or cite any third-party product or company
anywhere — source, comments, docs, commit messages, identifiers. The protocol surface is
our own design.

> **This rule is already enforced in the first layer**, by `tests/contracts/naming.test.ts`,
> which reads every text file under `src/`, `tests/`, `docs/` and `scripts/` and fails on
> the target's product name. The first layer draws one distinction the second layer
> should keep:
>
> - **A name is forbidden.** What the product says about itself, and any third-party
>   product or company.
> - **A datum is not.** The model ids, the API hosts, the environment variables, the
>   configuration root, the settings key names, the tool names, and the name of a binary
>   the program must actually invoke — a clone that renamed a key would reject a file the
>   target accepts, and a program that renamed a binary on disk would not run.
>
> **One open question for the second layer's planning:** the first layer's sandbox names
> the binary it invokes, because that is the binary's own name on the machine. Whether
> the second layer's rule admits that, or requires the name to be a parameter the code
> supplies, is a decision to make when the second layer is planned — not now.

## 3. The capabilities, and the honest-degradation contract

Every capability is required, and **honest degradation is the contract**: a feature that
cannot run **degrades with a clear reason** — `enabled: false`, `unsupported: <why>` —
and **never fakes success**.

| capability | what it needs | how it degrades |
|---|---|---|
| **Linux sandboxing** | a containment mechanism | `enabled: false` with the reason |
| **Computer use** | a display server and input control | `enabled: false` with the reason |
| **Approvals** | a human decision | the approval is *asked for*, and refused without it |
| **The JSON-RPC protocol over stdio** | — | the protocol surface is our own design |
| **The model backend** | any OpenAI-compatible backend | the backend's absence is reported, not worked around |
| **The Product Builder pipeline** | the stages below | a stage that cannot run says which stage and why |

**The specific mechanism for sandboxing and for computer use is an open decision**, to be
settled when this layer is planned. It was raised with two concrete candidates, and the
naming rule above bars writing either into the repository — so the choice is made, and
the repository refers to the capability, not to the technology.

## 4. The Product Builder pipeline

```
concept → clarify → specify → plan → build → verify → ship → operate
```

The purpose is stated plainly: **turning an idea into a verified, shippable product.**
The stages are the pipeline's shape; each one's contract — what it consumes, what it
produces, what it can refuse — is to be planned.

## 5. The stack, and the port question

The concept was first framed around a Rust workspace. **This repository is TypeScript**,
and the second layer will be built on **this** stack: the layer is TypeScript now, and
whether it is later **ported to Rust — or stays in TypeScript — is an open question**,
to be answered with evidence rather than by preference.

A port is a *later* decision, and it is cheap to defer precisely because the protocol
surface is ours: a JSON-RPC protocol over stdio is a boundary a port can cross without
the product changing.

## 6. What the second layer will need, and does not have yet

The first layer's foundations are what this layer is built on. They are, in the state the
first layer leaves them:

- the **protocol surface** — the target's own wire behaviour, reproduced;
- the **agent loop** — the tool-calling loop, its scheduling, and its permission rules;
- the **tool registry** and its **permission model**;
- the **sandbox** — the mechanism, the plan, the policy;
- the **sessions** — the store, the resume, the compaction;
- the **terminal UI** — the theme, the transcript, the composer, the keybindings;
- the **config** — the settings document, the tiers, the merge;
- the **providers** — the routes, the credentials, the cost.

**What the second layer adds, and which the first layer does not have:** the
**JSON-RPC protocol over stdio** as our own surface; the **Product Builder pipeline** and
its stages; **approvals** as a first-class concept; the **computer use** capability; the
**pitch animations** and the **optimised transitions** in the terminal; and the
**frontend engineering** — the second layer is explicitly not only a backend, and its
terminal surface is to be built with motion and transitions designed deliberately rather
than inherited.

**None of that is started.**

## 7. The order

1. **Finish the first layer, precisely.** Every surface the target has, enumerated and
   accounted for; the report measuring the clone against it; no `unknown` left.
2. **Then** plan this layer properly — its own planning, its own components, its own
   milestones. The plan for it is not this file.
3. **Then** build it.

Until step 1 is done, nothing here is touched.
