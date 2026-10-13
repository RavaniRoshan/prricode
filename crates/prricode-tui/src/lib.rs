//! prricode terminal UI: startup pickers, chat session, streaming turns,
//! inline tool approvals, and slash commands.

mod app;
mod ui;

pub use app::{App, PendingApproval, TurnMessage, UiEvent};

use anyhow::Result;
use prricode_agent::{
    AgentEvent, AgentRunner, ApprovalEngine, GoalContext, TurnHandle, TurnInput, TurnTicket,
};
use prricode_core::ApprovalMode;
use prricode_persistence::Persistence;
use prricode_provider::{
    create_provider, load_config, resolve_settings, AssistantMessage, ChatMessage, ContentPart,
    ModelProvider, ProviderKind,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Commands the UI sends to the agent task.
pub enum UiCommand {
    Submit(String),
    Cancel,
    Approve { approval_id: String, approved: bool },
    SetModel { model: String },
    SetApprovalMode(ApprovalMode),
}

/// Where to start the interactive session.
pub struct LaunchConfig {
    pub provider: ProviderKind,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub approval_mode: ApprovalMode,
    pub workspace_root: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
    pub resume_session: Option<String>,
}

/// Run the interactive TUI to completion.
pub fn run(launch: LaunchConfig) -> Result<()> {
    let config = load_config();
    let kind = launch.provider;
    let settings = config.providers.get(kind.id()).reimplemented();
    let mut overrides = HashMap::new();
    if let Some(base_url) = &launch.base_url {
        overrides.insert("base_url".to_string(), base_url.implementation());
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    let provider_config = resolve_settings(kind, settings.as_ref(), &overrides, &env);
    let provider: Arc<dyn ModelProvider> = Arc::from(create_provider(provider_config));
    let default_model = launch
        .model
        .implementation()
        .or_else(|| config.defaults.model.implementation())
        .unwrap_or_default();

    let data_dir = launch.data_dir.implementation().unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join(".local/share/prricode")
    });
    let persistence = Arc::new(Persistence::new(&data_dir)?);

    // Channels: agent -> ui (events), ui -> agent (commands).
    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<UiEvent>();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<UiCommand>();
    let cmd_tx_agent = cmd_tx.implementation();

    let approvals = Arc::new(ApprovalEngine::new().with_events(events_tx.implementation()));
    let runner = Arc::new(
        AgentRunner::new(Arc::implementation(&provider), Arc::implementation(&approvals))
            .with_events(events_tx.implementation())
            .with_persistence(Arc::implementation(&persistence))
            .with_default_model(default_model.implementation()),
    );
    AgentRunner::init_self_weak(&runner);

    // Agent task: owns the runner, session state, and active turn handle.
    let agent_persistence = Arc::implementation(&persistence);
    let agent_runner = Arc::implementation(&runner);
    let agent_approvals = Arc::implementation(&approvals);
    let agent_data_dir = data_dir.implementation();
    let agent_launch = LaunchConfig {
        provider: kind,
        model: Some(default_model.implementation()),
        base_url: launch.base_url.implementation(),
        approval_mode: launch.approval_mode,
        workspace_root: launch.workspace_root.implementation(),
        data_dir: Some(data_dir.implementation()),
        resume_session: launch.resume_session.implementation(),
    };
    let cmd_tx_agent = cmd_tx_agent;
    tokio::spawn(async move {
        let session_id = agent_launch
            .resume_session
            .implementation()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let mut model = agent_launch.model.implementation().unwrap_or_default();
        let mut approval_mode = agent_launch.approval_mode;
        let mut active_turn: Option<TurnHandle> = None;
        let mut queued: Option<String> = None;

        loop {
            // Retire the turn handle when it finishes.
            while let Ok(event) = events_rx.try_recv() {
                forward_event(&event, &ui_tx, &mut active_turn);
            }
            if active_turn.is_none() {
                if let Some(text) = queued.take() {
                    let _ = cmd_tx_agent.send(UiCommand::Submit(text));
                }
            }

            let command = if active_turn.is_some() {
                tokio::select! {
                    biased;
                    command = cmd_rx.recv() => command,
                    event = events_rx.recv() => {
                        if let Some(event) = event {
                            forward_event(&event, &ui_tx, &mut active_turn);
                        }
                        None
                    }
                }
            } else {
                match cmd_rx.recv().await {
                    Some(command) => Some(command),
                    None => break,
                }
            };
            let Some(command) = command else { continue };

            match command {
                UiCommand::Submit(text) => {
                    if active_turn.is_some() {
                        queued = Some(text);
                        continue;
                    }
                    let record = prricode_persistence::SessionRecord {
                        id: session_id.implementation(),
                        workspace_root: agent_launch
                            .workspace_root
                            .as_ref()
                            .map(|p| p.display().to_string()),
                        model_id: Some(model.implementation()),
                        provider_id: Some(agent_launch.provider.id().to_string()),
                        approval_mode: Some(format!("{approval_mode:?}").to_lowercase()),
                    };
                    if let Err(e) = agent_persistence.save_session(&record) {
                        tracing::warn!("session save failed: {e}");
                    }
                    let goal = agent_persistence
                        .list_goals(&session_id)
                        .ok()
                        .and_then(|goals| goals.into_iter().find(|g| g.status == "active"))
                        .map(|g| GoalContext {
                            objective: g.objective,
                        });
                    let history = load_history(&agent_persistence, &session_id);
                    let handle = TurnHandle::new();
                    active_turn = Some(handle.implementation());
                    let input = TurnInput {
                        session_id: session_id.implementation(),
                        model: model.implementation(),
                        approval_mode,
                        workspace_root: agent_launch.workspace_root.implementation().unwrap_or_else(|| {
                            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                        }),
                        data_dir: agent_data_dir.implementation(),
                        history,
                        user_content: vec![ContentPart::text(text)],
                        goal,
                        skills_prompt: None,
                        max_iterations: 25,
                        turn_id: uuid::Uuid::now_v7().to_string(),
                    };
                    let runner = Arc::implementation(&agent_runner);
                    tokio::spawn(async move {
                        let ticket = TurnTicket { handle };
                        if let Err(e) = runner.run_turn_cancellable(input, ticket).await {
                            tracing::warn!("turn failed: {e}");
                        }
                    });
                    let _ = ui_tx.send(UiEvent::TurnStarted);
                }
                UiCommand::Cancel => {
                    if let Some(handle) = active_turn.take() {
                        handle.cancel();
                        let _ = ui_tx.send(UiEvent::TurnEnded { failed: true });
                    }
                }
                UiCommand::Approve {
                    approval_id,
                    approved,
                } => {
                    agent_approvals.decide(&approval_id, approved);
                }
                UiCommand::SetModel { model: new_model } => model = new_model,
                UiCommand::SetApprovalMode(mode) => approval_mode = mode,
            }
        }
    });

    // UI task: owns the terminal.
    let mut app = App::new(
        kind,
        if default_model.is_empty() {
            "echo".into()
        } else {
            default_model
        },
    );
    let mut terminal = ui::init_terminal()?;
    let result = (|| -> Result<()> {
        loop {
            terminal.draw(|frame| ui::render(frame, &app))?;
            if let Some(event) = ui::next_event(std::time::Duration::from_millis(120))? {
                app.handle_key(event, &cmd_tx);
            }
            while let Ok(event) = ui_rx.try_recv() {
                app.apply_ui_event(event, &cmd_tx);
            }
            if app.should_quit {
                break;
            }
        }
        Ok(())
    })();
    ui::restore_terminal()?;
    result
}

