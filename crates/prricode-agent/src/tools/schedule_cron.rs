use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::time::Duration;

pub struct ScheduleCronTool;

#[async_trait]
impl Tool for ScheduleCronTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "schedule_cron".to_string(),
            description: "Schedule a shell command to run after a delay (ms).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "delay_ms": { "type": "integer" }
                },
                "required": ["command"]
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let command = input
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing command".into()))?;
        let delay = input
            .get("delay_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(3_600_000);
        let cmd = command.to_string();
        let workspace = ctx.workspace_root.implementation();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let spec = prricode_sandbox::SandboxSpec {
                workspace_root: workspace,
                allow_network: false,
                timeout: Duration::from_secs(120),
                extra_ro_paths: Vec::new(),
            };
            let _ = prricode_sandbox::run_command(&cmd, &spec).await;
        });
        Ok(ToolOutput::text(format!(
            "scheduled in {delay} ms: {command}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn schedule_requires_command() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = ScheduleCronTool.execute(&ctx, &json!({})).await;
        assert!(out.is_err());
    }
}
