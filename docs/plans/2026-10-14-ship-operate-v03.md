# Ship & Operate v0.3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Product Builder's last mile: a default Ship stage (installable product + tagged GitHub release) and an optional, agent-driven Deploy stage that inspects the product's stack, asks the operator for exactly the credentials/secrets the target needs, and records rollback info — plus Operate (health checks + run log, GitHub-issue reopen on failure).

**Architecture:** New `prricode-ship` crate with three seams: `release` (GitHub release via `gh`/`git` — the always-available ship path), `deploy` (an interactive, agent-driven flow: propose target from detected stack → collect secrets through the TUI composer → execute via the target's CLI under the existing approval gate → record the release id + rollback command), and `operate` (health checks against the running artifact, an append-only operate log, GitHub issue reopen on failure). The pipeline gains a Ship stage after Verify; the TUI gains `/ship`, `/deploy` (with the secret-collection flow) and `/operate` commands; the protocol gains `pipeline/shipRead`, `pipeline/operateRead`.

**Tech Stack:** Rust (tokio, serde_json), `gh` CLI + `git` for releases, `reqwest` for health checks, existing `prricode-sandbox`/approval engine/agent loop. Secrets pass through the environment of a child process only — never written to the repo, spec, dossier, or DB.

**Spec:** `docs/PRD.md` §8 (last mile), §10 (oracle map — ship gates), §16 (v0.3 milestone). Founder ruling (2026-10-14): ship stops at GitHub release + install steps; deploy is optional and agent-arranged per product; the agent asks the operator for credentials/secrets as the target requires.

## Global Constraints

- Rust edition 2021; deps via `[workspace.dependencies]`; new crate in `[workspace] members`; additive protocol only (fingerprint untouched).
- **Secrets hygiene (hard rule):** credentials/secrets collected in the TUI are used only as environment variables of the deploy child process. They are never persisted to SQLite, the spec, the dossier, git, or any log. The operate log records *that* a deploy happened, never the secret material. Redact known patterns (`token`, `key`, `secret`, `password`) from any captured command output before it lands in an artifact.
- **Ship works with zero credentials:** the default path (GitHub release via `gh`, or `git tag` + push when `gh` is absent) runs against the run worktree's repo; no tokens beyond what `gh` already has configured in the user's environment.
- **Deploy is agent-arranged, never assumed:** the agent proposes the target from the detected stack and the product's own config, the operator confirms the target and supplies credentials, and only then does execution run. If anything is missing, the agent asks — it never invents credentials or proceeds on assumption.
- Human approval gates unchanged in shape: deploy (irreversible + external side effects) requires explicit confirmation; ship (GitHub release, also irreversible) requires explicit confirmation.
- Rollback records the previous release id + a one-command rollback for whatever target shipped (GitHub release revert, or the deploy target's rollback).
- CI gates green at every task boundary; no third-party product or company names.

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/prricode-ship/src/lib.rs` | Crate root: `ShipRecord`, `DeployPlan`, `OperateEvent`, `HealthResult` types |
| `crates/prricode-ship/src/release.rs` | Ship: detect git remote, ensure install artifacts, tag + push, `gh release create` (fallback: tag-only), record |
| `crates/prricode-ship/src/deploy.rs` | Deploy: stack-informed target proposal, secret-collection contract, execution wrapper (env-only secrets), rollback record |
| `crates/prricode-ship/src/operate.rs` | Operate: health checks (HTTP + command), append-only operate log, GitHub issue reopen on failure |
| `crates/prricode-pipeline/src/ship.rs` | Ship stage orchestration (verify → ship; optional deploy; operate events) |
| `crates/prricode-tui/src/{lib.rs,app.rs,ui.rs}` | `/ship`, `/deploy` (secret flow), `/operate`, ship rail, install-steps display |
| `crates/prricode-server/src/lib.rs` | `pipeline/shipRead`, `pipeline/operateRead` |
| `docs/*` | PROTOCOL (methods), ARCHITECTURE (ship/deploy/operate), CONFIGURATION (credentials model), TESTING |

---

## Task 1: `prricode-ship` crate + ship record types

**Files:** Create crate + manifest; modify root `Cargo.toml`.

**Interfaces:**
- Produces: `ShipRecord { pub run_id: String, pub repo: String, pub release_url: Option<String>, pub tag: Option<String>, pub install_steps: Vec<String>, pub rolled_back_from: Option<String>, pub created_at: String }` with `ShipRecord::new(run_id)` and `render_install_steps(&self) -> String` (markdown list); `DeployPlan { pub target: String, pub reason: String, pub required_credentials: Vec<CredentialRequest>, pub commands: Vec<String>, pub rollback: String }`, `CredentialRequest { pub name: String, pub purpose: String, pub secret: bool }` with `CredentialRequest::new(name, purpose, secret)`; `HealthResult { pub name: String, pub url: Option<String>, pub command: Option<String>, pub ok: bool, pub detail: String }`; `OperateEvent { pub run_id: String, pub kind: String, pub detail: String, pub at: String }` with `OperateEvent::new(run_id, kind, detail)`.

- [ ] **Step 1: Write the failing test** — types + redaction-free invariants: `CredentialRequest` with `secret: true` never appears in `ShipRecord` serialization (ShipRecord has no field for it); `render_install_steps` renders each step; `HealthResult::from_exit(code)` maps 0→ok; `OperateEvent::new` fills `at` non-empty.
- [ ] **Step 2: Run to verify failure** (`cargo test -p prricode-ship`).
- [ ] **Step 3: Implement** — pure types, serde derives, uuid + a small timestamp helper (reuse the pattern from `crates/prricode-agent/src/prompts.rs::chrono_lite_now`).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ship): prricode-ship crate with ship/deploy/operate types`

---

## Task 2: Ship — install artifacts + GitHub release

**Files:** `crates/prricode-ship/src/release.rs`; manifest deps (tokio).

**Interfaces:**
- Consumes: nothing beyond T1.
- Produces: `pub async fn ship_release(run_id: &str, workspace: &Path, version: Option<&str>) -> anyhow::Result<ShipRecord>` — (1) detect the remote repo (`git remote get-url origin`, normalize to `owner/name`), (2) ensure install artifacts exist in the worktree (`INSTALL.md` with the detected stack's one-command install + run; `README.md` presence check — write INSTALL.md only when absent), (3) commit them (`git add -A && git commit -m "chore: install steps"`, tolerate "nothing to commit"), (4) tag `v<date>-<run-short>` or the supplied version, push the branch + tag, (5) `gh release create <tag> --title ... --notes-file <dossier>` when `gh` is on PATH and authenticated, else record tag-only with a note, (6) return the `ShipRecord` with `install_steps`.

- [ ] **Step 1: Write the failing test** — real temp git repo (init, commit, no remote): `ship_release` writes INSTALL.md, commits, tags, and returns a record with the tag set and release_url None (no remote ⇒ gh-free path); the test cleans up (`git worktree`-free; plain `git init` dir in temp).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — commands via `tokio::process::Command` with the workspace as cwd; `gh` presence probed via `gh --version`; the dossier path is `acceptance-dossier.md` when present (the v0.2 artifact) else a generated notes stub. INSTALL.md content per stack (reuse `prricode-verify`'s `StackKind::detect` + `GatePlan`-style commands: Node → `pnpm install && pnpm dev`; Python → `pip install -r requirements.txt && python3 -m <app>`; Rust → `cargo run`).
- [ ] **Step 4: Run to verify pass** (git operations are deterministic in temp dirs).
- [ ] **Step 5: Commit** — `feat(ship): install artifacts and GitHub release path`

---

## Task 3: Deploy — stack-informed proposal + secret contract

**Files:** `crates/prricode-ship/src/deploy.rs`.

**Interfaces:**
- Consumes: `StackKind` (prricode-verify), workspace contents.
- Produces: `pub fn propose_target(workspace: &Path) -> DeployPlan` — inspects stack + config markers (e.g. `wrangler.toml`/`Dockerfile`/`fly.toml`/`Procfile`/`vercel.json`) and returns a plan with the target name, a one-line reason, the required credentials (e.g. `CLOUDFLARE_API_TOKEN`), the commands, and the rollback command; unknown setups → plan with target `"manual"`, reason asking the operator to describe the target; `pub fn required_env(plan: &DeployPlan) -> Vec<String>` (credential var names, for the collection UI); `pub async fn execute_deploy(workspace: &Path, plan: &DeployPlan, secrets: &HashMap<String, String>) -> anyhow::Result<DeployOutcome>` where `DeployOutcome { pub ok: bool, pub release_id: Option<String>, pub rollback_hint: String, pub output_tail: String }` — runs the plan's commands as a child process with the secrets **as environment variables only** (`Command::envs`), captures a redacted tail (`redact()` strips values of any env var whose name matches token/key/secret/password, plus common patterns), and on success extracts the release id from the output when the plan says how (`release_id_regex: Option<String>` on the plan — keep it a documented convention: the plan's commands must print `release_id: <id>`).

- [ ] **Step 1: Write the failing test** — (a) a workspace with `wrangler.toml` proposes Cloudflare with `CLOUDFLARE_API_TOKEN` required; (b) an empty workspace proposes `manual`; (c) `redact()` replaces a secret value and a `ghp_…`-style token with `[REDACTED]`; (d) `execute_deploy` with a command that prints `release_id: abc123` returns the release id.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — marker detection table (documented, extensible); redaction before any output is stored; env-only secrets (assert in a test that the child sees them and that the captured tail does not).
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ship): deploy proposal, secret contract, redacted execution`

---

## Task 4: Operate — health checks + run log + issue reopen

**Files:** `crates/prricode-ship/src/operate.rs`.

**Interfaces:**
- Consumes: T1 types; `reqwest` (manifest).
- Produces: `pub async fn health_check(result: &mut HealthResult) -> anyhow::Result<()>` — GET the URL (2s timeout, ok on 2xx/3xx) or run the command; `pub fn append_operate_log(data_dir: &Path, run_id: &str, event: &OperateEvent) -> anyhow::Result<()>` — JSONL append at `<data_dir>/operate/<run_id>.jsonl`; `pub fn read_operate_log(data_dir: &Path, run_id: &str) -> anyhow::Result<Vec<OperateEvent>>`; `pub async fn reopen_issue_on_failure(workspace: &Path, run_id: &str, title: &str, evidence: &str) -> anyhow::Result<Option<String>>` — `gh issue create` with the failure evidence (redacted) when `gh` is available and the workspace has a GitHub remote; returns the issue URL or None (never fails the pipeline).

- [ ] **Step 1: Write the failing test** — log append/read round-trip (temp dir); `reopen_issue_on_failure` returns None when `gh` is absent or there's no remote (mock by pointing at a non-repo temp dir).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — JSONL via serde_json; `gh issue create --title --body` with body from a fixed template (what failed, evidence, run id); redaction applied to the body.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `feat(ship): operate health checks, run log, issue reopen`

---

## Task 5: Pipeline Ship stage — verify → ship → (optional deploy) → operate

**Files:** `crates/prricode-pipeline/src/ship.rs` (new); modify pipeline lib/Cargo.

**Interfaces:**
- Consumes: T2–T4, the pipeline's persisted state (`pipeline:<sessionId>`: spec, waves, run id, worktree path).
- Produces: `pub async fn run_ship_stage(runner: &AgentRunner, persistence: &Persistence, session_id: &str, workspace: &Path, data_dir: &Path, dossier_path: Option<&Path>) -> anyhow::Result<ShipRecord>`; `pub enum ShipEventKind { ShipReady { tag: String, install_steps: usize }, DeployProposed { target: String, credentials: Vec<String> }, DeploySecretRequested { name: String, purpose: String, secret: bool }, DeployDone { ok: bool }, HealthOk { name: String }, HealthFailed { name: String, issue: Option<String> } }` — the events the TUI rail consumes. The stage: (1) ship (always), (2) emit `DeployProposed` with the plan and **wait** for the operator's choice (the TUI answers via a command; the server-side flow returns the plan for the client to answer), (3) on confirm: for each `CredentialRequest`, emit `DeploySecretRequested` and wait for the value, (4) execute deploy with env-only secrets, (5) record `ShipRecord` + rollback, (6) run one health pass, (7) append operate log events.

- [ ] **Step 1: Write the failing test** — scripted end-to-end with a fake plan: ship stage over a temp git repo returns a `ShipRecord` with tag + install steps; the deploy-wait event sequence is emitted (proposed → secret requested) when a manual plan is confirmed; health pass against a local `python3 -m http.server`-style check is out of scope for unit tests (test the event flow with a stubbed health command via the plan's command form).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — the wait mechanism reuses the v0.1 gate pattern (the TUI already has confirmation-gate plumbing: `PipelineGate`/`PipelineConfirm`); the ship stage exposes a small state machine the TUI drives step by step (`ShipFlow { stage, plan: Option<DeployPlan>, pending_secret: Option<CredentialRequest> }`).
- [ ] **Step 4: Run to verify pass** + full gates.
- [ ] **Step 5: Commit** — `feat(pipeline): ship stage — release, agent-arranged deploy, operate`

---

## Task 6: Surfaces — TUI `/ship` `/deploy` `/operate` + secret collection + protocol

**Files:** `crates/prricode-tui/src/{lib.rs,app.rs,ui.rs}`, `crates/prricode-server/src/lib.rs`, `docs/PROTOCOL.md`.

**Interfaces:**
- Produces (TUI): `/ship` runs the ship stage and shows install steps + release URL (approval gate first); `/deploy` proposes the plan, renders the target + reason + the **exact credentials it will ask for**, and on `y` opens a secret-collection mode where each typed line is a credential value (masked in the composer via a `secret_input: bool` flag on the input box) and is forwarded to the agent task as a `DeploySecret { name, value }` command that **never** persists it; `/operate` runs a health pass and shows results; ship rail segment (`ship: v… · deploy: cloudflare · health: 2/2`).
- Produces (server): `pipeline/shipRead {sessionId}` → `{ship}` (latest ShipRecord); `pipeline/operateRead {sessionId}` → `{events}` — additive methods.

- [ ] **Step 1: Write the failing tests** — TUI: secret-collection mode masks input and clears it after submit (the value never lands in `messages`); `/ship` emits the approval-gate flow; server: both methods return empty results without error for unknown sessions.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — the secret input renders `*` per char and is dropped from history on submit (explicit `input.clear()` in the submit path and no `history.push`); server methods read the `ship:<runId>`/operate-log rows by the same "latest for session" resolution as v0.2's `verifyRead`.
- [ ] **Step 4: Run to verify pass** + full gates.
- [ ] **Step 5: Commit** — `feat(surfaces): ship/deploy/operate TUI + protocol methods`

---

## Task 7: Docs + branch verification

**Files:** `docs/ARCHITECTURE.md`, `docs/CONFIGURATION.md`, `docs/TESTING.md`, `docs/PROTOCOL.md`, `README.md`.

- [ ] **Step 1: Docs** — ARCHITECTURE: ship/deploy/operate sections (the always-works ship path, the agent-arranged deploy with the secrets hygiene rule, operate artifacts); CONFIGURATION: the credentials model (env-only, per-target var names, never persisted) and the supported target marker table; TESTING: which parts need `gh`/network (ship tests are local-git only; deploy execution is tested with local commands); PROTOCOL: the two methods; README: one line in the Product Builder section.
- [ ] **Step 2: Gates** — `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` (expect 100+).
- [ ] **Step 3: Commit** — `docs: ship/operate architecture, configuration, testing, protocol`

## Self-Review Notes

- PRD §8 mapped: IaC/deploy wiring → the marker-driven plan + commands; human-approved deploy → gate before execution; dossier produced at verify (v0.2) and attached to the release notes (this plan, Task 2); rollback = redeploy previous release → the rollback command per plan + `rolled_back_from` on ShipRecord.
- PRD §10 oracle map: ship/deploy gates are human-confirmed (irreversible); health checks and the log are machine-verifiable; the operate stage's failure→issue loop is best-effort (documented).
- Secrets hygiene is enforced by construction (env-only, redaction, no persistence paths) and by test (Task 3 (c)/(d), Task 6).
- Deferred deliberately: monitoring vendors, multi-target support beyond the marker table, deploy retries/backoff, the brownfield path.
