use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};

pub struct AskUserQuestionTool;

#[async_trait]
impl Tool for AskUserQuestionTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "ask_user_question".to_string(),
            description: "Ask the user a yes/no question via the approval prompt.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "question": { "type": "string" }
                },
                "required": ["question"]
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let question = input
            .get("question")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing question".into()))?;
        let outcome = ctx
            .approvals
            .authorize(
                &ctx.session_id,
                &uuid::Uuid::now_v7().to_string(),
                "ask_user_question",
                json!({"question": question}),
                Risk::Sensitive,
                prricode_core::ApprovalMode::Closed,
            )
            .await;
        if outcome.approved {
            Ok(ToolOutput::text("yes"))
        } else {
            Ok(ToolOutput::text("no"))
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
    async fn ask_user_requires_question() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(
                ApprovalEngine::new().with_timeout(std::time::Duration::from_millis(10)),
            ),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = AskUserQuestionTool.execute(&ctx, &json!({})).await;
        assert!(out.is_err());
    }
}
