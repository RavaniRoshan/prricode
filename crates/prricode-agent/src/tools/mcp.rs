//! MCP tool: exposes tools from a connected MCP server to the agent loop.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_mcp::{McpRegistry, McpTool as McpServerTool};
use prricode_provider::ToolDef;
use serde_json::Value;
use std::sync::Arc;

pub struct McpTool {
    server: String,
    spec: McpServerTool,
    registry: Arc<McpRegistry>,
}

impl McpTool {
    pub fn new(server: String, spec: McpServerTool, registry: Arc<McpRegistry>) -> Self {
        Self {
            server,
            spec,
            registry,
        }
    }
}

#[async_trait]
impl Tool for McpTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: format!("mcp__{}__{}", self.server, self.spec.name),
            description: format!("[MCP {}] {}", self.server, self.spec.description),
            parameters: self.spec.input_schema.clone(),
        }
    }

    fn risk(&self) -> Risk {
        // MCP servers execute external code; always sensitive.
        Risk::Sensitive
    }

    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let client = self.registry.get(&self.server).ok_or_else(|| {
            super::ToolError::Execution(format!("MCP server '{}' disconnected", self.server))
        })?;
        let result = client
            .tools_call(&self.spec.name, input.clone())
            .await
            .map_err(|e| super::ToolError::Execution(e.to_string()))?;
        let text = mcp_result_text(&result);
        Ok(ToolOutput::text(text))
    }
}

/// Flatten an MCP tools/call result into tool-output text.
pub fn mcp_result_text(result: &Value) -> String {
    let mut out = String::new();
    if let Some(content) = result.get("content").and_then(|c| c.as_array()) {
        for part in content {
            match part.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                        out.push_str(text);
                        out.push('\n');
                    }
                }
                Some("image") => out.push_str("[image content omitted]\n"),
                Some("resource") => out.push_str("[resource content omitted]\n"),
                _ => {}
            }
        }
    }
    if result
        .get("isError")
        .and_then(|e| e.as_bool())
        .unwrap_or(false)
    {
        out.push_str("[MCP tool reported an error]");
    }
    if out.is_empty() {
        out = serde_json::to_string_pretty(result).unwrap_or_default();
    }
    out.trim_end().to_string()
}
