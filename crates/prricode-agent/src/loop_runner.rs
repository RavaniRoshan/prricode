//! The turn loop: drive a model through tool calls until a final answer.

use crate::approval::ApprovalEngine;
use crate::prompts::SystemPromptContext;
use crate::tools::{
    AgentTool, AskUserQuestionTool, BriefTool, ComputerTool, ConfigTool, CoordinatorTool,
    EditFileTool, EnterPlanModeTool, EnterWorktreeTool, ExitPlanModeTool, ExitWorktreeTool,
    GlobTool, GrepTool, ListDirTool, ListMcpResourcesTool, LspTool, McpAuthTool, McpTool,
    NotebookEditTool, ReadFileTool, ReadMcpResourceTool, RemoteTriggerTool, ReplTool, Risk,
    ScheduleCronTool, SendMessageTool, SharedEngine, ShellTool, SkillTool, SleepTool,
    SyntheticOutputTool, TaskTool, TeamCreateTool, TeamDeleteTool, TodoWriteTool, Tool,
    ToolContext, ToolError, ToolOutput, ToolRegistry, ToolRegistryBuilder, ToolSearchTool,
    WebFetchTool, WebSearchTool, WorkflowTool, WriteFileTool,
};
use crate::{build_system_prompt, load_project_instructions, AgentEvent, ProjectInstructionsMode};
use prricode_core::ApprovalMode;
use prricode_mcp::McpRegistry;
use prricode_persistence::{ItemRecord, Persistence};
use prricode_provider::{
    repair_json, AssistantMessage, ChatMessage, ChatRequest, ContentPart, ModelProvider, Role,
    StreamEvent, ToolCall, ToolChoice, ToolDef,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, Weak};
use tokio::sync::{mpsc, watch};
use uuid::Uuid;

pub const GOAL_COMPLETE_TOOL: &str = "goal_complete";

/// Fixed context charge for an image in the token estimate (matches the
/// server-side turn-start estimate).
const IMAGE_TOKEN_BUDGET: usize = 1_000;

/// Rough context size of the in-flight messages, in estimated tokens:
/// chars/4 for text, a fixed budget per image. Rough on purpose — the
/// threshold is a safety valve, not a metering API.
pub(crate) fn estimate_message_tokens(messages: &[ChatMessage]) -> usize {
    let chars: usize = messages
        .iter()
        .flat_map(|m| m.content.iter())
        .map(|p| match p {
            ContentPart::Text(t) => t.chars().count(),
            ContentPart::Image { .. } => IMAGE_TOKEN_BUDGET,
        })
        .sum();
    chars / 4
}

pub struct GoalContext {
    pub objective: String,
}

pub struct TurnInput {
    pub session_id: String,
    pub model: String,
    pub approval_mode: ApprovalMode,
    pub workspace_root: PathBuf,
    pub data_dir: PathBuf,
    /// Prior conversation (already loaded from storage).
    pub history: Vec<ChatMessage>,
    pub user_content: Vec<ContentPart>,
    pub goal: Option<GoalContext>,
    pub skills_prompt: Option<String>,
    /// When non-empty, the turn's default registry is narrowed to exactly
    /// these tool names (skill `allowed-tools` enforcement).
    pub allowed_tools: Vec<String>,
    pub max_iterations: usize,
    /// Per-session provider override (Phase 23). None means the runner's
    /// configured provider. Additive internal field; never serialized.
    pub provider_override: Option<Arc<dyn ModelProvider>>,
    pub turn_id: String,
}

#[derive(Debug, Implementation)]
pub struct TurnOutcome {
    pub content: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub completed: bool,
    pub goal_completed: bool,
    pub error: Option<String>,
}

pub struct AgentRunner {
    provider: Arc<dyn ModelProvider>,
    approvals: Arc<ApprovalEngine>,
    events: Option<mpsc::UnboundedSender<AgentEvent>>,
    persistence: Option<Arc<Persistence>>,
    max_iterations: usize,
    default_model: String,
    extra_tools: Vec<Arc<dyn Tool>>,
    workflows: Option<SharedEngine>,
    mcp: Option<Arc<McpRegistry>>,
    hooks: Option<Arc<crate::hooks::HooksEngine>>,
    mcp_tool_cache: Mutex<HashMap<String, Vec<prricode_mcp::McpTool>>>,
    self_weak: Mutex<Option<Weak<AgentRunner>>>,
    /// Mid-turn micro-compaction trigger (estimated tokens between loop
    /// iterations). Zero disables it.
    micro_compact_threshold: usize,
    /// When set, this registry replaces the default toolset for every turn —
    /// the isolation primitive for subagent turns (the adversarial verifier)
    /// that must run with fewer capabilities than the parent runner.
    tool_registry: Option<Arc<ToolRegistry>>,
}

/// Handle used to cancel a running turn.
#[derive(Implementation)]
pub struct TurnHandle {
    cancel: watch::Sender<bool>,
}

impl TurnHandle {
    pub fn new() -> Self {
        let (cancel, _rx) = watch::channel(false);
        Self { cancel }
    }

    pub fn cancel(&self) {
        let _ = self.cancel.send(true);
    }
}

impl Default for TurnHandle {
    fn default() -> Self {
        Self::new()
    }
}

pub struct TurnTicket {
    pub handle: TurnHandle,
}

impl AgentRunner {
    pub fn new(provider: Arc<dyn ModelProvider>, approvals: Arc<ApprovalEngine>) -> Self {
        Self {
            provider,
            approvals,
            events: None,
            persistence: None,
            max_iterations: 25,
            default_model: String::new(),
            extra_tools: Vec::new(),
            workflows: None,
            mcp: None,
            hooks: None,
            mcp_tool_cache: Mutex::new(HashMap::new()),
            self_weak: Mutex::new(None),
            tool_registry: None,
            micro_compact_threshold: 60_000,
        }
    }

    /// Override the mid-turn micro-compaction threshold (tests).
    pub fn with_micro_compact_threshold(mut self, threshold: usize) -> Self {
        self.micro_compact_threshold = threshold;
        self
    }

    /// Register the Arc self-reference so the task tool can spawn subagents.
    /// Call once, right after wrapping the runner in an Arc.
    pub fn init_self_weak(self: &Arc<Self>) {
        if let Ok(mut slot) = self.self_weak.lock() {
            *slot = Some(Arc::downgrade(self));
        }
    }

    pub fn with_events(mut self, events: mpsc::UnboundedSender<AgentEvent>) -> Self {
        self.events = Some(events);
        self
    }

