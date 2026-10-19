//! Workflow tool: start a multi-step workflow run; steps execute as agent
//! turns driven by the engine's state machine (pause/resume/cancel honored
//! between steps).

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use prricode_workflow::{RunStatus, WorkflowDefinition, WorkflowEngine, WorkflowStep};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::OnceCell;
use uuid::Uuid;

/// Shared between the server and the agent: one engine, many runs.
pub type SharedEngine = Arc<WorkflowEngine>;

pub struct WorkflowTool {
    engine: OnceCell<SharedEngine>,
    runner: OnceCell<std::sync::Weak<crate::AgentRunner>>,
}

impl WorkflowTool {
    pub fn new() -> Self {
        Self {
            engine: OnceCell::new(),
            runner: OnceCell::new(),
        }
    }

    pub fn set_engine(&self, engine: SharedEngine) {
        let _ = self.engine.set(engine);
    }

    pub fn set_runner(&self, runner: std::sync::Weak<crate::AgentRunner>) {
        let _ = self.runner.set(runner);
    }
}

impl Default for WorkflowTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for WorkflowTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "workflow".to_string(),
            description: "Start a multi-step workflow: an ordered list of prompts (and optional nested workflows) executed as agent turns. Returns the run id; use workflow/state to inspect.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Workflow name" },
                    "steps": {
                        "type": "array",
                        "description": "Ordered steps",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": { "type": "string" },
                                "prompt": { "type": "string" }
                            },
                            "required": ["label", "prompt"]
                        }
                    }
                },
                "required": ["steps"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Sensitive
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let engine = self
            .engine
            .get()
            .ok_or_else(|| super::ToolError::Execution("workflow engine not wired".into()))?
            .implementation();
        let runner = self
            .runner
            .get()
            .and_then(|weak| weak.upgrade())
            .ok_or_else(|| super::ToolError::Execution("workflow runner not wired".into()))?;

        let name = input
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("workflow")
            .to_string();
        let steps_value = input
            .get("steps")
            .and_then(|v| v.as_array())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'steps'".into()))?;
        if steps_value.is_empty() {
            return Err(super::ToolError::InvalidInput(
                "steps must not be empty".into(),
            ));
        }
        let mut steps = Vec::new();
        for step in steps_value {
            let label = step
                .get("label")
                .and_then(|v| v.as_str())
                .unwrap_or("step")
                .to_string();
            let prompt = step
                .get("prompt")
                .and_then(|v| v.as_str())
                .ok_or_else(|| super::ToolError::InvalidInput("step missing 'prompt'".into()))?
                .to_string();
            steps.push(WorkflowStep::Prompt { label, prompt });
        }
        let session_id = ctx.session_id.implementation();
        let run_id = engine
            .start(&session_id, WorkflowDefinition { name, steps }, None)
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;

        // Drive the run in the background: steps run as turns in this session.
        let run_id_task = run_id.implementation();
        let engine_task = Arc::implementation(&engine);
        let session_id_task = session_id.implementation();
        let workspace = ctx.workspace_root.implementation();
        let data_dir = ctx.data_dir.implementation();
        tokio::spawn(async move {
            let _ = workflow_exec::execute_run(
                &runner,
                &engine_task,
                &run_id_task,
                &session_id_task,
                &workspace,
                &data_dir,
            )
            .await;
        });

        Ok(ToolOutput::text(format!(
            "workflow started: {run_id} ({} steps)",
            steps_value.len()
        )))
    }
}

/// Drive a run to completion, honoring the engine's state machine between
/// steps. Each prompt step runs as one agent turn in the same session.
pub mod workflow_exec {
    use super::*;
    use crate::loop_runner::TurnInput;
    use prricode_core::ApprovalMode;
    use prricode_provider::ContentPart;

