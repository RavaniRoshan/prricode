use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::sync::Weak;
use tokio::sync::OnceCell;

pub struct CoordinatorTool {
    runner: OnceCell<Weak<crate::AgentRunner>>,
}

impl CoordinatorTool {
    pub fn new() -> Self {
        Self {
            runner: OnceCell::new(),
        }
    }
    pub fn set_runner(&self, runner: Weak<crate::AgentRunner>) {
        let _ = self.runner.set(runner);
    }
}

impl Default for CoordinatorTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for CoordinatorTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "coordinator".to_string(),
            description: "Run multiple sub-tasks in parallel and aggregate results.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "items": {"type":"object","properties":{"prompt":{"type":"string"},"description":{"type":"string"}},"required":["prompt"]}
                    }
                },
                "required": ["tasks"]
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Safe
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let runner = self
            .runner
            .get()
            .ok_or_else(|| super::ToolError::Execution("coordinator runner not wired".into()))?
            .upgrade()
            .ok_or_else(|| super::ToolError::Execution("coordinator runner dropped".into()))?;
        let tasks = input
            .get("tasks")
            .and_then(|v| v.as_array())
            .ok_or_else(|| super::ToolError::InvalidInput("missing tasks".into()))?;
        let mut handles = Vec::new();
        let workspace_root = ctx.workspace_root.implementation();
        let data_dir = ctx.data_dir.implementation();
        for t in tasks {
            let prompt = t
                .get("prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let runner = runner.implementation();
            let workspace_root = workspace_root.implementation();
            let data_dir = data_dir.implementation();
            handles.push(tokio::spawn(async move {
                let outcome = runner
                    .run_subagent(crate::TurnInput {
                        session_id: format!("coord-{}", uuid::Uuid::now_v7()),
                        model: String::new(),
                        approval_mode: prricode_core::ApprovalMode::Auto,
                        workspace_root: workspace_root.implementation(),
                        data_dir: data_dir.implementation(),
                        history: vec![],
                        user_content: vec![prricode_provider::ContentPart::text(prompt.implementation())],
                        goal: None,
                        skills_prompt: None,
                        allowed_tools: Vec::new(),
                        max_iterations: 15,
                        turn_id: uuid::Uuid::now_v7().to_string(),
                    })
                    .await;
                (prompt, outcome)
            }));
        }
        let mut out = String::new();
        for h in handles {
            if let Ok((prompt, Ok(outcome))) = h.await {
                out.push_str(&format!("## {prompt}\n{}\n\n", outcome.content));
            } else {
                out.push_str("## (failed)\n\n");
            }
        }
        Ok(ToolOutput::text(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn coordinator_requires_tasks() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let tool = CoordinatorTool::new();
        let out = tool.execute(&ctx, &serde_json::json!({})).await;
        assert!(out.is_err());
    }
}
