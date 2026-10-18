use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};

pub struct WebSearchTool;

#[async_trait]
impl Tool for WebSearchTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "web_search".to_string(),
            description: "Search the web (best-effort).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" }
                },
                "required": ["query"]
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Safe
    }
    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let query = input
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing query".into()))?;
        let url = format!("https://duckduckgo.com/html/?q={}", query.replace(" ", "+"));
        let resp = reqwest::get(&url)
            .await
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let text = resp
            .text()
            .await
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        // Strip tags crudely.
        let mut out = String::new();
        for line in text.lines() {
            let t = line.trim();
            if t.contains("result__a") || t.contains("result__snippet") {
                out.push_str(t);
                out.push('\n');
            }
        }
        if out.is_empty() {
            out = "no results parsed".to_string();
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
    async fn web_search_requires_query() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = WebSearchTool.execute(&ctx, &json!({})).await;
        assert!(out.is_err());
    }
}
