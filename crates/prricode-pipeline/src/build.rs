//! The Build stage: task graph waves execute as concurrent agent turns,
//! gated by the workflow engine's state machine (pause/cancel honored
//! between steps, per PRD stage 5).

use futures_util::future::join_all;
use prricode_agent::{AgentRunner, TurnInput};
use prricode_core::ApprovalMode;
use prricode_persistence::{GateRecordRow, Persistence};
use prricode_provider::ContentPart;
use prricode_spec::TaskGraph;
use prricode_verify::{gates, GateRecord};
use prricode_workflow::{RunStatus, WorkflowDefinition, WorkflowEngine, WorkflowStep};
use std::path::Path;
use uuid::Uuid;

/// The "[wave N]" prefix a step label carries; consecutive steps sharing one
/// prefix are one wave.
fn wave_prefix(label: &str) -> &str {
    label.split(']').next().unwrap_or(label)
}

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
    WorkflowDefinition {
        name: "build".into(),
        steps,
    }
}

/// Drive a build run wave by wave: tasks within a wave run as concurrent
/// subagent turns; the engine's state machine is honored between waves and
/// the token budget is checked per task. A cheap gate pass runs after each
/// successful step: gate failures are carried forward in the step summary
/// and persisted records, but the build does not roll back.
pub async fn run_build(
    runner: &AgentRunner,
    engine: &WorkflowEngine,
    run_id: &str,
    session_id: &str,
    workspace: &Path,
    data_dir: &Path,
) -> anyhow::Result<String> {
    // The per-task gate plan is fixed for the workspace: detect the stack
    // once, then run the plan after every successful step.
    let gate_plan = gates::GatePlan::for_stack(gates::StackKind::detect(workspace));
    let persistence = Persistence::new(data_dir)?;
    let mut prior_summaries: Vec<String> = Vec::new();
    loop {
        let run = match engine.get(run_id) {
            Ok(run) => run,
            Err(_) => return Ok(String::new()),
        };
        match run.status {
            RunStatus::Running => {}
            RunStatus::Paused => {
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                continue;
            }
            RunStatus::Cancelled | RunStatus::Completed | RunStatus::Failed => {
                return Ok(format!("build {}", run.status.as_str()));
            }
        }
        let total_steps = run.definition.steps.len();
        let prefix = match run.definition.steps.get(run.current_step) {
            Some(WorkflowStep::Prompt { label, .. }) => wave_prefix(label).to_string(),
            Some(WorkflowStep::Child { .. }) => {
                // Nested workflow children are not executed in this version;
                // skip past.
                if engine.advance(run_id)? {
                    return Ok("build completed".into());
                }
                continue;
            }
            None => return Ok("build steps exhausted".into()),
        };
        let mut wave: Vec<(usize, WorkflowStep)> = Vec::new();
        while let Some(step) = run.definition.steps.get(run.current_step + wave.len()) {
            match step {
                WorkflowStep::Prompt { label, .. } if wave_prefix(label) == prefix.as_str() => {
                    wave.push((run.current_step + wave.len(), step.clone()));
                }
                _ => break,
            }
        }
        let mut pending = Vec::new();
        for (index, step) in &wave {
            let WorkflowStep::Prompt { label, prompt } = step else {
                continue;
            };
            let mut full = format!(
                "[build step {}/{}: {label}]\n{prompt}",
                index + 1,
                total_steps
            );
            if !prior_summaries.is_empty() {
                full.push_str("\n\nPrevious steps reported:\n");
                for summary in &prior_summaries {
                    full.push_str(&format!("- {summary}\n"));
                }
            }
            pending.push(runner.run_subagent(TurnInput {
                session_id: session_id.to_string(),
                model: String::new(),
                // The build runs open: the plan gate is the human consent
                // point for these edits, the turns work in a disposable
                // worktree, and the per-task gates are what judge the result.
                // With `Auto` every write/shell call is Sensitive and would
                // wait out the approval timeout before being denied, so an
                // autonomous build could never finish a wave.
                approval_mode: ApprovalMode::Open,
                workspace_root: workspace.to_path_buf(),
                data_dir: data_dir.to_path_buf(),
                history: vec![],
                user_content: vec![ContentPart::text(full)],
                goal: None,
                skills_prompt: None,
                max_iterations: 15,
                turn_id: Uuid::now_v7().to_string(),
            }));
        }
        let outcomes = join_all(pending).await;
        for (outcome, (_, step)) in outcomes.into_iter().zip(wave.iter()) {
            let outcome = outcome?;
            let label = match step {
                WorkflowStep::Prompt { label, .. } => label.clone(),
                _ => "child".into(),
            };
            // The per-task cheap gates: real records, persisted under the
            // run, and a failure marks this step's output without rolling
            // the build back.
            let gate_records = gates::run_gates(run_id, workspace, &gate_plan).await;
            persist_gate_records(&persistence, &gate_records)?;
            prior_summaries.push(format!(
                "{label}: {}\n{}",
                outcome.content.chars().take(400).collect::<String>(),
                gate_note(&gate_records)
            ));
            if engine.record_usage(
                run_id,
                (outcome.input_tokens + outcome.output_tokens) as u64,
            )? {
                return Ok("build failed: token budget exhausted".into());
            }
            if engine.advance(run_id)? {
                return Ok("build completed".into());
            }
        }
    }
}