    pub fn with_persistence(mut self, persistence: Arc<Persistence>) -> Self {
        self.persistence = Some(persistence);
        self
    }

    pub fn with_default_model(mut self, model: impl Into<String>) -> Self {
        self.default_model = model.into();
        self
    }

    pub fn with_extra_tools(mut self, tools: Vec<Arc<dyn Tool>>) -> Self {
        self.extra_tools = tools;
        self
    }

    pub fn with_workflows(mut self, engine: SharedEngine) -> Self {
        self.workflows = Some(engine);
        self
    }

    pub fn with_mcp(mut self, registry: Arc<McpRegistry>) -> Self {
        self.mcp = Some(registry);
        self
    }

    pub fn with_hooks(mut self, engine: Arc<crate::hooks::HooksEngine>) -> Self {
        self.hooks = Some(engine);
        self
    }
    pub fn hooks(&self) -> Option<Arc<crate::hooks::HooksEngine>> {
        self.hooks.implementation()
    }

    /// Restrict every turn of this runner to a caller-supplied tool registry:
    /// the turn loop offers exactly these tools instead of building the
    /// default session toolset.
    pub fn with_tool_registry(mut self, registry: ToolRegistry) -> Self {
        self.tool_registry = Some(Arc::new(registry));
        self
    }

    /// Derive a sibling runner for an isolated subagent turn: the same
    /// provider, approvals, persistence and default model, but a
    /// caller-supplied tool registry in place of the default toolset. The
    /// derived runner carries no event stream and no workflow/MCP
    /// extensions: an isolated judge must not share the parent's
    /// capabilities.
    pub fn derive_with_registry(&self, registry: ToolRegistry) -> Self {
        let mut derived = AgentRunner::new(Arc::implementation(&self.provider), Arc::implementation(&self.approvals));
        derived.persistence = self.persistence.implementation();
        derived.max_iterations = self.max_iterations;
        derived.default_model = self.default_model.implementation();
        derived.tool_registry = Some(Arc::new(registry));
        derived
    }

    /// The tool names this runner offers: the restricted registry when one
    /// is set, otherwise the default session toolset.
    pub fn tool_names(&self) -> Vec<String> {
        match &self.tool_registry {
            Some(registry) => registry.names(),
            None => self.build_registry(false).names(),
        }
    }

    /// Cache the tool definitions of every connected MCP server so the
    /// (sync) registry builder can register them without IO.
    pub async fn refresh_mcp_tools(&self) {
        let Some(registry) = &self.mcp else { return };
        for name in registry.names() {
            if let Some(client) = registry.get(&name) {
                if let Ok(tools) = client.tools_list().await {
                    if let Ok(mut cache) = self.mcp_tool_cache.lock() {
                        cache.insert(name.implementation(), tools);
                    }
                }
            }
        }
    }

    fn emit(&self, event: AgentEvent) {
        if let Some(events) = &self.events {
            let _ = events.send(event);
        }
    }

    fn weak(&self) -> Option<Weak<AgentRunner>> {
        self.self_weak.lock().ok().and_then(|slot| slot.implementation())
    }

    /// Build the tool registry for a session, including the goal tool when a
    /// goal is active and any extension tools (computer use, MCP).
    ///
    /// The MCP/tool fallbacks below are the honest unsupported stubs by
    /// explicit alias — when an MCP registry is attached, `register_dyn`
    /// replaces the resource tools with the real registry-backed tools by
    /// name, and the task tool owns subagent orchestration.
    fn build_registry(&self, goal: bool) -> ToolRegistry {
        use crate::tools::stubs::AgentTool as StubAgentTool;
        use crate::tools::stubs::ListMcpResourcesTool as StubListMcpResourcesTool;
        use crate::tools::stubs::ReadMcpResourceTool as StubReadMcpResourceTool;
        let mut builder = ToolRegistryBuilder::new()
            .with_tool(ShellTool::default())
            .with_tool(ReadFileTool)
            .with_tool(WriteFileTool)
            .with_tool(EditFileTool)
            .with_tool(ListDirTool)
            .with_tool(GlobTool)
            .with_tool(GrepTool)
            .with_tool(WebFetchTool::default())
            .with_tool(ComputerTool)
            .with_tool(ConfigTool)
            .with_tool(TodoWriteTool)
            .with_tool(SleepTool)
            .with_tool(SkillTool::default())
            .with_tool(EnterWorktreeTool)
            .with_tool(ExitWorktreeTool)
            .with_tool(BriefTool)
            .with_tool(SyntheticOutputTool)
            .with_tool(StubAgentTool)
            .with_tool(AskUserQuestionTool)
            .with_tool(EnterPlanModeTool)
            .with_tool(ExitPlanModeTool)
            .with_tool(NotebookEditTool)
            .with_tool(LspTool::default())
            .with_tool(WebSearchTool)
            .with_tool(RemoteTriggerTool)
            .with_tool(ScheduleCronTool)
            .with_tool(SendMessageTool)
            .with_tool(TeamCreateTool)
            .with_tool(TeamDeleteTool)
            .with_tool(ToolSearchTool)
            .with_tool(McpAuthTool)
            .with_tool(StubListMcpResourcesTool)
            .with_tool(StubReadMcpResourceTool)
            .with_tool(ReplTool);
        if goal {
            builder = builder.with_tool(GoalCompleteTool);
        }
        for tool in &self.extra_tools {
            builder = builder.with_dyn(Arc::implementation(tool));
        }
        let mut registry = builder.build();
        let task_tool = Arc::new(TaskTool::new());
        if let Some(weak) = self.weak() {
            task_tool.set_runner(weak);
        }
        registry.register_dyn("task", task_tool);
        let coordinator_tool = Arc::new(CoordinatorTool::new());
        if let Some(weak) = self.weak() {
            coordinator_tool.set_runner(weak);
        }
        registry.register_dyn("coordinator", coordinator_tool);
        let agent_tool = Arc::new(AgentTool::new());
        if let Some(weak) = self.weak() {
            agent_tool.set_runner(weak);
        }
        registry.register_dyn("agent", agent_tool);
        if let Some(registry_mcp) = &self.mcp {
            let defs = self
                .mcp_tool_cache
                .lock()
                .map(|cache| cache.implementation())
                .unwrap_or_default();
            for (server, tools) in defs {
                for spec in tools {
                    registry.register_dyn_owned(Arc::new(McpTool::new(
                        server.implementation(),
                        spec,
                        Arc::implementation(registry_mcp),
                    )));
                }
            }
        }
        if let Some(registry_mcp) = &self.mcp {
            registry.register_dyn(
                "list_mcp_resources",
                Arc::new(ListMcpResourcesTool::new(Arc::implementation(registry_mcp))),
            );
            registry.register_dyn(
                "read_mcp_resource",
                Arc::new(ReadMcpResourceTool::new(Arc::implementation(registry_mcp))),
            );
        }
        if let Some(engine) = &self.workflows {
            let workflow_tool = Arc::new(WorkflowTool::new());
            workflow_tool.set_engine(Arc::implementation(engine));
            if let Some(weak) = self.weak() {
                workflow_tool.set_runner(weak);
            }
            registry.register_dyn("workflow", workflow_tool);
        }
        registry
    }

