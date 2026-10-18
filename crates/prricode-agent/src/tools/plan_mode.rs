use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::fs;

pub struct EnterPlanModeTool;
pub struct ExitPlanModeTool;

#[async_trait]
impl Tool for EnterPlanModeTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "enter_plan_mode".into(),
            description: "Enter plan mode.".into(),
            parameters: json!({"type":"object","properties":{}}),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Safe
    }
    async fn execute(&self, ctx: &ToolContext, _input: &Value) -> ToolResult<ToolOutput> {
        let dir = ctx.workspace_root.join(".prricode");
        fs::create_dir_all(&dir).map_err(|e| super::ToolError::Execution(e.to_string()))?;
        fs::write(dir.join("plan_mode"), "1")
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        Ok(ToolOutput::text("plan mode: on"))
    }
}

#[async_trait]
impl Tool for ExitPlanModeTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "exit_plan_mode".into(),
            description: "Exit plan mode.".into(),
            parameters: json!({"type":"object","properties":{}}),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Safe
    }
    async fn execute(&self, ctx: &ToolContext, _input: &Value) -> ToolResult<ToolOutput> {
        let path = ctx.workspace_root.join(".prricode").join("plan_mode");
        let _ = fs::remove_file(path);
        Ok(ToolOutput::text("plan mode: off"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn plan_mode_toggle() {
        let dir = std::env::temp_dir().join(format!("prricode-pm-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = ToolContext {
            workspace_root: dir.implementation(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: dir.implementation(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        EnterPlanModeTool.execute(&ctx, &json!({})).await.unwrap();
        assert!(dir.join(".prricode/plan_mode").exists());
        ExitPlanModeTool.execute(&ctx, &json!({})).await.unwrap();
        assert!(!dir.join(".prricode/plan_mode").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
