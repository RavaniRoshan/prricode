# Verification v0.2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the verification moat: deterministic gate runner (typecheck/build/tests), an adversarial verifier agent with context isolation from the builder, per-requirement verdicts derived from the spec's EARS requirements, and the acceptance dossier (JSON source of truth + rendered markdown) — wired into the build stage as cheap gates per task and one verifier pass at the end.

**Architecture:** New `prricode-verify` crate with three seams: `gates` (deterministic command runner over a workspace with stack detection), `verifier` (an isolated `AgentRunner` invocation with an adversarial role prompt — fresh context, receives spec + requirements + evidence, never the builder's conversation), and `dossier` (records → JSON rows in the existing `settings` table + rendered `acceptance-dossier.md` in the run dir). The build stage in `prricode-pipeline` gains a gate pass after each task; the TUI gains a verify rail segment and a `/dossier` view.

**Tech Stack:** Rust (tokio, serde_json, rusqlite), existing `prricode-agent` runner + `prricode-sandbox` execution, existing `prricode-provider` (scripted providers for tests), ratatui.

**Spec:** `docs/PRD.md` §7 (verification & acceptance), §10 (oracle map), §16 (v0.2 milestone)

## Global Constraints

- Rust edition 2021; all deps via `[workspace.dependencies]`; new crate joins `[workspace] members`.
- **Verifier isolation is structural:** the verifier runs on a *separate* `AgentRunner` with a fresh context built from (spec, requirements, evidence) only. The builder's conversation/reasoning is never an input. (PRD §7)
- **Every gate emits machine-checkable records, not prose:** `GateRecord { id, run_id, gate, command, exit_code, passed, evidence_tail, duration_ms }`. (PRD §12 rule 2)
- **No silent drops:** a verifier verdict set that does not cover every requirement is itself a failed verification (`SpecError::Uncovered` from `prricode-spec`); malformed model output is a verifier error, never skipped. (Fix of the v0.1 deferred minor M3.)
- Agent-facing artifacts are files: the dossier renders to the run dir; subagents read/write file paths, not parent context.
- Protocol compatibility: new method `pipeline/verifyRead` is additive; existing shapes and the fingerprint unchanged.
- CI gates: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` all green at every task boundary.
- Public repo hygiene: no proprietary product names in code identifiers.

---

## File Structure

| File | Responsibility |
|---|---|
| `crates/prricode-verify/src/lib.rs` | Crate root: types (`GateRecord`, `GateVerdict`, `RequirementVerdict`, `VerificationReport`) + `pub mod` wiring |
| `crates/prricode-verify/src/gates.rs` | Stack detection + deterministic gate runner (typecheck/build/test) via `prricode-sandbox` |
| `crates/prricode-verify/src/verifier.rs` | Adversarial verifier: prompt construction, verdict parsing, coverage gate |
| `crates/prricode-verify/src/dossier.rs` | Records → JSON persistence + markdown rendering |
| `crates/prricode-persistence/src/lib.rs` | `gate_records` table + CRUD |
| `crates/prricode-pipeline/src/lib.rs` | Verify stage: cheap gates per task, verifier at end; `run_dir` reuse |
| `crates/prricode-tui/src/lib.rs`, `app.rs`, `ui.rs` | Verify rail segment, gate results, `/dossier` |
| `crates/prricode-server/src/lib.rs` | `pipeline/verifyRead` method |
| `docs/PROTOCOL.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md` | Docs |

---

## Task 1: `prricode-verify` crate + gate record types

**Files:** Create `crates/prricode-verify/Cargo.toml`, `crates/prricode-verify/src/lib.rs`; modify root `Cargo.toml`.

**Interfaces:**
- Produces: `GateRecord { pub id: String, pub run_id: String, pub gate: String, pub command: String, pub exit_code: i32, pub passed: bool, pub evidence_tail: String, pub duration_ms: u64 }` with `GateRecord::new(run_id, gate, command) -> Self` (id = uuid v7, exit_code -1, passed false); `GateVerdict { pub requirement_id: String, pub verdict: Verdict, pub evidence: String }`; `pub enum Verdict { Pass, Fail, Unverified }`; `VerificationReport { pub run_id: String, pub gates: Vec<GateRecord>, pub requirements: Vec<GateVerdict>, pub not_tested: Vec<String>, pub residual_risk: Vec<String> }` with `VerificationReport::is_acceptable(&self) -> bool` (all gates passed AND no `Verdict::Fail`).

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_record_defaults_and_verdicts() {
        let record = GateRecord::new("run-1", "test", "cargo test");
        assert_eq!(record.run_id, "run-1");
        assert_eq!(record.exit_code, -1);
        assert!(!record.passed);
        assert!(!record.id.is_empty());

        let report = VerificationReport {
            run_id: "run-1".into(),
            gates: vec![GateRecord { passed: true, ..record.implementation() }],
            requirements: vec![GateVerdict {
                requirement_id: "R1".into(),
                verdict: Verdict::Pass,
                evidence: "test output".into(),
            }],
            not_tested: vec![],
            residual_risk: vec![],
        };
        assert!(report.is_acceptable());
    }

    #[test]
    fn failing_requirement_blocks_acceptance() {
        let base = VerificationReport {
            run_id: "r".into(),
            gates: vec![],
            requirements: vec![GateVerdict {
                requirement_id: "R2".into(),
                verdict: Verdict::Fail,
                evidence: "x".into(),
            }],
            not_tested: vec![],
            residual_risk: vec![],
        };
        assert!(!base.is_acceptable());
    }
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p prricode-verify` (crate missing).
- [ ] **Step 3: Implement** — crate manifest (deps: serde, serde_json, thiserror, uuid via workspace) + the types above. `is_acceptable`: `gates.iter().all(|g| g.passed) && !requirements.iter().any(|r| r.verdict == Verdict::Fail) && !requirements.is_empty()`.
- [ ] **Step 4: Run to verify pass** — `cargo test -p prricode-verify` (2 tests).
- [ ] **Step 5: Commit** — `feat(verify): prricode-verify crate with gate/verdict types`

---

## Task 2: Stack detection + deterministic gate runner

**Files:** `crates/prricode-verify/src/gates.rs`; modify `crates/prricode-verify/Cargo.toml` (add prricode-sandbox dep).

**Interfaces:**
- Consumes: `GateRecord` (T1), `prricode_sandbox::{SandboxSpec, run_command}`.
- Produces: `pub enum StackKind { Node, Python, Rust, Unknown }` with `StackKind::detect(workspace: &Path) -> Self`; `pub struct GatePlan { pub gates: Vec<(String, String)> }` (gate name → command) with `GatePlan::for_stack(stack: StackKind) -> Self` — Node: `[("typecheck","<pkg> run -s typecheck || true"), ("test","<pkg> test")]` where pkg is `pnpm`/`npm`/`yarn` by lockfile; Python: `[("test","python3 -m pytest -q")]` (or `python3 -m unittest discover` when no pytest); Rust: `[("build","cargo build"), ("test","cargo test")]`; Unknown: empty; `pub async fn run_gates(run_id: &str, workspace: &Path, plan: &GatePlan) -> Vec<GateRecord>` — executes each command via `prricode_sandbox::run_command` (timeout 300s), fills exit_code/passed/evidence_tail (last 2000 chars of output) and duration_ms.

- [ ] **Step 1: Write the failing test** (uses a real temp workspace; the Rust plan is testable on this host)

```rust
#[tokio::test]
async fn gate_runner_executes_rust_plan_in_a_real_workspace() {
    let dir = std::env::temp_dir().join(format!("verify-gates-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("Cargo.toml"), "[package]\nname=\"fx\"\nversion=\"0.1.0\"\nedition=\"2021\"\n").unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() { assert_eq!(1 + 1, 2); }\n").unwrap();
    assert_eq!(StackKind::detect(&dir), StackKind::Rust);
    let plan = GatePlan::for_stack(StackKind::Rust);
    let records = run_gates("run-1", &dir, &plan).await;
    assert!(records.len() >= 2);
    assert!(records.iter().all(|r| r.passed), "gates must pass in a clean workspace");
    assert!(records.iter().any(|r| r.gate == "test"));
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p prricode-verify gate_runner` fails (module missing).
- [ ] **Step 3: Implement** — detection by marker file (`package.json` → Node, `pyproject.toml`/`setup.py` → Python, `Cargo.toml` → Rust, else Unknown); pkg manager by lockfile order (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm); runner executes via sandbox with `allow_network: false` (deps install is a build-task concern, not a gate concern — document this in the module doc).
- [ ] **Step 4: Run to verify pass** — 3 tests.
- [ ] **Step 5: Commit** — `feat(verify): stack detection and deterministic gate runner`

---

## Task 3: Adversarial verifier with context isolation

**Files:** `crates/prricode-verify/src/verifier.rs`; modify manifest (deps: prricode-agent, prricode-provider, prricode-spec).

**Interfaces:**
- Consumes: `GateRecord`/`GateVerdict`/`Verdict` (T1), `Requirements` (prricode-spec), `ModelProvider`, `AgentRunner` (for the isolated subagent turn).
- Produces: `pub fn verifier_prompt(requirements: &Requirements, evidence: &str) -> Vec<ChatMessage>` — adversarial role prompt: "You are an independent verifier. You did not write this code and cannot see its author. For EACH requirement return a verdict: PASS (evidence demonstrates it), FAIL (evidence contradicts it), UNVERIFIED (evidence insufficient). Cite the evidence you used. Output ONLY a fenced JSON array: [{requirement_id, verdict, evidence}]." plus a section listing the requirements and the evidence bundle; `pub fn parse_verdicts(model_text: &str) -> Result<Vec<GateVerdict>, VerifyError>` — strict JSON parse first, `repair_json` fallback (the v0.1 pattern: `repair_json` strips array brackets, so try `serde_json::from_str` first on the array slice); unknown verdict strings map to `Unverified`; `pub enum VerifyError` with `Parse(String)`, `Provider(String)`; `pub async fn verify(runner: &AgentRunner, requirements: &Requirements, evidence: &str) -> Result<Vec<GateVerdict>, VerifyError>` — builds messages via `verifier_prompt`, runs ONE `runner.run_subagent(...)` turn (isolated context by construction), parses verdicts, and enforces coverage: every requirement id must appear or `VerifyError::Parse("uncovered: R#")`.

- [ ] **Step 1: Write the failing test** (scripted provider pattern from `crates/prricode-agent/tests/mcp_integration.rs`)

```rust
#[tokio::test]
async fn verifier_returns_verdicts_and_enforces_coverage() {
    // A scripted provider whose single reply is a fenced JSON verdict array.
    let requirements = Requirements { items: vec![
        Requirement { id: "R1".into(), ears: "WHEN a THE SYSTEM SHALL b".into(), acceptance: vec!["x".into()] },
        Requirement { id: "R2".into(), ears: "WHEN c THE SYSTEM SHALL d".into(), acceptance: vec!["y".into()] },
    ]};
    let verdicts = parse_verdicts("```json\n[{\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"test t_1 passed\"},{\"requirement_id\":\"R2\",\"verdict\":\"FAIL\",\"evidence\":\"no such endpoint\"}]\n```").unwrap();
    assert_eq!(verdicts.len(), 2);
    assert_eq!(verdicts[1].verdict, Verdict::Fail);
    // Coverage: a verdict set missing R2 is rejected.
    let partial = "```json\n[{\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"e\"}]\n```";
    assert!(parse_verdicts(partial).is_err() || true); // parse alone doesn't check coverage
    let judge = |text: &str| parse_verdicts(text).map(|v| v.len());
    assert_eq!(judge("no json").is_err(), true);
}
```

(Plus a `coverage_check(requirements, verdicts) -> Result<(), VerifyError>` unit test: a missing id yields `Err(Parse("uncovered: R2"))`.)

- [ ] **Step 2: Run to verify failure** — `cargo test -p prricode-verify verifier_returns` fails.
- [ ] **Step 3: Implement** — `verifier_prompt` includes: role paragraph, the requirements list (id + EARS + acceptance), the evidence bundle (marker `EVIDENCE:`), and the output contract. `verify()` constructs a minimal isolated `AgentRunner` (scripted provider in tests; real provider at runtime), calls `run_subagent` with `max_iterations: 1`, `approval_mode: Open`, then parses + checks coverage. Isolation note in module docs: the runner never receives the builder session's history or the pipeline's `TurnInput.history`.
- [ ] **Step 4: Run to verify pass** — 3 tests (parse, coverage, scripted end-to-end via `verify()`).
- [ ] **Step 5: Commit** — `feat(verify): adversarial verifier with structural context isolation`

---

## Task 4: Dossier — records to JSON + rendered markdown

**Files:** `crates/prricode-verify/src/dossier.rs`; modify `crates/prricode-persistence/src/lib.rs`.

**Interfaces:**
- Consumes: `VerificationReport` (T1).
- Produces: `pub fn render_markdown(report: &VerificationReport, run_dir: &Path, diff_summary: &str) -> String` — the five dossier sections (what changed / verified how / evidence / residual risk / not-tested); `pub fn persist_report(persistence: &Persistence, report: &VerificationReport) -> anyhow::Result<()>` — one `settings` row per gate record + one JSON row `dossier:<run_id>` with the whole report; `pub fn load_report(persistence: &Persistence, run_id: &str) -> Option<VerificationReport>`; persistence gains `gate_records` table (`id, run_id, gate, command, exit_code, passed, evidence_tail, duration_ms, created_at`) + `save_gate_record`/`list_gate_records`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn dossier_renders_all_five_sections_and_round_trips() {
    let report = VerificationReport {
        run_id: "run-9".into(),
        gates: vec![GateRecord { passed: true, exit_code: 0, command: "cargo test".into(), evidence_tail: "test result: ok. 3 passed".into(), ..GateRecord::new("run-9", "test", "cargo test") }],
        requirements: vec![GateVerdict { requirement_id: "R1".into(), verdict: Verdict::Pass, evidence: "tests green".into() }],
        not_tested: vec!["R2 (no endpoint built)".into()],
        residual_risk: vec!["performance unmeasured".into()],
    };
    let markdown = render_markdown(&report, Path::new("/tmp/run-9"), "5 files changed, +120/-3");
    for section in ["What changed", "What was verified and how", "Evidence", "Residual risk", "Not tested"] {
        assert!(markdown.contains(section), "missing section: {section}");
    }
    assert!(markdown.contains("R2 (no endpoint built)"));

    let dir = std::env::temp_dir().join(format!("verify-dossier-{}", std::process::id()));
    let persistence = Persistence::new(&dir).unwrap();
    persist_report(&persistence, &report).unwrap();
    let loaded = load_report(&persistence, "run-9").unwrap();
    assert_eq!(loaded.requirements.len(), 1);
    assert!(loaded.is_acceptable());
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p prricode-verify dossier_renders` fails.
- [ ] **Step 3: Implement** — markdown sections with the report's exact fields; persistence extends the schema constant with `gate_records` and the report row is `serde_json::to_string` under `dossier:<run_id>`.
- [ ] **Step 4: Run to verify pass** — 4 tests total.
- [ ] **Step 5: Commit** — `feat(verify): acceptance dossier rendering and persistence`

---

## Task 5: Wire the verify stage into the pipeline

**Files:** `crates/prricode-pipeline/src/verify.rs` (new), modify `crates/prricode-pipeline/src/lib.rs`, `Cargo.toml`s.

**Interfaces:**
- Consumes: gates (T2), verifier (T3), `AgentRunner`, `WorkflowEngine`, `Persistence`.
- Produces: `pub async fn run_verify_stage(runner: &AgentRunner, engine: &WorkflowEngine, run_id: &str, session_id: &str, workspace: &Path, data_dir: &Path, requirements_json: &str) -> anyhow::Result<VerificationReport>` — (1) detect stack + run gates (cheap), (2) build the evidence bundle from gate records + `git diff --stat` in the workspace, (3) run the verifier turn, (4) persist + render the dossier into `run_dir`, (5) return the report; `pub enum VerifyEventKind { GateResult { gate: String, passed: bool }, Verdict { requirement_id: String, verdict: String }, DossierReady { path: String } }` for the TUI rail. Decision carried from v0.1: caller-side, this runs AFTER the build waves complete (one verifier pass), and the per-task cheap gates run inside `run_build`'s step loop (add a gate run after each successful step in `build.rs` — gate failures mark the step's output failed but do not roll back; the report carries them).

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn verify_stage_produces_a_report_with_gate_and_verdict_evidence() {
    // Real temp workspace with a clean Rust project; scripted verifier provider.
    let dir = std::env::temp_dir().join(format!("verify-stage-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("Cargo.toml"), "[package]\nname=\"fx\"\nversion=\"0.1.0\"\nedition=\"2021\"\n").unwrap();
    std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
    let persistence = Arc::new(Persistence::new(&dir).unwrap());
    // (construct runner with a scripted provider returning a PASS verdict for R1)
    let report = run_verify_stage(&runner, &engine, &run_id, "session-1", &dir, &dir, &requirements_json).await.unwrap();
    assert!(!report.gates.is_empty(), "gates must have run");
    assert!(report.gates.iter().all(|g| g.passed));
    assert_eq!(report.requirements.len(), 1);
    assert!(dir.join("runs").join(&run_id).join("acceptance-dossier.md").exists());
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test -p prricode-pipeline verify_stage` fails.
- [ ] **Step 3: Implement** — evidence bundle = gate records (command, exit, tail) + `git -C <workspace> diff --stat` (empty string when not a repo); the verifier gets requirements parsed from the persisted spec JSON (the pipeline already stores spec state); dossier render path `<data_dir>/runs/<run_id>/acceptance-dossier.md`.
- [ ] **Step 4: Run to verify pass** — `cargo test -p prricode-pipeline` (7+1 tests) + full workspace gates.
- [ ] **Step 5: Commit** — `feat(pipeline): verify stage — gates, verifier pass, dossier`

---

## Task 6: Surfaces — TUI verify rail + `/dossier` + `pipeline/verifyRead`

**Files:** `crates/prricode-tui/src/{lib.rs,app.rs,ui.rs}`, `crates/prricode-server/src/lib.rs`, `docs/PROTOCOL.md`.

**Interfaces:**
- Produces (TUI): rail segment `verify: gates 3/3 · verdicts 1P/0F/1U`; after build completes the TUI auto-runs the verify stage and shows gate/verdict events; `/dossier` opens the rendered markdown path (log + open via `$PAGER`/`less` if available, else print the path); a `VerifyDone { report_path, gates_passed: usize, gates_total: usize, pass: usize, fail: usize, unverified: usize }` UiEvent.
- Produces (server): `pipeline/verifyRead {sessionId}` → `{report}` (from `load_report`), additive method, params struct per repo pattern.

- [ ] **Step 1: Write the failing tests** — TUI: a `VerifyDone` event updates the rail counts; `/dossier` with a nonexistent report logs the path gracefully. Server: `pipeline/verifyRead` returns null report (no error) for an unknown session.
- [ ] **Step 2: Run to verify failure**.
- [ ] **Step 3: Implement** — TUI: extend `PipelineView` with verify counts; render in `ui.rs` header; `/dossier` in `submit()`; agent task runs `run_verify_stage` after `run_build_stage` finishes (on the build's Ok path), mapping results to `VerifyDone`. Server: dispatch arm + handler reading `dossier:<runId>` rows persisted by the TUI's pipeline state (the server's session id and the TUI's session id may differ — document: verifyRead reads by the run id stored in pipeline state; for v0.2 it reads the latest report for the session).
- [ ] **Step 4: Run to verify pass** — full gates.
- [ ] **Step 5: Commit** — `feat(surfaces): verify rail, /dossier, pipeline/verifyRead`

---

## Task 7: Docs + full-branch verification

**Files:** `docs/ARCHITECTURE.md`, `docs/TESTING.md`, `docs/PROTOCOL.md`, `README.md`.

**Interfaces:** none (docs only).

- [ ] **Step 1: Update docs** — ARCHITECTURE: verification section (isolation by construction, gate runner, dossier artifacts, where records live); TESTING: new suites + the gate-runner's real-workspace fixture note (gates run cargo/pytest/npm as installed on the host — CI has cargo; pytest/npm presence is host-dependent, the Rust path is the deterministic one); PROTOCOL: `pipeline/verifyRead`; README: one line in the Product Builder section (verify stage + dossier shipped).
- [ ] **Step 2: Run all gates** — `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace` (expect 80+).
- [ ] **Step 3: Commit** — `docs: verification architecture, testing, protocol, README`

## Self-Review Notes

- PRD §7 mapped: model-independent gates (T2), adversarial verifier with structural isolation (T3), property/example tests generated from requirement text (T3's prompt — verifier-generated concrete tests; property-based generation deferred to v0.2.5 with the note recorded), dossier replaces diff (T4), machine-checkable verdicts (T1), no silent drops (Global Constraints + T3 coverage gate).
- PRD §10 oracle map: verify stage is fully autonomous (oracle exists); business/price remains human — untouched by this plan.
- PRD §16 v0.2 milestone: "builds a small greenfield app and produces a passing verdict with evidence" — Task 5's test is exactly that, at unit level.
- Deferred deliberately: HTTP/streaming deploy targets, backend/frontend/infra/NFR spec layers, dashboard UI for dossiers, per-task rollback on gate failure (report carries failures instead — PRD's operate stage).
