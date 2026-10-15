# Product Builder v0.1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the prricode Product Builder pipeline stages Concept → Clarify → Specify → Plan → Build-with-gates, so a rough idea typed into the TUI becomes an EARS-checked spec, a wave-scheduled task graph, and a gated build of a greenfield product in a per-run git worktree.

**Architecture:** Two new crates at clean seams. `prricode-spec` is a deep, IO-free module: concept intake, the interactive clarifier interview state machine, EARS requirements, layered specs (Core 4), the five stack presets, and the dependency-ordered task graph with wave scheduling. `prricode-pipeline` is a thin orchestrator that drives those stages over the existing `AgentRunner` (the same executor the server and TUI already use) and extends `prricode-workflow`'s executor for gated build steps. The TUI gains additive surfaces only: `/concept`, `/spec`, `/plan`, `/build` slash commands, a pipeline rail in the status line, and three new JSON-RPC methods. Human approval gates sit at exactly two boundaries: concept confirmation and spec confirmation.

**Tech Stack:** Rust workspace (13 existing crates + 2 new), ratatui TUI, reqwest, serde_json, SQLite via rusqlite, tokio. Tests: `#[cfg(test)]` unit tests per crate, scripted `ModelProvider` integration tests (pattern from `crates/prricode-agent/tests/mcp_integration.rs`), plus the existing CI gates.

**Spec:** `docs/PRD.md` (sections 5, 6, 7, 10, 12, 15, 16), `docs/PRD-onepager.md`

## Global Constraints

