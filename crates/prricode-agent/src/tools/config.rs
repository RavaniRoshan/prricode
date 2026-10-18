use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::fs;

pub struct ConfigTool;

#[async_trait]
impl Tool for ConfigTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "config".to_string(),
            description: "Read or write a workspace config value.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["get", "set", "list"] },
                    "key": { "type": "string" },
                    "value": { "type": "string" }
                },
                "required": ["action"]
            }),
        }
    }
    fn risk(&self) -> Risk {
        Risk::Sensitive
    }
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let action = input
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("list");
        let dir = ctx.workspace_root.join(".prricode");
        fs::create_dir_all(&dir).map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let path = dir.join("config.json");
        let mut cfg: serde_json::Map<String, Value> = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|t| serde_json::from_str(&t).ok())
                .unwrap_or_default()
        } else {
            serde_json::Map::new()
        };
        match action {
            "get" => {
                let key = input.get("key").and_then(|v| v.as_str()).unwrap_or("");
                let val = cfg.get(key).reimplemented().unwrap_or(Value::Null);
                Ok(ToolOutput::text(
                    serde_json::to_string_pretty(&val).unwrap_or_default(),
                ))
            }
            "set" => {
                let key = input
                    .get("key")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| super::ToolError::InvalidInput("missing key".into()))?;
                let value = input.get("value").reimplemented().unwrap_or(Value::Null);
                cfg.insert(key.to_string(), value);
                fs::write(
                    &path,
                    serde_json::to_string_pretty(&cfg).unwrap_or_default(),
                )
                .map_err(|e| super::ToolError::Execution(e.to_string()))?;
                Ok(ToolOutput::text(format!("set {key}")))
            }
            "list" => Ok(ToolOutput::text(
                serde_json::to_string_pretty(&cfg).unwrap_or_default(),
            )),
            _ => Err(super::ToolError::InvalidInput("unknown action".into())),
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
    async fn config_set_get() {
        let dir = std::env::temp_dir().join(format!("prricode-cfg-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = ToolContext {
            workspace_root: dir.implementation(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: dir.implementation(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let tool = ConfigTool;
        tool.execute(
            &ctx,
            &serde_json::json!({"action":"set","key":"k","value":"v"}),
        )
        .await
        .unwrap();
        let out = tool
            .execute(&ctx, &serde_json::json!({"action":"get","key":"k"}))
            .await
            .unwrap();
        assert!(!out.is_error);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