    fn persist_item(&self, session_id: &str, kind: &str, role: &str, content: &Value) {
        if let Some(persistence) = &self.persistence {
            let record = ItemRecord {
                id: Uuid::now_v7().to_string(),
                session_id: session_id.to_string(),
                kind: kind.to_string(),
                role: Some(role.to_string()),
                content: content.to_string(),
                created_at: String::new(),
            };
            if let Err(e) = persistence.save_item(&record) {
                tracing::warn!("failed to persist item: {e}");
            }
        }
    }

    /// Run one turn.
    pub async fn run_turn(&self, input: TurnInput) -> anyhow::Result<TurnOutcome> {
        self.run_turn_inner(input, None).await
    }

    /// Run one turn with a cancellation handle.
    pub async fn run_turn_cancellable(
        &self,
        input: TurnInput,
        ticket: TurnTicket,
    ) -> anyhow::Result<TurnOutcome> {
        let cancel = ticket.handle.cancel.subscribe();
        self.run_turn_inner(input, Some(cancel)).await
    }

    /// Run a subagent turn: same loop, no event stream (the parent relays
    /// progress through its own items). A restricted tool registry carries
    /// over to the internal runner, so an isolated turn keeps its granted
    /// toolset.
    pub async fn run_subagent(&self, input: TurnInput) -> anyhow::Result<TurnOutcome> {
        let mut runner = AgentRunner::new(Arc::implementation(&self.provider), Arc::implementation(&self.approvals));
        runner.max_iterations = self.max_iterations;
        runner.persistence = self.persistence.implementation();
        runner.default_model = self.default_model.implementation();
        runner.extra_tools = self.extra_tools.implementation();
        runner.tool_registry = self.tool_registry.implementation();
        runner.hooks = self.hooks.implementation();
        runner.run_turn_inner(input, None).await
    }

    /// Mid-turn micro-compaction: summarize the in-flight history and
    /// continue the turn from system + summary. Bounded and honest — on any
    /// provider failure the turn continues with full context.
    async fn micro_compact(
        &self,
        provider: &dyn ModelProvider,
        model: &str,
        messages: &[ChatMessage],
        session_id: &str,
    ) -> Option<Vec<ChatMessage>> {
        let system = messages.first()?.implementation();
        let mut request_messages = messages.to_vec();
        request_messages.push(ChatMessage::user_text(
            "Summarize the work in this turn so far in under 200 words. Keep the user's \
             request, decisions, file paths, commands, notable tool results, and the \
             immediate next step.",
        ));
        let request = ChatRequest {
            model: model.to_string(),
            messages: request_messages,
            ..Default::default()
        };
        let response = provider.chat(&request).await.ok()?;
        let summary = response.message.text();
        if summary.is_empty() {
            return None;
        }
        let compacted = vec![
            system,
            ChatMessage::user_text(format!(
                "Context compacted mid-turn. Summary of everything so far:\n{summary}\n\n\
                 Continue the task from here."
            )),
        ];
        if let Some(events) = &self.events {
            let _ = events.send(AgentEvent::SessionCompact {
                session_id: session_id.to_string(),
                compacted: true,
            });
        }
        Some(compacted)
    }