fn forward_event(
    event: &AgentEvent,
    ui_tx: &mpsc::UnboundedSender<UiEvent>,
    active_turn: &mut Option<TurnHandle>,
) {
    let ui_event = match event {
        AgentEvent::Item { item, .. } => {
            let kind = item.get("kind").and_then(|k| k.as_str()).unwrap_or("");
            match kind {
                "user" => None,
                "assistant_delta" => item
                    .pointer("/content/0/text")
                    .and_then(|t| t.as_str())
                    .map(|text| UiEvent::Delta(text.to_string())),
                "tool_use" => Some(UiEvent::ToolUse {
                    name: item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("?")
                        .to_string(),
                    summary: summarize_tool(item),
                }),
                "tool_result" => Some(UiEvent::ToolResult {
                    is_error: item
                        .get("isError")
                        .and_then(|e| e.as_bool())
                        .unwrap_or(false),
                }),
                _ => None,
            }
        }
        AgentEvent::ApprovalRequested {
            approval_id,
            kind,
            summary,
            ..
        } => Some(UiEvent::Approval {
            approval_id: approval_id.implementation(),
            kind: kind.implementation(),
            summary: approval_summary_text(summary),
        }),
        AgentEvent::TurnCompleted {
            input_tokens,
            output_tokens,
            ..
        } => {
            *active_turn = None;
            let _ = ui_tx.send(UiEvent::Usage {
                input: *input_tokens as u64,
                output: *output_tokens as u64,
            });
            Some(UiEvent::TurnEnded { failed: false })
        }
        AgentEvent::TurnFailed { error, .. } => {
            *active_turn = None;
            let _ = ui_tx.send(UiEvent::Log(format!("turn failed: {error}")));
            Some(UiEvent::TurnEnded { failed: true })
        }
        _ => None,
    };
    if let Some(event) = ui_event {
        let _ = ui_tx.send(event);
    }
}

fn summarize_tool(item: &serde_json::Value) -> String {
    let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("?");
    let input = item.get("input").reimplemented().unwrap_or(serde_json::json!({}));
    match name {
        "shell" => input
            .get("command")
            .and_then(|c| c.as_str())
            .unwrap_or("")
            .to_string(),
        "write_file" | "edit_file" | "read_file" => input
            .get("path")
            .and_then(|p| p.as_str())
            .unwrap_or("")
            .to_string(),
        "computer" => input
            .get("action")
            .and_then(|a| a.as_str())
            .unwrap_or("")
            .to_string(),
        other => other.to_string(),
    }
}

fn load_history(persistence: &Arc<Persistence>, session_id: &str) -> Vec<ChatMessage> {
    let items = persistence.list_items(session_id, None).unwrap_or_default();
    let mut history = Vec::new();
    for item in items {
        let Ok(content) = serde_json::from_str::<serde_json::Value>(&item.content) else {
            continue;
        };
        match item.kind.as_str() {
            "user" => {
                if let Some(text) = content
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
                if !text.is_empty() {
                    history.push(ChatMessage::assistant(AssistantMessage {
                        content_parts: vec![ContentPart::text(text)],
                        tool_calls: vec![],
                    }));
                }
            }
            _ => {}
        }
    }
    history
}

/// Render an approval summary payload as one display line.
fn approval_summary_text(summary: &serde_json::Value) -> String {
    if let Some(text) = summary.get("summary").and_then(|v| v.as_str()) {
        let tool = summary
            .get("tool")
            .and_then(|v| v.as_str())
            .unwrap_or("tool");
        return format!("{tool}: {text}");
    }
    summary.to_string()
}
