//! JSON-RPC server over stdio: session lifecycle, turns, goals, approvals,
//! computer-use setup, tasks, skills, models, usage, media, and the
//! product-builder pipeline.

use anyhow::Result;
use prricode_agent::{
    AgentEvent, AgentRunner, ApprovalEngine, GoalContext, TurnHandle, TurnInput, TurnTicket,
};
use prricode_core::protocol::*;
use prricode_core::types::*;
use prricode_core::*;
use prricode_persistence::*;
use prricode_pipeline::clarify::Clarifier;
use prricode_pipeline::PipelineStage;
use prricode_spec::{Concept, Spec};
// Explicit imports shadow same-named types (ContentPart) from the core globs above.
use prricode_provider::{
    AssistantMessage, ChatMessage, ChatRequest, ContentPart, ModelProvider, ToolCall,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use uuid::Uuid;

const MAX_GOAL_CONTINUATIONS: usize = 100;

pub struct PrricodeServer {
    data_dir: PathBuf,
    persistence: Arc<Persistence>,
    provider: Arc<dyn ModelProvider>,
    runner: Arc<AgentRunner>,
    approvals: Arc<ApprovalEngine>,
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
    turns: Arc<Mutex<HashMap<String, TurnHandle>>>,
    goals: Arc<Mutex<HashMap<String, GoalRecord>>>,
    uploads: Arc<Mutex<HashMap<String, MediaUploadState>>>,
    workflows: Arc<prricode_workflow::WorkflowEngine>,
    events_tx: mpsc::UnboundedSender<AgentEvent>,
    default_model: Option<String>,
    default_provider_id: String,
}

#[derive(Debug, Clone)]
struct SessionState {
    id: String,
    workspace_root: Option<String>,
    model_id: Option<String>,
    provider_id: String,
    approval_mode: ApprovalMode,
}

#[derive(Debug, Default)]
struct MediaUploadState {
    media_type: String,
    total_bytes: u64,
    chunks_received: u32,
    chunk_count: u32,
    bytes: Vec<u8>,
}

/// Product-builder pipeline state, persisted per session as JSON in the
/// settings table under the `pipeline:<sessionId>` key.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
struct PipelineState {
    stage: String,
    #[serde(default)]
    concept: Option<Value>,
    #[serde(default)]
    spec: Option<Value>,
    #[serde(default)]
    waves: Vec<Vec<String>>,
    /// The current build's workflow run id, set once a build starts; the
    /// session's verification report resolves through it when present.
    #[serde(default)]
    run_id: Option<String>,
}

/// Convert agent events to JSON-RPC notifications on the wire.
pub fn notification_for(event: &AgentEvent) -> Option<(String, Value)> {
    match event {
        AgentEvent::TurnStarted {
            turn_id,
            session_id,
        } => Some((
            "turn/started".into(),
            json!({ "turnId": turn_id, "sessionId": session_id }),
        )),
        AgentEvent::Item { session_id, item } => Some((
            "turn/item".into(),
            json!({ "sessionId": session_id, "item": item }),
        )),
        AgentEvent::ApprovalRequested {
            approval_id,
            session_id,
            requirement_id,
            kind,
            summary,
        } => Some((
            "approval/requested".into(),
            json!({
                "approvalId": approval_id,
                "sessionId": session_id,
                "requirementId": requirement_id,
                "kind": kind,
                "summary": summary,
            }),
        )),
        AgentEvent::ApprovalResolved {
            approval_id,
            session_id,
            approved,
        } => Some((
            "approval/resolved".into(),
            json!({ "approvalId": approval_id, "sessionId": session_id, "approved": approved }),
        )),
        AgentEvent::TurnCompleted {
            turn_id,
            session_id,
            content,
            input_tokens,
            output_tokens,
        } => Some((
            "turn/completed".into(),
            json!({
                "turnId": turn_id,
                "sessionId": session_id,
                "content": content,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
            }),
        )),
        AgentEvent::TurnFailed {
            turn_id,
            session_id,
            error,
        } => Some((
            "turn/failed".into(),
            json!({ "turnId": turn_id, "sessionId": session_id, "error": error }),
        )),
        AgentEvent::Log {
            session_id,
            level,
            message,
        } => Some((
            "log".into(),
            json!({ "sessionId": session_id, "level": level, "message": message }),
        )),
        AgentEvent::SessionListChanged => Some(("session/listChanged".into(), json!({}))),
        AgentEvent::GoalUpdated {
            session_id,
            objective,
            status,
            percent_complete,
        } => Some((
            "goal/updated".into(),
            json!({
                "sessionId": session_id,
                "objective": objective,
                "status": status,
                "percentComplete": percent_complete,
            }),
        )),
        AgentEvent::GoalCleared { session_id } => {
            Some(("goal/cleared".into(), json!({ "sessionId": session_id })))
        }
        AgentEvent::SessionRenamed { session_id, name } => Some((
            "session/renamed".into(),
            json!({ "sessionId": session_id, "name": name }),
        )),
        AgentEvent::SessionCompact {
            session_id,
            compacted,
        } => Some((
            "session/compact".into(),
            json!({ "sessionId": session_id, "compacted": compacted }),
        )),
        AgentEvent::TaskUpdated {
            session_id,
            task_id,
            status,
        } => Some((
            "task/updated".into(),
            json!({ "sessionId": session_id, "taskId": task_id, "status": status }),
        )),
        AgentEvent::ModelCatalogChanged { models } => {
            Some(("model/catalogChanged".into(), json!({ "models": models })))
        }
        AgentEvent::UsageUpdated {
            session_id,
            input_tokens,
            output_tokens,
            total_cost,
        } => Some((
            "usage/updated".into(),
            json!({
                "sessionId": session_id,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalCost": total_cost,
            }),
        )),
        AgentEvent::MediaUploadProgress {
            session_id,
            upload_id,
            bytes_received,
            total_bytes,
            complete,
        } => Some((
            "media/uploadProgress".into(),
            json!({
                "sessionId": session_id,
                "uploadId": upload_id,
                "bytesReceived": bytes_received,
                "totalBytes": total_bytes,
                "complete": complete,
            }),
        )),
        AgentEvent::ComputerUseStateChanged { session_id, state } => Some((
            "computerUse/stateChanged".into(),
            json!({ "sessionId": session_id, "state": state }),
        )),
        AgentEvent::WorkflowStateChanged {
            session_id,
            workflow_run_id,
            status,
        } => Some((
            "workflow/stateChanged".into(),
            json!({ "sessionId": session_id, "workflowRunId": workflow_run_id, "status": status }),
        )),
        AgentEvent::ApprovalExpired {
            approval_id,
            session_id,
        } => Some((
            "approval/expired".into(),
            json!({ "approvalId": approval_id, "sessionId": session_id }),
        )),
        AgentEvent::SubagentUpdated {
            session_id,
            subagent_id,
            status,
        } => Some((
            "subagent/updated".into(),
            json!({ "sessionId": session_id, "subagentId": subagent_id, "status": status }),
        )),
        AgentEvent::ToolCallStarted {
            session_id,
            turn_id,
            tool_call_id,
            name,
        } => Some((
            "tool/callStarted".into(),
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "toolCallId": tool_call_id,
                "name": name,
            }),
        )),
        AgentEvent::ToolCallCompleted {
            session_id,
            turn_id,
            tool_call_id,
            name,
        } => Some((
            "tool/callCompleted".into(),
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "toolCallId": tool_call_id,
                "name": name,
            }),
        )),
        AgentEvent::SessionForked {
            session_id,
            forked_session_id,
        } => Some((
            "session/forked".into(),
            json!({ "sessionId": session_id, "forkedSessionId": forked_session_id }),
        )),
        AgentEvent::SessionModelChanged {
            session_id,
            model_id,
        } => Some((
            "session/modelChanged".into(),
            json!({ "sessionId": session_id, "modelId": model_id }),
        )),
        AgentEvent::SessionApprovalModeChanged { session_id, mode } => Some((
            "session/approvalModeChanged".into(),
            json!({ "sessionId": session_id, "mode": mode }),
        )),
        AgentEvent::ItemOutputReady {
            session_id,
            item_id,
        } => Some((
            "item/outputReady".into(),
            json!({ "sessionId": session_id, "itemId": item_id }),
        )),
        AgentEvent::TurnSteered {
            session_id,
            turn_id,
        } => Some((
            "turn/steered".into(),
            json!({ "sessionId": session_id, "turnId": turn_id }),
        )),
        AgentEvent::TurnUnqueued {
            session_id,
            turn_id,
        } => Some((
            "turn/unqueued".into(),
            json!({ "sessionId": session_id, "turnId": turn_id }),
        )),
        AgentEvent::AccountLoginStateChanged { authenticated } => Some((
            "account/loginStateChanged".into(),
            json!({ "authenticated": authenticated }),
        )),
        AgentEvent::SettingsChanged { settings } => {
            Some(("settings/changed".into(), json!({ "settings": settings })))
        }
        AgentEvent::PermissionProfileChanged {
            session_id,
            profile,
        } => Some((
            "permissionProfile/changed".into(),
            json!({ "sessionId": session_id, "profile": profile }),
        )),
        AgentEvent::SkillActivationChanged {
            session_id,
            skill,
            activation,
        } => Some((
            "skill/activationChanged".into(),
            json!({ "sessionId": session_id, "skill": skill, "activation": activation }),
        )),
        AgentEvent::ScheduledFired { prompt_id } => {
            Some(("scheduled/fired".into(), json!({ "promptId": prompt_id })))
        }
        AgentEvent::PeerAdmissionRequested { peer_id } => Some((
            "peer/admissionRequested".into(),
            json!({ "peerId": peer_id }),
        )),
        AgentEvent::RuntimeStateChanged { state } => {
            Some(("runtime/stateChanged".into(), json!({ "state": state })))
        }
        AgentEvent::WorkflowChildUpdated {
            session_id,
            workflow_run_id,
            child,
        } => Some((
            "workflow/childUpdated".into(),
            json!({ "sessionId": session_id, "workflowRunId": workflow_run_id, "child": child }),
        )),
        AgentEvent::McpServerStateChanged {
            session_id,
            server,
            state,
        } => Some((
            "mcp/serverStateChanged".into(),
            json!({ "sessionId": session_id, "server": server, "state": state }),
        )),
        AgentEvent::HookExecuted { session_id, hook } => Some((
            "hook/executed".into(),
            json!({ "sessionId": session_id, "hook": hook }),
        )),
        AgentEvent::PluginChanged { plugin, action } => Some((
            "plugin/changed".into(),
            json!({ "plugin": plugin, "action": action }),
        )),
    }
}

