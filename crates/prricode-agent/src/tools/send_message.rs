use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::fs;

pub struct SendMessageTool;

#[async_trait]
impl Tool for SendMessageTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "send_message".into(),
            description: "Queue a message to a peer/session.".into(),
            parameters: json!({"type":"object","properties":{"to":{"type":"string"},"message":{"type":"string"}},"required":["to","message"]}),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let to = input
            .get("to")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing to".into()))?;
        let message = input
            .get("message")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing message".into()))?;
        let dir = ctx.workspace_root.join(".prricode").join("messages");
        fs::create_dir_all(&dir).map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let path = dir.join(format!("{to}.jsonl"));
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        writeln!(f, "{}", json!({"to":to,"message":message}))
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        Ok(ToolOutput::text(format!("queued message to {to}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn send_message_requires_fields() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = SendMessageTool.execute(&ctx, &json!({})).await;
        assert!(out.is_err());
    }
}
