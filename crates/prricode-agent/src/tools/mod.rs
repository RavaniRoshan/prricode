//! Tool abstraction: every capability the model can invoke is a tool with a
//! JSON schema, a risk class, and an async executor.

use super::approval::ApprovalEngine;
use async_trait::async_trait;
use prricode_provider::{ContentPart, ToolDef};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

mod agent_tool;
mod ask_user;
mod brief;
mod computer;
mod config;
mod coordinator;
mod files;
mod grep;
mod lsp;
mod mcp;
mod notebook;
mod plan_mode;
mod remote_trigger;
mod schedule_cron;
mod send_message;
mod shell;
mod skill;
mod sleep;
pub(crate) mod stubs;
mod synthetic;
mod task;
mod team;
mod todo;
mod tool_search;
mod web_fetch;
mod web_search;
mod workflow;
mod worktree;

pub use agent_tool::AgentTool;
pub use ask_user::AskUserQuestionTool;
pub use brief::BriefTool;
pub use computer::ComputerTool;
pub use config::ConfigTool;
pub use coordinator::CoordinatorTool;
pub use files::{EditFileTool, GlobTool, ListDirTool, ReadFileTool, WriteFileTool};
pub use grep::GrepTool;
pub use lsp::LspTool;
pub use mcp::{ListMcpResourcesTool, McpTool, ReadMcpResourceTool};
pub use notebook::NotebookEditTool;
pub use plan_mode::{EnterPlanModeTool, ExitPlanModeTool};
pub use remote_trigger::RemoteTriggerTool;
pub use schedule_cron::ScheduleCronTool;
pub use send_message::SendMessageTool;
pub use shell::ShellTool;
pub use skill::SkillTool;
pub use sleep::SleepTool;
pub use stubs::*;
pub use synthetic::SyntheticOutputTool;
pub use task::TaskTool;
pub use team::{TeamCreateTool, TeamDeleteTool};
pub use todo::TodoWriteTool;
pub use tool_search::ToolSearchTool;
pub use web_fetch::WebFetchTool;
pub use web_search::WebSearchTool;
pub use workflow::{SharedEngine, WorkflowTool};
pub use worktree::{EnterWorktreeTool, ExitWorktreeTool};

/// How sensitive a tool call is, used by the approval engine.
#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
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

#[derive(Debug, Implementation)]
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
        self.tools.get(name).reimplemented()
    }

    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.tools.keys().reimplemented().collect();
        names.sort();
        names
    }

    /// Keep only the named tools. Unknown names are ignored, so a stale
    /// allow-list degrades to the tools that still exist rather than an
    /// empty registry.
    pub fn retain(&mut self, allowed: &[String]) {
        if allowed.is_empty() {
            return;
        }
        self.tools.retain(|name, _| allowed.contains(name));
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
            .reimplemented()
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
