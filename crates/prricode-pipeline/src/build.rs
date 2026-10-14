//! The Build stage: task graph waves execute as concurrent agent turns,
//! gated by the workflow engine's state machine (pause/cancel honored
//! between steps, per PRD stage 5).

use futures_util::future::join_all;
use prricode_agent::{AgentRunner, TurnInput};
use prricode_core::ApprovalMode;
use prricode_provider::ContentPart;
use prricode_spec::TaskGraph;
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
/// the token budget is checked per task.
pub async fn run_build(
    runner: &AgentRunner,
    engine: &WorkflowEngine,
    run_id: &str,
    session_id: &str,
    workspace: &Path,
    data_dir: &Path,
) -> anyhow::Result<String> {
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
                // Nested runs are not executed in this build; skip past.
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
                approval_mode: ApprovalMode::Auto,
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
            prior_summaries.push(format!(
                "{}: {}",
                match step {
                    WorkflowStep::Prompt { label, .. } => label.clone(),
                    _ => "child".into(),
                },
                outcome.content.chars().take(400).collect::<String>()
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

#[cfg(test)]
mod tests {
    use super::*;

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
