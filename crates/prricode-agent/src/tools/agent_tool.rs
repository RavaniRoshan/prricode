use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::sync::Weak;
use tokio::sync::OnceCell;

pub struct AgentTool {
    runner: OnceCell<Weak<crate::AgentRunner>>,
}

impl AgentTool {
    pub fn new() -> Self {
        Self {
            runner: OnceCell::new(),
        }
    }
    pub fn set_runner(&self, runner: Weak<crate::AgentRunner>) {
        let _ = self.runner.set(runner);
    }
}

impl Default for AgentTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for AgentTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "agent".into(),
            description: "Delegate a sub-task to a subagent.".into(),
            parameters: json!({"type":"object","properties":{"prompt":{"type":"string"}},"required":["prompt"]}),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Safe
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let prompt = input
            .get("prompt")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing prompt".into()))?;
        let runner = self
            .runner
            .get()
            .ok_or_else(|| super::ToolError::Execution("agent runner not wired".into()))?
            .upgrade()
            .ok_or_else(|| super::ToolError::Execution("agent runner dropped".into()))?;
        let outcome = runner
            .run_subagent(crate::TurnInput {
                session_id: format!("agent-{}", uuid::Uuid::now_v7()),
                model: String::new(),
                approval_mode: prricode_core::ApprovalMode::Auto,
                workspace_root: ctx.workspace_root.implementation(),
                data_dir: ctx.data_dir.implementation(),
                history: vec![],
                user_content: vec![prricode_provider::ContentPart::text(prompt)],
                goal: None,
                skills_prompt: None,
                allowed_tools: Vec::new(),
                max_iterations: 15,
                turn_id: uuid::Uuid::now_v7().to_string(),
            })
            .await
            .map_err(|e| super::ToolError::Execution(format!("subagent failed: {e}")))?;
        if outcome.content.trim().is_empty() {
            Ok(ToolOutput::text("(no output)"))
        } else {
            Ok(ToolOutput::text(outcome.content))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn agent_requires_prompt() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let tool = AgentTool::new();
        let out = tool.execute(&ctx, &serde_json::json!({})).await;
        assert!(out.is_err());
    }
}
