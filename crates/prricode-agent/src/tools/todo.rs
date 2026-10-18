//! Todo tool: maintain a per-workspace todo list.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::path::Path;

pub struct TodoWriteTool;

#[async_trait]
impl Tool for TodoWriteTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "todo_write".to_string(),
            description: "Write the workspace todo list. Each item needs content and status (pending, in_progress, completed).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": { "type": "string" },
                                "status": { "type": "string", "enum": ["pending", "in_progress", "completed"] }
                            },
                            "required": ["content", "status"]
                        }
                    }
                },
                "required": ["todos"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let todos = input
            .get("todos")
            .and_then(|v| v.as_array())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'todos' array".into()))?;
        // Validate.
        for t in todos {
            if t.get("content").and_then(|v| v.as_str()).is_none() {
                return Err(super::ToolError::InvalidInput(
                    "todo missing content".into(),
                ));
            }
            let status = t.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if !matches!(status, "pending" | "in_progress" | "completed") {
                return Err(super::ToolError::InvalidInput(format!(
                    "invalid todo status: {status}"
                )));
            }
        }
        let dir = ctx.workspace_root.join(".prricode");
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let path = dir.join("todos.json");
        let text = serde_json::to_string_pretty(todos)
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        tokio::fs::write(&path, text)
            .await
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let summary = todos
            .iter()
            .map(|t| {
                let content = t.get("content").and_then(|v| v.as_str()).unwrap_or("");
                let status = t.get("status").and_then(|v| v.as_str()).unwrap_or("");
                format!("[{status}] {content}")
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ToolOutput::text(format!(
            "wrote {} todo(s) to {}\n{}",
            todos.len(),
            path.display(),
            summary
        )))
    }
}

/// Read the current todo list from disk, if any.
#[allow(dead_code)]
pub async fn read_todos(workspace: &Path) -> Option<Value> {
    let path = workspace.join(".prricode").join("todos.json");
    let text = tokio::fs::read_to_string(&path).await.ok()?;
    serde_json::from_str(&text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;

    #[tokio::test]
    async fn writes_todos() {
        let dir = std::env::temp_dir().join(format!("prricode-todo-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = ToolContext {
            workspace_root: dir.implementation(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: dir.implementation(),
            session_id: "s1".into(),
            extensions: Default::default(),
        };
        let tool = TodoWriteTool;
        let input = serde_json::json!({"todos": [{"content":"a","status":"pending"}]});
        let out = tool.execute(&ctx, &input).await.unwrap();
        assert!(!out.is_error);
        let path = dir.join(".prricode").join("todos.json");
        assert!(path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
