//! Task tool: spawn a subagent that works a self-contained prompt with its
//! own fresh context and returns its final answer.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::sync::Weak;
use tokio::sync::OnceCell;

pub struct TaskTool {
    runner: OnceCell<Weak<crate::AgentRunner>>,
}

impl TaskTool {
    pub fn new() -> Self {
        Self {
            runner: OnceCell::new(),
        }
    }

    /// Wire the shared runner in after it is constructed (avoids the
    /// registry → runner → registry cycle).
    pub fn set_runner(&self, runner: Weak<crate::AgentRunner>) {
        let _ = self.runner.set(runner);
    }
}

impl Default for TaskTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for TaskTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "task".to_string(),
            description: "Delegate a self-contained sub-task to a subagent with its own context. Returns the subagent's final answer.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "prompt": { "type": "string", "description": "Complete, self-contained instructions for the subagent" },
                    "description": { "type": "string", "description": "Short label for the sub-task" }
                },
                "required": ["prompt"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let prompt = input
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'prompt'".into()))?;
        let runner = self
            .runner
            .get()
            .ok_or_else(|| super::ToolError::Execution("task runner not wired".into()))?
            .upgrade()
            .ok_or_else(|| super::ToolError::Execution("task runner dropped".into()))?;
        let session_id = format!("sub-{}", uuid::Uuid::now_v7());
        let outcome = runner
            .run_subagent(crate::TurnInput {
                session_id,
                model: String::new(),
                approval_mode: prricode_core::ApprovalMode::Auto,
                workspace_root: ctx.workspace_root.clone(),
                data_dir: ctx.data_dir.clone(),
                history: vec![],
                user_content: vec![prricode_provider::ContentPart::text(prompt)],
                goal: None,
                skills_prompt: None,
                max_iterations: 15,
                turn_id: uuid::Uuid::now_v7().to_string(),
            })
            .await
            .map_err(|e| super::ToolError::Execution(format!("subagent failed: {e}")))?;
        if outcome.content.trim().is_empty() {
            Ok(ToolOutput::text("(subagent produced no output)"))
        } else {
            Ok(ToolOutput::text(outcome.content))
        }
    }
}
