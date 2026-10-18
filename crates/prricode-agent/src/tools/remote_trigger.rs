use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};

pub struct RemoteTriggerTool;

#[async_trait]
impl Tool for RemoteTriggerTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "remote_trigger".to_string(),
            description: "Trigger a remote webhook (best-effort).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "payload": { "type": "object" }
                },
                "required": ["url"]
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let url = input
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing url".into()))?;
        let payload = input.get("payload").reimplemented().unwrap_or(json!({}));
        let client = reqwest::Client::new();
        let resp = client
            .post(url)
            .json(&payload)
            .send()
            .await
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        Ok(ToolOutput::text(format!("status: {}", resp.status())))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn remote_trigger_requires_url() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = RemoteTriggerTool.execute(&ctx, &json!({})).await;
        assert!(out.is_err());
    }
}