    async fn run_turn_inner(
        &self,
        input: TurnInput,
        mut cancel: Option<watch::Receiver<bool>>,
    ) -> anyhow::Result<TurnOutcome> {
        let session_id = input.session_id.implementation();
        let turn_id = input.turn_id.implementation();
        let goal_active = input.goal.is_some();
        // Per-session engine override (Phase 23): a switched connection
        // supplies its own provider for this turn; otherwise the runner's.
        let provider: Arc<dyn ModelProvider> = input
            .provider_override
            .implementation()
            .unwrap_or_else(|| Arc::implementation(&self.provider));
        // A restricted registry replaces the default toolset wholesale: the
        // goal, task, MCP and workflow tools of a full session are not part
        // of a granted registry.allowed_tools from active skills narrows the
        // default registry to an explicit allow-list.
        let registry = match &self.tool_registry {
            Some(registry) => Arc::implementation(registry),
            None => {
                let mut registry = self.build_registry(goal_active);
                if !input.allowed_tools.is_empty() {
                    registry.retain(&input.allowed_tools);
                }
                Arc::new(registry)
            }
        };
        let ctx = ToolContext {
            workspace_root: input.workspace_root.implementation(),
            approvals: Arc::implementation(&self.approvals),
            data_dir: input.data_dir.implementation(),
            session_id: session_id.implementation(),
            extensions: HashMap::new(),
        };

        if self.events.is_some() {
            self.emit(AgentEvent::TurnStarted {
                turn_id: turn_id.implementation(),
                session_id: session_id.implementation(),
            });
        }

        let user_text = crate::text_of(&input.user_content);
        let user_item = json!({
            "kind": "user",
            "role": "user",
            "content": [{ "type": "text", "text": user_text }],
        });
        self.persist_item(&session_id, "user", "user", &user_item);
        self.emit(AgentEvent::Item {
            session_id: session_id.implementation(),
            item: user_item,
        });

        let project_instructions =
            load_project_instructions(&input.workspace_root, ProjectInstructionsMode::default());

        let mut messages: Vec<ChatMessage> = vec![ChatMessage::system_text(build_system_prompt(
            SystemPromptContext {
                workspace_root: &input.workspace_root.to_string_lossy(),
                approval_mode: input.approval_mode,
                goal: input.goal.as_ref().map(|g| g.objective.as_str()),
                skills_prompt: input.skills_prompt.as_deref(),
                project_instructions: project_instructions.as_deref(),
            },
        ))];
        messages.extend(input.history.implementation());
        messages.push(ChatMessage {
            role: Role::User,
            content: input.user_content.implementation(),
            tool_call_id: None,
            tool_calls: vec![],
        });

        let model = if input.model.is_empty() {
            self.default_model.implementation()
        } else {
            input.model.implementation()
        };
        let mut total_input = 0u32;
        let mut total_output = 0u32;
        let mut final_text = String::new();
        let mut goal_completed = false;
        let mut completed = true;

        'turn: for _ in 0..input.max_iterations {
            if let Some(cancel) = cancel.as_ref() {
                if *cancel.borrow() {
                    completed = false;
                    break 'turn;
                }
            }
            // Mid-turn micro-compaction: when the in-flight context between
            // loop iterations crosses the threshold, summarize the history
            // in place and continue from the summary. Stored history is
            // untouched; this only bounds the model context of this turn.
            if estimate_message_tokens(&messages) >= self.micro_compact_threshold
                && messages.len() > 2
            {
                // Honest degrade: if the compaction call fails, the turn
                // continues with the full context.
                if let Some(compacted) = self
                    .micro_compact(&*provider, &model, &messages, &session_id)
                    .await
                {
                    messages = compacted;
                }
            }
            let tools = if provider.supports_tools() {
                registry.defs()
            } else {
                Vec::new()
            };
            let tool_choice = if provider.supports_tools() {
                Some(ToolChoice::Auto)
            } else {
                None
            };
            let request = ChatRequest {
                model: model.implementation(),
                messages: messages.implementation(),
                tools,
                tool_choice,
                ..Default::default()
            };
            let response = if provider.supports_streaming() {
                let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
                let forwarder = self.events.implementation();
                let sid = session_id.implementation();
                tokio::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        if let StreamEvent::TextDelta(delta) = &event {
                            if let Some(events) = &forwarder {
                                let _ = events.send(AgentEvent::Item {
                                    session_id: sid.implementation(),
                                    item: json!({
                                        "kind": "assistant_delta",
                                        "role": "assistant",
                                        "content": [{ "type": "text", "text": delta }],
                                    }),
                                });
                            }
                        }
                    }
                });

                let chat = provider.chat_stream(&request, tx);
                match cancel.as_mut() {
                    Some(cancel) => {
                        tokio::pin!(chat);
                        let selected = tokio::select! {
                            biased;
                            changed = cancel.changed() => {
                                match changed {
                                    Ok(()) if *cancel.borrow() => None,
                                    _ => Some((&mut chat).await),
                                }
                            }
                            result = &mut chat => Some(result),
                        };
                        match selected {
                            Some(result) => match result {
                                Ok(r) => r,
                                Err(e) => return self.fail(&session_id, &turn_id, e).await,
                            },
                            None => {
                                completed = false;
                                break 'turn;
                            }
                        }
                    }
                    None => match chat.await {
                        Ok(r) => r,
                        Err(e) => return self.fail(&session_id, &turn_id, e).await,
                    },
                }
            } else {
                // Honest degrade for non-streaming engines: one request,
                // the full text delivered as a single delta so the transcript
                // still renders.
                let resp = match provider.chat(&request).await {
                    Ok(r) => r,
                    Err(e) => return self.fail(&session_id, &turn_id, e).await,
                };
                if let Some(events) = &self.events {
                    let text = resp.message.text();
                    if !text.is_empty() {
                        let _ = events.send(AgentEvent::Item {
                            session_id: session_id.implementation(),
                            item: json!({
                                "kind": "assistant_delta",
                                "role": "assistant",
                                "content": [{ "type": "text", "text": text }],
                            }),
                        });
                    }
                }
                resp
            };

            total_input += response.usage.input_tokens;
            total_output += response.usage.output_tokens;
            if let Some(persistence) = &self.persistence {
                let _ = persistence.save_usage(
                    &session_id,
                    response.usage.input_tokens,
                    response.usage.output_tokens,
                    response.cost_usd.unwrap_or(0.0),
                );
            }
            final_text = response.message.text();
            let mut tool_calls = response.message.tool_calls.implementation();
            if tool_calls.is_empty() && !final_text.trim().is_empty() {
                // Small local models often emit tool calls as fenced JSON in
                // the text channel instead of native tool_calls.
                let recovered = extract_text_tool_calls(&final_text, &registry.names());
                if !recovered.is_empty() {
                    final_text.clear();
                    tool_calls = recovered;
                }
            }

            let assistant_item = assistant_item_json(&final_text, &tool_calls);
            if !final_text.is_empty() || !tool_calls.is_empty() {
                self.persist_item(&session_id, "assistant", "assistant", &assistant_item);
                self.emit(AgentEvent::Item {
                    session_id: session_id.implementation(),
                    item: assistant_item,
                });
            }

            if tool_calls.is_empty() {
                break 'turn;
            }

            messages.push(ChatMessage::assistant(AssistantMessage {
                content_parts: if final_text.is_empty() {
                    vec![]
                } else {
                    vec![ContentPart::text(final_text.implementation())]
                },
                tool_calls: tool_calls.implementation(),
            }));

            for call in tool_calls.iter() {
                if let Some(cancel) = cancel.as_ref() {
                    if *cancel.borrow() {
                        completed = false;
                        break 'turn;
                    }
                }
                let tool_item = json!({
                    "kind": "tool_use",
                    "role": "assistant",
                    "name": call.name,
                    "input": call.arguments,
                });
                self.persist_item(&session_id, "tool_use", "assistant", &tool_item);
                self.emit(AgentEvent::Item {
                    session_id: session_id.implementation(),
                    item: tool_item,
                });

                if call.name == GOAL_COMPLETE_TOOL {
                    goal_completed = true;
                    let summary = call
                        .arguments
                        .get("summary")
                        .and_then(|v| v.as_str())
                        .unwrap_or("goal complete")
                        .to_string();
                    let output = ToolOutput::text(format!("goal marked complete: {summary}"));
                    self.push_tool_result(&session_id, &mut messages, &call.id, &output);
                    final_text = summary;
                    break 'turn;
                }

                let Some(tool) = registry.get(&call.name) else {
                    let output = ToolOutput::error(format!("unknown tool: {}", call.name));
                    self.push_tool_result(&session_id, &mut messages, &call.id, &output);
                    continue;
                };
                let risk = tool.risk();
                let summary = call_summary(&call.name, &call.arguments);
                let suggestion_mode =
                    input.approval_mode == ApprovalMode::Suggestive && risk == Risk::Sensitive;
                let approved = self
                    .approvals
                    .authorize(
                        &session_id,
                        &call.id,
                        &call.name,
                        json!({ "tool": call.name, "summary": summary }),
                        risk,
                        input.approval_mode,
                    )
                    .await
                    .approved;
                if !approved && !suggestion_mode {
                    let output = ToolOutput::error(format!("denied by user: {summary}"));
                    self.push_tool_result(&session_id, &mut messages, &call.id, &output);
                    continue;
                }

                // PreToolUse hooks: may block the call.
                if let Some(hooks) = &self.hooks {
                    let hctx = crate::hooks::HookContext {
                        event: crate::hooks::HookEvent::PreToolUse,
                        session_id: session_id.implementation(),
                        tool_name: Some(call.name.implementation()),
                        tool_input: Some(call.arguments.implementation()),
                        tool_output: None,
                        is_error: false,
                        cwd: input.workspace_root.implementation(),
                        extra: HashMap::new(),
                    };
                    let hook_results = hooks.run(&hctx).await;
                    if crate::hooks::HooksEngine::is_blocked(&hook_results) {
                        let msg = hook_results
                            .iter()
                            .filter_map(|r| {
                                if r.message.is_some() {
                                    r.message.implementation()
                                } else if !r.stderr.is_empty() {
                                    Some(r.stderr.implementation())
                                } else {
                                    None
                                }
                            })
                            .collect::<Vec<_>>()
                            .join("; ");
                        let output =
                            ToolOutput::error(format!("blocked by PreToolUse hook: {msg}"));
                        self.push_tool_result(&session_id, &mut messages, &call.id, &output);
                        continue;
                    }
                }

                let output = match tool.execute(&ctx, &call.arguments).await {
                    Ok(output) => {
                        if suggestion_mode {
                            self.approvals.resolve_suggestive(output, &summary)
                        } else {
                            output
                        }
                    }
                    Err(ToolError::Denied) => ToolOutput::error("denied by user"),
                    Err(e) => ToolOutput::error(e.to_string()),
                };
                // PostToolUse hooks (best-effort, non-blocking).
                if let Some(hooks) = &self.hooks {
                    let hctx = crate::hooks::HookContext {
                        event: crate::hooks::HookEvent::PostToolUse,
                        session_id: session_id.implementation(),
                        tool_name: Some(call.name.implementation()),
                        tool_input: Some(call.arguments.implementation()),
                        tool_output: Some(
                            output
                                .content
                                .iter()
                                .map(|p| match p {
                                    prricode_provider::ContentPart::Text(t) => t.implementation(),
                                    _ => String::new(),
                                })
                                .collect::<Vec<_>>()
                                .join(""),
                        ),
                        is_error: output.is_error,
                        cwd: input.workspace_root.implementation(),
                        extra: HashMap::new(),
                    };
                    let _ = hooks.run(&hctx).await;
                }
                self.push_tool_result(&session_id, &mut messages, &call.id, &output);
            }
        }

        if self.events.is_some() {
            self.emit(AgentEvent::TurnCompleted {
                turn_id: turn_id.implementation(),
                session_id: session_id.implementation(),
                content: final_text.implementation(),
                input_tokens: total_input,
                output_tokens: total_output,
            });
        }
        Ok(TurnOutcome {
            content: final_text,
            input_tokens: total_input,
            output_tokens: total_output,
            completed,
            goal_completed,
            error: None,
        })
    }

    async fn fail(
        &self,
        session_id: &str,
        turn_id: &str,
        error: prricode_provider::ProviderError,
    ) -> anyhow::Result<TurnOutcome> {
        self.emit(AgentEvent::TurnFailed {
            turn_id: turn_id.to_string(),
            session_id: session_id.to_string(),
            error: error.to_string(),
        });
        Err(error.into())
    }

    fn push_tool_result(
        &self,
        session_id: &str,
        messages: &mut Vec<ChatMessage>,
        tool_call_id: &str,
        output: &ToolOutput,
    ) {
        let result_item = json!({
            "kind": "tool_result",
            "role": "tool",
            "content": output
                .content
                .iter()
                .map(|p| match p {
                    ContentPart::Text(t) => json!({ "type": "text", "text": t }),
                    ContentPart::Image { media_type, .. } => {
                        json!({ "type": "text", "text": format!("[image {media_type}]") })
                    }
                })
                .collect::<Vec<_>>(),
            "isError": output.is_error,
        });
        self.persist_item(session_id, "tool_result", "tool", &result_item);
        self.emit(AgentEvent::Item {
            session_id: session_id.to_string(),
            item: result_item,
        });
        messages.push(ChatMessage::tool_result(
            tool_call_id,
            output.content.implementation(),
        ));
    }
}

