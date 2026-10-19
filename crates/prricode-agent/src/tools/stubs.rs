use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};

macro_rules! stub_tool {
    ($name:ident, $tool_name:expr, $desc:expr, $risk:expr) => {
        pub struct $name;
        #[async_trait]
        impl Tool for $name {
            fn def(&self) -> ToolDef {
                ToolDef {
                    name: $tool_name.to_string(),
                    description: $desc.to_string(),
                    parameters: json!({"type":"object","properties":{}}),
                }
            }
            fn risk(&self) -> Risk { $risk }
            async fn execute(&self, _ctx: &ToolContext, _input: &Value) -> ToolResult<ToolOutput> {
                Ok(ToolOutput::error(format!("unsupported: {} is not implemented in this build", $tool_name)))
            }
        }
    };
}

stub_tool!(
    McpAuthTool,
    "mcp_auth",
    "MCP auth (unsupported in this build).",
    Risk::Sensitive
);
stub_tool!(
    ListMcpResourcesTool,
    "list_mcp_resources",
    "List MCP resources (unsupported in this build).",
    Risk::Safe
);
stub_tool!(
    ReadMcpResourceTool,
    "read_mcp_resource",
    "Read MCP resource (unsupported in this build).",
    Risk::Safe
);
stub_tool!(
    ReplTool,
    "repl",
    "REPL (unsupported in this build).",
    Risk::Sensitive
);
stub_tool!(
    AgentTool,
    "agent",
    "Spawn subagent (use task tool instead).",
    Risk::Sensitive
);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;

    #[tokio::test]
    async fn stubs_report_unsupported() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = McpAuthTool.execute(&ctx, &json!({})).await.unwrap();
        assert!(out.is_error);
        assert!(out.content.iter().any(|p| match p {
            prricode_provider::ContentPart::Text(t) => t.contains("unsupported"),
            _ => false,
        }));
    }
}

#[cfg(test)]
mod registry_tests {
    use crate::tools::{LspTool, ReplTool, ToolRegistryBuilder};

    #[test]
    fn allowed_tools_narrow_the_registry_and_tolerate_stale_names() {
        let mut registry = ToolRegistryBuilder::new()
            .with_tool(LspTool::default())
            .with_tool(ReplTool)
            .build();
        registry.retain(&["lsp".into(), "ghost".into()]);
        assert_eq!(registry.names(), vec!["lsp".to_string()]);
        // An empty list is a no-op, never an empty registry.
        registry.retain(&[]);
        assert_eq!(registry.names(), vec!["lsp".to_string()]);
    }
}
