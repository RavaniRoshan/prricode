# PRRICODE Product-to-Reality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take PRRICODE from a feature-complete base foundation (reference-agent-parity implementation + model-agnostic provider layer) to a validated product that turns an idea into a verified, shippable product — exercised end-to-end on a real idea, with remaining roadmap items closed and launch checkpoints read.

**Architecture:** The base layer is done (protocol, agent loop, TUI, pipeline, verification, ship/operate, multi-provider, connections). What remains is (1) real-world validation of the full pipeline on a non-trivial idea, (2) closing the last roadmap items that block "works everywhere" (Wayland input, macOS backend, speech, presets, palettes), (3) TUI UX polish for connections, and (4) launch-readiness verification against preregistered targets. Each phase is independently committable and testable.

**Tech Stack:** Rust 2021 workspace, tokio, ratatui/crossterm, serde, rusqlite, bubblewrap, X11/Wayland probes, GitHub Actions, mkdocs.

**Spec:** `AGENTS.md` (non-negotiable rules), `docs/explanation/prd.md`, `docs/explanation/launch-status.md`, `docs/explanation/roadmap.md`, `docs/plans/provider-track.md`.

## Global Constraints

- Protocol compatibility: schema fingerprint `sha256:6de32db0…` never changes; new capabilities are additive (`#[serde(default)]`, new methods/tools/notifications).
- No third-party product or company names in code/docs/commits; no secrets in repo.
- Every agent-facing behavior is a tool or protocol method.
- Honest degradation: `enabled: false` / `unsupported: <why>`, never fake success.
- TDD per slice; `cargo fmt --check`, clippy `-D warnings`, `cargo test --workspace` green before every commit; one commit per phase item.
- Agent isolation: verifier never shares context with builder; approvals gate side effects.
- Credentials env-only for child processes, redacted from artifacts.
- Marking system: each task has a status line `[ ]` (not started), `[~]` (in progress), `[x]` (done). If work stops, the next agent reads the first `[ ]`/`[~]` task and resumes from its last unchecked step. Commit messages include the task ID (e.g. `feat: Task 4.2 ...`).

## Review Focus

1. **Real-world pipeline run** — the pipeline has been driven live but on small inputs; a non-trivial idea will surface build/verify/ship friction that unit tests cannot predict. The verifier must not share context with the builder.
2. **Wayland input execution** — selection is probed but never executed against a live compositor; a user on Wayland with `wlrctl`/`ydotool` expects input to actually land.
3. **macOS computer-use backend** — `unavailable_reason()` reports honestly today; shipping a real backend (Accessibility + Screen Recording) is the last platform gap.
4. **Speech model manager** — local speech needs a user-built binary today; a bundled manager removes the biggest onboarding friction for voice.
5. **Embedded TUI live provider switch** — the protocol path works; the embedded runner still rebuilds per turn, so a mid-session switch is not yet seamless.

## Phase A — Real-world product validation

### Task A.1: End-to-end pipeline run on a non-trivial idea

**Files:**
- Create: `docs/explanation/real-world-run.md` (run log)
- Modify: `docs/how-to/run-the-tests.md` (add the live-pipeline verification step)

**Interfaces:** none new; exercises existing pipeline stages.

- [ ] **Step 1: Pick a non-trivial idea** — a small but real CLI tool with a spec, tests, and a deploy target (e.g. a "weather CLI that fetches Open-Meteo and prints a one-line summary"). Record the idea in the run log.
- [ ] **Step 2: Run `/concept`** — answer the clarify questions; record the clarified concept in the run log.
- [ ] **Step 3: Run `/specify`** — generate EARS requirements + Core-4 layered spec; record the spec artifact path.
- [ ] **Step 4: Run `/plan`** — generate the task graph + waves; record wave count and task count.
- [ ] **Step 5: Run `/build`** — let the builder execute waves; record any stalls, approval prompts, and how they were resolved.
- [ ] **Step 6: Run `/verify`** — gate runner (typecheck/build/test) + adversarial verifier; record pass/fail and any verifier findings.
- [ ] **Step 7: Run `/ship` + `/deploy` + `/operate`** — GitHub release path, deploy to a target, health check; record the deployed URL and health status.
- [ ] **Step 8: Write the run log** — `docs/explanation/real-world-run.md` with the idea, artifacts, friction points, and a punch list of issues found (each becomes a tracked row).
- [ ] **Step 9: Commit** — `docs: real-world pipeline run log (Task A.1)`.

