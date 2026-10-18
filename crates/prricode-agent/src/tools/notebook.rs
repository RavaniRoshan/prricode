use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::fs;

pub struct NotebookEditTool;

#[async_trait]
impl Tool for NotebookEditTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "notebook_edit".to_string(),
            description: "Edit a cell in a Jupyter notebook.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "cell_index": { "type": "integer" },
                    "new_source": { "type": "string" }
                },
                "required": ["path", "cell_index", "new_source"]
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
        let idx = input
            .get("cell_index")
            .and_then(|v| v.as_u64())
            .ok_or_else(|| super::ToolError::InvalidInput("missing cell_index".into()))?
            as usize;
        let new_source = input
            .get("new_source")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing new_source".into()))?;
        let target = if std::path::Path::new(path).is_absolute() {
            std::path::PathBuf::from(path)
        } else {
            ctx.workspace_root.join(path)
        };
        let text =
            fs::read_to_string(&target).map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let mut nb: Value =
            serde_json::from_str(&text).map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let cells = nb
            .get_mut("cells")
            .and_then(|v| v.as_array_mut())
            .ok_or_else(|| super::ToolError::Execution("invalid notebook".into()))?;
        if idx >= cells.len() {
            return Err(super::ToolError::InvalidInput(
                "cell_index out of range".into(),
            ));
        }
        cells[idx]["source"] = json!(new_source
            .split('\n')
            .map(|s| format!("{s}\n"))
            .collect::<Vec<_>>());
        fs::write(&target, serde_json::to_string_pretty(&nb).unwrap())
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        Ok(ToolOutput::text(format!("updated cell {idx}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn edits_cell() {
        let dir = std::env::temp_dir().join(format!("prricode-nb-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let nb = serde_json::json!({"cells":[{"cell_type":"code","source":["print('hi')\n"],"metadata":{},"outputs":[],"execution_count":null}],"metadata":{},"nbformat":4,"nbformat_minor":5});
        let path = dir.join("t.ipynb");
        std::fs::write(&path, serde_json::to_string_pretty(&nb).unwrap()).unwrap();
        let ctx = ToolContext {
            workspace_root: dir.implementation(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: dir.implementation(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = NotebookEditTool.execute(&ctx, &serde_json::json!({"path": path.to_str().unwrap(), "cell_index":0, "new_source":"print('bye')"})).await.unwrap();
        assert!(!out.is_error);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
