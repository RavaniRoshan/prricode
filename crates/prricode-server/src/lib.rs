use anyhow::Result;
use prricode_core::protocol::*;
use prricode_core::types::*;
use prricode_core::*;
use prricode_persistence::*;
use prricode_provider::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use uuid::Uuid;

pub struct MspServer {
    data_dir: PathBuf,
    sessions: Arc<RwLock<HashMap<String, SessionState>>>,
    goals: Arc<RwLock<HashMap<String, GoalRecord>>>,
    provider: Box<dyn ModelProvider>,
}

#[derive(Debug, Implementation)]
struct SessionState {
    id: String,
    workspace_root: Option<String>,
    model_id: Option<String>,
    provider_id: String,
    approval_mode: String,
    items: Vec<Value>,
}

impl MspServer {
    pub fn new(data_dir: PathBuf, provider_kind: ProviderKind) -> Self {
        Self {
            data_dir,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            goals: Arc::new(RwLock::new(HashMap::new())),
            provider: create_provider(provider_kind),
        }
    }

    pub async fn handle_request_from_value(&self, value: Value) -> JsonRpcResponse {
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

    pub async fn handle_request(&self, req: JsonRpcRequest) -> JsonRpcResponse {
        let id = req.id.implementation();
        match self.dispatch(&req.method, req.params).await {
            Ok(result) => JsonRpcResponse {
                jsonrpc: "2.0".into(),
                id,
                result: Some(result),
                error: None,
            },
            Err(err) => {
                let error = if let Some(rpc_err) = err.downcast_ref::<RpcError>() {
                    rpc_err.0.implementation()
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

    async fn dispatch(&self, method: &str, params: Option<Value>) -> Result<Value> {
        match method {
            "initialize" => self.handle_initialize(params).await,
            "session/start" => self.handle_session_start(params).await,
            "session/read" => self.handle_session_read(params).await,
            "session/list" => self.handle_session_list().await,
            "session/resume" => self.handle_session_resume(params).await,
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
            "computerUseSetup/check" => self.handle_computer_use_check().await,
            "computerUseSetup/start" => self.handle_computer_use_start(params).await,
            "computerUseSettings/read" => self.handle_computer_use_settings_read().await,
            "computerUseSettings/update" => self.handle_computer_use_settings_update(params).await,
            "approval/decide" => self.handle_approval_decide(params).await,
            "approval/listPending" => self.handle_approval_list_pending(params).await,
            "subagent/close" => self.handle_subagent_close(params).await,
            "subagent/sendMessage" => self.handle_subagent_send_message(params).await,
            "task/background" => self.handle_task_background(params).await,
            "task/stop" => self.handle_task_stop(params).await,
            "task/list" => self.handle_task_list(params).await,
            "skill/list" => self.handle_skill_list(params).await,
            "skill/import" => self.handle_skill_import(params).await,
            "model/list" => self.handle_model_list(params).await,
            "usage/read" => self.handle_usage_read().await,
            "userInput/answer" => self.handle_user_input_answer(params).await,
            "media/upload" => self.handle_media_upload(params).await,
            "recap/request" => self.handle_recap_request(params).await,
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
            "item/readOutput" => self.handle_item_read_output(params).await,
            "plugin/list" => self.handle_plugin_list(params).await,
            "plugin/install" => self.handle_plugin_install(params).await,
            "hook/list" => self.handle_hook_list(params).await,
            "feedback/submit" => self.handle_feedback_submit(params).await,
            "turn/cancel" => self.handle_turn_cancel(params).await,
            "turn/interrupt" => self.handle_turn_interrupt(params).await,
            "turn/steer" => self.handle_turn_steer(params).await,
            "turn/unqueue" => self.handle_turn_unqueue(params).await,
            _ => Err(JsonRpcError::method_not_found(format!("unknown method: {method}")).into()),
        }
    }

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
            user_agent: format!("prricode/{} (serve; {}-{}; build 00000000000000000000000000000000000000000000000000000000000)",
                SERVER_VERSION, std::env::consts::OS, std::env::consts::ARCH),
        };
        Ok(serde_json::to_value(result)?)
    }

    async fn handle_session_start(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionStartParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let session_id = params.session_id.unwrap_or_else(Uuid::now_v7);
        let state = SessionState {
            id: session_id.to_string(),
            workspace_root: params.workspace_root.implementation(),
            model_id: params.model_id.implementation(),
            provider_id: params.provider_id.map(|p| p.id().to_string()).unwrap_or_else(|| "echo".into()),
            approval_mode: params.approval_mode.map(|m| format!("{m:?}")).unwrap_or_else(|| "closed".into()),
            items: vec![],
        };
        let record = SessionRecord {
            id: state.id.implementation(),
            workspace_root: state.workspace_root.implementation(),
            model_id: state.model_id.implementation(),
            provider_id: Some(state.provider_id.implementation()),
            approval_mode: Some(state.approval_mode.implementation()),
        };
        let persistence = Persistence::new(&self.data_dir)?;
        persistence.save_session(&record)?;
        self.sessions.write().await.insert(session_id.to_string(), state);
        Ok(serde_json::to_value(SessionStartResult { session_id })?)
    }

    async fn handle_session_read(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionReadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let sessions = self.sessions.read().await;
        let session = sessions.get(&params.session_id.to_string())
            .ok_or_else(|| JsonRpcError::session_not_found())?;
        let result = SessionReadResult {
            session_id: params.session_id,
            items: session.items.iter().map(|item| {
                SessionItem {
                    id: item.get("id").and_then(|v| v.as_str()).unwrap_or("").into(),
                    kind: item.get("kind").and_then(|v| v.as_str()).unwrap_or("").into(),
                    role: item.get("role").and_then(|v| v.as_str()).map(String::from),
                    content: None,
                }
            }).collect(),
            cursor: None,
        };
        Ok(serde_json::to_value(result)?)
    }

    async fn handle_session_list(&self) -> Result<Value> {
        let sessions = self.sessions.read().await;
        let items: Vec<Value> = sessions.values().map(|s| json!({
            "sessionId": s.id,
            "workspaceRoot": s.workspace_root,
            "modelId": s.model_id,
            "providerId": s.provider_id,
            "approvalMode": s.approval_mode,
        })).collect();
        Ok(json!({ "sessions": items }))
    }

    async fn handle_session_resume(&self, params: Option<Value>) -> Result<Value> {
        let _params: SessionResumeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "resumed": true }))
    }