### Task A.2: Punch-list triage

**Files:**
- Modify: `docs/plans/phase-status.md` (append "Track 3 — Real-world validation punch list" rows)

- [ ] **Step 1: Convert each friction point from the run log into a tracker row** with status `pending` and a one-line honest reason.
- [ ] **Step 2: Commit** — `docs: punch list from real-world run (Task A.2)`.

## Phase B — TUI UX polish for connections

### Task B.1: Navigable `/connections` modal

**Files:**
- Modify: `crates/prricode-tui/src/app.rs` (add `ConnectionsPicker` state + key handling)
- Modify: `crates/prricode-tui/src/ui.rs` (render the modal)
- Test: `crates/prricode-tui/src/app.rs` (tests module)

**Interfaces:**
- Consumes: `prricode_provider::load_config()`, `parse_kind_id`.
- Produces: `App::connections_picker: Option<ConnectionsPicker>`, `UiCommand::SwitchConnection { name }`.

- [ ] **Step 1: Write failing tests** — picker opens on `/connections`, lists connections, Enter selects, Esc closes.
- [ ] **Step 2: Run tests to confirm failure**.
- [ ] **Step 3: Implement** — modal state, key handling (Up/Down/Enter/Esc), render with the same styling as the session picker.
- [ ] **Step 4: Run tests to confirm pass**.
- [ ] **Step 5: Commit** — `feat: navigable /connections modal (Task B.1)`.

### Task B.2: Embedded TUI live provider switch

**Files:**
- Modify: `crates/prricode-tui/src/lib.rs` (add `UiCommand::SwitchProvider { connection }`, rebuild provider Arc, store in `agent_provider`)
- Modify: `crates/prricode-tui/src/app.rs` (`/provider <connection>` sends the command; `/connections` Enter sends it)
- Test: `crates/prricode-tui/src/app.rs`

**Interfaces:**
- Consumes: `prricode_provider::resolve_connection`, `create_provider`, `CapabilityGatedProvider`.
- Produces: `agent_provider: Arc<dyn ModelProvider>` mutable in the agent task; `TurnInput.provider_override` set from it.

- [ ] **Step 1: Write failing tests** — SwitchProvider command rebuilds the provider and the next turn uses it.
- [ ] **Step 2: Run tests to confirm failure**.
- [ ] **Step 3: Implement** — agent task holds `agent_provider` (Arc), SwitchProvider rebuilds from config, Submit uses `Some(agent_provider.implementation())`.
- [ ] **Step 4: Run tests to confirm pass**.
- [ ] **Step 5: Commit** — `feat: embedded TUI live provider switch (Task B.2)`.

## Phase C — Roadmap completion

### Task C.1: Wayland input execution

**Files:**
- Modify: `crates/prricode-computer-use/src/lib.rs` (execute input via `wlrctl`/`ydotool` when probed)
- Test: `crates/prricode-computer-use/src/lib.rs` (unit tests for command construction; live probe skipped on non-Wayland hosts)

**Interfaces:**
- Consumes: existing probe code.
- Produces: `input_execute(action) -> Result<(), String>` honest error on unsupported compositor.

- [ ] **Step 1: Write failing tests** — command construction for click/type/key/scroll; unsupported compositor returns honest error.
- [ ] **Step 2: Run tests to confirm failure**.
- [ ] **Step 3: Implement** — spawn `wlrctl`/`ydotool` via the sandbox; parse exit status; return honest error on failure.
- [ ] **Step 4: Run tests to confirm pass**.
- [ ] **Step 5: Commit** — `feat: Wayland input execution (Task C.1)`.

### Task C.2: macOS computer-use backend

**Files:**
- Modify: `crates/prricode-computer-use/src/lib.rs` (macOS capture via `screencapture`, input via `cliclick`/Accessibility, gated by `cfg(target_os = "macos")`)
- Test: `crates/prricode-computer-use/src/lib.rs`

**Interfaces:**
- Produces: `unavailable_reason()` returns `None` on macOS when tools are present.

