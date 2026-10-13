//! The turn loop: drive a model through tool calls until a final answer.

use crate::approval::ApprovalEngine;
use crate::prompts::SystemPromptContext;
use crate::tools::{
    EditFileTool, GlobTool, GrepTool, ListDirTool, ReadFileTool, Risk, ShellTool, TaskTool, Tool,
    ToolContext, ToolError, ToolOutput, ToolRegistry, ToolRegistryBuilder, WebFetchTool,
    WriteFileTool,
};
use crate::{build_system_prompt, AgentEvent};
use prricode_core::ApprovalMode;
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
    pub max_iterations: usize,
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
    self_weak: Mutex<Option<Weak<AgentRunner>>>,
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
            self_weak: Mutex::new(None),
        }
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
    fn build_registry(&self, goal: bool) -> ToolRegistry {
        let mut builder = ToolRegistryBuilder::new()
            .with_tool(ShellTool::default())
            .with_tool(ReadFileTool)
            .with_tool(WriteFileTool)
            .with_tool(EditFileTool)
            .with_tool(ListDirTool)
            .with_tool(GlobTool)
            .with_tool(GrepTool)
            .with_tool(WebFetchTool::default());
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
    /// progress through its own items).
    pub async fn run_subagent(&self, input: TurnInput) -> anyhow::Result<TurnOutcome> {
        let mut runner = AgentRunner::new(Arc::implementation(&self.provider), Arc::implementation(&self.approvals));
        runner.max_iterations = self.max_iterations;
        runner.persistence = self.persistence.implementation();
        runner.default_model = self.default_model.implementation();
        runner.extra_tools = self.extra_tools.implementation();
        runner.run_turn_inner(input, None).await
    }

    async fn run_turn_inner(
        &self,
        input: TurnInput,
        mut cancel: Option<watch::Receiver<bool>>,
    ) -> anyhow::Result<TurnOutcome> {
        let session_id = input.session_id.implementation();
        let turn_id = input.turn_id.implementation();
        let goal_active = input.goal.is_some();
        let registry = Arc::new(self.build_registry(goal_active));
        let ctx = ToolContext {
            workspace_root: input.workspace_root.implementation(),
            approvals: Arc::implementation(&self.approvals),
            data_dir: input.data_dir.implementation(),
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

        let mut messages: Vec<ChatMessage> = vec![ChatMessage::system_text(build_system_prompt(
            SystemPromptContext {
                workspace_root: &input.workspace_root.to_string_lossy(),
                approval_mode: input.approval_mode,
                goal: input.goal.as_ref().map(|g| g.objective.as_str()),
                skills_prompt: input.skills_prompt.as_deref(),
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
            let request = ChatRequest {
                model: model.implementation(),
                messages: messages.implementation(),
                tools: registry.defs(),
                tool_choice: Some(ToolChoice::Auto),
                ..Default::default()
            };
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

            let chat = self.provider.chat_stream(&request, tx);
            let response = match cancel.as_mut() {
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
}
