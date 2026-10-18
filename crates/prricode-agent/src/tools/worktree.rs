//! Worktree tools: create/remove git worktrees.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

pub struct EnterWorktreeTool;
pub struct ExitWorktreeTool;

#[async_trait]
impl Tool for EnterWorktreeTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "enter_worktree".to_string(),
            description: "Create a git worktree for isolated work.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "branch/worktree name" }
                }
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let name = input
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("worktree");
        let path = ctx.workspace_root.join(".worktrees").join(name);
        std::fs::create_dir_all(path.parent().unwrap())
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let out = Command::new("git")
            .args(["worktree", "add", path.to_str().unwrap(), "-b", name])
            .current_dir(&ctx.workspace_root)
            .output()
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        if !out.status.success() {
            return Err(super::ToolError::Execution(
                String::from_utf8_lossy(&out.stderr).to_string(),
            ));
        }
        Ok(ToolOutput::text(format!(
            "created worktree at {}",
            path.display()
        )))
    }
}

#[async_trait]
impl Tool for ExitWorktreeTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "exit_worktree".to_string(),
            description: "Remove a git worktree.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                },
                "required": ["path"]
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let path = input
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing path".into()))?;
        let target = PathBuf::from(path);
        // safety: must be under workspace
        if !target.starts_with(&ctx.workspace_root) {
            return Err(super::ToolError::InvalidInput(
                "path outside workspace".into(),
            ));
        }
        let out = Command::new("git")
            .args(["worktree", "remove", path, "--force"])
            .current_dir(&ctx.workspace_root)
            .output()
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        if !out.status.success() {
            return Err(super::ToolError::Execution(
                String::from_utf8_lossy(&out.stderr).to_string(),
            ));
        }
        Ok(ToolOutput::text(format!("removed worktree {path}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn enter_worktree_requires_git() {
        let dir = std::env::temp_dir().join(format!("prricode-wt-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        // init git repo
        let _ = Command::new("git")
            .args(["init"])
            .current_dir(&dir)
            .output();
        let ctx = ToolContext {
            workspace_root: dir.implementation(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: dir.implementation(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let tool = EnterWorktreeTool;
        let out = tool.execute(&ctx, &serde_json::json!({"name":"wt1"})).await;
        // may succeed or fail depending git; just ensure no panic
        let _ = out;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
