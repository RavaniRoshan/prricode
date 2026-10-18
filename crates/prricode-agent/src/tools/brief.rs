use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};

pub struct BriefTool;

#[async_trait]
impl Tool for BriefTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "brief".to_string(),
            description: "Send a brief message to the user.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "message": { "type": "string" }
                },
                "required": ["message"]
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Safe
    }
    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let msg = input.get("message").and_then(|v| v.as_str()).unwrap_or("");
        Ok(ToolOutput::text(msg))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn brief_returns_message() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = BriefTool
            .execute(&ctx, &serde_json::json!({"message":"hi"}))
            .await
            .unwrap();
        assert!(!out.is_error);
    }
}