    async fn handle_turn_start(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnStartParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let turn_id = Uuid::now_v7();
        let sessions = self.sessions.read().await;
        let session = sessions.get(&params.session_id.to_string())
            .ok_or_else(|| JsonRpcError::session_not_found())?;
        let response = self.provider.generate(ModelRequest {
            model_id: session.model_id.implementation().unwrap_or_else(|| "echo".into()),
            messages: params.input.iter().filter_map(|part| {
                if let TurnInputPart::Text { text } = part {
                    Some(Message { role: "user".into(), content: text.implementation() })
                } else { None }
            }).collect(),
            max_tokens: 4096,
            temperature: 0.7,
        }).await?;
        Ok(serde_json::to_value(TurnStartResult {
            turn_id,
            command_id: params.command_id,
        })?)
        .map(|mut v| {
            v["response"] = json!({
                "content": response.content,
                "inputTokens": response.input_tokens,
                "outputTokens": response.output_tokens,
                "finishReason": response.finish_reason,
            });
            v
        })
    }

    async fn handle_goal_set(&self, params: Option<Value>) -> Result<Value> {
        let params: GoalSetParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let goal_id = Uuid::now_v7().to_string();
        let goal = GoalRecord {
            id: goal_id.implementation(),
            session_id: params.session_id.to_string(),
            objective: params.objective,
            status: "active".into(),
            percent_complete: 0,
            current_work: None,
            next_work: None,
        };
        let persistence = Persistence::new(&self.data_dir)?;
        persistence.save_goal(&goal)?;
        self.goals.write().await.insert(goal_id.implementation(), goal);
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "set".into(),
        })?)
    }

    async fn handle_goal_edit(&self, params: Option<Value>) -> Result<Value> {
        let params: GoalEditParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "edited".into(),
        })?)
    }

    async fn handle_goal_clear(&self, params: Option<Value>) -> Result<Value> {
        let params: GoalClearParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "cleared".into(),
        })?)
    }

    async fn handle_goal_pause(&self, params: Option<Value>) -> Result<Value> {
        let params: GoalPauseParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "paused".into(),
        })?)
    }

    async fn handle_goal_resume(&self, params: Option<Value>) -> Result<Value> {
        let params: GoalResumeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(GoalCommandResult {
            command_id: params.command_id,
            status: "resumed".into(),
        })?)
    }

    async fn handle_workflow_cancel(&self, params: Option<Value>) -> Result<Value> {
        let params: WorkflowCancelParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(WorkflowControlResult {
            command_id: params.command_id,
            status: "cancelled".into(),
        })?)
    }

    async fn handle_workflow_pause(&self, params: Option<Value>) -> Result<Value> {
        let params: WorkflowPauseParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(WorkflowControlResult {
            command_id: params.command_id,
            status: "paused".into(),
        })?)
    }

    async fn handle_workflow_resume(&self, params: Option<Value>) -> Result<Value> {
        let params: WorkflowResumeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(WorkflowResumeResult {
            command_id: params.command_id,
            status: "resumed".into(),
            turn_id: Uuid::now_v7(),
        })?)
    }

    async fn handle_workflow_child_control(&self, params: Option<Value>) -> Result<Value> {
        let params: WorkflowChildControlParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(WorkflowControlResult {
            command_id: params.command_id,
            status: format!("{}d", match params.action { WorkflowChildAction::Skip => "skip", WorkflowChildAction::Retry => "retr" }),
        })?)
    }

    async fn handle_computer_use_check(&self) -> Result<Value> {
        Ok(serde_json::to_value(ComputerUseSetupState {
            accessibility: ComputerUsePermission::Missing,
            input_monitoring: ComputerUsePermission::Missing,
            screen_recording: ComputerUsePermission::Missing,
            setup: ComputerUseSetupPhase::Dormant,
        })?)
    }

    async fn handle_computer_use_start(&self, params: Option<Value>) -> Result<Value> {
        let _params: ComputerUseSetupStartParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(ComputerUseSetupState {
            accessibility: ComputerUsePermission::Granted,
            input_monitoring: ComputerUsePermission::Granted,
            screen_recording: ComputerUsePermission::Granted,
            setup: ComputerUseSetupPhase::InProgress,
        })?)
    }

    async fn handle_computer_use_settings_read(&self) -> Result<Value> {
        Ok(serde_json::to_value(ComputerUseSettings {
            blocked_apps: None,
            computer_control: Some(ComputerUseChoice::Ask),
            screenshots: Some(ComputerUseChoice::Ask),
        })?)
    }

    async fn handle_computer_use_settings_update(&self, params: Option<Value>) -> Result<Value> {
        let _params: ComputerUseSettingsUpdateParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(ComputerUseSettings {
            blocked_apps: None,
            computer_control: Some(ComputerUseChoice::Ask),
            screenshots: Some(ComputerUseChoice::Ask),
        })?)
    }

    async fn handle_approval_decide(&self, params: Option<Value>) -> Result<Value> {
        let params: ApprovalDecideParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(ApprovalDecideResult {
            command_id: params.command_id,
            status: "decided".into(),
        })?)
    }

    async fn handle_approval_list_pending(&self, params: Option<Value>) -> Result<Value> {
        let _params: ApprovalListPendingParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "approvals": [] }))
    }

    async fn handle_subagent_close(&self, params: Option<Value>) -> Result<Value> {
        let params: SubagentCloseParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(CommandAcceptedResult { command_id: params.command_id })?)
    }

    async fn handle_subagent_send_message(&self, params: Option<Value>) -> Result<Value> {
        let params: SubagentInputParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(CommandAcceptedResult { command_id: params.command_id })?)
    }

    async fn handle_task_background(&self, params: Option<Value>) -> Result<Value> {
        let params: TaskBackgroundParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(TaskCommandResult { command_id: params.command_id })?)
    }

    async fn handle_task_stop(&self, params: Option<Value>) -> Result<Value> {
        let params: TaskStopParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(TaskCommandResult { command_id: params.command_id })?)
    }

    async fn handle_task_list(&self, params: Option<Value>) -> Result<Value> {
        let _params: TaskListParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "tasks": [] }))
    }

    async fn handle_skill_list(&self, params: Option<Value>) -> Result<Value> {
        let _params: SkillListParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "skills": [] }))
    }

    async fn handle_skill_import(&self, params: Option<Value>) -> Result<Value> {
        let params: SkillImportParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "imported": false, "source": params.source }))
    }

    async fn handle_model_list(&self, params: Option<Value>) -> Result<Value> {
        let _params: ModelListParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        let models = self.provider.list_models().await?;
        let entries: Vec<Value> = models.iter().map(|m| json!({
            "modelId": m.model_id,
            "providerId": self.provider.kind().id(),
            "profileId": "default",
            "contextLimit": m.context_limit,
            "outputLimit": 4096,
            "displayLabel": m.display_label,
            "isActive": m.is_active,
            "isDefault": m.is_active,
        })).collect();
        Ok(json!({ "models": entries }))
    }

    async fn handle_usage_read(&self) -> Result<Value> {
        Ok(serde_json::to_value(UsageReadResult {
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cost: 0.0,
        })?)
    }

    async fn handle_user_input_answer(&self, params: Option<Value>) -> Result<Value> {
        let params: UserInputAnswerParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "accepted": true }))
    }

    async fn handle_media_upload(&self, params: Option<Value>) -> Result<Value> {
        let params: MediaUploadParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "received": true, "chunkIndex": params.chunk_index }))
    }

    async fn handle_recap_request(&self, params: Option<Value>) -> Result<Value> {
        let params: RecapRequestParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(RecapRequestResult {
            command_id: params.command_id,
            status: "requested".into(),
        })?)
    }

    async fn handle_user_shell(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionUserShellParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(SessionUserShellResult {
            exit_code: 0,
            stdout: params.command_text,
            stderr: String::new(),
        })?)
    }

    async fn handle_session_set_model(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionSetModelParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "model": params.model }))
    }

    async fn handle_session_set_approval_mode(&self, params: Option<Value>) -> Result<Value> {
        let _params: SessionSetApprovalModeParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "status": "updated" }))
    }

    async fn handle_session_set_reasoning_effort(&self, params: Option<Value>) -> Result<Value> {
        let _params: SessionSetReasoningEffortParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "status": "updated" }))
    }

    async fn handle_session_rename(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionRenameParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "name": params.name }))
    }

    async fn handle_session_side_chat(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionSideChatParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "started": true }))
    }

    async fn handle_session_compact(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionCompactParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(serde_json::to_value(SessionCompactResult { compacted: true })?)
    }

    async fn handle_session_fork(&self, params: Option<Value>) -> Result<Value> {
        let params: SessionForkParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "forkedSessionId": Uuid::now_v7() }))
    }

    async fn handle_view_page(&self, params: Option<Value>) -> Result<Value> {
        let _params: ViewPageParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "items": [], "hasMore": false }))
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

    async fn handle_turn_cancel(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnCancelParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "cancelled": true }))
    }

    async fn handle_turn_interrupt(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnInterruptParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "interrupted": true }))
    }

    async fn handle_turn_steer(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnSteerParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "steered": true }))
    }

    async fn handle_turn_unqueue(&self, params: Option<Value>) -> Result<Value> {
        let params: TurnUnqueueParams = serde_json::from_value(params.unwrap_or(json!({})))?;
        Ok(json!({ "commandId": params.command_id, "unqueued": true }))
    }
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SessionResumeParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SessionRenameParams {
    pub command_id: CommandId,
    pub name: String,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SessionSideChatParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SessionForkParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SessionSetApprovalModeParams {
    pub command_id: CommandId,
    pub mode: crate::ApprovalMode,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SessionSetReasoningEffortParams {
    pub command_id: CommandId,
    pub reasoning_effort: crate::ReasoningEffort,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct TurnCancelParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct TurnInterruptParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct TurnSteerParams {
    pub command_id: CommandId,
    pub expected_turn_id: TurnId,
    pub input: Vec<TurnInputPart>,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct TurnUnqueueParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct TaskStopParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub task_id: TaskId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct TaskStopAllParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct TaskListParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SkillListParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SkillSetActivationParams {
    pub activation: String,
    pub command_id: CommandId,
    pub scope: String,
    pub selector: String,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ApprovalListPendingParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SubagentTargetParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub subagent_id: SubagentId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ComputerUseSetupReadParams {
    pub session_id: Option<SessionId>,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ComputerUseSettingsReadParams {
    pub show_built_ins: Option<bool>,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ViewPageParams {
    pub limit: u32,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ViewSubscribeParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ViewUnsubscribeParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ViewUnsubscribeBySessionIdParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ItemReadOutputParams {
    pub item_id: String,
    pub output_ref: String,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct PluginListParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct PluginInstallParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
    pub target: String,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct HookListParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct FeedbackSubmitParams {
    pub classification: String,
    pub note: String,
    pub with_files: bool,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct RecapCancelParams {
    pub command_id: CommandId,
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct AccountLoginStartParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct AccountLoginCancelParams {
    pub command_id: CommandId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct McpServerOAuthLoginParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct McpServerOAuthLoginCancelParams {
    pub command_id: CommandId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct LogSubscribeParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct LogUnsubscribeParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct LogPageParams {
    pub session_id: SessionId,
    pub limit: u32,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ProjectionReadParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ConversationRewindEvaluateParams {
    pub session_id: SessionId,
}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SupersedeLoginCredentialParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct DeviceLoginParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SubscriptionActivationParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ProcessBackgroundParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SessionNameParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct PermissionProfileSetParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct LocalSessionMessageParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct PeerAdmissionParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ScheduledFireParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SettingsReadParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SettingsWriteValueParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct SettingsWriteManyParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct WorkflowTriggerConfigurationParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct RuntimeLaunchParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct WorkflowControlParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct TurnSubmitOriginParams {}

#[derive(Debug, Implementation, serde::Serialize, serde::Deserialize)]
pub struct ToolConfigurationParams {}