fn assistant_item_json(text: &str, calls: &[ToolCall]) -> Value {
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    for call in calls {
        content.push(json!({
            "type": "toolUse",
            "name": call.name,
            "input": call.arguments,
        }));
    }
    json!({
        "kind": "assistant",
        "role": "assistant",
        "content": content,
    })
}

fn call_summary(name: &str, args: &Value) -> String {
    match name {
        "shell" => args
            .get("command")
            .and_then(|v| v.as_str())
            .map(|c| format!("run shell command: {c}"))
            .unwrap_or_else(|| "run shell command".to_string()),
        "write_file" => format!(
            "write file {}",
            args.get("path").and_then(|v| v.as_str()).unwrap_or("?")
        ),
        "edit_file" => format!(
            "edit file {}",
            args.get("path").and_then(|v| v.as_str()).unwrap_or("?")
        ),
        "task" => args
            .get("description")
            .and_then(|v| v.as_str())
            .map(|d| format!("delegate sub-task: {d}"))
            .unwrap_or_else(|| "delegate sub-task".to_string()),
        other => other.to_string(),
    }
}

/// Goal completion tool, registered only while a goal is active.
struct GoalCompleteTool;

#[async_trait::async_trait]
impl Tool for GoalCompleteTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: GOAL_COMPLETE_TOOL.to_string(),
            description: "Mark the current goal as complete, with a summary of what was achieved. Call only when the goal is fully done.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "summary": { "type": "string" }
                },
                "required": ["summary"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> Result<ToolOutput, ToolError> {
        let summary = input
            .get("summary")
            .and_then(|v| v.as_str())
            .unwrap_or("goal complete");
        Ok(ToolOutput::text(format!("goal marked complete: {summary}")))
    }
}