impl PrricodeServer {
    pub fn new(
        data_dir: PathBuf,
        provider: Box<dyn ModelProvider>,
        default_model: Option<String>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<AgentEvent>) {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let persistence = Arc::new(Persistence::new(&data_dir).expect("persistence init"));
        let approvals = Arc::new(ApprovalEngine::new().with_events(events_tx.clone()));
        let provider: Arc<dyn ModelProvider> = Arc::from(provider);
        let workflows = Arc::new(prricode_workflow::WorkflowEngine::new());
        // MCP: spawn configured stdio servers and expose their tools.
        let mcp_registry = Arc::new(prricode_mcp::McpRegistry::new());
        let runner = Arc::new(
            AgentRunner::new(Arc::clone(&provider), Arc::clone(&approvals))
                .with_events(events_tx.clone())
                .with_persistence(Arc::clone(&persistence))
                .with_workflows(Arc::clone(&workflows))
                .with_mcp(Arc::clone(&mcp_registry))
                .with_default_model(default_model.clone().unwrap_or_default()),
        );
        AgentRunner::init_self_weak(&runner);
        // MCP servers spawn in the background; their tools refresh into the
        // agent's tool cache once connected.
        let mcp_spawner = Arc::clone(&mcp_registry);
        let refresher = Arc::clone(&runner);
        tokio::spawn(async move {
            for server in mcp::load_mcp_servers() {
                match prricode_mcp::McpStdioClient::spawn(
                    &server.name,
                    &server.command,
                    &server.args,
                )
                .await
                {
                    Ok(client) => {
                        tracing::info!("mcp server '{}' connected", server.name);
                        mcp_spawner.insert(client);
                    }
                    Err(e) => tracing::warn!("mcp server '{}' failed: {e}", server.name),
                }
            }
            refresher.refresh_mcp_tools().await;
        });
        let default_provider_id = provider.kind().id().to_string();
        let server = Arc::new(Self {
            data_dir,
            persistence,
            provider,
            runner,
            approvals,
            sessions: Arc::new(Mutex::new(HashMap::new())),
            turns: Arc::new(Mutex::new(HashMap::new())),
            goals: Arc::new(Mutex::new(HashMap::new())),
            uploads: Arc::new(Mutex::new(HashMap::new())),
            workflows,
            events_tx,
            default_model,
            default_provider_id,
        });
        (server, events_rx)
    }