- [ ] **Step 1: Write failing tests** — macOS probe detects `screencapture`/`cliclick`; capture command construction.
- [ ] **Step 2: Run tests to confirm failure**.
- [ ] **Step 3: Implement** — gated by cfg; honest degrade when tools missing.
- [ ] **Step 4: Run tests to confirm pass** (Linux tests skip the macOS path).
- [ ] **Step 5: Commit** — `feat: macOS computer-use backend (Task C.2)`.

### Task C.3: Bundled speech model manager + streaming ASR

**Files:**
- Modify: `crates/prricode-voice/src/lib.rs` (model manager trait + download/check)
- Modify: `crates/prricode-cli/src/main.rs` (voice subcommand: `--download-model`, `--list-models`)
- Test: `crates/prricode-voice/src/lib.rs`

**Interfaces:**
- Produces: `ModelManager::ensure(model) -> Result<PathBuf, VoiceError>`, `VoiceError::ModelMissing`.

- [ ] **Step 1: Write failing tests** — model presence check, download URL construction, honest missing-model error.
- [ ] **Step 2: Run tests to confirm failure**.
- [ ] **Step 3: Implement** — download to `~/.local/share/prricode/models/`, verify checksum, set env for local engines.
- [ ] **Step 4: Run tests to confirm pass** (network tests marked `#[ignore]`).
- [ ] **Step 5: Commit** — `feat: bundled speech model manager (Task C.3)`.

### Task C.4: vLLM / llama.cpp / LM Studio presets

**Files:**
- Modify: `crates/prricode-provider/src/config.rs` (add kind ids: `vllm`, `llamacpp`, `lmstudio` — or document that `custom` covers them)
- Modify: `docs/how-to/connect-a-provider.md` (preset table + example)

**Interfaces:**
- Consumes: existing custom provider path.

- [ ] **Step 1: Decide** — either add first-class kind ids (with preset base URLs) or document `custom` as the path. Record the decision in the run log.
- [ ] **Step 2: Implement** the chosen approach with tests.
- [ ] **Step 3: Commit** — `feat: local OpenAI-compatible presets (Task C.4)`.

### Task C.5: Houston/Snazzy palette verification

**Files:**
- Modify: `crates/prricode-tui/src/theme.rs` (verify palette values against upstream)
- Test: `crates/prricode-tui/src/theme.rs` (contrast assertions)

- [ ] **Step 1: Verify** palette values against the upstream Houston/Snazzy specs; record findings.
- [ ] **Step 2: Fix** any mismatches; add contrast assertions.
- [ ] **Step 3: Commit** — `fix: Houston/Snazzy palette verification (Task C.5)`.

## Phase D — Launch validation

### Task D.1: Read W1 checkpoint

**Files:**
- Modify: `docs/explanation/launch-status.md` (append actuals)

- [ ] **Step 1: Read** the GitHub traffic/reimplementations/stars/issues surfaces.
- [ ] **Step 2: Append** actuals to the W1 row; note misses vs targets.
- [ ] **Step 3: Commit** — `docs: W1 checkpoint actuals (Task D.1)`.

### Task D.2: Cut v0.3.0

**Files:**
- Modify: `Cargo.toml` (workspace version bump), `CHANGELOG` (if present)

- [ ] **Step 1: Bump** version to 0.3.0 across the workspace.
- [ ] **Step 2: Tag** `v0.3.0` and push; verify the release workflow publishes 5 targets + SHA256SUMS.
- [ ] **Step 3: Commit + tag** — `chore: release v0.3.0 (Task D.2)`.

### Task D.3: Read M1 checkpoint

**Files:**
- Modify: `docs/explanation/launch-status.md`

- [ ] **Step 1: Read** the surfaces at the M1 date.
- [ ] **Step 2: Append** actuals; record misses.
- [ ] **Step 3: Commit** — `docs: M1 checkpoint actuals (Task D.3)`.

## Resumption marker

If work stops, the next agent should:
1. Read this plan and `docs/plans/phase-status.md`.
2. Find the first task with an unchecked `[ ]` step.
3. Run `cargo test --workspace` to confirm green before editing.
4. Resume from that step; commit after each task with the task ID in the message.
5. Update the task's checkboxes to `[x]` as steps complete.