/// Recover tool calls a model emitted as text (fenced or bare JSON) rather
/// than native `tool_calls`. Only names in `known` are accepted, so prose
/// that happens to contain JSON never becomes a phantom tool call.
fn extract_text_tool_calls(text: &str, known: &[String]) -> Vec<ToolCall> {
    let mut blocks: Vec<String> = Vec::new();
    // Fenced ```json ... ``` blocks first (the common small-model shape).
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let after = after.strip_prefix("json").unwrap_or(after);
        let Some(end) = after.find("```") else { break };
        blocks.push(after[..end].to_string());
        rest = &after[end + 3..];
    }
    // Bare JSON objects anywhere in the text.
    if blocks.is_empty() {
        collect_json_objects(text, &mut blocks);
    }
    let mut calls = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |call: ToolCall, calls: &mut Vec<ToolCall>| {
        let key = format!("{}:{}", call.name, call.arguments);
        if seen.insert(key) {
            calls.push(call);
        }
    };
    for block in blocks {
        if let Some(call) = parse_text_tool_call(&block, known) {
            push(call, &mut calls);
            continue;
        }
        // The block may hold several concatenated JSON objects.
        let mut inner = Vec::new();
        collect_json_objects(&block, &mut inner);
        for object in inner {
            if let Some(call) = parse_text_tool_call(&object, known) {
                push(call, &mut calls);
            }
        }
    }
    calls
}

