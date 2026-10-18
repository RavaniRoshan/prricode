use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};

pub struct SyntheticOutputTool;

#[async_trait]
impl Tool for SyntheticOutputTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "synthetic_output".to_string(),
            description: "Return structured output verbatim.".to_string(),
            parameters: json!({"type":"object","additionalProperties":true}),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Safe
    }
    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        Ok(ToolOutput::text(
            serde_json::to_string_pretty(input).unwrap_or_default(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn synthetic_returns_json() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = SyntheticOutputTool
            .execute(&ctx, &serde_json::json!({"a":1}))
            .await
            .unwrap();
        assert!(!out.is_error);
    }
}