/// Persist one gate pass's records under the run.
fn persist_gate_records(persistence: &Persistence, records: &[GateRecord]) -> anyhow::Result<()> {
    for record in records {
        persistence.save_gate_record(&GateRecordRow::from(record))?;
    }
    Ok(())
}

/// The step-summary line a gate pass adds: a pass counts its gates, a
/// failure names them.
fn gate_note(records: &[GateRecord]) -> String {
    if records.is_empty() {
        return String::new();
    }
    let failed: Vec<&str> = records
        .iter()
        .filter(|record| !record.passed)
        .map(|record| record.gate.as_str())
        .collect();
    if failed.is_empty() {
        format!("gates: {} passed", records.len())
    } else {
        format!("gates FAILED: {}", failed.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prricode_agent::ApprovalEngine;
    use prricode_provider::{
        AssistantMessage, ChatRequest, ChatResponse, ContentPart, ModelProvider, ProviderKind,
        ProviderResult, StreamEvent, Usage,
    };
    use std::sync::Arc;
    use tokio::sync::mpsc;

    struct ScriptedBuilder;

    #[async_trait::async_trait]
    impl ModelProvider for ScriptedBuilder {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Echo
        }

        async fn list_models(&self) -> ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }

        async fn chat(&self, _request: &ChatRequest) -> ProviderResult<ChatResponse> {
            Ok(ChatResponse {
                message: AssistantMessage {
                    content_parts: vec![ContentPart::text("task done")],
                    tool_calls: vec![],
                },
                usage: Usage::default(),
                finish_reason: "stop".into(),
                cost_usd: None,
            })
        }

        async fn chat_stream(
            &self,
            request: &ChatRequest,
            events: mpsc::UnboundedSender<StreamEvent>,
        ) -> ProviderResult<ChatResponse> {
            let response = self.chat(request).await?;
            let text = response.message.text();
            if !text.is_empty() {
                let _ = events.send(StreamEvent::TextDelta(text));
            }
            let _ = events.send(StreamEvent::Done);
            Ok(response)
        }
    }

    fn one_step_definition() -> WorkflowDefinition {
        WorkflowDefinition {
            name: "build".into(),
            steps: vec![WorkflowStep::Prompt {
                label: "[wave 1] scaffold".into(),
                prompt: "scaffold the app".into(),
            }],
        }
    }

    #[tokio::test]
    async fn build_runs_a_gate_pass_after_each_step() {
        // A real temp Rust workspace: the per-task cheap gates run for real
        // after the step succeeds, and their records persist under the run.
        let workspace = std::env::temp_dir().join(format!("build-gates-{}", std::process::id()));
        std::fs::create_dir_all(workspace.join("src")).unwrap();
        std::fs::write(
            workspace.join("Cargo.toml"),
            "[package]\nname=\"fx\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
        )
        .unwrap();
        std::fs::write(workspace.join("src/main.rs"), "fn main() {}\n").unwrap();
        let data_dir =
            std::env::temp_dir().join(format!("build-gates-data-{}", std::process::id()));
        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptedBuilder);
        let runner = AgentRunner::new(provider, Arc::new(ApprovalEngine::new()));
        let engine = WorkflowEngine::new();
        let run_id = engine
            .start("session-1", one_step_definition(), None)
            .unwrap();

        let summary = run_build(
            &runner,
            &engine,
            &run_id,
            "session-1",
            &workspace,
            &data_dir,
        )
        .await
        .unwrap();

        assert_eq!(summary, "build completed");
        let persistence = Persistence::new(&data_dir).unwrap();
        let records = persistence.list_gate_records(&run_id).unwrap();
        assert_eq!(records.len(), 2, "the rust plan runs build and test gates");
        assert!(
            records.iter().all(|r| r.passed),
            "a clean workspace passes its per-task gates"
        );
        std::fs::remove_dir_all(&workspace).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn graph_becomes_wave_ordered_definition() {
        let graph = prricode_spec::TaskGraph {
            nodes: vec![
                prricode_spec::TaskNode {
                    id: "a".into(),
                    label: "A".into(),
                    prompt: "pa".into(),
                    depends_on: vec![],
                    requirement_id: None,
                },
                prricode_spec::TaskNode {
                    id: "b".into(),
                    label: "B".into(),
                    prompt: "pb".into(),
                    depends_on: vec!["a".into()],
                    requirement_id: Some("R1".into()),
                },
            ],
        };
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
}

#[cfg(test)]
mod live {
    use super::*;
    use prricode_agent::ApprovalEngine;
    use std::sync::Arc;

    /// Live-provider check for the build stage, ignored by default because it
    /// burns real quota. Run it with a key in the environment:
    ///
    /// ```text
    /// OPENROUTER_API_KEY=sk-or-... MODEL=nvidia/nemotron-3-super-120b-a12b:free \
    ///   cargo test -p prricode-pipeline live_build_wave_writes_files -- --ignored --nocapture
    /// ```
    ///
    /// It drives the same `run_build` the TUI drives, against a real model, and
    /// asserts the turn really produces files in the workspace and that the
    /// per-task gates run. `sk-test`-style keys and a missing `MODEL` skip it.
    #[tokio::test]
    #[ignore = "live provider: needs OPENROUTER_API_KEY and MODEL"]
    async fn live_build_wave_writes_files() {
        let key = match std::env::var("OPENROUTER_API_KEY") {
            Ok(key) if !key.is_empty() && !key.contains("test") => key,
            _ => {
                eprintln!("skip: OPENROUTER_API_KEY not set");
                return;
            }
        };
        let model = match std::env::var("MODEL") {
            Ok(model) if !model.is_empty() => model,
            _ => {
                eprintln!("skip: MODEL not set");
                return;
            }
        };

        let workspace = std::env::temp_dir().join(format!("live-build-{}", std::process::id()));
        let data_dir = std::env::temp_dir().join(format!("live-build-data-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&data_dir);
        std::fs::create_dir_all(&workspace).unwrap();
        // A seed Python project so the per-task gate plan has a stack to detect
        // and something to run; the live turn adds greeting.py next to it.
        std::fs::write(
            workspace.join("pyproject.toml"),
            "[project]\nname = \"live-greeting\"\nversion = \"0.1.0\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(workspace.join("tests")).unwrap();
        std::fs::write(
            workspace.join("tests/test_greeting.py"),
            "def test_seed_passes():\n    assert True\n",
        )
        .unwrap();

        let env: std::collections::HashMap<String, String> = std::env::vars().collect();
        let config = prricode_provider::resolve_settings(
            prricode_provider::ProviderKind::OpenRouter,
            None,
            &std::collections::HashMap::from([("api_key".to_string(), key)]),
            &env,
        );
        let provider: Arc<dyn prricode_provider::ModelProvider> =
            Arc::from(prricode_provider::create_provider(config));
        let runner = AgentRunner::new(provider, Arc::new(ApprovalEngine::new()))
            .with_default_model(model.clone());
        let engine = WorkflowEngine::new();
        let run_id = engine
            .start(
                "live-session",
                WorkflowDefinition {
                    name: "build".into(),
                    steps: vec![WorkflowStep::Prompt {
                        label: "[wave 1] scaffold".into(),
                        prompt: format!(
                        "Create a file greeting.py in the current directory whose contents are \
                         exactly `print('hello from a live build')`, then run it with python3 \
                         and report the output. Use the write_file and shell tools. Model: {model}."
                    ),
                    }],
                },
                None,
            )
            .unwrap();

        let summary = run_build(
            &runner,
            &engine,
            &run_id,
            "live-session",
            &workspace,
            &data_dir,
        )
        .await
        .expect("the build wave runs");
        eprintln!("build summary: {summary}");
        assert_eq!(summary, "build completed");

        let produced = std::fs::read_dir(&workspace)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        eprintln!("workspace now holds: {produced:?}");
        assert!(
        produced.iter().any(|name| name.ends_with(".py")),
        "the live build turn must have written a .py file into the workspace, found {produced:?}"
    );

        let persistence = Persistence::new(&data_dir).unwrap();
        let records = persistence.list_gate_records(&run_id).unwrap();
        eprintln!("gate records: {}", records.len());
        assert!(
            !records.is_empty(),
            "the per-task gates run over the built workspace"
        );

        // Then the verify pass over what was just built: the same stage the TUI
        // runs after a successful build, ending in the acceptance dossier.
        let requirements = prricode_spec::Requirements {
            items: vec![prricode_spec::Requirement {
                id: "R1".into(),
                ears: "WHEN the build runs THE SYSTEM SHALL create greeting.py".into(),
                acceptance: vec!["greeting.py exists".into()],
            }],
        };
        let verifier = crate::verify::evidence_only_verifier(&runner);
        let report = crate::verify::run_verify_stage(
            &verifier,
            &engine,
            &run_id,
            "live-session",
            &workspace,
            &data_dir,
            &serde_json::to_string(&requirements).unwrap(),
        )
        .await
        .expect("the verify pass runs over the live build");
        eprintln!(
            "verify: {} gates ({} passed), {} verdicts",
            report.gates.len(),
            report.gates.iter().filter(|g| g.passed).count(),
            report.requirements.len()
        );
        assert_eq!(
            report.requirements.len(),
            1,
            "the requirement gets a verdict"
        );
        let dossier = data_dir
            .join("runs")
            .join(&run_id)
            .join("acceptance-dossier.md");
        assert!(dossier.exists(), "the dossier renders into the run dir");
        eprintln!("dossier: {}", dossier.display());

        // What the run cost and what it delivered for it.
        let md = std::fs::read_to_string(&dossier).unwrap();
        assert!(
            md.contains("## Delivery economics"),
            "the dossier must report the run's economics"
        );
        let economics = prricode_verify::dossier::load_economics(&persistence, &run_id)
            .expect("the economics persist as their own row");
        eprintln!(
            "economics: {} tokens over {} tasks · {} ms of gates · {} verified of {} requirements",
            economics.build_tokens,
            economics.tasks_attempted,
            economics.gate_wall_ms,
            economics.requirements_verified,
            economics.requirements_total
        );
        assert!(
            economics.build_tokens > 0,
            "a live build spends tokens: {economics:?}"
        );
        assert!(
            economics.tokens_per_verified().is_some(),
            "the verified requirement gives a computable rate: {economics:?}"
        );

        std::fs::remove_dir_all(&workspace).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }
}
