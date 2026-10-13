//! Agent runtime: the turn loop, tool registry, and approval engine.
//!
//! The loop drives a model through tool calls until it produces a final
//! answer, persisting every item and recording usage along the way.

mod approval;
mod loop_runner;
mod prompts;
mod tools;

pub use approval::{ApprovalDecision, ApprovalEngine, ApprovalOutcome};
pub use loop_runner::{
    AgentRunner, GoalContext, TurnHandle, TurnInput, TurnOutcome, TurnTicket, GOAL_COMPLETE_TOOL,
};
pub use prompts::build_system_prompt;
pub use prricode_mcp::McpRegistry;
pub use tools::{
    ComputerTool, EditFileTool, GlobTool, GrepTool, ListDirTool, McpTool, ReadFileTool, Risk,
    ShellTool, TaskTool, ToolContext, ToolRegistry, ToolRegistryBuilder, WebFetchTool,
    WriteFileTool,
};

use prricode_provider::ContentPart;

/// Events the agent emits for the transport layer to serialize as
/// JSON-RPC notifications.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    TurnStarted {
        turn_id: String,
        session_id: String,
    },
    Item {
        session_id: String,
        item: serde_json::Value,
    },
    ApprovalRequested {
        approval_id: String,
        session_id: String,
        requirement_id: String,
        kind: String,
        summary: serde_json::Value,
    },
    ApprovalResolved {
        approval_id: String,
        session_id: String,
        approved: bool,
    },
    TurnCompleted {
        turn_id: String,
        session_id: String,
        content: String,
        input_tokens: u32,
        output_tokens: u32,
    },
    TurnFailed {
        turn_id: String,
        session_id: String,
        error: String,
    },
    Log {
        session_id: String,
        level: String,
        message: String,
    },
    SessionListChanged,
    GoalUpdated {
        session_id: String,
        objective: String,
        status: String,
        percent_complete: u32,
    },
    GoalCleared {
        session_id: String,
    },
    SessionRenamed {
        session_id: String,
        name: String,
    },
    SessionCompact {
        session_id: String,
        compacted: bool,
    },
    TaskUpdated {
        session_id: String,
        task_id: String,
        status: String,
    },
    ModelCatalogChanged {
        models: Vec<serde_json::Value>,
    },
    UsageUpdated {
        session_id: Option<String>,
        input_tokens: u64,
        output_tokens: u64,
        total_cost: f64,
    },
    MediaUploadProgress {
        session_id: String,
        upload_id: String,
        bytes_received: u64,
        total_bytes: u64,
        complete: bool,
    },
    ComputerUseStateChanged {
        session_id: String,
        state: String,
    },
    WorkflowStateChanged {
        session_id: String,
        workflow_run_id: String,
        status: String,
    },
    ApprovalExpired {
        approval_id: String,
        session_id: String,
    },
    SubagentUpdated {
        session_id: String,
        subagent_id: String,
        status: String,
    },
    ToolCallStarted {
        session_id: String,
        turn_id: String,
        tool_call_id: String,
        name: String,
    },
    ToolCallCompleted {
        session_id: String,
        turn_id: String,
        tool_call_id: String,
        name: String,
    },
    SessionForked {
        session_id: String,
        forked_session_id: String,
    },
    SessionModelChanged {
        session_id: String,
        model_id: String,
    },
    SessionApprovalModeChanged {
        session_id: String,
        mode: String,
    },
    ItemOutputReady {
        session_id: String,
        item_id: String,
    },
    TurnSteered {
        session_id: String,
        turn_id: String,
    },
    TurnUnqueued {
        session_id: String,
        turn_id: String,
    },
    AccountLoginStateChanged {
        authenticated: bool,
    },
    SettingsChanged {
        settings: serde_json::Value,
    },
    PermissionProfileChanged {
        session_id: String,
        profile: String,
    },
    SkillActivationChanged {
        session_id: String,
        skill: String,
        activation: String,
    },
    ScheduledFired {
        prompt_id: String,
    },
    PeerAdmissionRequested {
        peer_id: String,
    },
    RuntimeStateChanged {
        state: String,
    },
    WorkflowChildUpdated {
        session_id: String,
        workflow_run_id: String,
        child: serde_json::Value,
    },
    McpServerStateChanged {
        session_id: String,
        server: String,
        state: String,
    },
    HookExecuted {
        session_id: String,
        hook: String,
    },
    PluginChanged {
        plugin: String,
        action: String,
    },
}

pub fn text_of(parts: &[ContentPart]) -> String {
    parts
        .iter()
        .filter_map(|p| match p {
            ContentPart::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("")
}
