//! Tool abstraction: every capability the model can invoke is a tool with a
//! JSON schema, a risk class, and an async executor.

use super::approval::ApprovalEngine;
use async_trait::async_trait;
use prricode_provider::{ContentPart, ToolDef};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

mod computer;
mod files;
mod grep;
mod mcp;
mod shell;
mod task;
mod web_fetch;
mod workflow;

pub use computer::ComputerTool;
pub use files::{EditFileTool, GlobTool, ListDirTool, ReadFileTool, WriteFileTool};
pub use grep::GrepTool;
pub use mcp::McpTool;
pub use shell::ShellTool;
pub use task::TaskTool;
pub use web_fetch::WebFetchTool;
pub use workflow::{SharedEngine, WorkflowTool};

/// How sensitive a tool call is, used by the approval engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Risk {
    /// Read-only or trivially reversible: never needs approval.
    Safe,
    /// Changes the system (shell, file writes, computer control, MCP):
    /// asks according to the session's approval mode.
    Sensitive,
}

#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("execution failed: {0}")]
    Execution(String),
    #[error("approval denied")]
    Denied,
}

pub type ToolResult<T> = Result<T, ToolError>;

#[derive(Debug, Clone)]
pub struct ToolOutput {
    pub content: Vec<ContentPart>,
    pub is_error: bool,
}

impl ToolOutput {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentPart::text(text)],
            is_error: false,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentPart::text(text)],
            is_error: true,
        }
    }
}

#[async_trait]
pub trait Tool: Send + Sync {
    fn def(&self) -> ToolDef;
    fn risk(&self) -> Risk;
    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput>;
}

/// Shared services available to every tool execution.
pub struct ToolContext {
    pub workspace_root: PathBuf,
    pub approvals: Arc<ApprovalEngine>,
    pub data_dir: PathBuf,
    pub session_id: String,
    /// Extra hooks installed later (computer use, MCP, skills).
    pub extensions: HashMap<String, Arc<dyn Tool>>,
}

pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn Tool>>,
}

impl ToolRegistry {
    pub fn defs(&self) -> Vec<ToolDef> {
        let mut defs: Vec<ToolDef> = self.tools.values().map(|t| t.def()).collect();
        defs.sort_by(|a, b| a.name.cmp(&b.name));
        defs
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn Tool>> {
        self.tools.get(name).cloned()
    }

    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.keys().cloned().collect();
        names.sort();
        names
    }

    /// Register an already-shared tool (used for late-bound extensions).
    pub fn register_dyn(&mut self, name: &str, tool: Arc<dyn Tool>) {
        self.tools.insert(name.to_string(), tool);
    }

    /// Register an already-shared tool under its own schema name.
    pub fn register_dyn_owned(&mut self, tool: Arc<dyn Tool>) {
        let name = tool.def().name;
        self.tools.insert(name, tool);
    }

    pub async fn execute(
        &self,
        ctx: &ToolContext,
        name: &str,
        input: &Value,
    ) -> ToolResult<ToolOutput> {
        let tool = self
            .tools
            .get(name)
            .cloned()
            .ok_or_else(|| ToolError::InvalidInput(format!("unknown tool: {name}")))?;
        tool.execute(ctx, input).await
    }
}

pub struct ToolRegistryBuilder {
    tools: Vec<Arc<dyn Tool>>,
}

impl ToolRegistryBuilder {
    pub fn new() -> Self {
        Self { tools: Vec::new() }
    }

    pub fn with_tool(mut self, tool: impl Tool + 'static) -> Self {
        self.tools.push(Arc::new(tool));
        self
    }

    pub fn build(self) -> ToolRegistry {
        let mut map = HashMap::new();
        for tool in self.tools {
            map.insert(tool.def().name, tool);
        }
        ToolRegistry { tools: map }
    }

    pub fn with_dyn(mut self, tool: Arc<dyn Tool>) -> Self {
        self.tools.push(tool);
        self
    }
}

impl Default for ToolRegistryBuilder {
    fn default() -> Self {
        Self::new()
    }
}