    pub async fn handle_request_from_value(self: &Arc<Self>, value: Value) -> JsonRpcResponse {
        let req = match serde_json::from_value::<JsonRpcRequest>(value) {
            Ok(r) => r,
            Err(e) => {
                return JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id: None,
                    result: None,
                    error: Some(JsonRpcError::parse_error(format!("invalid request: {e}"))),
                };
            }
        };
        self.handle_request(req).await
    }

    pub async fn handle_request(self: &Arc<Self>, req: JsonRpcRequest) -> JsonRpcResponse {
        let id = req.id.clone();
        match self.dispatch(&req.method, req.params).await {
            Ok(result) => JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id,
                result: Some(result),
                error: None,
            },
            Err(err) => {
                let error = if let Some(rpc_err) = err.downcast_ref::<RpcError>() {
                    rpc_err.0.clone()
                } else if let Some(json_err) = err.downcast_ref::<JsonRpcError>() {
                    json_err.clone()
                } else {
                    JsonRpcError::internal_error(err.to_string())
                };
                JsonRpcResponse {
                    jsonrpc: "2.0".into(),
                    id,
                    result: None,
                    error: Some(error),
                }
            }
        }
    }

    async fn dispatch(self: &Arc<Self>, method: &str, params: Option<Value>) -> Result<Value> {
        match method {
            "initialize" => self.handle_initialize(params).await,
            "accountLogin/start" => self.handle_account_login_start(params).await,
            "accountLogin/cancel" => self.handle_account_login_cancel(params).await,
            "auth/deviceLogin" => self.handle_device_login(params).await,
            "auth/supersedeLoginCredential" => self.handle_supersede_login_credential(params).await,
            "mcpServer/oauthLogin" => self.handle_mcp_server_oauth_login(params).await,
            "mcpServer/oauthLoginCancel" => self.handle_mcp_server_oauth_login_cancel(params).await,
            "subscription/activate" => self.handle_subscription_activate(params).await,
            "session/start" => self.handle_session_start(params).await,
            "session/read" => self.handle_session_read(params).await,
            "session/list" => self.handle_session_list().await,
            "session/resume" => self.handle_session_resume(params).await,
            "session/name" => self.handle_session_name(None).await,
            "turn/start" => self.handle_turn_start(params).await,
            "goal/set" => self.handle_goal_set(params).await,
            "goal/edit" => self.handle_goal_edit(params).await,
            "goal/clear" => self.handle_goal_clear(params).await,
            "goal/pause" => self.handle_goal_pause(params).await,
            "goal/resume" => self.handle_goal_resume(params).await,
            "workflow/cancel" => self.handle_workflow_cancel(params).await,
            "workflow/pause" => self.handle_workflow_pause(params).await,
            "workflow/resume" => self.handle_workflow_resume(params).await,
            "workflow/childControl" => self.handle_workflow_child_control(params).await,
            "workflow/control" => self.handle_workflow_control(None).await,
            "workflow/triggerConfiguration" => {
                self.handle_workflow_trigger_configuration(None).await
            }
            "computerUseSetup/check" => self.handle_computer_use_check().await,
            "computerUseSetup/read" => self.handle_computer_use_setup_read(params).await,
            "computerUseSetup/start" => self.handle_computer_use_start(params).await,
            "computerUseSettings/read" => self.handle_computer_use_settings_read().await,
            "computerUseSettings/update" => self.handle_computer_use_settings_update(params).await,
            "approval/decide" => self.handle_approval_decide(params).await,
            "approval/listPending" => self.handle_approval_list_pending(params).await,
            "subagent/close" => self.handle_subagent_close(params).await,
            "subagent/sendMessage" => self.handle_subagent_send_message(params).await,
            "subagent/target" => self.handle_subagent_target(params).await,
            "task/background" => self.handle_task_background(params).await,
            "task/stop" => self.handle_task_stop(params).await,
            "task/stopAll" => self.handle_task_stop_all(params).await,
            "task/list" => self.handle_task_list(params).await,
            "skill/list" => self.handle_skill_list(params).await,
            "skill/import" => self.handle_skill_import(params).await,
            "skill/setActivation" => self.handle_skill_set_activation(params).await,
            "permissionProfile/set" => self.handle_permission_profile_set(params).await,
            "settings/read" => self.handle_settings_read(params).await,
            "settings/writeValue" => self.handle_settings_write_value(params).await,
            "settings/writeMany" => self.handle_settings_write_many(params).await,
            "model/list" => self.handle_model_list(params).await,
            "usage/read" => self.handle_usage_read().await,
            "userInput/answer" => self.handle_user_input_answer(params).await,
            "media/upload" => self.handle_media_upload(params).await,
            "recap/request" => self.handle_recap_request(params).await,
            "recap/cancel" => self.handle_recap_cancel(params).await,
            "session/userShell" => self.handle_user_shell(params).await,
            "session/setModel" => self.handle_session_set_model(params).await,
            "session/setApprovalMode" => self.handle_session_set_approval_mode(params).await,
            "session/setReasoningEffort" => self.handle_session_set_reasoning_effort(params).await,
            "session/rename" => self.handle_session_rename(params).await,
            "session/sideChat" => self.handle_session_side_chat(params).await,
            "session/compact" => self.handle_session_compact(params).await,
            "session/fork" => self.handle_session_fork(params).await,
            "view/page" => self.handle_view_page(params).await,
            "view/subscribe" => self.handle_view_subscribe(params).await,
            "view/unsubscribe" => self.handle_view_unsubscribe(params).await,
            "view/unsubscribeBySessionId" => {
                self.handle_view_unsubscribe_by_session_id(params).await
            }
            "item/readOutput" => self.handle_item_read_output(params).await,
            "plugin/list" => self.handle_plugin_list(params).await,
            "plugin/install" => self.handle_plugin_install(params).await,
            "hook/list" => self.handle_hook_list(params).await,
            "feedback/submit" => self.handle_feedback_submit(params).await,
            "turn/cancel" => self.handle_turn_cancel(params).await,
            "turn/interrupt" => self.handle_turn_interrupt(params).await,
            "turn/steer" => self.handle_turn_steer(params).await,
            "turn/unqueue" => self.handle_turn_unqueue(params).await,
            "turn/submitOrigin" => self.handle_turn_submit_origin(None).await,
            "conversationRewind/evaluate" => self.handle_conversation_rewind_evaluate(params).await,
            "localSession/message" => self.handle_local_session_message(params).await,
            "scheduled/fire" => self.handle_scheduled_fire(None).await,
            "runtime/launch" => self.handle_runtime_launch(None).await,
            "process/background" => self.handle_process_background(None).await,
            "projection/read" => self.handle_projection_read(params).await,
            "log/subscribe" => self.handle_log_subscribe(params).await,
            "log/unsubscribe" => self.handle_log_unsubscribe(params).await,
            "log/page" => self.handle_log_page(params).await,
            "peer/admission" => self.handle_peer_admission(None).await,
            "tool/configuration" => self.handle_tool_configuration(None).await,
            "pipeline/conceptSet" => self.handle_pipeline_concept_set(params).await,
            "pipeline/specRead" => self.handle_pipeline_spec_read(params).await,
            "pipeline/planRead" => self.handle_pipeline_plan_read(params).await,
            "pipeline/verifyRead" => self.handle_pipeline_verify_read(params).await,
            "pipeline/shipRead" => self.handle_pipeline_ship_read(params).await,
            "pipeline/operateRead" => self.handle_pipeline_operate_read(params).await,
            _ => Err(JsonRpcError::method_not_found(format!("unknown method: {method}")).into()),
        }
    }

    // ---------- helpers ----------

    async fn session_state(&self, session_id: &str) -> Result<SessionState> {
        if let Some(state) = self.sessions.lock().unwrap().get(session_id) {
            return Ok(state.clone());
        }
        // Fall back to durable storage (resume path).
        let record = self
            .persistence
            .list_sessions()?
            .into_iter()
            .find(|s| s.id == session_id)
            .ok_or_else(JsonRpcError::session_not_found)?;
        let approval_mode = record
            .approval_mode
            .as_deref()
            .and_then(|m| serde_json::from_value::<ApprovalMode>(json!(m)).ok())
            .unwrap_or(ApprovalMode::Closed);
        let state = SessionState {
            id: record.id.clone(),
            workspace_root: record.workspace_root.clone(),
            model_id: record.model_id.clone(),
            provider_id: record
                .provider_id
                .clone()
                .unwrap_or_else(|| self.default_provider_id.clone()),
            approval_mode,
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), state.clone());
        Ok(state)
    }

    fn workspace_of(session: &SessionState) -> PathBuf {
        session
            .workspace_root
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
    }

    fn model_of(&self, session: &SessionState) -> String {
        session
            .model_id
            .clone()
            .or_else(|| self.default_model.clone())
            .unwrap_or_default()
    }

    fn goal_of(&self, session_id: &str) -> Option<GoalRecord> {
        self.goals
            .lock()
            .unwrap()
            .get(session_id)
            .filter(|g| g.status == "active")
            .cloned()
    }

    /// Rebuild the model message history from persisted items, honoring the
    /// latest compaction summary as the context boundary.
    fn load_history(&self, session_id: &str) -> Vec<ChatMessage> {
        let items = self
            .persistence
            .list_items(session_id, None)
            .unwrap_or_default();
        let mut summary: Option<String> = None;
        let mut last_summary_idx = None;
        for (idx, item) in items.iter().enumerate() {
            if item.kind == "summary" {
                summary = Some(item.content.clone());
                last_summary_idx = Some(idx);
            }
        }
        let mut history = Vec::new();
        if let Some(summary) = summary {
            history.push(ChatMessage::system_text(format!(
                "Summary of the earlier part of this session: {summary}"
            )));
        }
        let start = last_summary_idx.map(|i| i + 1).unwrap_or(0);
        for item in &items[start..] {
            let Ok(content) = serde_json::from_str::<Value>(&item.content) else {
                continue;
            };
            match item.kind.as_str() {
                "user" => {
                    if let Some(text) =
                        content
                            .get("content")
                            .and_then(|c| c.as_array())
                            .map(|parts| {
                                parts
                                    .iter()
                                    .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                    {
                        history.push(ChatMessage::user_text(text));
                    }
                }
                "assistant" => {
                    let text = content
                        .get("content")
                        .and_then(|c| c.as_array())
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(|p| {
                                    if p.get("type")?.as_str()? == "text" {
                                        p.get("text")?.as_str()
                                    } else {
                                        None
                                    }
                                })
                                .collect::<Vec<_>>()
                                .join("")
                        })
                        .unwrap_or_default();
                    let tool_calls = parse_history_tool_calls(&content);
                    if tool_calls.is_empty() {
                        if !text.is_empty() {
                            history.push(ChatMessage::assistant(AssistantMessage {
                                content_parts: vec![ContentPart::text(text)],
                                tool_calls: vec![],
                            }));
                        }
                    } else {
                        history.push(ChatMessage::assistant(AssistantMessage {
                            content_parts: if text.is_empty() {
                                vec![]
                            } else {
                                vec![ContentPart::text(text)]
                            },
                            tool_calls,
                        }));
                    }
                }
                "tool_result" => {
                    if let (Some(id), Some(parts)) = (
                        content.get("toolCallId").and_then(|v| v.as_str()),
                        content.get("content").and_then(|c| c.as_array()),
                    ) {
                        let parts: Vec<ContentPart> = parts
                            .iter()
                            .filter_map(|p| {
                                Some(ContentPart::text(p.get("text")?.as_str()?.to_string()))
                            })
                            .collect();
                        history.push(ChatMessage::tool_result(id, parts));
                    }
                }
                _ => {}
            }
        }
        history
    }

    /// Spawn a turn for a session; returns the turn id.
    fn spawn_turn(
        self: &Arc<Self>,
        session: &SessionState,
        user_content: Vec<ContentPart>,
        goal: Option<GoalContext>,
        is_continuation: bool,
    ) -> String {
        let turn_id = Uuid::now_v7().to_string();
        let session_id = session.id.clone();
        let history = self.load_history(&session_id);
        let handle = TurnHandle::new();
        self.turns
            .lock()
            .unwrap()
            .insert(turn_id.clone(), handle.clone());
        let runner = Arc::clone(&self.runner);
        let turns = Arc::clone(&self.turns);
        let goals = Arc::clone(&self.goals);
        let server = Arc::clone(self);
        let input = TurnInput {
            session_id: session_id.clone(),
            model: self.model_of(session),
            approval_mode: session.approval_mode,
            workspace_root: Self::workspace_of(session),
            data_dir: self.data_dir.clone(),
            history,
            user_content,
            goal,
            skills_prompt: None,
            max_iterations: 25,
            turn_id: turn_id.clone(),
        };
        let goal_after = self.goal_of(&session_id);
        let session_owned = session.clone();
        let turn_id_out = turn_id.clone();
        tokio::spawn(async move {
            let ticket = TurnTicket {
                handle: handle.clone(),
            };
            let outcome = runner.run_turn_cancellable(input, ticket).await;
            turns.lock().unwrap().remove(&turn_id);
            let Ok(outcome) = outcome else { return };
            if is_continuation {
                return;
            }
            // Goal continuation: keep working autonomously while the goal is
            // active, the turn completed, and the goal wasn't just finished.
            let Some(goal) = goal_after else { return };
            if !outcome.completed || outcome.goal_completed || goal.status != "active" {
                return;
            }
            let current = goals.lock().unwrap().get(&session_id).cloned();
            let Some(current) = current else { return };
            if current.status != "active" {
                return;
            }
            let continuations = current.percent_complete;
            if continuations as usize >= MAX_GOAL_CONTINUATIONS {
                return;
            }
            let _ = server.persistence.save_goal(&GoalRecord {
                percent_complete: continuations + 1,
                ..current.clone()
            });
            goals.lock().unwrap().insert(
                session_id.clone(),
                GoalRecord {
                    percent_complete: continuations + 1,
                    ..current.clone()
                },
            );
            server.spawn_turn(
                &session_owned,
                vec![ContentPart::text(
                    "[goal continuation] Continue working toward the goal above. \
                     Briefly report progress, then take the next concrete action. \
                     Call goal_complete when it is fully achieved.",
                )],
                Some(GoalContext {
                    objective: current.objective,
                }),
                true,
            );
        });
        turn_id_out
    }

    fn emit_goal_updated(&self, session_id: &str) {
        if let Some(goal) = self.goals.lock().unwrap().get(session_id).cloned() {
            let _ = self.events_tx.send(AgentEvent::GoalUpdated {
                session_id: session_id.to_string(),
                objective: goal.objective,
                status: goal.status,
                percent_complete: goal.percent_complete.max(0) as u32,
            });
        }
    }

    // ---------- handlers ----------

    async fn handle_initialize(&self, params: Option<Value>) -> Result<Value> {
        let _params: InitializeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let result = InitializeResult {
            platform_family: "unix".into(),
            platform_os: std::env::consts::OS.into(),
            sandbox_availability: "available".into(),
            schema: SchemaInfo {
                fingerprint: SCHEMA_FINGERPRINT.into(),
                version: PROTOCOL_VERSION,
            },
            server_info: ServerInfo {
                name: SERVER_NAME.into(),
                version: SERVER_VERSION.into(),
            },
            user_agent: format!(
                "prricode/{} (serve; {}-{})",
                SERVER_VERSION,
                std::env::consts::OS,
                std::env::consts::ARCH
            ),
        };
        Ok(serde_json::to_value(result)?)
    }

    // ---------- account / auth / subscription (browser flows land in their phase) ----------

    async fn handle_account_login_start(&self, params: Option<Value>) -> Result<Value> {
        let params: AccountLoginStartParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "started": true }))
    }

    async fn handle_account_login_cancel(&self, params: Option<Value>) -> Result<Value> {
        let params: AccountLoginCancelParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "cancelled": true }))
    }

    async fn handle_device_login(&self, params: Option<Value>) -> Result<Value> {
        let params: DeviceLoginParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({
            "commandId": params.command_id,
            "started": true,
            "verificationUrl": null,
            "userCode": null,
        }))
    }

    async fn handle_supersede_login_credential(&self, params: Option<Value>) -> Result<Value> {
        let params: SupersedeLoginCredentialParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "superseded": true }))
    }

    async fn handle_mcp_server_oauth_login(&self, params: Option<Value>) -> Result<Value> {
        let params: McpServerOAuthLoginParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "started": true }))
    }

    async fn handle_mcp_server_oauth_login_cancel(&self, params: Option<Value>) -> Result<Value> {
        let params: McpServerOAuthLoginCancelParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "cancelled": true }))
    }

    async fn handle_subscription_activate(&self, params: Option<Value>) -> Result<Value> {
        let params: SubscriptionActivationParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "activated": true }))
    }

    async fn handle_session_start(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: SessionStartParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session_id = params.session_id.unwrap_or_else(Uuid::now_v7);
        let approval_mode = params.approval_mode.unwrap_or(ApprovalMode::Closed);
        let provider_id = params
            .provider_id
            .map(|p| p.id().to_string())
            .unwrap_or_else(|| self.default_provider_id.clone());
        let model_id = params.model_id.or_else(|| self.default_model.clone());
        let workspace_root = params.workspace_root.or_else(|| {
            params
                .workspace_roots
                .and_then(|roots| roots.into_iter().next())
        });
        let state = SessionState {
            id: session_id.to_string(),
            workspace_root: workspace_root.clone(),
            model_id: model_id.clone(),
            provider_id: provider_id.clone(),
            approval_mode,
        };
        let record = SessionRecord {
            id: state.id.clone(),
            workspace_root: state.workspace_root.clone(),
            model_id: state.model_id.clone(),
            provider_id: Some(provider_id),
            approval_mode: Some(format!("{:?}", approval_mode).to_lowercase()),
        };
        self.persistence.save_session(&record)?;
        self.sessions
            .lock()
            .unwrap()
            .insert(session_id.to_string(), state);
        let _ = self.events_tx.send(AgentEvent::SessionListChanged);
        Ok(serde_json::to_value(SessionStartResult { session_id })?)
    }

    async fn handle_session_read(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionReadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        self.session_state(&params.session_id.to_string()).await?;
        let items = self
            .persistence
            .list_items(&params.session_id.to_string(), None)?;
        let items: Vec<SessionItem> = items
            .iter()
            .filter(|item| item.kind != "assistant_delta")
            .map(|item| {
                let content: Option<Value> = serde_json::from_str(&item.content).ok();
                SessionItem {
                    id: item.id.clone(),
                    kind: item.kind.clone(),
                    role: item.role.clone(),
                    content: content
                        .as_ref()
                        .and_then(|c| c.get("content"))
                        .and_then(parts_to_core),
                }
            })
            .collect();
        let result = SessionReadResult {
            session_id: params.session_id,
            items,
            cursor: None,
        };
        Ok(serde_json::to_value(result)?)
    }

    async fn handle_session_list(&self) -> Result<Value> {
        let sessions = self.persistence.list_sessions()?;
        let items: Vec<Value> = sessions
            .iter()
            .map(|s| {
                json!({
                    "sessionId": s.id,
                    "workspaceRoot": s.workspace_root,
                    "modelId": s.model_id,
                    "providerId": s.provider_id,
                    "approvalMode": s.approval_mode,
                })
            })
            .collect();
        Ok(json!({ "sessions": items }))
    }

    async fn handle_session_resume(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionResumeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let state = self.session_state(&params.session_id.to_string()).await?;
        // Reload goal state for the session.
        let goals = self
            .persistence
            .list_goals(&params.session_id.to_string())?;
        for goal in goals.iter().filter(|g| g.status == "active") {
            self.goals
                .lock()
                .unwrap()
                .insert(params.session_id.to_string(), goal.clone());
        }
        Ok(json!({
            "resumed": true,
            "sessionId": state.id,
            "workspaceRoot": state.workspace_root,
            "modelId": state.model_id,
            "approvalMode": state.approval_mode,
        }))
    }

    async fn handle_turn_start(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: TurnStartParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session = self.session_state(&params.session_id.to_string()).await?;
        let user_content: Vec<ContentPart> = params
            .input
            .iter()
            .map(|part| match part {
                TurnInputPart::Text { text } => ContentPart::text(text.clone()),
                TurnInputPart::Image { data, media_type } => ContentPart::Image {
                    media_type: media_type.clone(),
                    data_base64: data.clone(),
                },
            })
            .collect();
        if user_content.is_empty() {
            return Err(JsonRpcError::invalid_params("turn input is empty").into());
        }
        let goal = self.goal_of(&session.id).map(|g| GoalContext {
            objective: g.objective,
        });
        let turn_id = self.spawn_turn(&session, user_content, goal, false);
        Ok(serde_json::to_value(TurnStartResult {
            turn_id: Uuid::parse_str(&turn_id).unwrap_or_else(|_| Uuid::now_v7()),
            command_id: params.command_id,
        })?)
    }

    // ---------- goals ----------

    async fn handle_goal_set(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: GoalSetParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session = self.session_state(&params.session_id.to_string()).await?;
        // Clear any existing goal for this session first.
        self.persistence.delete_goals(&session.id)?;
        self.goals.lock().unwrap().remove(&session.id);
        let goal_id = Uuid::now_v7().to_string();
        let goal = GoalRecord {
            id: goal_id.clone(),
            session_id: session.id.clone(),
            objective: params.objective.clone(),
            status: "active".into(),
            percent_complete: 0,
            current_work: None,
            next_work: None,
        };
        self.persistence.save_goal(&goal)?;
        self.goals.lock().unwrap().insert(session.id.clone(), goal);
        self.emit_goal_updated(&session.id);
        // Kick off autonomous work immediately.
        self.spawn_turn(
            &session,
            vec![ContentPart::text(format!(
                "[goal] New goal set: {}\nStart working on it now.",
                params.objective
            ))],
            Some(GoalContext {
                objective: params.objective,
            }),
            false,
        );
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "set".into(),
        })?)
    }

    async fn handle_goal_edit(&self, params: Option<Value>) -> Result<Value> {
        let params: GoalEditParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        if let Some(goal) = self
            .goals
            .lock()
            .unwrap()
            .get_mut(&params.session_id.to_string())
        {
            goal.objective = params.objective.clone();
            self.persistence.save_goal(goal)?;
        }
        self.emit_goal_updated(&params.session_id.to_string());
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "edited".into(),
        })?)
    }

    async fn handle_goal_clear(&self, params: Option<Value>) -> Result<Value> {
        let params: GoalClearParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        self.goals
            .lock()
            .unwrap()
            .remove(&params.session_id.to_string());
        self.persistence
            .delete_goals(&params.session_id.to_string())?;
        let _ = self.events_tx.send(AgentEvent::GoalCleared {
            session_id: params.session_id.to_string(),
        });
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "cleared".into(),
        })?)
    }

    async fn handle_goal_pause(&self, params: Option<Value>) -> Result<Value> {
        let params: GoalPauseParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        if let Some(goal) = self
            .goals
            .lock()
            .unwrap()
            .get_mut(&params.session_id.to_string())
        {
            goal.status = "paused".into();
            self.persistence.save_goal(goal)?;
        }
        self.emit_goal_updated(&params.session_id.to_string());
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "paused".into(),
        })?)
    }

    async fn handle_goal_resume(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: GoalResumeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session = self.session_state(&params.session_id.to_string()).await?;
        if let Some(goal) = self
            .goals
            .lock()
            .unwrap()
            .get_mut(&params.session_id.to_string())
        {
            goal.status = "active".into();
            self.persistence.save_goal(goal)?;
        }
        self.emit_goal_updated(&params.session_id.to_string());
        let objective = self
            .goals
            .lock()
            .unwrap()
            .get(&session.id)
            .map(|g| g.objective.clone());
        if let Some(objective) = objective {
            if self.goal_of(&session.id).is_some() {
                self.spawn_turn(
                    &session,
                    vec![ContentPart::text(
                        "[goal resumed] Continue working toward the goal above.",
                    )],
                    Some(GoalContext { objective }),
                    true,
                );
            }
        }
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "resumed".into(),
        })?)
    }

    // ---------- workflows (engine lands in its phase; control surface is real) ----------

    async fn handle_workflow_cancel(&self, params: Option<Value>) -> Result<Value> {
        let params: WorkflowCancelParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        match self.workflows.cancel(&params.workflow_run_id.to_string()) {
            Ok(()) => Ok(serde_json::to_value(WorkflowControlResult {
                command_id: params.command_id,
                status: "cancelled".into(),
            })?),
            Err(_) => Ok(serde_json::to_value(WorkflowControlResult {
                command_id: params.command_id,
                status: "not_found".into(),
            })?),
        }
    }

    async fn handle_workflow_pause(&self, params: Option<Value>) -> Result<Value> {
        let params: WorkflowPauseParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        match self.workflows.pause(&params.workflow_run_id.to_string()) {
            Ok(()) => Ok(serde_json::to_value(WorkflowControlResult {
                command_id: params.command_id,
                status: "paused".into(),
            })?),
            Err(_) => Ok(serde_json::to_value(WorkflowControlResult {
                command_id: params.command_id,
                status: "invalid_transition".into(),
            })?),
        }
    }

    async fn handle_workflow_resume(&self, params: Option<Value>) -> Result<Value> {
        let params: WorkflowResumeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        match self.workflows.resume(&params.workflow_run_id.to_string()) {
            Ok(()) => Ok(serde_json::to_value(WorkflowResumeResult {
                command_id: params.command_id,
                status: "resumed".into(),
                turn_id: Uuid::now_v7(),
            })?),
            Err(_) => Ok(serde_json::to_value(WorkflowResumeResult {
                command_id: params.command_id,
                status: "invalid_transition".into(),
                turn_id: Uuid::now_v7(),
            })?),
        }
    }

    async fn handle_workflow_child_control(&self, params: Option<Value>) -> Result<Value> {
        let params: WorkflowChildControlParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        let retry = matches!(params.action, WorkflowChildAction::Retry);
        match self.workflows.child_control(
            &params.workflow_run_id.to_string(),
            &params.child_id,
            retry,
        ) {
            Ok(child) => Ok(serde_json::to_value(WorkflowControlResult {
                command_id: params.command_id,
                status: format!("{}:{}", child.status, child.phase),
            })?),
            Err(_) => Ok(serde_json::to_value(WorkflowControlResult {
                command_id: params.command_id,
                status: "not_found".into(),
            })?),
        }
    }

    // ---------- computer use (X11 backend lands in its phase) ----------

    async fn handle_computer_use_check(&self) -> Result<Value> {
        Ok(serde_json::to_value(computer_use_state())?)
    }

    async fn handle_computer_use_setup_read(&self, params: Option<Value>) -> Result<Value> {
        let _params: ComputerUseSetupReadParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        self.handle_computer_use_check().await
    }

    async fn handle_computer_use_start(&self, params: Option<Value>) -> Result<Value> {
        let _params: ComputerUseSetupStartParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        let mut state = computer_use_state();
        if state.setup == ComputerUseSetupPhase::ReadyForTarget {
            state.setup = ComputerUseSetupPhase::InProgress;
        }
        Ok(serde_json::to_value(state)?)
    }

    async fn handle_computer_use_settings_read(&self) -> Result<Value> {
        Ok(serde_json::to_value(ComputerUseSettings {
            blocked_apps: None,
            computer_control: Some(ComputerUseChoice::Ask),
            screenshots: Some(ComputerUseChoice::Ask),
        })?)
    }

    async fn handle_computer_use_settings_update(&self, params: Option<Value>) -> Result<Value> {
        let params: ComputerUseSettingsUpdateParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        let settings = ComputerUseSettings {
            blocked_apps: params.block_apps.map(|apps| {
                apps.into_iter()
                    .map(|bundle_id| ComputerUseBlockedApp { bundle_id })
                    .collect()
            }),
            computer_control: params.computer_control,
            screenshots: params.screenshots,
        };
        self.persistence
            .set_setting("computerUseSettings", &serde_json::to_string(&settings)?)?;
        Ok(serde_json::to_value(settings)?)
    }

    // ---------- approvals ----------

    async fn handle_approval_decide(&self, params: Option<Value>) -> Result<Value> {
        let params: ApprovalDecideParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let approved = !params.choice_id.eq_ignore_ascii_case("deny")
            && !params.choice_id.eq_ignore_ascii_case("reject")
            && !params.choice_id.eq_ignore_ascii_case("cancel");
        let acknowledged = self
            .approvals
            .decide(&params.approval_id.to_string(), approved);
        Ok(serde_json::to_value(ApprovalDecideResult {
            command_id: params.command_id,
            status: if acknowledged {
                "decided".into()
            } else {
                "unknown".into()
            },
        })?)
    }

    async fn handle_approval_list_pending(&self, params: Option<Value>) -> Result<Value> {
        let params: ApprovalListPendingParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        let approvals = self.approvals.list_pending(&params.session_id.to_string());
        Ok(json!({ "approvals": approvals }))
    }

    // ---------- subagents ----------

    async fn handle_subagent_close(&self, params: Option<Value>) -> Result<Value> {
        let params: SubagentCloseParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        self.sessions
            .lock()
            .unwrap()
            .remove(&params.subagent_id.to_string());
        Ok(serde_json::to_value(CommandAcceptedResult {
            command_id: params.command_id,
        })?)
    }

    async fn handle_subagent_send_message(
        self: &Arc<Self>,
        params: Option<Value>,
    ) -> Result<Value> {
        let params: SubagentInputParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let subagent_id = params.subagent_id.to_string();
        let session = SessionState {
            id: subagent_id.clone(),
            workspace_root: None,
            model_id: None,
            provider_id: self.default_provider_id.clone(),
            approval_mode: ApprovalMode::Auto,
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(subagent_id, session.clone());
        self.spawn_turn(&session, vec![ContentPart::text(params.body)], None, false);
        Ok(serde_json::to_value(CommandAcceptedResult {
            command_id: params.command_id,
        })?)
    }

    // ---------- tasks ----------

    async fn handle_task_background(&self, params: Option<Value>) -> Result<Value> {
        let params: TaskBackgroundParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let _ = self.events_tx.send(AgentEvent::TaskUpdated {
            session_id: params.session_id.to_string(),
            task_id: params.task_id.to_string(),
            status: "backgrounded".into(),
        });
        Ok(serde_json::to_value(TaskCommandResult {
            command_id: params.command_id,
        })?)
    }

    async fn handle_task_stop(&self, params: Option<Value>) -> Result<Value> {
        let params: TaskStopParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let _ = self.events_tx.send(AgentEvent::TaskUpdated {
            session_id: params.session_id.to_string(),
            task_id: params.task_id.to_string(),
            status: "stopped".into(),
        });
        Ok(serde_json::to_value(TaskCommandResult {
            command_id: params.command_id,
        })?)
    }

    async fn handle_task_stop_all(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: TaskStopAllParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let stopped: Vec<String> = {
            let turns = self.turns.lock().unwrap();
            for handle in turns.values() {
                handle.cancel();
            }
            turns.keys().cloned().collect()
        };
        for turn_id in stopped {
            let _ = self.events_tx.send(AgentEvent::TaskUpdated {
                session_id: params.session_id.to_string(),
                task_id: turn_id,
                status: "stopped".into(),
            });
        }
        Ok(json!({ "commandId": params.command_id, "stopped": true }))
    }

    async fn handle_task_list(&self, params: Option<Value>) -> Result<Value> {
        let _params: TaskListParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let active: Vec<Value> = self
            .turns
            .lock()
            .unwrap()
            .keys()
            .map(|turn_id| json!({ "taskId": turn_id, "status": "active", "kind": "turn" }))
            .collect();
        Ok(json!({ "tasks": active }))
    }

    // ---------- skills (loader lands in its phase) ----------

    async fn handle_skill_list(&self, params: Option<Value>) -> Result<Value> {
        let _params: SkillListParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let home = dirs_home();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let skills = prricode_skills::load_skills(&home, &cwd);
        let entries: Vec<Value> = skills
            .iter()
            .map(|skill| {
                json!({
                    "name": skill.name,
                    "source": skill.source,
                    "description": skill.description,
                    "location": skill.location.display().to_string(),
                })
            })
            .collect();
        Ok(json!({ "skills": entries }))
    }

    async fn handle_skill_import(&self, params: Option<Value>) -> Result<Value> {
        let params: SkillImportParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let home = dirs_home();
        match prricode_skills::import_skill(
            &home,
            std::path::Path::new(&params.source),
            params.dry_run.unwrap_or(false),
            params.force.unwrap_or(false),
        ) {
            Ok(imported) => Ok(json!({
                "commandId": params.command_id,
                "imported": imported.imported,
                "name": imported.name,
                "source": params.source,
                "dryRun": params.dry_run.unwrap_or(false),
                "dest": imported.dest.display().to_string(),
            })),
            Err(e) => Err(JsonRpcError::invalid_params(e.to_string()).into()),
        }
    }

    // ---------- models / usage ----------

    async fn handle_model_list(&self, params: Option<Value>) -> Result<Value> {
        let _params: ModelListParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let provider_id = self.provider.kind().id().to_string();
        let models = self.provider.list_models().await?;
        let entries: Vec<Value> = models
            .iter()
            .map(|m| {
                json!({
                    "modelId": m.model_id,
                    "providerId": provider_id,
                    "profileId": "default",
                    "contextLimit": m.context_limit,
                    "outputLimit": 4096,
                    "displayLabel": m.display_label,
                    "isActive": m.is_active,
                    "isDefault": m.is_active,
                })
            })
            .collect();
        let _ = self.events_tx.send(AgentEvent::ModelCatalogChanged {
            models: entries.clone(),
        });
        Ok(json!({ "models": entries }))
    }

    async fn handle_usage_read(&self) -> Result<Value> {
        let mut input_tokens = 0u64;
        let mut output_tokens = 0u64;
        let mut cost = 0.0f64;
        if let Ok(sessions) = self.persistence.list_sessions() {
            for session in sessions {
                let (i, o, c) = self.persistence.usage_summary(&session.id)?;
                input_tokens += i;
                output_tokens += o;
                cost += c;
            }
        }
        let result = UsageReadResult {
            total_input_tokens: input_tokens,
            total_output_tokens: output_tokens,
            total_cost: cost,
        };
        let _ = self.events_tx.send(AgentEvent::UsageUpdated {
            session_id: None,
            input_tokens,
            output_tokens,
            total_cost: cost,
        });
        Ok(serde_json::to_value(result)?)
    }

    // ---------- misc ----------

    async fn handle_user_input_answer(&self, params: Option<Value>) -> Result<Value> {
        let params: UserInputAnswerParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "accepted": true }))
    }

    async fn handle_media_upload(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: MediaUploadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        use base64::Engine;
        let chunk = base64::engine::general_purpose::STANDARD
            .decode(&params.chunk_base64)
            .map_err(|e| JsonRpcError::invalid_params(format!("bad base64 chunk: {e}")))?;
        let upload_id = params.upload_id.to_string();
        let mut uploads = self.uploads.lock().unwrap();
        let state = uploads.entry(upload_id.clone()).or_default();
        state.media_type = params.media_type.clone();
        state.total_bytes = params.total_bytes;
        state.chunk_count = params.chunk_count;
        state.chunks_received += 1;
        state.bytes.extend_from_slice(&chunk);
        let complete = state.chunks_received >= state.chunk_count;
        let bytes_len = state.bytes.len();
        let media_type = state.media_type.clone();
        let bytes = std::mem::take(&mut state.bytes);
        drop(uploads);
        let mut path = None;
        if complete {
            let dir = self.data_dir.join("uploads");
            std::fs::create_dir_all(&dir)?;
            let file = dir.join(&upload_id);
            std::fs::write(&file, &bytes)?;
            path = Some(file.to_string_lossy().to_string());
            let record = serde_json::to_string(&json!({
                "uploadId": upload_id,
                "mediaType": media_type,
                "bytes": bytes_len,
                "path": path,
            }))?;
            let item = ItemRecord {
                id: Uuid::now_v7().to_string(),
                session_id: params.session_id.to_string(),
                kind: "media".into(),
                role: Some("user".into()),
                content: record,
                created_at: String::new(),
            };
            self.persistence.save_item(&item)?;
        }
        Ok(json!({
            "commandId": params.command_id,
            "received": true,
            "chunkIndex": params.chunk_index,
            "complete": complete,
            "bytes": bytes_len,
            "path": path,
        }))
    }

    async fn handle_recap_request(&self, params: Option<Value>) -> Result<Value> {
        let params: RecapRequestParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(RecapRequestResult {
            command_id: params.command_id,
            status: "requested".into(),
        })?)
    }

    async fn handle_recap_cancel(&self, params: Option<Value>) -> Result<Value> {
        let params: RecapCancelParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "cancelled": true }))
    }

    async fn handle_user_shell(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: SessionUserShellParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session = self.session_state(&params.session_id.to_string()).await?;
        let sensitive = matches!(
            session.approval_mode,
            ApprovalMode::Closed | ApprovalMode::Auto | ApprovalMode::Suggestive
        );
        if sensitive && session.approval_mode != ApprovalMode::Open {
            // A synchronous RPC cannot wait for an approval decision without
            // blocking the transport; require the client to move to Open mode
            // or use the agent's shell tool for approved execution.
            let _ = self.events_tx.send(AgentEvent::Log {
                session_id: session.id.clone(),
                level: "warn".into(),
                message: format!(
                    "userShell denied in {:?} approval mode",
                    session.approval_mode
                ),
            });
            return Err(RpcError(JsonRpcError::capability_required("userShell")).into());
        }
        let workspace = Self::workspace_of(&session);
        let output = tokio::process::Command::new("bash")
            .arg("-c")
            .arg(&params.command_text)
            .current_dir(&workspace)
            .output()
            .await
            .map_err(|e| JsonRpcError::internal_error(format!("shell failed: {e}")))?;
        Ok(serde_json::to_value(SessionUserShellResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        })?)
    }

    async fn handle_session_set_model(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionSetModelParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session_id = params.session_id.to_string();
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.model_id = Some(params.model.model_id.clone());
            let record = SessionRecord {
                id: session.id.clone(),
                workspace_root: session.workspace_root.clone(),
                model_id: session.model_id.clone(),
                provider_id: Some(session.provider_id.clone()),
                approval_mode: Some(format!("{:?}", session.approval_mode).to_lowercase()),
            };
            self.persistence.save_session(&record)?;
        }
        let _ = self.events_tx.send(AgentEvent::SessionModelChanged {
            session_id,
            model_id: params.model.model_id.clone(),
        });
        Ok(json!({ "commandId": params.command_id, "model": params.model }))
    }

    async fn handle_session_set_approval_mode(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionSetApprovalModeParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        let session_id = params.session_id.to_string();
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.get_mut(&session_id) {
            session.approval_mode = params.mode;
            let record = SessionRecord {
                id: session.id.clone(),
                workspace_root: session.workspace_root.clone(),
                model_id: session.model_id.clone(),
                provider_id: Some(session.provider_id.clone()),
                approval_mode: Some(format!("{:?}", session.approval_mode).to_lowercase()),
            };
            self.persistence.save_session(&record)?;
        }
        let _ = self.events_tx.send(AgentEvent::SessionApprovalModeChanged {
            session_id,
            mode: format!("{:?}", params.mode).to_lowercase(),
        });
        Ok(json!({ "status": "updated", "mode": params.mode }))
    }

    async fn handle_session_set_reasoning_effort(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionSetReasoningEffortParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        self.persistence.set_setting(
            &format!("reasoningEffort:{}", params.session_id),
            &format!("{:?}", params.reasoning_effort).to_lowercase(),
        )?;
        Ok(json!({ "status": "updated", "reasoningEffort": params.reasoning_effort }))
    }

    async fn handle_session_rename(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionRenameParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        self.persistence
            .set_setting(&format!("name:{}", params.session_id), &params.name)?;
        let _ = self.events_tx.send(AgentEvent::SessionRenamed {
            session_id: params.session_id.to_string(),
            name: params.name.clone(),
        });
        Ok(json!({ "commandId": params.command_id, "name": params.name }))
    }

    async fn handle_session_side_chat(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionSideChatParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(
            json!({ "commandId": params.command_id, "started": true, "sessionId": params.session_id }),
        )
    }

    async fn handle_session_compact(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: SessionCompactParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session = self.session_state(&params.session_id.to_string()).await?;
        let history = self.load_history(&session.id);
        if history.len() < 4 {
            let _ = self.events_tx.send(AgentEvent::SessionCompact {
                session_id: session.id.clone(),
                compacted: false,
            });
            return Ok(serde_json::to_value(SessionCompactResult {
                compacted: false,
            })?);
        }
        let compact_input: Vec<ChatMessage> = history
            .iter()
            .cloned()
            .chain(std::iter::once(ChatMessage::user_text(
                "Summarize the conversation so far in under 400 words. Keep decisions, \
                 file paths, commands, and open questions. This summary replaces the \
                 earlier history.",
            )))
            .collect();
        let response = self
            .provider
            .chat(&ChatRequest {
                model: self.model_of(&session),
                messages: compact_input,
                ..Default::default()
            })
            .await?;
        let summary = response.message.text();
        self.persistence.save_summary_item(&session.id, &summary)?;
        self.persistence.save_usage(
            &session.id,
            response.usage.input_tokens,
            response.usage.output_tokens,
            response.cost_usd.unwrap_or(0.0),
        )?;
        let _ = self.events_tx.send(AgentEvent::SessionCompact {
            session_id: session.id.clone(),
            compacted: true,
        });
        Ok(serde_json::to_value(SessionCompactResult {
            compacted: true,
        })?)
    }

    async fn handle_session_fork(self: &Arc<Self>, params: Option<Value>) -> Result<Value> {
        let params: SessionForkParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let source = self.session_state(&params.session_id.to_string()).await?;
        let fork_id = Uuid::now_v7();
        let record = SessionRecord {
            id: fork_id.to_string(),
            workspace_root: source.workspace_root.clone(),
            model_id: source.model_id.clone(),
            provider_id: Some(source.provider_id.clone()),
            approval_mode: Some(format!("{:?}", source.approval_mode).to_lowercase()),
        };
        self.persistence.save_session(&record)?;
        for item in self.persistence.list_items(&source.id, None)? {
            let mut copy = item.clone();
            copy.id = Uuid::now_v7().to_string();
            copy.session_id = fork_id.to_string();
            copy.created_at = String::new();
            self.persistence.save_item(&copy)?;
        }
        let state = SessionState {
            id: fork_id.to_string(),
            ..source
        };
        self.sessions
            .lock()
            .unwrap()
            .insert(fork_id.to_string(), state);
        let _ = self.events_tx.send(AgentEvent::SessionForked {
            session_id: params.session_id.to_string(),
            forked_session_id: fork_id.to_string(),
        });
        let _ = self.events_tx.send(AgentEvent::SessionListChanged);
        Ok(json!({ "commandId": params.command_id, "forkedSessionId": fork_id }))
    }

    // ---------- conformance: second-surface methods ----------

    async fn handle_conversation_rewind_evaluate(&self, params: Option<Value>) -> Result<Value> {
        let params: ConversationRewindEvaluateParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({
            "sessionId": params.session_id,
            "canRewind": false,
            "reason": "rewind is not available in this build",
        }))
    }

    async fn handle_local_session_message(&self, params: Option<Value>) -> Result<Value> {
        let _params: LocalSessionMessageParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "delivered": false, "reason": "local session transport unavailable" }))
    }

    async fn handle_log_subscribe(&self, params: Option<Value>) -> Result<Value> {
        let params: LogSubscribeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "sessionId": params.session_id, "subscribed": true }))
    }

    async fn handle_log_unsubscribe(&self, params: Option<Value>) -> Result<Value> {
        let params: LogUnsubscribeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "sessionId": params.session_id, "unsubscribed": true }))
    }

    async fn handle_log_page(&self, params: Option<Value>) -> Result<Value> {
        let params: LogPageParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session_id = params.session_id.to_string();
        self.session_state(&session_id).await?;
        let items = self
            .persistence
            .list_items(&session_id, Some(params.limit))?;
        let entries: Vec<Value> = items
            .iter()
            .map(|i| {
                json!({
                    "id": i.id,
                    "kind": i.kind,
                    "role": i.role,
                    "content": serde_json::from_str::<Value>(&i.content).unwrap_or(json!({})),
                })
            })
            .collect();
        Ok(json!({ "items": entries, "hasMore": false }))
    }

    async fn handle_peer_admission(&self, params: Option<Value>) -> Result<Value> {
        let _params: PeerAdmissionParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "admitted": false, "reason": "no peer sessions connected" }))
    }

    async fn handle_permission_profile_set(&self, params: Option<Value>) -> Result<Value> {
        let params: PermissionProfileSetParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        self.persistence.set_setting(
            &format!("permissionProfile:{}", params.session_id),
            &params.profile,
        )?;
        Ok(json!({
            "commandId": params.command_id,
            "status": "updated",
            "profile": params.profile,
        }))
    }

    async fn handle_process_background(&self, params: Option<Value>) -> Result<Value> {
        let _params: ProcessBackgroundParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "backgrounded": false, "reason": "no background process to take over" }))
    }

    async fn handle_projection_read(&self, params: Option<Value>) -> Result<Value> {
        let params: ProjectionReadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session_id = params.session_id.to_string();
        self.session_state(&session_id).await?;
        let items = self.persistence.list_items(&session_id, None)?;
        let counts: HashMap<String, u64> = items.iter().fold(HashMap::new(), |mut acc, item| {
            *acc.entry(item.kind.clone()).or_insert(0) += 1;
            acc
        });
        Ok(json!({
            "sessionId": session_id,
            "itemCounts": counts,
            "itemTotal": items.len(),
        }))
    }

    async fn handle_runtime_launch(&self, params: Option<Value>) -> Result<Value> {
        let _params: RuntimeLaunchParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "launched": false, "reason": "external runtime launch unavailable" }))
    }

    async fn handle_scheduled_fire(&self, params: Option<Value>) -> Result<Value> {
        let _params: ScheduledFireParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "fired": false, "reason": "no scheduled prompts configured" }))
    }

    async fn handle_session_name(&self, params: Option<Value>) -> Result<Value> {
        let _params: SessionNameParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "name": null }))
    }

    async fn handle_settings_read(&self, params: Option<Value>) -> Result<Value> {
        let _params: SettingsReadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "settings": {} }))
    }

    async fn handle_settings_write_value(&self, params: Option<Value>) -> Result<Value> {
        let params: SettingsWriteValueParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        self.persistence.set_setting(&params.key, &params.value)?;
        let _ = self.events_tx.send(AgentEvent::SettingsChanged {
            settings: json!({ params.key.clone(): params.value.clone() }),
        });
        Ok(json!({ "written": true, "key": params.key, "value": params.value }))
    }

    async fn handle_settings_write_many(&self, params: Option<Value>) -> Result<Value> {
        let params: SettingsWriteManyParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        for (key, value) in params.values.iter() {
            self.persistence.set_setting(key, value)?;
        }
        if let Some((first_key, _)) = params.values.iter().next() {
            let _ = self.events_tx.send(AgentEvent::SettingsChanged {
                settings: json!({ first_key.clone(): params.values.get(first_key).cloned().unwrap_or_default() }),
            });
        }
        Ok(json!({ "written": true, "count": params.values.len() }))
    }

    async fn handle_skill_set_activation(&self, params: Option<Value>) -> Result<Value> {
        let params: SkillSetActivationParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        self.persistence.set_setting(
            &format!("skillActivation:{}", params.session_id),
            &params.activation,
        )?;
        Ok(json!({
            "commandId": params.command_id,
            "status": "updated",
            "activation": params.activation,
            "scope": params.scope,
            "selector": params.selector,
        }))
    }

    async fn handle_subagent_target(&self, params: Option<Value>) -> Result<Value> {
        let params: SubagentTargetParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({
            "commandId": params.command_id,
            "targeted": true,
            "subagentId": params.subagent_id,
        }))
    }

    async fn handle_tool_configuration(&self, params: Option<Value>) -> Result<Value> {
        let _params: ToolConfigurationParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "tools": [] }))
    }

    async fn handle_turn_submit_origin(&self, params: Option<Value>) -> Result<Value> {
        let _params: TurnSubmitOriginParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "origin": null }))
    }

    async fn handle_view_unsubscribe_by_session_id(&self, params: Option<Value>) -> Result<Value> {
        let params: ViewUnsubscribeBySessionIdParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "sessionId": params.session_id, "unsubscribed": true }))
    }

    async fn handle_workflow_control(&self, params: Option<Value>) -> Result<Value> {
        let _params: WorkflowControlParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "status": "accepted" }))
    }

    async fn handle_workflow_trigger_configuration(&self, params: Option<Value>) -> Result<Value> {
        let _params: WorkflowTriggerConfigurationParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "triggers": [] }))
    }

    // ---------- views / items ----------

    async fn handle_view_page(&self, params: Option<Value>) -> Result<Value> {
        let params: ViewPageParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        self.session_state(&params.session_id.to_string()).await?;
        let items = self
            .persistence
            .list_items(&params.session_id.to_string(), Some(params.limit))?;
        let values: Vec<Value> = items
            .iter()
            .filter(|i| i.kind != "assistant_delta")
            .map(|i| {
                json!({
                    "id": i.id,
                    "kind": i.kind,
                    "role": i.role,
                    "content": serde_json::from_str::<Value>(&i.content).unwrap_or(json!({})),
                })
            })
            .collect();
        Ok(json!({ "items": values, "hasMore": false }))
    }

    async fn handle_view_subscribe(&self, params: Option<Value>) -> Result<Value> {
        let params: ViewSubscribeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "sessionId": params.session_id, "subscribed": true }))
    }

    async fn handle_view_unsubscribe(&self, params: Option<Value>) -> Result<Value> {
        let params: ViewUnsubscribeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "sessionId": params.session_id, "unsubscribed": true }))
    }

    async fn handle_item_read_output(&self, params: Option<Value>) -> Result<Value> {
        let params: ItemReadOutputParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "itemId": params.item_id, "output": "", "truncated": false }))
    }

    // ---------- plugins / hooks / feedback (engines land in later phases) ----------

    async fn handle_plugin_list(&self, params: Option<Value>) -> Result<Value> {
        let _params: PluginListParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "plugins": [] }))
    }

    async fn handle_plugin_install(&self, params: Option<Value>) -> Result<Value> {
        let params: PluginInstallParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "installed": false, "target": params.target }))
    }

    async fn handle_hook_list(&self, params: Option<Value>) -> Result<Value> {
        let _params: HookListParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "hooks": [] }))
    }

    async fn handle_feedback_submit(&self, params: Option<Value>) -> Result<Value> {
        let params: FeedbackSubmitParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "accepted": true, "classification": params.classification }))
    }

    // ---------- turn control ----------

    async fn handle_turn_cancel(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnCancelParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        // Cancel every active turn for the session.
        let mut cancelled = 0;
        let turns = self.turns.lock().unwrap();
        for handle in turns.values() {
            handle.cancel();
            cancelled += 1;
        }
        drop(turns);
        let _ = cancelled;
        Ok(json!({ "commandId": params.command_id, "cancelled": true }))
    }

    async fn handle_turn_interrupt(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnInterruptParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let turns = self.turns.lock().unwrap();
        for handle in turns.values() {
            handle.cancel();
        }
        drop(turns);
        Ok(json!({ "commandId": params.command_id, "interrupted": true }))
    }

    async fn handle_turn_steer(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnSteerParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        // Steering injects a user item that the next turn iteration picks up.
        let text = params
            .input
            .iter()
            .filter_map(|part| match part {
                TurnInputPart::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        let item = ItemRecord {
            id: Uuid::now_v7().to_string(),
            session_id: params.session_id.to_string(),
            kind: "user".into(),
            role: Some("user".into()),
            created_at: String::new(),
            content: json!({
                "kind": "user",
                "role": "user",
                "content": [{ "type": "text", "text": format!("[steer] {text}") }],
            })
            .to_string(),
        };
        self.persistence.save_item(&item)?;
        Ok(json!({ "commandId": params.command_id, "steered": true }))
    }

    async fn handle_turn_unqueue(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnUnqueueParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "unqueued": true }))
    }

    // ---------- pipeline (product builder) ----------

    fn pipeline_setting_key(session_id: &str) -> String {
        format!("pipeline:{session_id}")
    }

    fn pipeline_state(&self, session_id: &str) -> PipelineState {
        self.persistence
            .get_setting(&Self::pipeline_setting_key(session_id))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save_pipeline_state(&self, session_id: &str, state: &PipelineState) -> Result<()> {
        self.persistence.set_setting(
            &Self::pipeline_setting_key(session_id),
            &serde_json::to_string(state)?,
        )
    }

    fn pipeline_stage_label(state: &PipelineState) -> String {
        if state.stage.is_empty() {
            PipelineStage::Concept.label().to_string()
        } else {
            state.stage.clone()
        }
    }

    async fn handle_pipeline_concept_set(&self, params: Option<Value>) -> Result<Value> {
        let params: PipelineConceptSetParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session_id = params.session_id.to_string();
        let concept = Concept::from_idea(&params.idea);
        let question = Clarifier::new(concept.clone()).next_question();
        let mut state = self.pipeline_state(&session_id);
        state.stage = PipelineStage::Clarify.label().to_string();
        state.concept = Some(serde_json::to_value(&concept)?);
        self.save_pipeline_state(&session_id, &state)?;
        if let Some(question) = &question {
            let _ = self.events_tx.send(AgentEvent::Item {
                session_id: session_id.clone(),
                item: json!({
                    "kind": "pipeline_question",
                    "role": "assistant",
                    "stage": PipelineStage::Clarify.label(),
                    "content": [{ "type": "text", "text": question }],
                }),
            });
        }
        Ok(json!({
            "commandId": params.command_id,
            "concept": concept,
            "question": question,
        }))
    }

    async fn handle_pipeline_spec_read(&self, params: Option<Value>) -> Result<Value> {
        let params: PipelineSpecReadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let state = self.pipeline_state(&params.session_id.to_string());
        let spec = match &state.spec {
            Some(spec) => spec.clone(),
            None => serde_json::to_value(Spec::draft(Concept::from_idea("")))?,
        };
        Ok(json!({ "spec": spec, "stage": Self::pipeline_stage_label(&state) }))
    }

    async fn handle_pipeline_plan_read(&self, params: Option<Value>) -> Result<Value> {
        let params: PipelinePlanReadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let state = self.pipeline_state(&params.session_id.to_string());
        Ok(json!({ "waves": state.waves, "stage": Self::pipeline_stage_label(&state) }))
    }

    /// Read the session's verification report.
    ///
    /// Resolution order: the run id stored in the session's pipeline state
    /// (set by the TUI when a build starts) when its run has a dossier;
    /// otherwise the most recent persisted `dossier:<runId>` row. v0.2
    /// does not scope dossier rows by session, so a session that never ran
    /// verification reads the latest report in the data dir instead of its
    /// own — and a data dir with no dossier at all reads `null`.
    async fn handle_pipeline_verify_read(&self, params: Option<Value>) -> Result<Value> {
        let params: PipelineVerifyReadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let state = self.pipeline_state(&params.session_id.to_string());
        let report = state
            .run_id
            .as_deref()
            .and_then(|run_id| prricode_verify::dossier::load_report(&self.persistence, run_id))
            .or_else(|| Self::latest_dossier_report(&self.persistence));
        Ok(json!({ "report": report }))
    }

    /// The most recent persisted verification report: dossier rows are keyed
    /// by uuid v7 run id, so the lexicographically greatest `dossier:<runId>`
    /// key names the latest run.
    fn latest_dossier_report(
        persistence: &Persistence,
    ) -> Option<prricode_verify::VerificationReport> {
        let run_id = persistence
            .list_settings()
            .ok()?
            .into_iter()
            .filter_map(|(key, _)| key.strip_prefix("dossier:").map(String::from))
            .max()?;
        prricode_verify::dossier::load_report(persistence, &run_id)
    }

    /// Read the session's latest ship record.
    ///
    /// Resolution mirrors `pipeline/verifyRead`: the `runId` stored in the
    /// session's pipeline state when that run has a persisted
    /// `ship:<runId>` row, otherwise the most recent such row. A session
    /// (or data dir) with no ship reads `null`. The record carries no
    /// deploy material: credential values never leave the deploy child
    /// process's environment.
    async fn handle_pipeline_ship_read(&self, params: Option<Value>) -> Result<Value> {
        let params: PipelineShipReadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let ship = self
            .latest_ship_record(&params.session_id.to_string())
            .map(|record| serde_json::to_value(&record).unwrap_or(Value::Null))
            .unwrap_or(Value::Null);
        Ok(json!({ "ship": ship }))
    }

    /// The session's latest ship record: its run's row when one exists, else
    /// the most recent `ship:<runId>` row in the data dir (ship rows are
    /// keyed by uuid v7 run id, so the lexicographically greatest key names
    /// the latest run, exactly as the dossier rows do).
    fn latest_ship_record(&self, session_id: &str) -> Option<prricode_ship::ShipRecord> {
        let state = self.pipeline_state(session_id);
        if let Some(run_id) = state.run_id.as_deref() {
            if let Some(record) = Self::ship_record(&self.persistence, run_id) {
                return Some(record);
            }
        }
        let run_id = self
            .persistence
            .list_settings()
            .ok()?
            .into_iter()
            .filter_map(|(key, _)| key.strip_prefix("ship:").map(String::from))
            .max()?;
        Self::ship_record(&self.persistence, &run_id)
    }

    fn ship_record(persistence: &Persistence, run_id: &str) -> Option<prricode_ship::ShipRecord> {
        persistence
            .get_setting(&format!("ship:{run_id}"))
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str(&raw).ok())
    }

    /// Read the session's operate log entries.
    ///
    /// The log lives at `<data_dir>/operate/<runId>.jsonl`, where the run id
    /// resolves exactly as the ship stage persists it (the pipeline state's
    /// runId, else the session id); when that run has no log, the most
    /// recent log in the operate directory is read instead — the same
    /// "latest for session" resolution `verifyRead` applies to dossiers. A
    /// data dir with no log at all reads an empty list.
    async fn handle_pipeline_operate_read(&self, params: Option<Value>) -> Result<Value> {
        let params: PipelineOperateReadParams =
            serde_json::from_value(params.unwrap_or(json!({})))?;
        let session_id = params.session_id.to_string();
        let state = self.pipeline_state(&session_id);
        let run_id = state
            .run_id
            .clone()
            .filter(|run_id| !run_id.is_empty())
            .unwrap_or_else(|| session_id.clone());
        let events =
            prricode_ship::operate::read_operate_log(&self.data_dir, &run_id).unwrap_or_default();
        if !events.is_empty() {
            return Ok(json!({ "events": events }));
        }
        let latest = Self::latest_operate_run_id(&self.data_dir)
            .and_then(|run_id| {
                prricode_ship::operate::read_operate_log(&self.data_dir, &run_id).ok()
            })
            .unwrap_or_default();
        Ok(json!({ "events": latest }))
    }

    /// The most recent operate log's run id: the lexicographically greatest
    /// `<runId>.jsonl` file name in the data dir's operate directory, mirroring
    /// the latest-row resolution for ship and dossier rows.
    fn latest_operate_run_id(data_dir: &std::path::Path) -> Option<String> {
        std::fs::read_dir(data_dir.join("operate"))
            .ok()?
            .flatten()
            .filter_map(|entry| {
                let path = entry.path();
                if path.extension()?.to_str()? != "jsonl" {
                    return None;
                }
                let stem = path.file_stem()?.to_string_lossy().to_string();
                (!stem.is_empty()).then_some(stem)
            })
            .max()
    }
}