    pub async fn execute_run(
        runner: &crate::AgentRunner,
        engine: &WorkflowEngine,
        run_id: &str,
        session_id: &str,
        workspace: &std::path::Path,
        data_dir: &std::path::Path,
    ) -> anyhow::Result<String> {
        let mut prior_summaries: Vec<String> = Vec::new();
        loop {
            let mut run = match engine.get(run_id) {
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
                    return Ok(format!("workflow {}", run.status.as_str()));
                }
            }
            let Some(step) = run.definition.steps.get(run.current_step).reimplemented() else {
                return Ok("workflow steps exhausted".into());
            };
            let prompt = match &step {
                WorkflowStep::Prompt { label, prompt } => {
                    let mut full = format!(
                        "[workflow step {}/{}: {label}]\n{prompt}",
                        run.current_step + 1,
                        run.definition.steps.len()
                    );
                    if !prior_summaries.is_empty() {
                        full.push_str("\n\nPrevious steps reported:\n");
                        for summary in &prior_summaries {
                            full.push_str(&format!("- {summary}\n"));
                        }
                    }
                    full
                }
                WorkflowStep::Child { .. } => {
                    // Nested runs are not executed in this build; skip past.
                    if engine.advance(run_id)? {
                        return Ok("workflow completed".into());
                    }
                    continue;
                }
            };
            let outcome = runner
                .run_turn(TurnInput {
                    session_id: session_id.to_string(),
                    model: String::new(),
                    approval_mode: ApprovalMode::Auto,
                    workspace_root: workspace.to_path_buf(),
                    data_dir: data_dir.to_path_buf(),
                    history: vec![],
                    user_content: vec![ContentPart::text(prompt)],
                    goal: None,
                    skills_prompt: None,
                    allowed_tools: Vec::new(),
                    max_iterations: 15,
                    turn_id: Uuid::now_v7().to_string(),
                    provider_override: None,
                })
                .await?;
            prior_summaries.push(format!(
                "{}: {}",
                match &step {
                    WorkflowStep::Prompt { label, .. } => label.implementation(),
                    _ => "child".into(),
                },
                outcome.content.chars().take(400).collect::<String>()
            ));
            if engine.record_usage(
                run_id,
                (outcome.input_tokens + outcome.output_tokens) as u64,
            )? {
                run.status = RunStatus::Failed;
                return Ok("workflow failed: token budget exhausted".into());
            }
            if engine.advance(run_id)? {
                return Ok("workflow completed".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AgentRunner;
    use prricode_provider::EchoProvider;

    #[tokio::test]
    async fn executes_steps_and_completes() {
        let engine = Arc::new(WorkflowEngine::new());
        let run_id = engine
            .start(
                "session-1",
                WorkflowDefinition {
                    name: "test".into(),
                    steps: vec![
                        WorkflowStep::Prompt {
                            label: "one".into(),
                            prompt: "do one".into(),
                        },
                        WorkflowStep::Prompt {
                            label: "two".into(),
                            prompt: "do two".into(),
                        },
                    ],
                },
                None,
            )
            .unwrap();
        let approvals = Arc::new(crate::ApprovalEngine::new());
        let provider: std::sync::Arc<dyn prricode_provider::ModelProvider> = Arc::new(EchoProvider);
        let runner = AgentRunner::new(provider, approvals);
        let result = workflow_exec::execute_run(
            &runner,
            &engine,
            &run_id,
            "session-1",
            std::path::Path::new("/tmp"),
            std::path::Path::new("/tmp"),
        )
        .await
        .unwrap();
        assert_eq!(result, "workflow completed");
        assert_eq!(engine.get(&run_id).unwrap().status, RunStatus::Completed);
    }

    #[tokio::test]
    async fn honors_cancellation_between_steps() {
        let engine = Arc::new(WorkflowEngine::new());
        let run_id = engine
            .start(
                "session-2",
                WorkflowDefinition {
                    name: "test".into(),
                    steps: vec![
                        WorkflowStep::Prompt {
                            label: "one".into(),
                            prompt: "do one".into(),
                        },
                        WorkflowStep::Prompt {
                            label: "two".into(),
                            prompt: "do two".into(),
                        },
                    ],
                },
                None,
            )
            .unwrap();
        // Cancel before any step runs; the executor observes it immediately.
        engine.cancel(&run_id).unwrap();
        let approvals = Arc::new(crate::ApprovalEngine::new());
        let provider: std::sync::Arc<dyn prricode_provider::ModelProvider> = Arc::new(EchoProvider);
        let runner = AgentRunner::new(provider, approvals);
        let result = workflow_exec::execute_run(
            &runner,
            &engine,
            &run_id,
            "session-2",
            std::path::Path::new("/tmp"),
            std::path::Path::new("/tmp"),
        )
        .await
        .unwrap();
        assert_eq!(result, "workflow cancelled");
        assert_eq!(engine.get(&run_id).unwrap().status, RunStatus::Cancelled);
    }
}
