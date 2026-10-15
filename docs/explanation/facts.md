# Facts

Everything below is verifiable from the repository or the release. Where a
number could change, it says where to read the current value rather than
printing one that goes stale.

## Identity

| | |
|---|---|
| Name | prricode |
| One line | An autonomous AI coding agent that lives in your terminal |
| License | MIT |
| Language | Rust (2021 edition) |
| Repository | https://github.com/RavaniRoshan/prricode |
| Current release | https://github.com/RavaniRoshan/prricode/releases/latest |
| Documentation | https://ravaniroshan.github.io/prricode/ |

## What it is

prricode takes a rough concept and carries it end to end — conversation →
specification → plan → build → verification → delivery → operation — and
returns a live, verified product rather than a diff to review.

It has two halves that share one engine:

**A coding agent.** A terminal-native TUI (`prricode` with no arguments) with a
composer, streaming tool output, inline approvals, and slash commands for
everything: `/model`, `/provider`, `/approval`, `/theme`, `/goal`. Every
setting is reachable from the TUI; the config file is an optional equivalent.

**A product builder.** A gated pipeline — Concept → Clarify → Specify → Plan →
Build → Verify → Ship → Operate — where each stage exits only on a
machine-checkable verdict.

## The design position

Generation is not the bottleneck. The pipeline puts autonomy where a machine
can check the result (does the build pass, does the test pass, does the
requirement hold) and human judgement where it cannot (is this the right
product, is this price right). Approvals sit at the irreversible moments —
deploy, spend, publish — not at every edit.

The reviewable artifact is an **acceptance dossier**, not a diff: what changed,
what was verified and how, the evidence, the residual risk, and what was not
tested.

## Verified capabilities

Each of these is backed by a test in the repository; the gate commands below
are runnable by anyone.

| Capability | What it means |
|---|---|
| Tool-calling agent loop | Reads, writes, edits, globs, greps, fetches the web, spawns subagents, drives the screen — with fenced-JSON recovery and argument repair so a small model still lands its tool calls |
| Model agnostic | One OpenAI-compatible client; first-class presets for Ollama (local and cloud), OpenRouter, the Kilo AI Gateway, OpenAI, and any custom endpoint |
| Sandboxed execution | bubblewrap with network toggling and path scoping |
| Approvals | Three durability tiers (once / session / always-in-this-workspace) with a timeout that denies rather than hangs |
| Verification | Deterministic gates, an adversarial verifier with structural context isolation, and property tests generated from the requirements |
| Delivery economics | Tokens + gate wall time per verified requirement, persisted per run |
| Ship and operate | GitHub release path, agent-arranged deploy with env-only credentials, health checks, and autonomous rollback |
| Brownfield | A workspace survey that makes the plan, the gates, and the property tests run against the project that is already there |

## What it does not claim

- It is not a coding agent that only writes code; the point is the verified
  outcome, not the diff.
- It does not implement macOS computer use yet (X11 is the tested path).
- It does not bundle an offline speech model; voice works through
  OpenAI-compatible audio endpoints.
- The business layer produces drafts a human confirms. It never invents a
  price or an unsourced claim.

## Gate commands

```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

All three run on every push in CI, alongside an end-to-end scenario that
drives the JSON-RPC server against a local model.

## Usage

```bash
prricode                                   # the TUI
prricode exec "<what to do>" --provider ollama
prricode serve                             # JSON-RPC over stdio
```

## Boilerplate

- Short: "prricode — an autonomous AI coding agent that lives in your terminal."
- Long: "prricode is an open-source, model-agnostic coding agent for the
  terminal. It drives a tool-calling agent loop against any OpenAI-compatible
  model, and extends into a product builder that carries a concept through
  specification, build, verification, and delivery — with a machine-checkable
  gate at every stage and an acceptance dossier as the reviewable artifact."

## Logo

The TUI's wordmark renders in the theme accent colour; the repository ships no
bitmap logo. For press, a screenshot of the TUI is preferred over a graphic.
`prricode` with no arguments, or the demo on the release page.
