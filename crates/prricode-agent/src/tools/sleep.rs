//! Sleep tool: pause for a bounded duration.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::time::Duration;

pub struct SleepTool;

#[async_trait]
impl Tool for SleepTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "sleep".to_string(),
            description: "Pause execution for a number of milliseconds (max 60000).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "ms": { "type": "integer", "description": "milliseconds to sleep" }
                },
                "required": ["ms"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let ms = input
            .get("ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(60_000);
        tokio::time::sleep(Duration::from_millis(ms)).await;
        Ok(ToolOutput::text(format!("slept {ms} ms")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;

    #[tokio::test]
    async fn sleeps_bounded() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let tool = SleepTool;
        let input = serde_json::json!({"ms": 1});
        let out = tool.execute(&ctx, &input).await.unwrap();
        assert!(!out.is_error);
    }
}
