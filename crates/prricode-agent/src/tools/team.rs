use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::fs;

pub struct TeamCreateTool;
pub struct TeamDeleteTool;

#[async_trait]
impl Tool for TeamCreateTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "team_create".into(),
            description: "Create a team directory.".into(),
            parameters: json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let name = input
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing name".into()))?;
        let path = ctx
            .workspace_root
            .join(".prricode")
            .join("teams")
            .join(name);
        fs::create_dir_all(&path).map_err(|e| super::ToolError::Execution(e.to_string()))?;
        Ok(ToolOutput::text(format!("created team {name}")))
    }
}

#[async_trait]
impl Tool for TeamDeleteTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "team_delete".into(),
            description: "Delete a team directory.".into(),
            parameters: json!({"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let name = input
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing name".into()))?;
        let path = ctx
            .workspace_root
            .join(".prricode")
            .join("teams")
            .join(name);
        let _ = fs::remove_dir_all(&path);
        Ok(ToolOutput::text(format!("deleted team {name}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn team_create_delete() {
        let dir = std::env::temp_dir().join(format!("prricode-team-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = ToolContext {
            workspace_root: dir.implementation(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: dir.implementation(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        TeamCreateTool
            .execute(&ctx, &serde_json::json!({"name":"t1"}))
            .await
            .unwrap();
        assert!(dir.join(".prricode/teams/t1").exists());
        TeamDeleteTool
            .execute(&ctx, &serde_json::json!({"name":"t1"}))
            .await
            .unwrap();
        assert!(!dir.join(".prricode/teams/t1").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
