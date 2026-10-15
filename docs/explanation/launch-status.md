# Launch status

Where prricode stands, what was audited, what is measured, and what the
targets are. This page is the record an auditor or a curious reader can check
claims against; it is not a marketing page.

**Current state at a glance:** public repository, MIT license, CI green on
both jobs (build/clippy/fmt/tests and the Ollama e2e), 226 workspace tests
passing, latest release `v0.2.2` tagged (five platform binaries + `SHA256SUMS`).

## What has been verified

| Claim | Evidence |
|---|---|
| The repo builds from a clean clone | CI runs `cargo build` on every push |
| The gates pass | `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` — all green in CI |
| The agent loop really runs tools | `tests/e2e.sh` drives `prricode serve` against local Ollama: session, turn, `write_file` → `shell` → results |
| Providers work for real | live runs against OpenRouter's free catalog, Kilo's `:free` tier, and local Ollama — see [run the tests](../how-to/run-the-tests.md) |
| The pipeline completes | concept → clarify → specify → plan → build → verify → dossier, driven live and covered by an `#[ignore]`d live test |
| The protocol surface is what it says | [Protocol conformance](../reference/protocol-conformance.md), with reproduce commands |

## Launch-readiness audit

A RAMP **preflight** read was taken on 2026-10-15 against the evidence above.
The auditor's root scorer was not installed in that environment, so the read
returned `status: NEEDS_INPUT`, `verdict: UNDECIDED`, `score_state:
NOT_SCORED` — an observation set, not a gate verdict. Its findings and their
dispositions:

| Item | Finding | Disposition |
|---|---|---|
| `RAMP-A1` claim/disclosure integrity | The docs narrated where the protocol surface came from | **Fixed** — rewritten; no product, company, or discovery history remains in the working tree, any commit message, or any blob in history |
| `RAMP-R1` stage truth | Public repo, MIT, CI green — no contradiction with what is claimed | Pass |
| `RAMP-M1` platform/embargo | No embargo, no announcement under embargo | Pass |
| `RAMP-A9` technical go-live | Both CI jobs green; release path implemented | Pass — releases cut at `v0.1.0`–`v0.2.2`, each with platform binaries and checksums |
| `RAMP-A7` sales/support enablement | No `SECURITY.md`, no contribution path | **Fixed** — both added |
| `RAMP-R8` risk/rollback register | Gaps named in the roadmap, no register | Partial — [the roadmap](../explanation/roadmap.md) is the register |
| `RAMP-P1` instrumentation | No declared measurement | **Registered** — see below |
| `RAMP-R10` preregistered targets | None | **Registered** — see below |
| `RAMP-A4` press/facts manifest | None | **Fixed** — `docs/explanation/facts.md` (identity, verified capabilities, honest non-claims, boilerplate) |
| `RAMP-A6` pricing/offer terms | Open source, no paid tier | Not applicable |

To re-score, re-run the preflight with the root scorer present and feed it the
evidence in the table above.

## Measurement surfaces

Registered for `RAMP-P1`. All of these are **owner-side** — GitHub's own
analytics. prricode itself collects **no telemetry**: no product-side
analytics, no crash reporting, no model-call logging beyond what the session
stores locally, and the database lives in the user's data directory.

| Surface | What it measures | Where to read it |
|---|---|---|
| Repository traffic | Views and unique visitors over 14 days | `gh api repos/RavaniRoshan/prricode/traffic/views` |
| Repository clones | Clone count and unique cloners | `gh api repos/RavaniRoshan/prricode/traffic/clones` |
| Referrers | Which sites send people here | `gh api repos/RavaniRoshan/prricode/traffic/popular/referrers` |
| Release downloads | Download counts per release asset | the release page's asset list |
| Stars and forks | Attention and reuse | the repository page |
| Issues and discussions | Whether anyone hit a wall | the repository tracker |

Baseline at registration (2026-10-15): 13 views, 1 unique visitor, 0 stars,
0 forks, 0 issues.

### UTM convention

There is no paid campaign, but if a link is shared it should carry
attribution so the referrer data means something:

```text
?utm_source=<channel>&utm_medium=<where>&utm_campaign=prricode-v0.2.2
```

Channels worth distinguishing: `hn`, `reddit`, `x`, `linkedin`, `devto`,
`newsletter`, `word-of-mouth`. Use lowercase, hyphenated source names.

## Preregistered targets

Registered for `RAMP-R10` at release (`v0.2.2`, 2026-10-15). These are read
against the surfaces above — nothing else counts. If a target is missed, the
miss is recorded here rather than the target quietly moved.

| Checkpoint | When | Targets |
|---|---|---|
| **D0** — day of release | 2026-10-15 | Repository public and reachable; README renders and the demo plays on GitHub; both CI jobs green; the release published with assets |
| **W1** — one week | 2026-10-22 | 100+ views, 25+ unique clones, 10+ stars |
| **M1** — one month | 2026-11-15 | 250+ views, 50+ clones, 25+ stars, 3+ external issues opened |

Read these at each checkpoint and append the actuals below, keeping the
targets as written.

### Actuals

| Checkpoint | Views | Unique clones | Stars | External issues | Read on |
|---|---|---|---|---|---|
| D0 | — | — | — | — | pending |
| W1 | — | — | — | — | pending |
| M1 | — | — | — | — | pending |

## What is deliberately not measured

- Anything inside the product. There is no instrumentation to add, and adding
  it would contradict the no-telemetry stance this project ships with.
- Model, token, or cost telemetry for other people's runs. Usage is recorded
  locally in the user's own database for their own sessions.
- Sentiment or share-of-voice. No listening tooling is wired up.