fn parse_history_tool_calls(content: &Value) -> Vec<ToolCall> {
    let Some(parts) = content.get("content").and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    parts
        .iter()
        .filter(|p| p.get("type").and_then(|t| t.as_str()) == Some("toolUse"))
        .filter_map(|p| {
            Some(ToolCall {
                id: String::new(),
                name: p.get("name")?.as_str()?.to_string(),
                arguments: p.get("input").cloned().unwrap_or(json!({})),
            })
        })
        .collect()
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginStartParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountLoginCancelParams {
    pub command_id: CommandId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceLoginParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SupersedeLoginCredentialParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionActivationParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerOAuthLoginParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerOAuthLoginCancelParams {
    pub command_id: CommandId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseSetupReadParams {
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapCancelParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStopAllParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogSubscribeParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogUnsubscribeParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPageParams {
    pub session_id: SessionId,
    pub limit: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsReadParams {
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsWriteValueParams {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsWriteManyParams {
    pub values: HashMap<String, String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerAdmissionParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionProfileSetParams {
    pub command_id: CommandId,
    pub profile: String,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessBackgroundParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectionReadParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLaunchParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledFireParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameParams {
    pub command_id: Option<CommandId>,
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSetActivationParams {
    pub activation: String,
    pub command_id: CommandId,
    pub scope: String,
    pub selector: String,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTargetParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub subagent_id: SubagentId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSubmitOriginParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolConfigurationParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewUnsubscribeBySessionIdParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowControlParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTriggerConfigurationParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRewindEvaluateParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalSessionMessageParams {
    pub command_id: Option<CommandId>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineConceptSetParams {
    pub command_id: Option<CommandId>,
    pub idea: String,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineSpecReadParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelinePlanReadParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineVerifyReadParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineShipReadParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineOperateReadParams {
    pub session_id: SessionId,
}

// ---------- request param types ----------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRenameParams {
    pub command_id: CommandId,
    pub name: String,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSideChatParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetApprovalModeParams {
    pub command_id: CommandId,
    pub mode: crate::ApprovalMode,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetReasoningEffortParams {
    pub command_id: CommandId,
    pub reasoning_effort: crate::ReasoningEffort,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCancelParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerParams {
    pub command_id: CommandId,
    pub expected_turn_id: TurnId,
    pub input: Vec<TurnInputPart>,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUnqueueParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStopParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub task_id: TaskId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalListPendingParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseSettingsReadParams {
    pub show_built_ins: Option<bool>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPageParams {
    pub limit: u32,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSubscribeParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewUnsubscribeParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemReadOutputParams {
    pub item_id: String,
    pub output_ref: String,
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub target: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookListParams {
    pub session_id: SessionId,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitParams {
    pub classification: String,
    pub note: String,
    pub with_files: bool,
}

/// Convert a stored wire content array into protocol ContentPart values.
fn parts_to_core(value: &Value) -> Option<Vec<prricode_core::types::ContentPart>> {
    let array = value.as_array()?;
    let parts = array
        .iter()
        .filter_map(|part| match part.get("type")?.as_str()? {
            "text" => Some(prricode_core::types::ContentPart::Text {
                text: part.get("text")?.as_str()?.to_string(),
            }),
            "toolUse" => Some(prricode_core::types::ContentPart::ToolUse {
                name: part.get("name")?.as_str()?.to_string(),
                input: part.get("input").cloned().unwrap_or(json!({})),
            }),
            "toolResult" => Some(prricode_core::types::ContentPart::ToolResult {
                content: vec![prricode_core::types::ContentPart::Text {
                    text: part
                        .get("text")
                        .and_then(|t| t.as_str())
                        .unwrap_or("")
                        .to_string(),
                }],
            }),
            _ => None,
        })
        .collect();
    Some(parts)
}

/// Probe the host's computer-use permissions (X11 backend).
fn computer_use_state() -> ComputerUseSetupState {
    let probe = prricode_computer_use::ComputerUse::probe();
    let state = probe.state();
    ComputerUseSetupState {
        accessibility: match state.accessibility {
            prricode_computer_use::Permission::Granted => ComputerUsePermission::Granted,
            prricode_computer_use::Permission::Missing => ComputerUsePermission::Missing,
            prricode_computer_use::Permission::Unknown => ComputerUsePermission::Unknown,
        },
        input_monitoring: match state.input_monitoring {
            prricode_computer_use::Permission::Granted => ComputerUsePermission::Granted,
            prricode_computer_use::Permission::Missing => ComputerUsePermission::Missing,
            prricode_computer_use::Permission::Unknown => ComputerUsePermission::Unknown,
        },
        screen_recording: match state.screen_recording {
            prricode_computer_use::Permission::Granted => ComputerUsePermission::Granted,
            prricode_computer_use::Permission::Missing => ComputerUsePermission::Missing,
            prricode_computer_use::Permission::Unknown => ComputerUsePermission::Unknown,
        },
        setup: match state.setup {
            prricode_computer_use::SetupPhase::Dormant => ComputerUseSetupPhase::Dormant,
            prricode_computer_use::SetupPhase::InProgress => ComputerUseSetupPhase::InProgress,
            prricode_computer_use::SetupPhase::RestartRequired => {
                ComputerUseSetupPhase::RestartRequired
            }
            prricode_computer_use::SetupPhase::ReadyForTarget => {
                ComputerUseSetupPhase::ReadyForTarget
            }
            prricode_computer_use::SetupPhase::Stopped => ComputerUseSetupPhase::Stopped,
        },
    }
}

fn dirs_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// MCP server configuration (stdio transports from `~/.config/prricode/mcp.toml`).
mod mcp {
    #[derive(Debug, Clone)]
    pub struct McpServerConfig {
        pub name: String,
        pub command: String,
        pub args: Vec<String>,
    }

    /// Load `[[servers]]` tables from the MCP config file.
    pub fn load_mcp_servers() -> Vec<McpServerConfig> {
        let path = std::env::var("PRRICODE_MCP_CONFIG")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
                std::path::PathBuf::from(home).join(".config/prricode/mcp.toml")
            });
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Vec::new();
        };
        let Ok(table) = text.parse::<toml::Table>() else {
            return Vec::new();
        };
        table
            .get("servers")
            .and_then(|s| s.as_array())
            .map(|servers| {
                servers
                    .iter()
                    .filter_map(|server| {
                        let name = server.get("name")?.as_str()?.to_string();
                        let command = server.get("command")?.as_str()?.to_string();
                        let args = server
                            .get("args")
                            .and_then(|a| a.as_array())
                            .map(|a| {
                                a.iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        Some(McpServerConfig {
                            name,
                            command,
                            args,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

// ---------- tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn pipeline_methods_are_registered() {
        let (server, _rx) = PrricodeServer::new(
            std::env::temp_dir(),
            Box::new(prricode_provider::EchoProvider),
            None,
        );
        let request = serde_json::from_value::<JsonRpcRequest>(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pipeline/specRead",
            "params": { "sessionId": "00000000-0000-7000-8000-000000000001" }
        }))
        .unwrap();
        let response = server.handle_request(request).await;
        assert!(response.error.is_none(), "pipeline/specRead must not error");
    }

    #[tokio::test]
    async fn pipeline_verify_read_returns_null_for_an_unknown_session() {
        let data_dir = std::env::temp_dir().join(format!(
            "prricode-server-verify-null-{}",
            std::process::id()
        ));
        let (server, _rx) =
            PrricodeServer::new(data_dir, Box::new(prricode_provider::EchoProvider), None);
        let request = serde_json::from_value::<JsonRpcRequest>(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pipeline/verifyRead",
            "params": { "sessionId": "00000000-0000-7000-8000-000000000001" }
        }))
        .unwrap();
        let response = server.handle_request(request).await;
        assert!(
            response.error.is_none(),
            "pipeline/verifyRead must not error for an unknown session"
        );
        assert_eq!(
            response.result.expect("ok result")["report"],
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn pipeline_verify_read_returns_the_latest_persisted_report() {
        let data_dir = std::env::temp_dir().join(format!(
            "prricode-server-verify-read-{}",
            std::process::id()
        ));
        let report = prricode_verify::VerificationReport {
            run_id: "run-42".into(),
            gates: vec![],
            requirements: vec![prricode_verify::GateVerdict {
                requirement_id: "R1".into(),
                verdict: prricode_verify::Verdict::Pass,
                evidence: "tests green".into(),
            }],
            not_tested: vec![],
            residual_risk: vec![],
        };
        prricode_verify::dossier::persist_report(&Persistence::new(&data_dir).unwrap(), &report)
            .unwrap();
        let (server, _rx) = PrricodeServer::new(
            data_dir.clone(),
            Box::new(prricode_provider::EchoProvider),
            None,
        );
        let request = serde_json::from_value::<JsonRpcRequest>(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pipeline/verifyRead",
            "params": { "sessionId": "00000000-0000-7000-8000-000000000002" }
        }))
        .unwrap();
        let response = server.handle_request(request).await;
        assert!(response.error.is_none());
        let result = response.result.expect("ok result");
        assert_eq!(result["report"]["run_id"], "run-42");
        assert_eq!(result["report"]["requirements"][0]["verdict"], "pass");
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[tokio::test]
    async fn pipeline_ship_read_returns_null_for_an_unknown_session() {
        let data_dir =
            std::env::temp_dir().join(format!("prricode-server-ship-null-{}", std::process::id()));
        let (server, _rx) =
            PrricodeServer::new(data_dir, Box::new(prricode_provider::EchoProvider), None);
        let request = serde_json::from_value::<JsonRpcRequest>(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pipeline/shipRead",
            "params": { "sessionId": "00000000-0000-7000-8000-000000000001" }
        }))
        .unwrap();
        let response = server.handle_request(request).await;
        assert!(
            response.error.is_none(),
            "pipeline/shipRead must not error for an unknown session"
        );
        assert_eq!(
            response.result.expect("ok result")["ship"],
            serde_json::Value::Null
        );
    }

    #[tokio::test]
    async fn pipeline_operate_read_returns_empty_for_an_unknown_session() {
        let data_dir = std::env::temp_dir().join(format!(
            "prricode-server-operate-null-{}",
            std::process::id()
        ));
        let (server, _rx) =
            PrricodeServer::new(data_dir, Box::new(prricode_provider::EchoProvider), None);
        let request = serde_json::from_value::<JsonRpcRequest>(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pipeline/operateRead",
            "params": { "sessionId": "00000000-0000-7000-8000-000000000001" }
        }))
        .unwrap();
        let response = server.handle_request(request).await;
        assert!(
            response.error.is_none(),
            "pipeline/operateRead must not error for an unknown session"
        );
        assert_eq!(
            response.result.expect("ok result")["events"],
            serde_json::json!([])
        );
    }

    #[tokio::test]
    async fn pipeline_ship_read_returns_the_latest_persisted_record() {
        let data_dir =
            std::env::temp_dir().join(format!("prricode-server-ship-read-{}", std::process::id()));
        let mut record = prricode_ship::ShipRecord::new("run-ship-42");
        record.repo = "acme/probe".into();
        record.tag = Some("v2026-10-14-abcdef01".into());
        record.install_steps = vec!["cargo run".into()];
        Persistence::new(&data_dir)
            .unwrap()
            .set_setting("ship:run-ship-42", &serde_json::to_string(&record).unwrap())
            .unwrap();
        let (server, _rx) = PrricodeServer::new(
            data_dir.clone(),
            Box::new(prricode_provider::EchoProvider),
            None,
        );
        let request = serde_json::from_value::<JsonRpcRequest>(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pipeline/shipRead",
            "params": { "sessionId": "00000000-0000-7000-8000-000000000002" }
        }))
        .unwrap();
        let response = server.handle_request(request).await;
        assert!(response.error.is_none());
        let result = response.result.expect("ok result");
        assert_eq!(result["ship"]["run_id"], "run-ship-42");
        assert_eq!(result["ship"]["repo"], "acme/probe");
        assert_eq!(result["ship"]["tag"], "v2026-10-14-abcdef01");
        assert_eq!(result["ship"]["install_steps"][0], "cargo run");
        // The record has no field that could carry deploy material.
        assert!(result["ship"].get("requiredCredentials").is_none());
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[tokio::test]
    async fn pipeline_operate_read_returns_the_sessions_log_events() {
        let data_dir = std::env::temp_dir().join(format!(
            "prricode-server-operate-read-{}",
            std::process::id()
        ));
        let event = |kind: &str, detail: &str| {
            prricode_ship::OperateEvent::new("run-operate-1", kind, detail)
        };
        prricode_ship::operate::append_operate_log(
            &data_dir,
            "run-operate-1",
            &event("ship", "shipped acme/probe as v1"),
        )
        .unwrap();
        prricode_ship::operate::append_operate_log(
            &data_dir,
            "run-operate-1",
            &event("health", "release ok: exit code 0"),
        )
        .unwrap();
        let persistence = Persistence::new(&data_dir).unwrap();
        persistence
            .set_setting(
                "pipeline:00000000-0000-7000-8000-000000000003",
                r#"{"stage":"ship","runId":"run-operate-1"}"#,
            )
            .unwrap();
        let (server, _rx) = PrricodeServer::new(
            data_dir.clone(),
            Box::new(prricode_provider::EchoProvider),
            None,
        );
        let request = serde_json::from_value::<JsonRpcRequest>(serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "pipeline/operateRead",
            "params": { "sessionId": "00000000-0000-7000-8000-000000000003" }
        }))
        .unwrap();
        let response = server.handle_request(request).await;
        assert!(response.error.is_none());
        let result = response.result.expect("ok result");
        let events = result["events"].as_array().expect("events array");
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["kind"], "ship");
        assert_eq!(events[1]["kind"], "health");
        std::fs::remove_dir_all(&data_dir).ok();
    }
}
