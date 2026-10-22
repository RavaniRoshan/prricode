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


---

## 6. The decisions, taken

These were asked and answered. They are **locked** unless a later note says otherwise.

| the question | the decision |
|---|---|
| **The stack** | **TypeScript, and it stays TypeScript.** No port is planned; the question is not deferred, it is answered. The original concept was framed in Rust; this repository is TypeScript, and the second layer is built on this stack. |
| **The protocol's shape** | **PRRICODE is the server for its clients, and it speaks the same protocol to reach tool providers it does not implement.** This is the target's own arrangement — one process hosts the agent loop, the tools, the permissions and the UI, and the second boundary is the subprocess one — with our own protocol sitting on that tool boundary. The protocol surface is our own design. |
| **The model catalogue** | **Fetched from each provider.** The catalogue is what the connected providers report. |
| **The reasoning effort** | **A first-class per-model capability.** Each model declares whether it supports effort, which levels it accepts, and its default; the selector and the request both honour it. |
| **The Product Builder pipeline** | **Pluggable stages.** The stages are plugins, so a deployment can carry its own pipeline and still speak the same protocol. |
| **Approvals** | **Rules, like the first layer's permissions.** The shape the first layer already has — allow, ask, deny — so an approval is a rule that persists and decides, and a matching rule decides without asking. |
| **The motion** | **A shared motion system, used everywhere.** One vocabulary — the same easing, the same durations, the same frame budget — used by the prompt, the transitions, the stage changes and the overlays. |
| **The motion's degradation** | **Detect and disable, with the reason.** The terminal's capabilities are detected once, and what cannot be drawn is not drawn; the agent says why, in the same shape as every other degraded feature. |
| **Where the code lives** | **In this repository, one workspace.** Layer 2 builds on the first layer's modules directly, in the same workspace and the same package. |
| **How a stage plugs in** | **One interface, three deliveries.** A stage may be in-process, a package, or a process speaking our protocol over stdio, and the pipeline does not know the difference. |

### The three the research settled

These were held for the research, and are now taken from its evidence. The research
file is `/home/shiva/opt/reference-agent-rea/analysis/findings-model-layer.md` — 1 131
lines, every claim carrying a file and a line.

| the question | the decision | what the evidence said |
|---|---|---|
| **The catalogue and effort gap** | **The catalogue is fetched, and the effort is a named overlay the catalogue declares — never a rule in our code.** A model entry carries a list of named overlays, each with the request fields, the headers and the body it adds; the *reasoning effort* is one such overlay, and so are a thinking toggle and a token budget. The engine applies an overlay and knows no vendor's spelling. | The subject's design puts the effort in a 690-line table of near-duplicate protocol functions, most of them conditional on a model-id substring. The research flagged that table as the accumulated scar tissue of the design, and that the vendor-specific spelling belongs in the catalogue's declarative descriptor rather than in code. **We take the mechanism and refuse the scar tissue.** |
| **The credential storage** | **A store keyed by *integration*, not by provider, in three kinds — a key, an OAuth grant, and an *external* reference that carries no secret at all. The provider record has no secret field, ever.** A *connection* is derived rather than stored: the stored credentials, newest first, then the environment variables that are currently set, with the first being the active one. The secret lives in the **operating system's credential store**, with an **encrypted file** as the fallback where that store is not available. | The subject keys its store by integration, in three kinds, with `external` carrying only a reference; its provider record has no `apiKey` field at all; and its connections are derived from stored credentials followed by the environment variables that are set, with an identity of `credential:<id>` or `env:<name>`. Its medium is a database column; the *shape* is what matters, and the medium is ours — a real API key belongs in the keychain. |
| **The degradation contract's shape** | **One shape for every capability, with per-capability detail beneath it.** A capability reports whether it is enabled, and when it is not, why — and each capability adds its own fields under that shared pair. | The first layer already has the pattern: a typed refusal that *names* the capability it needed. This generalises it from an exception into data, so any caller can ask any capability the same question. |

### Two more the research answered, that were not asked

| the question | the decision |
|---|---|
| **Can one model be reached through more than one provider?** | **Yes, in the catalogue — and the choice is never made for the user.** One model appears under many providers, and the agent does **not** silently fall back when the selected one is unavailable; it fails loudly. Separately, a provider may **alias** another provider's whole definition — its models, its capabilities, its cost, its limits, its overlay spelling — and change only the endpoint and the credential. That is "the same model, but through my own gateway", and it is the answer to the question the research left open. |
| **What compatibility apparatus do we inherit?** | **None.** The subject's largest cost is the machinery that preserves a published configuration format and an ecosystem: a version migration, a prefix scheme, and two tables of rewriting rules. We have no published format and no ecosystem to preserve, so we build none of it. That is a saving, and it is deliberate. |

## 7. What the second layer will need, and does not have yet

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

## 8. The order

1. **Finish the first layer, precisely.** Every surface the target has, enumerated and
   accounted for; the report measuring the clone against it; no `unknown` left.
2. **Then** plan this layer properly — its own planning, its own components, its own
   milestones. The plan for it is not this file.
3. **Then** build it.

Until step 1 is done, nothing here is touched.
