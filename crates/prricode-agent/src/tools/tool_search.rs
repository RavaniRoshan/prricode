use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};

pub struct ToolSearchTool;

#[async_trait]
impl Tool for ToolSearchTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "tool_search".to_string(),
            description: "List available tools.".to_string(),
            parameters: json!({"type":"object","properties":{"query":{"type":"string"}}}),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Safe
    }
    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let query = input
            .get("query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let tools = [
            "shell",
            "read_file",
            "write_file",
            "edit_file",
            "list_dir",
            "glob",
            "grep",
            "web_fetch",
            "web_search",
            "computer",
            "task",
            "workflow",
            "todo_write",
            "sleep",
            "brief",
            "synthetic_output",
            "config",
            "enter_worktree",
            "exit_worktree",
            "notebook_edit",
            "remote_trigger",
            "tool_search",
        ];
        let matches: Vec<&str> = tools
            .iter()
            .filter(|t| query.is_empty() || t.contains(&query))
            .copied()
            .collect();
        Ok(ToolOutput::text(matches.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn tool_search_lists() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = ToolSearchTool
            .execute(&ctx, &json!({"query":"file"}))
            .await
            .unwrap();
        assert!(!out.is_error);
    }
}