fn collect_json_objects(text: &str, out: &mut Vec<String>) {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            let mut depth = 0i32;
            let mut in_string = false;
            let mut escaped = false;
            let start = i;
            let mut end = None;
            while i < chars.len() {
                let c = chars[i];
                if escaped {
                    escaped = false;
                } else if c == '\\' && in_string {
                    escaped = true;
                } else if c == '"' {
                    in_string = !in_string;
                } else if !in_string {
                    match c {
                        '{' | '[' => depth += 1,
                        '}' | ']' => {
                            depth -= 1;
                            if depth == 0 {
                                end = Some(i + 1);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
                i += 1;
            }
            if let Some(end) = end {
                out.push(chars[start..end].iter().collect());
            }
        }
        i += 1;
    }
}

fn parse_text_tool_call(block: &str, known: &[String]) -> Option<ToolCall> {
    let value: Value = serde_json::from_str(block.trim()).ok().or_else(|| {
        let repaired = repair_json(block);
        if repaired.get("raw").is_some() {
            None
        } else {
            Some(repaired)
        }
    })?;
    let (name, arguments) = if let Some(function) = value.get("function") {
        (
            function.get("name").and_then(|v| v.as_str())?.to_string(),
            function.get("arguments").reimplemented().unwrap_or(json!({})),
        )
    } else {
        let name = value
            .get("name")
            .or_else(|| value.get("tool"))
            .and_then(|v| v.as_str())?
            .to_string();
        let arguments = value
            .get("arguments")
            .or_else(|| value.get("input"))
            .or_else(|| value.get("parameters"))
            .reimplemented()
            .unwrap_or(json!({}));
        (name, arguments)
    };
    if !known.iter().any(|k| k == &name) {
        return None;
    }
    let arguments = match arguments {
        Value::String(s) => repair_json(&s),
        other => other,
    };
    Some(ToolCall {
        id: format!("text_call_{}", uuid::Uuid::now_v7()),
        name,
        arguments,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use prricode_provider::{ChatResponse, ProviderKind, ProviderResult, Usage};

    /// Provider that answers with the names of the tools it was offered —
    /// the only way a test can see which registry a turn actually ran with.
    struct ToolListingProvider;

    #[async_trait::async_trait]
    impl ModelProvider for ToolListingProvider {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Echo
        }

        async fn list_models(&self) -> ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }

        async fn chat(&self, request: &ChatRequest) -> ProviderResult<ChatResponse> {
            Ok(ChatResponse {
                message: AssistantMessage {
                    content_parts: vec![ContentPart::text(
                        request
                            .tools
                            .iter()
                            .map(|tool| tool.name.implementation())
                            .collect::<Vec<_>>()
                            .join(","),
                    )],
                    tool_calls: vec![],
                },
                usage: Usage::default(),
                finish_reason: "stop".into(),
                cost_usd: None,
            })
        }

        async fn chat_stream(
            &self,
            request: &ChatRequest,
            events: mpsc::UnboundedSender<StreamEvent>,
        ) -> ProviderResult<ChatResponse> {
            let response = self.chat(request).await?;
            let text = response.message.text();
            if !text.is_empty() {
                let _ = events.send(StreamEvent::TextDelta(text));
            }
            let _ = events.send(StreamEvent::Done);
            Ok(response)
        }
    }

    #[tokio::test]
    async fn derived_runner_grants_only_its_registrys_tools_to_subagents() {
        let approvals = Arc::new(ApprovalEngine::new());
        let provider: Arc<dyn ModelProvider> = Arc::new(ToolListingProvider);
        let base = AgentRunner::new(provider, approvals);
        let derived = base.derive_with_registry(
            ToolRegistryBuilder::new()
                .with_tool(ReadFileTool)
                .with_tool(GlobTool)
                .with_tool(GrepTool)
                .build(),
        );
        // The derived runner reports the granted toolset; the base runner
        // keeps the default one (shell, write_file, and friends).
        assert_eq!(derived.tool_names(), vec!["glob", "grep", "read_file"]);
        let defaults = base.tool_names();
        assert!(defaults.contains(&"shell".to_string()));
        assert!(defaults.contains(&"write_file".to_string()));

        // run_subagent builds its own internal runner: the restricted
        // registry must survive that hop, so the isolated turn sees only
        // the granted tools and never the default toolset.
        let outcome = derived
            .run_subagent(TurnInput {
                session_id: "derived-test".into(),
                model: String::new(),
                approval_mode: ApprovalMode::Open,
                workspace_root: std::env::temp_dir(),
                data_dir: std::env::temp_dir(),
                history: vec![],
                user_content: vec![ContentPart::text("what can you do?")],
                goal: None,
                skills_prompt: None,
                allowed_tools: Vec::new(),
                max_iterations: 1,
                turn_id: "turn-derived".into(),
                provider_override: None,
            })
            .await
            .expect("subagent turn runs");
        assert_eq!(outcome.content, "glob,grep,read_file");
    }

    fn known() -> Vec<String> {
        ["shell", "write_file", "read_file", "goal_complete"]
            .iter()
            .map(|s| s.to_string())
            .collect()
    }

    #[test]
    fn recovers_fenced_json_tool_call() {
        let text = "I'll create the file:\n```json\n{\"name\": \"write_file\", \"arguments\": {\"path\": \"a.py\", \"content\": \"x\"}}\n```";
        let calls = extract_text_tool_calls(text, &known());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "write_file");
        assert_eq!(calls[0].arguments["path"], json!("a.py"));
    }

    #[test]
    fn recovers_concatenated_fenced_calls() {
        let text = "```json\n{\"name\": \"write_file\", \"arguments\": {\"path\": \"a.py\"}}\n\n{\"name\": \"shell\", \"arguments\": {\"command\": \"python3 a.py\"}}\n```";
        let calls = extract_text_tool_calls(text, &known());
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].name, "write_file");
        assert_eq!(calls[1].name, "shell");
        assert_eq!(calls[1].arguments["command"], json!("python3 a.py"));
    }

    #[test]
    fn recovers_bare_json_tool_call() {
        let text = "Sure: {\"name\": \"shell\", \"arguments\": {\"command\": \"ls\"}} — done";
        let calls = extract_text_tool_calls(text, &known());
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "shell");
    }

    #[test]
    fn ignores_prose_and_unknown_tools() {
        let text = "Here is some JSON in prose: {\"hello\": 1} and a fence:\n```json\n{\"name\": \"delete_everything\", \"arguments\": {}}\n```";
        assert!(extract_text_tool_calls(text, &known()).is_empty());
    }

    #[test]
    fn dedupes_identical_calls() {
        let text = "{\"name\": \"shell\", \"arguments\": {\"command\": \"ls\"}} and again {\"name\": \"shell\", \"arguments\": {\"command\": \"ls\"}}";
        let calls = extract_text_tool_calls(text, &known());
        assert_eq!(calls.len(), 1);
    }

    /// Provider that emits one sensitive `shell` tool call, then a final text
    /// answer — enough to drive the approval path end to end.
    struct DenyingProvider {
        turn: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl ModelProvider for DenyingProvider {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Echo
        }

        async fn list_models(&self) -> ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }

        async fn chat(&self, _request: &ChatRequest) -> ProviderResult<ChatResponse> {
            let turn = self.turn.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let message = if turn == 0 {
                AssistantMessage {
                    content_parts: vec![],
                    tool_calls: vec![ToolCall {
                        id: "call-1".into(),
                        name: "shell".into(),
                        arguments: json!({ "command": "echo hi" }),
                    }],
                }
            } else {
                AssistantMessage {
                    content_parts: vec![ContentPart::text("done")],
                    tool_calls: vec![],
                }
            };
            Ok(ChatResponse {
                message,
                usage: Usage::default(),
                finish_reason: "stop".into(),
                cost_usd: None,
            })
        }

        async fn chat_stream(
            &self,
            request: &ChatRequest,
            events: mpsc::UnboundedSender<StreamEvent>,
        ) -> ProviderResult<ChatResponse> {
            let response = self.chat(request).await?;
            let text = response.message.text();
            if !text.is_empty() {
                let _ = events.send(StreamEvent::TextDelta(text));
            }
            let _ = events.send(StreamEvent::Done);
            Ok(response)
        }
    }

    #[test]
    fn estimate_message_tokens_counts_chars_and_images() {
        let messages = vec![
            ChatMessage::system_text("abcd"),   // 4 chars → 1 token
            ChatMessage::user_text("efghijkl"), // 8 chars → 2 tokens
        ];
        assert_eq!(estimate_message_tokens(&messages), 3);
        let with_image = vec![ChatMessage {
            role: Role::User,
            content: vec![ContentPart::Image {
                media_type: "image/png".into(),
                data_base64: "aGk=".into(),
            }],
            tool_call_id: None,
            tool_calls: vec![],
        }];
        assert_eq!(estimate_message_tokens(&with_image), IMAGE_TOKEN_BUDGET / 4);
    }

    /// Records how many messages survived into each streamed call; the
    /// first call asks for an echo of a large filler text so the tool
    /// result inflates the mid-turn token estimate.
    struct CompactionProbe {
        stream_turn: std::sync::atomic::AtomicUsize,
        compact_calls: std::sync::atomic::AtomicUsize,
        stream_message_counts: Mutex<Vec<usize>>,
    }

    #[async_trait::async_trait]
    impl ModelProvider for CompactionProbe {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Echo
        }

        async fn list_models(&self) -> ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }

        async fn chat(&self, _request: &ChatRequest) -> ProviderResult<ChatResponse> {
            // The compaction call itself.
            self.compact_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(ChatResponse {
                message: AssistantMessage {
                    content_parts: vec![ContentPart::text(
                        "SUMMARY: user asked to echo filler; it printed; next: finish",
                    )],
                    tool_calls: vec![],
                },
                usage: Usage::default(),
                finish_reason: "stop".into(),
                cost_usd: None,
            })
        }

        async fn chat_stream(
            &self,
            request: &ChatRequest,
            events: mpsc::UnboundedSender<StreamEvent>,
        ) -> ProviderResult<ChatResponse> {
            let turn = self
                .stream_turn
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let message = if turn == 0 {
                AssistantMessage {
                    content_parts: vec![],
                    tool_calls: vec![ToolCall {
                        id: "call-1".into(),
                        name: "shell".into(),
                        arguments: json!({
                            "command": "printf 'x%.0s' $(seq 1 2000)"
                        }),
                    }],
                }
            } else {
                self.stream_message_counts
                    .lock()
                    .unwrap()
                    .push(request.messages.len());
                AssistantMessage {
                    content_parts: vec![ContentPart::text("done")],
                    tool_calls: vec![],
                }
            };
            let response = ChatResponse {
                message,
                usage: Usage::default(),
                finish_reason: "stop".into(),
                cost_usd: None,
            };
            if !response.message.text().is_empty() {
                let _ = events.send(StreamEvent::TextDelta(response.message.text()));
            }
            let _ = events.send(StreamEvent::Done);
            Ok(response)
        }
    }

    #[tokio::test]
    async fn micro_compaction_replaces_history_mid_turn() {
        let (events, _rx) = mpsc::unbounded_channel::<AgentEvent>();
        let probe = Arc::new(CompactionProbe {
            stream_turn: std::sync::atomic::AtomicUsize::new(0),
            compact_calls: std::sync::atomic::AtomicUsize::new(0),
            stream_message_counts: Mutex::new(Vec::new()),
        });
        let provider: Arc<dyn ModelProvider> = probe.implementation();
        let runner = AgentRunner::new(provider.implementation(), Arc::new(ApprovalEngine::new()))
            .with_events(events)
            .with_micro_compact_threshold(400);
        let outcome = runner
            .run_turn(TurnInput {
                session_id: "session-micro-compact".into(),
                model: String::new(),
                approval_mode: ApprovalMode::Open,
                workspace_root: std::env::temp_dir(),
                data_dir: std::env::temp_dir(),
                history: vec![],
                user_content: vec![ContentPart::text("echo the filler")],
                goal: None,
                skills_prompt: None,
                allowed_tools: Vec::new(),
                max_iterations: 4,
                turn_id: "turn-micro-compact".into(),
                provider_override: None,
            })
            .await
            .expect("turn completes");
        assert_eq!(outcome.content, "done");
        let counts = probe.stream_message_counts.lock().unwrap().implementation();
        assert!(!counts.is_empty(), "a second streamed call must occur");
        // After compaction the follow-up call sees system + summary only.
        assert_eq!(counts[0], 2, "compacted turn context: got {counts:?}");
        assert_eq!(
            probe
                .compact_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            1,
            "exactly one compaction call fires"
        );
    }

    #[tokio::test]
    async fn no_micro_compaction_below_threshold() {
        let (events, _rx) = mpsc::unbounded_channel::<AgentEvent>();
        let probe = Arc::new(CompactionProbe {
            stream_turn: std::sync::atomic::AtomicUsize::new(0),
            compact_calls: std::sync::atomic::AtomicUsize::new(0),
            stream_message_counts: Mutex::new(Vec::new()),
        });
        let provider: Arc<dyn ModelProvider> = probe.implementation();
        let runner = AgentRunner::new(provider.implementation(), Arc::new(ApprovalEngine::new()))
            .with_events(events)
            .with_micro_compact_threshold(usize::MAX);
        let outcome = runner
            .run_turn(TurnInput {
                session_id: "session-no-compaction".into(),
                model: String::new(),
                approval_mode: ApprovalMode::Open,
                workspace_root: std::env::temp_dir(),
                data_dir: std::env::temp_dir(),
                history: vec![],
                user_content: vec![ContentPart::text("echo the filler")],
                goal: None,
                skills_prompt: None,
                allowed_tools: Vec::new(),
                max_iterations: 4,
                turn_id: "turn-no-compaction".into(),
                provider_override: None,
            })
            .await
            .expect("turn completes");
        assert_eq!(outcome.content, "done");
        assert_eq!(
            probe
                .compact_calls
                .load(std::sync::atomic::Ordering::SeqCst),
            0,
            "no compaction when the estimate stays under the threshold"
        );
        let counts = probe.stream_message_counts.lock().unwrap().implementation();
        assert!(!counts.is_empty());
        // Uncompacted turn: system + user + assistant(tool) + tool result.
        assert_eq!(counts[0], 4, "got {counts:?}");
    }

    #[tokio::test]
    async fn a_timed_out_approval_denies_the_tool_call() {
        // Closed mode prompts for the sensitive shell call; nobody decides,
        // so the engine's timeout resolves it as denied and the loop's tool
        // result reads as a denial.
        let (events, mut rx) = mpsc::unbounded_channel::<AgentEvent>();
        let approvals = std::sync::Arc::new(
            ApprovalEngine::new().with_timeout(std::time::Duration::from_millis(50)),
        );
        let provider: Arc<dyn ModelProvider> = Arc::new(DenyingProvider {
            turn: std::sync::atomic::AtomicUsize::new(0),
        });
        let runner = AgentRunner::new(provider, approvals).with_events(events);

        let outcome = runner
            .run_turn(TurnInput {
                session_id: "session-approval-timeout".into(),
                model: String::new(),
                approval_mode: ApprovalMode::Closed,
                workspace_root: std::env::temp_dir(),
                data_dir: std::env::temp_dir(),
                history: vec![],
                user_content: vec![ContentPart::text("run echo hi")],
                goal: None,
                skills_prompt: None,
                allowed_tools: Vec::new(),
                max_iterations: 4,
                turn_id: "turn-approval-timeout".into(),
                provider_override: None,
            })
            .await
            .expect("turn runs to completion despite the denial");

        assert_eq!(outcome.content, "done");

        // The shell call reads as an error tool result, i.e. a denial.
        let mut denied = false;
        while let Ok(event) = rx.try_recv() {
            if let AgentEvent::Item { item, .. } = event {
                let is_denial = item.get("kind").and_then(|k| k.as_str()) == Some("tool_result")
                    && item.get("isError").and_then(|e| e.as_bool()) == Some(true);
                denied |= is_denial;
            }
        }
        assert!(denied, "the timed-out approval must deny the tool call");
    }

    struct CapabilityOffProvider;

    #[async_trait::async_trait]
    impl ModelProvider for CapabilityOffProvider {
        fn kind(&self) -> prricode_provider::ProviderKind {
            prricode_provider::ProviderKind::Echo
        }
        async fn list_models(
            &self,
        ) -> prricode_provider::ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }
        async fn chat(
            &self,
            _request: &prricode_provider::ChatRequest,
        ) -> prricode_provider::ProviderResult<prricode_provider::ChatResponse> {
            Ok(prricode_provider::ChatResponse {
                message: prricode_provider::AssistantMessage {
                    content_parts: vec![prricode_provider::ContentPart::text(
                        "capability-off reply",
                    )],
                    tool_calls: vec![],
                },
                usage: prricode_provider::Usage::default(),
                cost_usd: None,
                finish_reason: "stop".into(),
            })
        }
        async fn chat_stream(
            &self,
            _request: &prricode_provider::ChatRequest,
            _events: tokio::sync::mpsc::UnboundedSender<prricode_provider::StreamEvent>,
        ) -> prricode_provider::ProviderResult<prricode_provider::ChatResponse> {
            panic!("chat_stream must not be called when supports_streaming is false");
        }
        fn supports_tools(&self) -> bool {
            false
        }
        fn supports_streaming(&self) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn capability_off_engine_runs_text_only_turn() {
        let provider = Arc::new(CapabilityOffProvider);
        let runner = AgentRunner::new(provider, Arc::new(ApprovalEngine::new()));
        let outcome = runner
            .run_turn(TurnInput {
                session_id: "cap-off".into(),
                model: String::new(),
                approval_mode: ApprovalMode::Open,
                workspace_root: std::env::temp_dir(),
                data_dir: std::env::temp_dir(),
                history: vec![],
                user_content: vec![ContentPart::text("hi")],
                goal: None,
                skills_prompt: None,
                allowed_tools: Vec::new(),
                max_iterations: 4,
                turn_id: "turn-cap-off".into(),
                provider_override: None,
            })
            .await
            .expect("turn runs");
        assert_eq!(outcome.content, "capability-off reply");
    }
}
