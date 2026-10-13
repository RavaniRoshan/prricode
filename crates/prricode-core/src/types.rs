use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub type CommandId = Uuid;
pub type SessionId = Uuid;
pub type TurnId = Uuid;
pub type ApprovalId = Uuid;
pub type SubagentId = Uuid;
pub type TaskId = Uuid;
pub type WorkflowRunId = Uuid;
pub type UploadId = Uuid;
pub type UserInputId = Uuid;

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct InitializeParams {
    pub client_info: ClientInfo,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ClientCapabilities>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ClientCapabilities {}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct InitializeResult {
    pub platform_family: String,
    pub platform_os: String,
    pub sandbox_availability: String,
    pub schema: SchemaInfo,
    pub server_info: ServerInfo,
    pub user_agent: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SchemaInfo {
    pub fingerprint: String,
    pub version: u32,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionStartParams {
    pub command_id: CommandId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<crate::ApprovalMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<SessionConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<crate::ProviderId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_roots: Option<Vec<String>>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<Vec<SessionMcpServerConfig>>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionMcpServerConfig {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionStartResult {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct TurnStartParams {
    pub command_id: CommandId,
    pub input: Vec<TurnInputPart>,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<crate::ReasoningEffort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_roots: Option<Vec<String>>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TurnInputPart {
    Text { text: String },
    Image { data: String, media_type: String },
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct TurnStartResult {
    pub turn_id: TurnId,
    pub command_id: CommandId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct GoalSetParams {
    pub command_id: CommandId,
    pub objective: String,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct GoalEditParams {
    pub command_id: CommandId,
    pub objective: String,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct GoalClearParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct GoalPauseParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct GoalResumeParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct GoalCommandResult {
    pub command_id: CommandId,
    pub status: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionReadParams {
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_items: Option<Vec<String>>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionReadResult {
    pub session_id: SessionId,
    pub items: Vec<SessionItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionItem {
    pub id: String,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<ContentPart>>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ContentPart {
    Text { text: String },
    ToolUse { name: String, input: serde_json::Value },
    ToolResult { content: Vec<ContentPart> },
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowCancelParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub workflow_run_id: WorkflowRunId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowPauseParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub workflow_run_id: WorkflowRunId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowResumeParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub workflow_run_id: WorkflowRunId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowControlResult {
    pub command_id: CommandId,
    pub status: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowResumeResult {
    pub command_id: CommandId,
    pub status: String,
    pub turn_id: TurnId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowChildControlParams {
    pub action: crate::WorkflowChildAction,
    pub attempt: u32,
    pub child_id: String,
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub workflow_run_id: WorkflowRunId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ComputerUseSetupState {
    pub accessibility: crate::ComputerUsePermission,
    pub input_monitoring: crate::ComputerUsePermission,
    pub screen_recording: crate::ComputerUsePermission,
    pub setup: crate::ComputerUseSetupPhase,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ComputerUseSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_apps: Option<Vec<ComputerUseBlockedApp>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computer_control: Option<crate::ComputerUseChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshots: Option<crate::ComputerUseChoice>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ComputerUseBlockedApp {
    pub bundle_id: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ComputerUseSetupStartParams {
    pub command_id: CommandId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ComputerUseSettingsUpdateParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block_apps: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub computer_control: Option<crate::ComputerUseChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screenshots: Option<crate::ComputerUseChoice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unblock_apps: Option<Vec<String>>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionUserShellParams {
    pub command_id: CommandId,
    pub command_text: String,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionUserShellResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ApprovalDecideParams {
    pub approval_id: ApprovalId,
    pub choice_id: String,
    pub command_id: CommandId,
    pub requirement_id: String,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ApprovalDecideResult {
    pub command_id: CommandId,
    pub status: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SubagentCloseParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub subagent_id: SubagentId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SubagentInputParams {
    pub body: String,
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub subagent_id: SubagentId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct CommandAcceptedResult {
    pub command_id: CommandId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct TaskBackgroundParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub task_id: TaskId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct TaskCommandResult {
    pub command_id: CommandId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ModelListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ModelCatalogEntry {
    pub model_id: String,
    pub provider_id: crate::ProviderId,
    pub profile_id: String,
    pub context_limit: u32,
    pub output_limit: u32,
    pub display_label: String,
    pub is_active: bool,
    pub is_default: bool,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowChild {
    pub attempt: u32,
    pub child_id: String,
    pub duration_ms: u64,
    pub label: String,
    pub phase: String,
    pub status: String,
    pub terminal: bool,
    pub usage: TokenUsage,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SkillInfo {
    pub name: String,
    pub source: crate::SkillSource,
    pub description: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SkillImportParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dry_run: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionCompactParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<TurnId>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionCompactResult {
    pub compacted: bool,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct UserInputAnswerParams {
    pub answers: Vec<String>,
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub user_input_id: UserInputId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct MediaUploadParams {
    pub chunk_base64: String,
    pub chunk_count: u32,
    pub chunk_index: u32,
    pub command_id: CommandId,
    pub media_type: String,
    pub session_id: SessionId,
    pub total_bytes: u64,
    pub upload_id: UploadId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct RecapRequestParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct RecapRequestResult {
    pub command_id: CommandId,
    pub status: String,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct UsageReadResult {
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cost: f64,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionSetModelParams {
    pub command_id: CommandId,
    pub model: ModelSelection,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ModelSelection {
    pub model_id: String,
    pub provider_id: crate::ProviderId,
    pub profile_id: String,
    pub display_label: String,
}