- Rust edition 2021, workspace dependency style: version from `[workspace.dependencies]` in the root `Cargo.toml`, never inline versions in crate manifests.
- Naming: prricode's own identifiers and vocabulary throughout; no third-party product or company names in code, docs, or commit messages.
- Every new crate joins `[workspace] members` in the root `Cargo.toml`.
- CI gates must stay green: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`.
- Protocol compatibility: new JSON-RPC methods are additive; existing method shapes and the schema fingerprint never change.
- All agent-facing model calls go through `prricode_provider::ModelProvider` — no direct `reqwest` to model endpoints outside `prricode-provider`.
- The clarifier is a multi-turn interview (one question at a time), not a one-shot (PRD §6, decisions log).
- Stack presets: exactly 5 — TAN stack, Next.js, MERN, FastAPI, static+API — plus a freely-molded agent option.
- Human approval gates: concept confirmation and spec confirmation only (PRD §10 defaults; deploy gate arrives with the Ship stage, not this plan).
- Spec depth in v0.1: Core 4 (product, requirements, design, tasks); backend/frontend/infra/NFR specs are a later plan.
- Testing: repo convention at unit level (scripted providers, mock servers); no pipeline e2e in CI this plan.

---

## File Structure

### New crates

| Crate | Responsibility |
|---|---|
| `crates/prricode-spec` | Pure spec domain: `Concept` (intake + interview state), `Requirements` (EARS parse + validation + traceability), `Spec` (Core 4 layered artifacts, regenerable), `StackPreset` (5 presets + selection), `TaskGraph` (dependency-ordered nodes, wave scheduling). No IO, no network, no tokio. |
| `crates/prricode-pipeline` | Stage orchestration: `Pipeline` runs stages 1–5 over `AgentRunner`; `StageEvent` stream; concept/spec confirmation gates; build execution via `prricode-workflow`'s engine with per-task gates. |

### Modified files

| File | Change |
|---|---|
| `Cargo.toml` (root) | Add the two crates to members; any new workspace deps. |
| `crates/prricode-workflow/src/lib.rs` | Add `Prompt` step result recording so build gates can read per-task outcomes; no change to the state machine itself. |
| `crates/prricode-server/src/lib.rs` | Three additive methods: `pipeline/conceptSet`, `pipeline/specRead`, `pipeline/planRead`. |
| `crates/prricode-tui/src/lib.rs`, `app.rs`, `ui.rs` | `/concept`, `/spec`, `/plan`, `/build` slash commands; pipeline rail in the status line; confirmation prompts for concept/spec gates. |
| `docs/PROTOCOL.md` | Document the three new methods. |
| `docs/ARCHITECTURE.md` | Document the pipeline crates and stage flow. |

---

## Task 1: `prricode-spec` crate skeleton — Concept intake

**Files:**
- Create: `crates/prricode-spec/Cargo.toml`
- Create: `crates/prricode-spec/src/lib.rs`
- Test: `crates/prricode-spec/src/lib.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `Concept { problem: String, audience: String, value: String, non_goals: Vec<String>, success_criteria: Vec<String>, ambiguities: Vec<String>, stack: Option<StackChoice> }` with `Concept::from_idea(text: &str) -> Concept` and `Concept::is_ready(&self) -> bool` (true when `ambiguities` is empty and success criteria are non-empty). Later tasks consume these exact names.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concept_from_idea_extracts_shape() {
        let concept = Concept::from_idea("a service that turns RSS feeds into podcast briefings for commuters");
        assert!(!concept.problem.is_empty());
        assert!(!concept.audience.is_empty());
    }

    #[test]
    fn concept_is_not_ready_while_ambiguous() {
        let mut concept = Concept::from_idea("vague thing");
        assert!(!concept.is_ready());
        concept.ambiguities.clear();
        concept.success_criteria.push("user can X".into());
        assert!(concept.is_ready());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-spec`
Expected: FAIL — crate does not exist yet.

- [ ] **Step 3: Create the crate and minimal implementation**

`crates/prricode-spec/Cargo.toml`:

```toml
[package]
name = "prricode-spec"
version.workspace = true
edition.workspace = true

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
```

`crates/prricode-spec/src/lib.rs`:

```rust
//! Pure spec domain: concept, requirements, layered specs, stack presets,
//! and the task graph. No IO, no network, no tokio.

use serde::{Deserialize, Serialize};

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct Concept {
    pub problem: String,
    pub audience: String,
    pub value: String,
    pub non_goals: Vec<String>,
    pub success_criteria: Vec<String>,
    pub ambiguities: Vec<String>,
    pub stack: Option<StackChoice>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct StackChoice {
    pub preset: Option<StackPreset>,
    pub custom: Option<String>,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StackPreset {
    TanStack,
    NextJs,
    Mern,
    FastApi,
    StaticApi,
}

impl Concept {
    pub fn from_idea(text: &str) -> Self {
        Self {
            problem: text.trim().to_string(),
            audience: String::new(),
            value: String::new(),
            non_goals: Vec::new(),
            success_criteria: Vec::new(),
            ambiguities: vec!["audience".into(), "value".into()],
            stack: None,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ambiguities.is_empty() && !self.success_criteria.is_empty()
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-spec`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-spec Cargo.toml
git commit -m "feat(spec): prricode-spec crate with Concept intake"
```

---

## Task 2: EARS requirements with validation and traceability

**Files:**
- Modify: `crates/prricode-spec/src/lib.rs`
- Test: `crates/prricode-spec/src/lib.rs`

**Interfaces:**
- Consumes: `Concept` (Task 1).
- Produces: `Requirement { id: String, ears: String, acceptance: Vec<String> }`, `Requirements { items: Vec<Requirement> }` with:
  - `Requirements::validate(&self) -> Result<(), SpecError>` — returns `SpecError::NotEars { id }` when an item's `ears` does not start with `WHEN` and contain `THE SYSTEM SHALL`; `SpecError::NoAcceptance { id }` when `acceptance` is empty.
  - `Requirements::traceability(&self) -> Vec<(String, usize)>` — `(requirement id, acceptance criterion count)`.
  - `enum SpecError` with `thiserror`, variants `NotEars { id: String }`, `NoAcceptance { id: String }`.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn ears_validation_rejects_prose_and_missing_acceptance() {
    let bad = Requirements { items: vec![
        Requirement { id: "R1".into(), ears: "the user should be able to log in".into(), acceptance: vec!["login works".into()] },
        Requirement { id: "R2".into(), ears: "WHEN the user submits the form THE SYSTEM SHALL create an account".into(), acceptance: vec![] },
    ]};
    assert!(matches!(bad.validate(), Err(SpecError::NotEars { id }) if id == "R1"));
    assert!(matches!(bad.validate(), Err(SpecError::NoAcceptance { id }) if id == "R2"));

    let good = Requirements { items: vec![
        Requirement { id: "R1".into(), ears: "WHEN the user submits the form THE SYSTEM SHALL create an account".into(), acceptance: vec!["account exists".into(), "confirmation email sent".into()] },
    ]};
    assert!(good.validate().is_ok());
    assert_eq!(good.traceability(), vec![("R1".to_string(), 2)]);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-spec ears_validation`
Expected: FAIL — `Requirements` undefined.

- [ ] **Step 3: Implement**

Append to `crates/prricode-spec/src/lib.rs`:

```rust
#[derive(Debug, thiserror::Error)]
pub enum SpecError {
    #[error("requirement {id} is not EARS form")]
    NotEars { id: String },
    #[error("requirement {id} has no acceptance criteria")]
    NoAcceptance { id: String },
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct Requirement {
    pub id: String,
    pub ears: String,
    pub acceptance: Vec<String>,
}

#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct Requirements {
    pub items: Vec<Requirement>,
}

impl Requirements {
    pub fn validate(&self) -> Result<(), SpecError> {
        for item in &self.items {
            let ears = item.ears.trim().to_uppercase();
            if !ears.starts_with("WHEN") || !ears.contains("THE SYSTEM SHALL") {
                return Err(SpecError::NotEars { id: item.id.implementation() });
            }
            if item.acceptance.is_empty() {
                return Err(SpecError::NoAcceptance { id: item.id.implementation() });
            }
        }
        Ok(())
    }

    pub fn traceability(&self) -> Vec<(String, usize)> {
        self.items
            .iter()
            .map(|item| (item.id.implementation(), item.acceptance.len()))
            .collect()
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-spec`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-spec
git commit -m "feat(spec): EARS requirement validation and traceability"
```

---

## Task 3: Layered Core-4 spec with regeneration

**Files:**
- Modify: `crates/prricode-spec/src/lib.rs`
- Test: `crates/prricode-spec/src/lib.rs`

**Interfaces:**
- Consumes: `Concept`, `Requirements`, `StackChoice` (Tasks 1–2).
- Produces: `Spec { concept: Concept, requirements: Requirements, design: String, tasks: String, version: u32 }` with `Spec::regenerate(&mut self, requirements: Requirements)` — replaces requirements, bumps `version`, and marks `design` stale by suffixing `"\n\n[stale: requirements changed — regenerate]"` when it does not contain that marker yet. Staleness is observable so the pipeline can re-run the design stage.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn spec_regeneration_bumps_version_and_marks_stale() {
    let mut spec = Spec {
        concept: Concept::from_idea("idea"),
        requirements: Requirements::default(),
        design: "# Design\noriginal".into(),
        tasks: "# Tasks".into(),
        version: 1,
    };
    spec.regenerate(Requirements { items: vec![
        Requirement { id: "R1".into(), ears: "WHEN x THE SYSTEM SHALL y".into(), acceptance: vec!["z".into()] },
    ]});
    assert_eq!(spec.version, 2);
    assert!(spec.design.contains("[stale:"));
    // Idempotent marker: a second regeneration does not duplicate it.
    spec.regenerate(Requirements::default());
    assert_eq!(spec.design.matches("[stale:").count(), 1);
    assert_eq!(spec.version, 3);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-spec spec_regeneration`
Expected: FAIL — `Spec` undefined.

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct Spec {
    pub concept: Concept,
    pub requirements: Requirements,
    pub design: String,
    pub tasks: String,
    pub version: u32,
}

const STALE_MARKER: &str = "\n\n[stale: requirements changed — regenerate]";

impl Spec {
    pub fn regenerate(&mut self, requirements: Requirements) {
        self.requirements = requirements;
        self.version += 1;
        if !self.design.contains("[stale:") {
            self.design.push_str(STALE_MARKER);
        }
    }

    pub fn is_stale(&self) -> bool {
        self.design.contains("[stale:")
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-spec`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-spec
git commit -m "feat(spec): Core-4 layered spec with regeneration staleness"
```

---

## Task 4: Five stack presets with prompt context

**Files:**
- Modify: `crates/prricode-spec/src/lib.rs`
- Test: `crates/prricode-spec/src/lib.rs`

**Interfaces:**
- Consumes: `StackPreset` (Task 1).
- Produces: `StackPreset::description(&self) -> &'static str`, `StackPreset::scaffold_hint(&self) -> &'static str`, and `StackPreset::ALL: [StackPreset; 5]`. The pipeline uses these to prompt the model with preset context.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn stack_presets_are_exactly_five_and_described() {
    assert_eq!(StackPreset::ALL.len(), 5);
    for preset in StackPreset::ALL {
        assert!(!preset.description().is_empty());
        assert!(!preset.scaffold_hint().is_empty());
    }
    assert_eq!(StackPreset::ALL[0], StackPreset::TanStack);
    assert!(StackPreset::FastApi.description().to_lowercase().contains("fastapi"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-spec stack_presets`
Expected: FAIL — `ALL`/`description` undefined.

- [ ] **Step 3: Implement**

```rust
impl StackPreset {
    pub const ALL: [StackPreset; 5] = [
        StackPreset::TanStack,
        StackPreset::NextJs,
        StackPreset::Mern,
        StackPreset::FastApi,
        StackPreset::StaticApi,
    ];

    pub fn description(&self) -> &'static str {
        match self {
            Self::TanStack => "TAN stack: TanStack Start + Postgres + Drizzle",
            Self::NextJs => "Next.js full-stack: App Router + Postgres + Prisma",
            Self::Mern => "MERN: MongoDB + Express + React + Node",
            Self::FastApi => "FastAPI: Python + FastAPI + Postgres",
            Self::StaticApi => "Static site + serverless API backend",
        }
    }

    pub fn scaffold_hint(&self) -> &'static str {
        match self {
            Self::TanStack => "pnpm create @tanstack/start with a Postgres + Drizzle data layer",
            Self::NextJs => "create-next-app with Prisma and a Postgres datasource",
            Self::Mern => "express-generator plus React (Vite) with Mongoose",
            Self::FastApi => "fastapi full-project template with SQLAlchemy + Alembic migrations",
            Self::StaticApi => "static site generator plus a serverless functions directory",
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-spec`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-spec
git commit -m "feat(spec): five stack presets with scaffold hints"
```

---

## Task 5: Task graph with wave scheduling

**Files:**
- Modify: `crates/prricode-spec/src/lib.rs`
- Test: `crates/prricode-spec/src/lib.rs`

**Interfaces:**
- Consumes: `Requirement` ids (Task 2).
- Produces: `TaskNode { id: String, label: String, prompt: String, depends_on: Vec<String>, requirement_id: Option<String> }`, `TaskGraph { nodes: Vec<TaskNode> }` with:
  - `TaskGraph::waves(&self) -> Result<Vec<Vec<TaskNode>>, SpecError>` — topological levels; independent tasks share a wave; `SpecError::Cycle { at: String }` on cycles; `SpecError::UnknownDep { task, dep }` on dangling dependencies.
  - `TaskGraph::traceability(&self) -> Vec<String>` — requirement ids referenced by nodes, in first-appearance order.

- [ ] **Step 1: Write the failing test**

```rust
fn node(id: &str, deps: &[&str], req: Option<&str>) -> TaskNode {
    TaskNode { id: id.into(), label: id.into(), prompt: format!("do {id}"), depends_on: deps.iter().map(|d| d.to_string()).collect(), requirement_id: req.map(String::from) }
}

#[test]
fn waves_group_independent_tasks_and_gate_dependents() {
    let graph = TaskGraph { nodes: vec![
        node("scaffold", &[], None),
        node("model", &["scaffold"], Some("R1")),
        node("ui", &["scaffold"], Some("R2")),
        node("wire", &["model", "ui"], Some("R3")),
    ]};
    let waves = graph.waves().unwrap();
    assert_eq!(waves.len(), 3);
    assert_eq!(waves[0].len(), 1);
    assert_eq!(waves[1].len(), 2); // model + ui run concurrently
    assert_eq!(waves[2][0].id, "wire");
    assert_eq!(graph.traceability(), vec!["R1".to_string(), "R2".to_string(), "R3".to_string()]);
}

#[test]
fn graph_rejects_cycles_and_unknown_deps() {
    let cyclic = TaskGraph { nodes: vec![node("a", &["b"], None), node("b", &["a"], None)] };
    assert!(matches!(cyclic.waves(), Err(SpecError::Cycle { .. })));
    let dangling = TaskGraph { nodes: vec![node("a", &["ghost"], None)] };
    assert!(matches!(dangling.waves(), Err(SpecError::UnknownDep { .. })));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-spec waves_group`
Expected: FAIL — `TaskGraph` undefined.

- [ ] **Step 3: Implement**

```rust
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct TaskNode {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub depends_on: Vec<String>,
    pub requirement_id: Option<String>,
}

#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct TaskGraph {
    pub nodes: Vec<TaskNode>,
}

impl TaskGraph {
    pub fn waves(&self) -> Result<Vec<Vec<TaskNode>>, SpecError> {
        let ids: Vec<&String> = self.nodes.iter().map(|n| &n.id).collect();
        for node in &self.nodes {
            for dep in &node.depends_on {
                if !ids.iter().any(|id| *id == dep) {
                    return Err(SpecError::UnknownDep { task: node.id.implementation(), dep: dep.implementation() });
                }
            }
        }
        let mut placed: Vec<String> = Vec::new();
        let mut remaining: Vec<&TaskNode> = self.nodes.iter().collect();
        let mut waves = Vec::new();
        while !remaining.is_empty() {
            let (ready, blocked): (Vec<&TaskNode>, Vec<&TaskNode>) = remaining
                .into_iter()
                .partition(|n| n.depends_on.iter().all(|d| placed.contains(d)));
            if ready.is_empty() {
                let stuck = blocked.first().map(|n| n.id.implementation()).unwrap_or_default();
                return Err(SpecError::Cycle { at: stuck });
            }
            for node in &ready {
                placed.push(node.id.implementation());
            }
            let wave: Vec<TaskNode> = ready.into_iter().reimplemented().collect();
            waves.push(wave);
            remaining = blocked;
        }
        Ok(waves)
    }

    pub fn traceability(&self) -> Vec<String> {
        let mut seen = Vec::new();
        for node in &self.nodes {
            if let Some(req) = &node.requirement_id {
                if !seen.contains(req) {
                    seen.push(req.implementation());
                }
            }
        }
        seen
    }
}
```

Add the new `SpecError` variants:

```rust
pub enum SpecError {
    #[error("requirement {id} is not EARS form")]
    NotEars { id: String },
    #[error("requirement {id} has no acceptance criteria")]
    NoAcceptance { id: String },
    #[error("task graph has a cycle at {at}")]
    Cycle { at: String },
    #[error("task {task} depends on unknown task {dep}")]
    UnknownDep { task: String, dep: String },
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-spec`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-spec
git commit -m "feat(spec): dependency-ordered task graph with wave scheduling"
```

---

## Task 6: `prricode-pipeline` crate skeleton + stage machine

**Files:**
- Create: `crates/prricode-pipeline/Cargo.toml`
- Create: `crates/prricode-pipeline/src/lib.rs`
- Modify: `Cargo.toml` (root — members)
- Test: `crates/prricode-pipeline/src/lib.rs`

**Interfaces:**
- Consumes: `prricode-spec` (all types), `prricode-agent::AgentRunner` (existing), `prricode-provider::ModelProvider` (existing).
- Produces: `enum PipelineStage { Concept, Clarify, Specify, Plan, Build }`, `struct StageEvent { stage: PipelineStage, kind: StageEventKind, detail: String }`, `enum StageEventKind { Started, Question { text: String }, Artifact { name: String }, GateWait { gate: String }, GatePassed, Failed }`, and `Pipeline::new(runner: Arc<AgentRunner>, persistence: Arc<Persistence>) -> Pipeline`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_events_carry_stage_and_kind() {
        let event = StageEvent {
            stage: PipelineStage::Specify,
            kind: StageEventKind::Artifact { name: "requirements.md".into() },
            detail: "4 requirements validated".into(),
        };
        assert_eq!(event.stage, PipelineStage::Specify);
        assert!(matches!(event.kind, StageEventKind::Artifact { .. }));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-pipeline`
Expected: FAIL — crate does not exist.

- [ ] **Step 3: Implement**

`crates/prricode-pipeline/Cargo.toml`:

```toml
[package]
name = "prricode-pipeline"
version.workspace = true
edition.workspace = true

[dependencies]
prricode-core = { path = "../prricode-core" }
prricode-spec = { path = "../prricode-spec" }
prricode-agent = { path = "../prricode-agent" }
prricode-provider = { path = "../prricode-provider" }
prricode-persistence = { path = "../prricode-persistence" }
prricode-workflow = { path = "../prricode-workflow" }
serde = { workspace = true }
serde_json = { workspace = true }
tokio = { workspace = true }
anyhow = { workspace = true }
uuid = { workspace = true }
tracing = { workspace = true }
```

Add to root `Cargo.toml` members: `"crates/prricode-pipeline"`.

`crates/prricode-pipeline/src/lib.rs`:

```rust
//! Product Builder pipeline: stages Concept -> Clarify -> Specify -> Plan ->
//! Build-with-gates, orchestrated over the existing AgentRunner.

use std::sync::Arc;

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum PipelineStage {
    Concept,
    Clarify,
    Specify,
    Plan,
    Build,
}

impl PipelineStage {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Concept => "concept",
            Self::Clarify => "clarify",
            Self::Specify => "specify",
            Self::Plan => "plan",
            Self::Build => "build",
        }
    }
}

#[derive(Debug, Implementation)]
pub enum StageEventKind {
    Started,
    Question { text: String },
    Artifact { name: String },
    GateWait { gate: String },
    GatePassed,
    Failed { error: String },
}

#[derive(Debug, Implementation)]
pub struct StageEvent {
    pub stage: PipelineStage,
    pub kind: StageEventKind,
    pub detail: String,
}

pub struct Pipeline {
    runner: Arc<prricode_agent::AgentRunner>,
    persistence: Arc<prricode_persistence::Persistence>,
}

impl Pipeline {
    pub fn new(
        runner: Arc<prricode_agent::AgentRunner>,
        persistence: Arc<prricode_persistence::Persistence>,
    ) -> Self {
        Self { runner, persistence }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-pipeline`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-pipeline Cargo.toml
git commit -m "feat(pipeline): crate skeleton with stage machine"
```

---

## Task 7: Clarify stage — interactive interview state machine

**Files:**
- Modify: `crates/prricode-pipeline/src/lib.rs`
- Create: `crates/prricode-pipeline/src/clarify.rs`
- Test: `crates/prricode-pipeline/src/clarify.rs`

**Interfaces:**
- Consumes: `prricode_spec::Concept` (Task 1), `ModelProvider` (existing).
- Produces: `Clarifier { concept: Concept, asked: Vec<String> }` with:
  - `Clarifier::new(concept: Concept) -> Self`
  - `Clarifier::next_question(&self) -> Option<String>` — one question at a time, in priority order: audience → value → success criteria → non-goals → stack; returns `None` when `concept.is_ready()`.
  - `Clarifier::apply(&mut self, answer: &str)` — fills the field the last question targeted, removes its ambiguity marker, pushes to `success_criteria`/`non_goals` as appropriate.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use prricode_spec::Concept;

    #[test]
    fn interview_asks_one_question_at_a_time_until_ready() {
        let mut clarifier = Clarifier::new(Concept::from_idea("vague thing"));
        assert_eq!(clarifier.next_question().as_deref(), Some("Who is the primary user of this product?"));
        clarifier.apply("commuters");
        assert_eq!(clarifier.next_question().as_deref(), Some("What is the core value they get?"));
        clarifier.apply("daily audio briefings");
        assert_eq!(clarifier.next_question().as_deref(), Some("What single success criterion says it works?"));
        clarifier.apply("a user receives a briefing every morning");
        assert!(clarifier.next_question().is_none());
        assert!(clarifier.concept.is_ready());
        assert_eq!(clarifier.concept.audience, "commuters");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-pipeline interview_asks`
Expected: FAIL — `Clarifier` undefined.

- [ ] **Step 3: Implement**

`crates/prricode-pipeline/src/clarify.rs`:

```rust
//! The Clarify stage: a one-question-at-a-time interview that empties the
//! concept's ambiguity markers.

use prricode_spec::Concept;

pub struct Clarifier {
    pub concept: Concept,
}

const QUESTIONS: &[(&str, &str)] = &[
    ("Who is the primary user of this product?", "audience"),
    ("What is the core value they get?", "value"),
    ("What single success criterion says it works?", "success"),
    ("What is explicitly NOT part of this product?", "non_goal"),
];

impl Clarifier {
    pub fn new(concept: Concept) -> Self {
        Self { concept }
    }

    pub fn next_question(&self) -> Option<String> {
        if self.concept.audience.is_empty() {
            return Some(QUESTIONS[0].0.to_string());
        }
        if self.concept.value.is_empty() {
            return Some(QUESTIONS[1].0.to_string());
        }
        if self.concept.success_criteria.is_empty() {
            return Some(QUESTIONS[2].0.to_string());
        }
        if self.concept.non_goals.is_empty() {
            return Some(QUESTIONS[3].0.to_string());
        }
        None
    }

    pub fn apply(&mut self, answer: &str) {
        let answer = answer.trim().to_string();
        if answer.is_empty() {
            return;
        }
        if self.concept.audience.is_empty() {
            self.concept.audience = answer;
            self.concept.ambiguities.retain(|a| a != "audience");
        } else if self.concept.value.is_empty() {
            self.concept.value = answer;
            self.concept.ambiguities.retain(|a| a != "value");
        } else if self.concept.success_criteria.is_empty() {
            self.concept.success_criteria.push(answer);
        } else if self.concept.non_goals.is_empty() {
            self.concept.non_goals.push(answer);
        }
    }
}
```

In `crates/prricode-pipeline/src/lib.rs` add `pub mod clarify;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-pipeline`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-pipeline
git commit -m "feat(pipeline): interactive clarifier interview state machine"
```

---

## Task 8: Specify stage — model-driven spec generation with EARS gate

**Files:**
- Modify: `crates/prricode-pipeline/src/lib.rs`
- Create: `crates/prricode-pipeline/src/specify.rs`
- Test: `crates/prricode-pipeline/src/specify.rs`

**Interfaces:**
- Consumes: `Clarifier` (Task 7), `ModelProvider`, `prricode_spec::{Spec, Requirements, Requirement, StackChoice, StackPreset}` (Tasks 1–4).
- Produces: `fn spec_prompt(concept: &Concept, preset: Option<StackPreset>) -> Vec<ChatMessage>` — the exact messages sent to the model; `fn parse_requirements(model_text: &str) -> Result<Requirements, SpecError>` — parses a fenced-JSON array of `{id, ears, acceptance}` (reusing `prricode_provider::repair_json`); `Spec::draft(concept: Concept) -> Spec`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use prricode_spec::Concept;

    #[test]
    fn spec_prompt_includes_concept_and_preset() {
        let mut concept = Concept::from_idea("rss briefings");
        concept.audience = "commuters".into();
        concept.value = "audio briefings".into();
        let messages = spec_prompt(&concept, Some(prricode_spec::StackPreset::TanStack));
        let joined: String = messages.iter().map(|m| m.content.iter().map(|p| match p {
            prricode_provider::ContentPart::Text(t) => t.implementation(),
            _ => String::new(),
        }).collect::<String>()).collect();
        assert!(joined.contains("commuters"));
        assert!(joined.contains("TAN stack"));
        assert!(joined.to_uppercase().contains("WHEN"));
    }

    #[test]
    fn parse_requirements_handles_fenced_json_and_rejects_prose() {
        let text = "```json\n[{\"id\":\"R1\",\"ears\":\"WHEN the user opens the app THE SYSTEM SHALL show today's briefing\",\"acceptance\":[\"briefing is visible\"]}]\n```";
        let requirements = parse_requirements(text).unwrap();
        assert_eq!(requirements.items.len(), 1);
        assert!(requirements.validate().is_ok());
        assert!(parse_requirements("no json here").is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-pipeline spec_prompt`
Expected: FAIL — `specify` module undefined.

- [ ] **Step 3: Implement**

`crates/prricode-pipeline/src/specify.rs`:

```rust
//! The Specify stage: turn a clarified concept into a validated Core-4 spec
//! draft. The EARS gate is structural; the model supplies content.

use prricode_provider::{repair_json, ChatMessage, ContentPart, Role};
use prricode_spec::{Concept, Requirement, Requirements, Spec, SpecError, StackPreset};

pub fn spec_prompt(concept: &Concept, preset: Option<StackPreset>) -> Vec<ChatMessage> {
    let stack = preset
        .map(|p| p.description().to_string())
        .unwrap_or_else(|| "choose the simplest stack that fits the concept".to_string());
    let mut prompt = format!(
        "Produce the product spec for this concept.\n\
         Problem: {}\nAudience: {}\nValue: {}\nNon-goals: {}\nSuccess criteria: {}\n\
         Reference stack: {}\n\n\
         Output a JSON array of requirements. Each requirement: {{\"id\":\"R1\",\"ears\":\"WHEN ... THE SYSTEM SHALL ...\",\"acceptance\":[\"...\"]}}.\n\
         Rules: EARS form only; at least one acceptance criterion per requirement; ids sequential from R1.\n\
         Output ONLY the fenced JSON block.",
        concept.problem,
        concept.audience,
        concept.value,
        concept.non_goals.join("; "),
        concept.success_criteria.join("; "),
        stack,
    );
    prompt.push('\n');
    vec![ChatMessage::system_text(
        "You are the Specify stage of a product builder. You emit machine-checkable specs.",
    ), ChatMessage {
        role: Role::User,
        content: vec![ContentPart::text(prompt)],
        tool_call_id: None,
        tool_calls: vec![],
    }]
}

pub fn parse_requirements(model_text: &str) -> Result<Requirements, SpecError> {
    let start = model_text.find('[').ok_or(SpecError::NotEars { id: "<none>".into() })?;
    let end = model_text.rfind(']').ok_or(SpecError::NotEars { id: "<none>".into() })?;
    let slice = &model_text[start..=end];
    let value = repair_json(slice);
    let array = value.as_array().ok_or(SpecError::NotEars { id: "<none>".into() })?;
    let items: Vec<Requirement> = array
        .iter()
        .enumerate()
        .filter_map(|(i, item)| {
            Some(Requirement {
                id: item.get("id")?.as_str().unwrap_or(&format!("R{}", i + 1)).to_string(),
                ears: item.get("ears")?.as_str()?.to_string(),
                acceptance: item
                    .get("acceptance")?
                    .as_array()?
                    .iter()
                    .filter_map(|a| a.as_str().map(String::from))
                    .collect(),
            })
        })
        .collect();
    if items.is_empty() {
        return Err(SpecError::NotEars { id: "<none>".into() });
    }
    let requirements = Requirements { items };
    requirements.validate()?;
    Ok(requirements)
}

impl Spec {
    pub fn draft(concept: Concept) -> Self {
        Self {
            concept,
            requirements: Requirements::default(),
            design: String::new(),
            tasks: String::new(),
            version: 1,
        }
    }
}
```

In `crates/prricode-pipeline/src/lib.rs` add `pub mod specify;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-pipeline`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-pipeline
git commit -m "feat(pipeline): specify stage prompt + EARS requirement parsing"
```

---

## Task 9: Plan stage — task graph generation with traceability gate

**Files:**
- Modify: `crates/prricode-pipeline/src/lib.rs`
- Create: `crates/prricode-pipeline/src/plan.rs`
- Test: `crates/prricode-pipeline/src/plan.rs`

**Interfaces:**
- Consumes: `Requirements` (Task 2), `ModelProvider`, `prricode_spec::TaskGraph` (Task 5).
- Produces: `fn plan_prompt(requirements: &Requirements) -> Vec<ChatMessage>`; `fn parse_task_graph(model_text: &str) -> Result<TaskGraph, SpecError>` — parses fenced JSON `{id, label, prompt, depends_on, requirement_id}`; `fn validate_traceability(graph: &TaskGraph, requirements: &Requirements) -> Result<(), SpecError>` — every requirement id must appear in `graph.traceability()`; new variant `SpecError::Uncovered { id: String }`.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use prricode_spec::{Requirement, Requirements};

    fn reqs() -> Requirements {
        Requirements { items: vec![
            Requirement { id: "R1".into(), ears: "WHEN a THE SYSTEM SHALL b".into(), acceptance: vec!["x".into()] },
            Requirement { id: "R2".into(), ears: "WHEN c THE SYSTEM SHALL d".into(), acceptance: vec!["y".into()] },
        ]}
    }

    #[test]
    fn parse_task_graph_and_validate_traceability() {
        let text = "```json\n[{\"id\":\"scaffold\",\"label\":\"Scaffold\",\"prompt\":\"create the app\",\"depends_on\":[],\"requirement_id\":null},{\"id\":\"feature\",\"label\":\"Feature\",\"prompt\":\"build b\",\"depends_on\":[\"scaffold\"],\"requirement_id\":\"R1\"},{\"id\":\"feature2\",\"label\":\"Feature 2\",\"prompt\":\"build d\",\"depends_on\":[\"scaffold\"],\"requirement_id\":\"R2\"}]\n```";
        let graph = parse_task_graph(text).unwrap();
        assert_eq!(graph.waves().unwrap().len(), 2);
        assert!(validate_traceability(&graph, &reqs()).is_ok());

        let partial = "```json\n[{\"id\":\"only\",\"label\":\"Only\",\"prompt\":\"x\",\"depends_on\":[],\"requirement_id\":\"R1\"}]\n```";
        let graph = parse_task_graph(partial).unwrap();
        assert!(matches!(validate_traceability(&graph, &reqs()), Err(SpecError::Uncovered { id }) if id == "R2"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-pipeline parse_task_graph`
Expected: FAIL — `plan` module undefined.

- [ ] **Step 3: Implement**

`crates/prricode-pipeline/src/plan.rs`:

```rust
//! The Plan stage: requirements become a dependency-ordered, wave-scheduled
//! task graph. The traceability gate blocks plans that leave a requirement
//! uncovered.

use prricode_provider::{repair_json, ChatMessage, ContentPart, Role};
use prricode_spec::{Requirements, SpecError, TaskGraph, TaskNode};

pub fn plan_prompt(requirements: &Requirements) -> Vec<ChatMessage> {
    let list: Vec<String> = requirements
        .items
        .iter()
        .map(|r| format!("{}: {} (acceptance: {})", r.id, r.ears, r.acceptance.join("; ")))
        .collect();
    let prompt = format!(
        "Turn these requirements into a task graph.\n{}\n\n\
         Output a fenced JSON array of tasks. Each task: {{\"id\":\"scaffold\",\"label\":\"Scaffold\",\"prompt\":\"...\",\"depends_on\":[],\"requirement_id\":\"R1\"}}.\n\
         Rules: at least one task per requirement (requirement_id traces it); ids are short slugs; \
         depends_on references earlier task ids only; the first task scaffolds the project.\n\
         Output ONLY the fenced JSON block.",
        list.join("\n"),
    );
    vec![
        ChatMessage::system_text("You are the Plan stage of a product builder. You emit dependency-ordered task graphs."),
        ChatMessage {
            role: Role::User,
            content: vec![ContentPart::text(prompt)],
            tool_call_id: None,
            tool_calls: vec![],
        },
    ]
}

pub fn parse_task_graph(model_text: &str) -> Result<TaskGraph, SpecError> {
    let start = model_text.find('[').ok_or(SpecError::NotEars { id: "<none>".into() })?;
    let end = model_text.rfind(']').ok_or(SpecError::NotEars { id: "<none>".into() })?;
    let value = repair_json(&model_text[start..=end]);
    let array = value.as_array().ok_or(SpecError::NotEars { id: "<none>".into() })?;
    let nodes: Vec<TaskNode> = array
        .iter()
        .filter_map(|item| {
            Some(TaskNode {
                id: item.get("id")?.as_str()?.to_string(),
                label: item.get("label").and_then(|v| v.as_str()).unwrap_or("task").to_string(),
                prompt: item.get("prompt")?.as_str()?.to_string(),
                depends_on: item
                    .get("depends_on")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|d| d.as_str().map(String::from)).collect())
                    .unwrap_or_default(),
                requirement_id: item.get("requirement_id").and_then(|v| v.as_str()).map(String::from),
            })
        })
        .collect();
    if nodes.is_empty() {
        return Err(SpecError::NotEars { id: "<none>".into() });
    }
    let graph = TaskGraph { nodes };
    graph.waves()?;
    Ok(graph)
}

pub fn validate_traceability(graph: &TaskGraph, requirements: &Requirements) -> Result<(), SpecError> {
    let covered = graph.traceability();
    for requirement in &requirements.items {
        if !covered.contains(&requirement.id) {
            return Err(SpecError::Uncovered { id: requirement.id.implementation() });
        }
    }
    Ok(())
}
```

Add to `prricode-spec`'s `SpecError`:

```rust
#[error("requirement {id} has no task covering it")]
Uncovered { id: String },
```

In `crates/prricode-pipeline/src/lib.rs` add `pub mod plan;`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-pipeline`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-pipeline crates/prricode-spec
git commit -m "feat(pipeline): plan stage generation with traceability gate"
```

---

## Task 10: Build stage — gated task execution over the workflow engine

**Files:**
- Modify: `crates/prricode-workflow/src/lib.rs`
- Create: `crates/prricode-pipeline/src/build.rs`
- Test: `crates/prricode-workflow/src/lib.rs`

**Interfaces:**
- Consumes: `TaskGraph` (Task 5), `AgentRunner` (existing), `WorkflowEngine` (existing).
- Produces (workflow): `WorkflowRun::last_step_summary(&self) -> Option<&str>` backed by a new `pub last_step_summary: Option<String>` field that `advance()` fills from the definition's current step label.
- Produces (pipeline): `fn graph_to_definition(graph: &TaskGraph) -> WorkflowDefinition` — one `Prompt` step per task, in wave order, with wave index embedded in the label (`"[wave 1] scaffold"`); `async fn run_build(runner: &AgentRunner, engine: &WorkflowEngine, run_id: &str, session_id: &str, workspace: &Path, data_dir: &Path) -> anyhow::Result<String>` — drives waves sequentially, tasks within a wave as concurrent `run_subagent` calls, recording per-task gate summaries.

- [ ] **Step 1: Write the failing test**

```rust
// crates/prricode-workflow/src/lib.rs tests
#[test]
fn advance_records_last_step_summary() {
    let engine = WorkflowEngine::new();
    let id = engine.start("s", two_step(), None).unwrap();
    assert!(engine.get(&id).unwrap().last_step_summary.is_none());
    engine.advance(&id).unwrap();
    assert_eq!(engine.get(&id).unwrap().last_step_summary.as_deref(), Some("one"));
}
```

```rust
// crates/prricode-pipeline/src/build.rs tests
#[test]
fn graph_becomes_wave_ordered_definition() {
    let graph = prricode_spec::TaskGraph { nodes: vec![
        prricode_spec::TaskNode { id: "a".into(), label: "A".into(), prompt: "pa".into(), depends_on: vec![], requirement_id: None },
        prricode_spec::TaskNode { id: "b".into(), label: "B".into(), prompt: "pb".into(), depends_on: vec!["a".into()], requirement_id: Some("R1".into()) },
    ]};
    let definition = graph_to_definition(&graph);
    assert_eq!(definition.steps.len(), 2);
    match &definition.steps[0] {
        WorkflowStep::Prompt { label, .. } => assert!(label.contains("wave 1")),
        _ => panic!("expected prompt step"),
    }
    match &definition.steps[1] {
        WorkflowStep::Prompt { label, .. } => assert!(label.contains("wave 2")),
        _ => panic!("expected prompt step"),
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p prricode-workflow advance_records && cargo test -p prricode-pipeline graph_becomes`
Expected: FAIL — `last_step_summary` and `build` module undefined.

- [ ] **Step 3: Implement**

In `crates/prricode-workflow/src/lib.rs`: add the field, and in `advance()` set it:

```rust
pub struct WorkflowRun {
    // ... existing fields ...
    #[serde(default)]
    pub last_step_summary: Option<String>,
}
```

In `advance()`, after `run.current_step += 1` and before the completion check:

```rust
if let Some(WorkflowStep::Prompt { label, .. }) =
    run.definition.steps.get(run.current_step - 1)
{
    run.last_step_summary = Some(label.implementation());
}
```

`crates/prricode-pipeline/src/build.rs`:

```rust
//! The Build stage: task graph waves execute as concurrent agent turns,
//! gated by the workflow engine's state machine (pause/cancel honored
//! between steps, per PRD stage 5).

use prricode_agent::AgentRunner;
use prricode_spec::TaskGraph;
use prricode_workflow::{WorkflowDefinition, WorkflowEngine, WorkflowStep};
use std::path::Path;

pub fn graph_to_definition(graph: &TaskGraph) -> WorkflowDefinition {
    let waves = graph.waves().unwrap_or_default();
    let mut steps = Vec::new();
    for (wave_index, wave) in waves.iter().enumerate() {
        for node in wave {
            steps.push(WorkflowStep::Prompt {
                label: format!("[wave {}] {}", wave_index + 1, node.label),
                prompt: format!(
                    "Task {} — requirement {}: {}",
                    node.label,
                    node.requirement_id.as_deref().unwrap_or("n/a"),
                    node.prompt
                ),
            });
        }
    }
    WorkflowDefinition { name: "build".into(), steps }
}
```

In `crates/prricode-pipeline/src/lib.rs` add `pub mod build;` and re-export:

```rust
pub use build::{graph_to_definition, run_build};
```

(The full `run_build` body mirrors `workflow_exec::execute_run` from `crates/prricode-agent/src/tools/workflow.rs`: sequential steps, `engine.advance` between them, `record_usage` budget checks, status checks for pause/cancel. Its exact implementation is written in the executing task following that pattern; the unit test above gates the pure part.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p prricode-workflow && cargo test -p prricode-pipeline`
Expected: PASS — workflow suite (9 tests) + pipeline suite (6 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-workflow crates/prricode-pipeline
git commit -m "feat(build): gated build stage over the workflow engine"
```

---

## Task 11: Server methods — additive pipeline protocol surface

**Files:**
- Modify: `crates/prricode-server/src/lib.rs`
- Modify: `crates/prricode-server/Cargo.toml`
- Modify: `docs/PROTOCOL.md`

**Interfaces:**
- Consumes: `prricode-pipeline` (Tasks 6–10).
- Produces: three additive methods:
  - `pipeline/conceptSet` `{sessionId, idea}` → `{commandId, concept}` — starts the pipeline, emits the first clarifier question as a `turn/item` notification.
  - `pipeline/specRead` `{sessionId}` → `{spec, stage}` — latest spec JSON + current stage.
  - `pipeline/planRead` `{sessionId}` → `{waves: [[taskIds]], stage}`.
  Pipeline state persists per session in the `settings` table under key `pipeline:<sessionId>`.

- [ ] **Step 1: Write the failing test**

```rust
// crates/prricode-server/src/lib.rs tests
#[tokio::test]
async fn pipeline_methods_are_registered() {
    let (server, _rx) = PrricodeServer::new(
        std::env::temp_dir(),
        Box::new(prricode_provider::EchoProvider),
        None,
    );
    let request = serde_json::from_value::<JsonRpcRequest>(serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "pipeline/specRead",
        "params": { "sessionId": "00000000-0000-7000-8000-000000000001" }
    }))
    .unwrap();
    let response = server.handle_request(request).await;
    assert!(response.error.is_none(), "pipeline/specRead must not error");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-server pipeline_methods`
Expected: FAIL — method not found (-32601).

- [ ] **Step 3: Implement**

- Add `prricode-pipeline` to `crates/prricode-server/Cargo.toml` dependencies.
- Add dispatch arms: `"pipeline/conceptSet" => self.handle_pipeline_concept_set(params).await,` etc.
- Handlers store/read pipeline state as JSON in the settings table (`pipeline:<sessionId>` key) and emit `AgentEvent::Item` notifications for clarifier questions. `pipeline/conceptSet` creates a concept via `Concept::from_idea`, persists it, and returns the concept JSON plus the first question (from `Clarifier::new(...).next_question()`).
- `pipeline/specRead` returns the persisted spec JSON (or an empty draft) and the persisted stage label.
- `pipeline/planRead` returns the persisted waves JSON.

In `docs/PROTOCOL.md`, add a "Pipeline" method group documenting the three methods, their params, results, and the `pipeline:<stage>` notifications.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-server`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add crates/prricode-server docs/PROTOCOL.md
git commit -m "feat(server): pipeline conceptSet/specRead/planRead methods"
```

---

## Task 12: TUI — slash commands, pipeline rail, confirmation gates

**Files:**
- Modify: `crates/prricode-tui/src/lib.rs`
- Modify: `crates/prricode-tui/src/app.rs`
- Modify: `crates/prricode-tui/src/ui.rs`

**Interfaces:**
- Consumes: `prricode-pipeline` (Tasks 6–10); existing TUI `App`/`UiCommand`.
- Produces:
  - New `UiCommand` variants: `PipelineConcept { idea: String }`, `PipelineAnswer { answer: String }`, `PipelineConfirm { stage: String, ok: bool }`.
  - Slash commands in `App::submit`: `/concept <idea>` starts the pipeline; `/spec`, `/plan`, `/build` advance/read; a bare message during an active clarifier interview is treated as the interview answer.
  - `App.pipeline: Option<PipelineView>` with `PipelineView { stage: String, gate: Option<String> }` rendered as a rail segment in the status line: `stage: specify · gate: spec-confirmation`.

- [ ] **Step 1: Write the failing test**

```rust
// crates/prricode-tui/src/app.rs tests
#[test]
fn slash_commands_start_and_advance_the_pipeline() {
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut app = new_app();
    for c in "/concept an rss briefing service".chars() {
        app.handle_key(KeyAction::Char(c), &tx);
    }
    app.handle_key(KeyAction::Enter, &tx);
    assert!(matches!(rx.try_recv().unwrap(), super::super::UiCommand::PipelineConcept { .. }));

    // While an interview is active, a plain message answers it.
    app.apply_ui_event(
        UiEvent::PipelineInterview { question: "Who is the primary user?".into() },
        &tx,
    );
    for c in "commuters".chars() {
        app.handle_key(KeyAction::Char(c), &tx);
    }
    app.handle_key(KeyAction::Enter, &tx);
    assert!(matches!(rx.try_recv().unwrap(), super::super::UiCommand::PipelineAnswer { .. }));
}

#[test]
fn pipeline_rail_shows_stage_and_gate() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let mut app = new_app();
    app.apply_ui_event(
        UiEvent::PipelineGate { gate: "spec-confirmation".into() },
        &tx,
    );
    assert!(app.pipeline.is_some());
    assert_eq!(app.pipeline.as_ref().unwrap().gate.as_deref(), Some("spec-confirmation"));
    assert!(app.status_line().contains("spec-confirmation"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p prricode-tui slash_commands_start`
Expected: FAIL — `UiCommand::PipelineConcept` / `UiEvent::PipelineInterview` undefined.

- [ ] **Step 3: Implement**

- `UiEvent` gains `PipelineInterview { question: String }`, `PipelineGate { gate: String }`, `PipelineStageChanged { stage: String }`.
- `UiCommand` gains `PipelineConcept { idea: String }`, `PipelineAnswer { answer: String }`, `PipelineConfirm { stage: String, ok: bool }`.
- `App` gains `pipeline: Option<PipelineView>`; `status_line()` appends ` · stage: {stage}` and ` · gate: {gate}` when present.
- `submit()` handles `/concept`, `/spec`, `/plan`, `/build`; when `app.pipeline` shows an active interview, a plain Enter routes to `PipelineAnswer`; when a gate is pending, `y`/`n` keys (handled alongside the existing approval keys) route to `PipelineConfirm`.
- `lib.rs` agent task handles the new commands: `PipelineConcept` creates the concept through the pipeline and relays the first question as a `UiEvent::PipelineInterview`; `PipelineAnswer` applies it and asks the next; `PipelineConfirm` records the gate decision and advances.
- The rail renders in `ui.rs` status header as a styled segment.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p prricode-tui`
Expected: PASS (13 tests).

- [ ] **Step 5: Gate check + commit**

Run: `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: all green.

```bash
git add crates/prricode-tui
git commit -m "feat(tui): pipeline slash commands, rail, and confirmation gates"
```

---

## Task 13: Worktree-per-run wiring + docs

**Files:**
- Modify: `crates/prricode-pipeline/src/lib.rs`
- Modify: `crates/prricode-server/src/lib.rs`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CONFIGURATION.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: `Pipeline::prepare_worktree(&self, session_id: &str) -> anyhow::Result<PathBuf>` — creates `<data_dir>/runs/<session_id>/` as a git worktree off the current workspace when inside a git repo (via `git worktree add`), else a fresh directory; the Build stage's workspace root points at it. `Pipeline::run_dir(&self, session_id: &str) -> PathBuf`.

- [ ] **Step 1: Write the failing test**

```rust
// crates/prricode-pipeline/src/lib.rs tests
#[tokio::test]
async fn prepare_worktree_returns_a_usable_directory() {
    let dir = std::env::temp_dir().join(format!("pricode-run-{}", std::process::id()));
    let persistence = Arc::new(prricode_persistence::Persistence::new(&dir).unwrap());
    let (events_tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let approvals = Arc::new(prricode_agent::ApprovalEngine::new());
    let provider: Arc<dyn prricode_provider::ModelProvider> =
        Arc::new(prricode_provider::EchoProvider);
    let runner = Arc::new(
        prricode_agent::AgentRunner::new(provider, approvals)
            .with_events(events_tx)
            .with_persistence(Arc::implementation(&persistence)),
    );
    let pipeline = Pipeline::new(runner, persistence);
    let worktree = pipeline.prepare_worktree("session-1").await.unwrap();
    assert!(worktree.exists() && worktree.is_dir());
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p prricode-pipeline prepare_worktree`
Expected: FAIL — method undefined.

- [ ] **Step 3: Implement**

```rust
impl Pipeline {
    pub fn run_dir(&self, session_id: &str) -> std::path::PathBuf {
        self.persistence.data_dir().join("runs").join(session_id)
    }

    /// Per-run workspace: a git worktree when the current directory is inside
    /// a git repository, otherwise a fresh directory.
    pub async fn prepare_worktree(&self, session_id: &str) -> anyhow::Result<std::path::PathBuf> {
        let run_dir = self.run_dir(session_id);
        std::fs::create_dir_all(&run_dir)?;
        let inside_git = std::process::Command::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if inside_git {
            let status = std::process::Command::new("git")
                .args(["worktree", "add", "--detach"])
                .arg(&run_dir)
                .status()?;
            if status.success() {
                return Ok(run_dir);
            }
            tracing::warn!("git worktree add failed; using a plain directory");
        }
        Ok(run_dir)
    }
}
```

(Requires adding `pub fn data_dir(&self) -> &Path` to `prricode-persistence`'s `Persistence` — one line, returns the stored path.)

Then:
- `docs/ARCHITECTURE.md`: add a "Product Builder pipeline" section (stage flow, the two crates, gates, worktree-per-run, the protocol methods).
- `docs/CONFIGURATION.md`: document the stack preset list and where run worktrees live.
- `README.md`: one line in the Product Builder section noting v0.1 covers Concept → Clarify → Specify → Plan → Build-with-gates.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p prricode-pipeline`
Expected: PASS (7 tests).

- [ ] **Step 5: Final gates + commit**

Run: `cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace`
Expected: all green; workspace test count 60+.

```bash
git add -A
git commit -m "feat(pipeline): worktree-per-run workspaces and pipeline docs"
```

---

## Self-Review Notes

**Spec coverage:** PRD §5 (stages + gates) → Tasks 6–10, 13. §6 (Core-4 spec, EARS, waves) → Tasks 1–5. §10 (autonomy/oracle map; two human gates) → Tasks 12–13. §15 (defaults: five presets, interactive interview, greenfield) → Tasks 4, 7, 13. §16 (v0.1 + build-with-gates milestone) → the whole plan. §12 (architecture table) → File Structure.

**Deliberate deferrals (stated, not silent):** deployment/operate (v0.3), independent verifier + dossier (v0.2), business layer (v0.4), backend/frontend/infra/NFR spec layers — each named in the PRD milestones and excluded from this plan's tasks.

**Type consistency:** `Concept`, `Requirements`, `Requirement`, `Spec`, `StackPreset`, `StackChoice`, `TaskNode`, `TaskGraph`, `SpecError`, `WorkflowStep::Prompt`, `Clarifier`, `Pipeline`, `StageEvent` — names used in later tasks match the definitions in Tasks 1–7. `Pipeline::prepare_worktree` returns `PathBuf`; `run_dir` returns `PathBuf`; both consumed only inside Task 13.
