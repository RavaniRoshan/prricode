# prricode build loop

A durable work contract. Re-read this at the start of every iteration.

## Objective

Close the gap between what the Product Builder PRD claims and what the code
actually does, in priority order, so prricode is launch-ready as the product it
was designed to be — not merely as the protocol-compatible agent that v0.1.0
shipped.

## Definition of done for the loop

The loop stops when either:
- every queue item below is shipped and verified, or
- an item is genuinely blocked (needs a decision, a key, or an external
  service) — record it and move to the next, do not stall.

Never mark an item done without: a test that fails before and passes after,
gates green, and a commit.

## Queue (in order)

1. **Cost per delivered outcome.** The PRD claims it as a differentiator; it
   does not exist. Compute tokens + gate durations + wall time per shipped
   unit, persist it, and surface it in the acceptance dossier and `/operate`.
   Small. It is a claim-integrity fix.
2. **Release binaries.** The README says none are published. Add cross-platform
   CI artifacts (linux/macOS x86_64/aarch64, windows) attached to the release,
   plus install steps that use them.
3. **Property-based tests from EARS.** The roadmap's "stronger oracle": generate
   property tests from requirement text, run them in the verify stage, and
   record the result in the dossier.
4. **Brownfield.** Run the pipeline against an existing codebase instead of a
   greenfield worktree: read the project first, plan against what is there,
   gate against the project's real build.
5. **Business layer.** The PRD's "part nobody else touches": a research →
   pricing → landing-page stage set. Expect to need human judgement on
   pricing; stop and ask rather than inventing numbers.

## Rules

- Gates before every commit: `cargo fmt --check`,
  `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo test --workspace`.
- Protocol surface stays additive only — the fingerprint and existing method
  shapes never change.
- Honest degradation: a feature that cannot run says so; never fake success.
- No third-party product or company names, in code, docs, or commits.
- The TUI stays the primary interface: every new capability is reachable from
  it, and documented there first.
- One concern per commit; test first.
- Do not delete or rewrite history. Do not force-push.

## Reporting

Each iteration ends with: what shipped, what was verified (command + result),
what the next item is, and anything blocked.
