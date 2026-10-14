//! prricode terminal UI: startup pickers, chat session, streaming turns,
//! inline tool approvals, and slash commands.

mod app;
mod ui;

pub use app::{App, PendingApproval, PipelineView, TurnMessage, UiEvent};

use anyhow::Result;
use prricode_agent::{
    AgentEvent, AgentRunner, ApprovalEngine, GoalContext, TurnHandle, TurnInput, TurnTicket,
};
use prricode_core::ApprovalMode;
use prricode_persistence::Persistence;
use prricode_pipeline::{
    build::{graph_to_definition, run_build},
    clarify::Clarifier,
    plan, specify, Pipeline, PipelineStage,
};
use prricode_provider::{
    create_provider, load_config, resolve_settings, AssistantMessage, ChatMessage, ContentPart,
    ModelProvider, ProviderKind,
};
use prricode_spec::{Concept, Spec, TaskGraph};
use prricode_workflow::WorkflowEngine;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Commands the UI sends to the agent task.
pub enum UiCommand {
    Submit(String),
    Cancel,
    Approve { approval_id: String, approved: bool },
    SetModel { model: String },
    SetApprovalMode(ApprovalMode),
    PipelineConcept { idea: String },
    PipelineAnswer { answer: String },
    PipelineConfirm { stage: String, ok: bool },
    PipelineAdvance { stage: String },
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
        // Product-builder pipeline: the stage runner plus per-session flow
        // state shared with the spawned stage tasks.
        let pipeline = Arc::new(Pipeline::new(
            Arc::implementation(&agent_runner),
            Arc::implementation(&agent_persistence),
        ));
        let flow = Arc::new(Mutex::new(PipelineFlow::default()));
        let stage_workspace = agent_launch
            .workspace_root
            .implementation()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

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
                UiCommand::PipelineConcept { idea } => {
                    let concept = Concept::from_idea(&idea);
                    let question = Clarifier::new(concept.implementation()).next_question();
                    {
                        let mut flow = flow.lock().unwrap();
                        flow.start(concept);
                        persist_pipeline(&pipeline, &session_id, &flow);
                    }
                    let _ = ui_tx.send(UiEvent::PipelineStageChanged {
                        stage: PipelineStage::Clarify.label().to_string(),
                    });
                    let _ = ui_tx.send(UiEvent::Log(format!("pipeline: concept started — {idea}")));
                    if let Some(question) = question {
                        let _ = ui_tx.send(UiEvent::PipelineInterview { question });
                    }
                }
                UiCommand::PipelineAnswer { answer } => {
                    let outcome = {
                        let mut flow = flow.lock().unwrap();
                        let answered = flow.clarifier.as_mut().map(|clarifier| {
                            clarifier.apply(&answer);
                            (clarifier.next_question(), clarifier.concept.implementation())
                        });
                        match answered {
                            Some((Some(question), _)) => AnswerOutcome::Interview { question },
                            Some((None, concept)) => {
                                // Exit gate: the concept gate opens only on a
                                // ready concept; a leftover ambiguity marker
                                // keeps the interview open on its question.
                                if concept.is_ready() {
                                    flow.concept = Some(concept);
                                    flow.stage = PipelineStage::Concept.label().to_string();
                                    persist_pipeline(&pipeline, &session_id, &flow);
                                    AnswerOutcome::ConceptReady
                                } else {
                                    AnswerOutcome::Interview {
                                        question: remaining_question(&concept),
                                    }
                                }
                            }
                            None => AnswerOutcome::NoInterview,
                        }
                    };
                    match outcome {
                        AnswerOutcome::Interview { question } => {
                            let _ = ui_tx.send(UiEvent::PipelineInterview { question });
                        }
                        AnswerOutcome::ConceptReady => {
                            let _ = ui_tx.send(UiEvent::PipelineStageChanged {
                                stage: PipelineStage::Concept.label().to_string(),
                            });
                            let _ = ui_tx.send(UiEvent::PipelineGate {
                                gate: "concept-confirmation".to_string(),
                            });
                            let _ = ui_tx.send(UiEvent::Log(
                                "pipeline: concept ready — y to confirm, n to reject".to_string(),
                            ));
                        }
                        AnswerOutcome::NoInterview => {
                            let _ = ui_tx.send(UiEvent::Log(
                                "pipeline: no interview in progress — /concept <idea> to start"
                                    .to_string(),
                            ));
                        }
                    }
                }
                UiCommand::PipelineConfirm { stage, ok } => {
                    if !ok {
                        let current = flow.lock().unwrap().stage.implementation();
                        let _ = ui_tx.send(UiEvent::PipelineStageChanged { stage: current });
                        let _ = ui_tx.send(UiEvent::Log(format!(
                            "pipeline: {stage} rejected — paused at the current stage"
                        )));
                        continue;
                    }
                    match stage.as_str() {
                        "concept-confirmation" => {
                            flow.lock().unwrap().concept_confirmed = true;
                            persist_pipeline(&pipeline, &session_id, &flow.lock().unwrap());
                            spawn_stage(
                                run_specify_stage,
                                StageCtx {
                                    pipeline: Arc::implementation(&pipeline),
                                    flow: Arc::implementation(&flow),
                                    ui_tx: ui_tx.implementation(),
                                    session_id: session_id.implementation(),
                                    model: model.implementation(),
                                    approval_mode,
                                    workspace_root: stage_workspace.implementation(),
                                    data_dir: agent_data_dir.implementation(),
                                },
                            );
                        }
                        "spec-confirmation" => {
                            flow.lock().unwrap().spec_confirmed = true;
                            persist_pipeline(&pipeline, &session_id, &flow.lock().unwrap());
                            spawn_stage(
                                run_plan_stage,
                                StageCtx {
                                    pipeline: Arc::implementation(&pipeline),
                                    flow: Arc::implementation(&flow),
                                    ui_tx: ui_tx.implementation(),
                                    session_id: session_id.implementation(),
                                    model: model.implementation(),
                                    approval_mode,
                                    workspace_root: stage_workspace.implementation(),
                                    data_dir: agent_data_dir.implementation(),
                                },
                            );
                        }
                        other => {
                            let _ = ui_tx
                                .send(UiEvent::Log(format!("pipeline: no gate named {other}")));
                        }
                    }
                }
                UiCommand::PipelineAdvance { stage } => {
                    let (ready, hint) = {
                        let flow = flow.lock().unwrap();
                        match stage.as_str() {
                            "specify" => (
                                flow.concept.is_some() && flow.concept_confirmed && !flow.stage_in_flight,
                                "confirm the concept gate first (answer the interview, then press y)",
                            ),
                            "plan" => (
                                flow.spec.is_some()
                                    && flow.spec_confirmed
                                    && !flow.stage_in_flight,
                                "confirm the spec gate first (press y)",
                            ),
                            "build" => (
                                flow.graph.is_some() && !flow.building,
                                "no plan yet — confirm the spec to generate one, or a build is already running",
                            ),
                            _ => (false, "unknown pipeline stage"),
                        }
                    };
                    if !ready {
                        let _ = ui_tx.send(UiEvent::Log(format!("pipeline: {hint}")));
                        continue;
                    }
                    let ctx = StageCtx {
                        pipeline: Arc::implementation(&pipeline),
                        flow: Arc::implementation(&flow),
                        ui_tx: ui_tx.implementation(),
                        session_id: session_id.implementation(),
                        model: model.implementation(),
                        approval_mode,
                        workspace_root: stage_workspace.implementation(),
                        data_dir: agent_data_dir.implementation(),
                    };
                    match stage.as_str() {
                        "specify" => spawn_stage(run_specify_stage, ctx),
                        "plan" => spawn_stage(run_plan_stage, ctx),
                        "build" => spawn_stage(run_build_stage, ctx),
                        _ => {}
                    }
                }
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

/// In-memory product-builder pipeline state for the session.
#[derive(Default)]
struct PipelineFlow {
    stage: String,
    concept: Option<Concept>,
    clarifier: Option<Clarifier>,
    spec: Option<Spec>,
    graph: Option<TaskGraph>,
    concept_confirmed: bool,
    spec_confirmed: bool,
    building: bool,
    /// Specify and plan share one in-flight claim: a late specify must not
    /// regenerate the spec while a plan is consuming it.
    stage_in_flight: bool,
}

impl PipelineFlow {
    /// Start a fresh concept interview, discarding any prior run.
    fn start(&mut self, concept: Concept) {
        self.clarifier = Some(Clarifier::new(concept.implementation()));
        self.concept = Some(concept);
        self.spec = None;
        self.graph = None;
        self.concept_confirmed = false;
        self.spec_confirmed = false;
        self.building = false;
        self.stage_in_flight = false;
        self.stage = PipelineStage::Clarify.label().to_string();
    }
}

/// What a clarifier answer produced.
enum AnswerOutcome {
    Interview { question: String },
    ConceptReady,
    NoInterview,
}

/// The question that clears a not-ready concept's first remaining ambiguity
/// marker. Domain invariants make the markerless case unreachable (the
/// field-driven interview exhausts every field before it stops asking), so it
/// gets a hold question instead of opening the concept gate.
fn remaining_question(concept: &Concept) -> String {
    concept
        .ambiguities
        .iter()
        .find_map(|marker| Clarifier::question_for_marker(marker))
        .map(str::to_string)
        .unwrap_or_else(|| "Tell me more about this concept before we confirm it.".to_string())
}

/// Shared context for a spawned pipeline stage turn.
struct StageCtx {
    pipeline: Arc<Pipeline>,
    flow: Arc<Mutex<PipelineFlow>>,
    ui_tx: mpsc::UnboundedSender<UiEvent>,
    session_id: String,
    model: String,
    approval_mode: ApprovalMode,
    workspace_root: PathBuf,
    data_dir: PathBuf,
}

fn spawn_stage<F>(stage: fn(StageCtx) -> F, ctx: StageCtx)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(stage(ctx));
}

/// Persist the pipeline state under the server's `pipeline:<sessionId>`
/// settings key so both surfaces read the same story.
fn persist_pipeline(pipeline: &Pipeline, session_id: &str, flow: &PipelineFlow) {
    let waves: Vec<Vec<String>> = flow
        .graph
        .as_ref()
        .map(|graph| {
            graph
                .waves()
                .unwrap_or_default()
                .iter()
                .map(|wave| wave.iter().map(|node| node.id.implementation()).collect())
                .collect()
        })
        .unwrap_or_default();
    let state = serde_json::json!({
        "stage": flow.stage,
        "concept": flow.concept.as_ref().and_then(|c| serde_json::to_value(c).ok()),
        "spec": flow.spec.as_ref().and_then(|s| serde_json::to_value(s).ok()),
        "waves": waves,
    });
    if let Err(e) = pipeline
        .persistence
        .set_setting(&format!("pipeline:{session_id}"), &state.to_string())
    {
        tracing::warn!("pipeline state save failed: {e}");
    }
}

/// Move the rail to a stage label, persisting and relaying the change.
async fn set_stage(ctx: &StageCtx, label: &str) {
    {
        let mut flow = ctx.flow.lock().unwrap();
        flow.stage = label.to_string();
        persist_pipeline(&ctx.pipeline, &ctx.session_id, &flow);
    }
    let _ = ctx.ui_tx.send(UiEvent::PipelineStageChanged {
        stage: label.to_string(),
    });
}

/// One silent model turn for a pipeline stage prompt.
fn stage_turn_input(ctx: &StageCtx, messages: Vec<ChatMessage>) -> TurnInput {
    let prompt = messages
        .iter()
        .map(message_text)
        .collect::<Vec<_>>()
        .join("\n\n");
    TurnInput {
        session_id: ctx.session_id.implementation(),
        model: ctx.model.implementation(),
        approval_mode: ctx.approval_mode,
        workspace_root: ctx.workspace_root.implementation(),
        data_dir: ctx.data_dir.implementation(),
        history: Vec::new(),
        user_content: vec![ContentPart::text(prompt)],
        goal: None,
        skills_prompt: None,
        max_iterations: 15,
        turn_id: uuid::Uuid::now_v7().to_string(),
    }
}

fn message_text(message: &ChatMessage) -> String {
    message
        .content
        .iter()
        .map(|part| match part {
            ContentPart::Text(text) => text.implementation(),
            ContentPart::Image { .. } => String::new(),
        })
        .collect()
}

/// The Specify stage: a confirmed concept becomes a validated Core-4 spec.
async fn run_specify_stage(ctx: StageCtx) {
    let concept = {
        let mut flow = ctx.flow.lock().unwrap();
        if flow.stage_in_flight {
            let _ = ctx.ui_tx.send(UiEvent::Log(
                "pipeline: a spec/plan stage is already in flight".to_string(),
            ));
            return;
        }
        let Some(concept) = flow.concept.implementation() else {
            let _ = ctx
                .ui_tx
                .send(UiEvent::Log("pipeline: no concept to specify".to_string()));
            return;
        };
        // Claim the launch in the same critical section as the re-check.
        flow.stage_in_flight = true;
        concept
    };
    let preset = concept.stack.as_ref().and_then(|stack| stack.preset);
    set_stage(&ctx, PipelineStage::Specify.label()).await;
    let input = stage_turn_input(&ctx, specify::spec_prompt(&concept, preset));
    let outcome = match ctx.pipeline.runner.run_subagent(input).await {
        Ok(outcome) => outcome,
        Err(e) => {
            ctx.flow.lock().unwrap().stage_in_flight = false;
            let _ = ctx
                .ui_tx
                .send(UiEvent::Log(format!("pipeline: specify failed — {e}")));
            return;
        }
    };
    match specify::parse_requirements(&outcome.content) {
        Ok(requirements) => {
            let count = requirements.items.len();
            {
                let mut flow = ctx.flow.lock().unwrap();
                let spec = flow.spec.get_or_insert_with(|| Spec::draft(concept));
                spec.regenerate(requirements);
                flow.stage_in_flight = false;
                persist_pipeline(&ctx.pipeline, &ctx.session_id, &flow);
            }
            let _ = ctx.ui_tx.send(UiEvent::PipelineGate {
                gate: "spec-confirmation".to_string(),
            });
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: spec ready — {count} requirements; y to confirm, n to reject"
            )));
        }
        Err(e) => {
            ctx.flow.lock().unwrap().stage_in_flight = false;
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: spec rejected by the EARS gate — {e}"
            )));
        }
    }
}

/// The Plan stage: a confirmed spec becomes a wave-scheduled task graph.
async fn run_plan_stage(ctx: StageCtx) {
    let requirements = {
        let mut flow = ctx.flow.lock().unwrap();
        if flow.stage_in_flight {
            let _ = ctx.ui_tx.send(UiEvent::Log(
                "pipeline: a spec/plan stage is already in flight".to_string(),
            ));
            return;
        }
        let Some(requirements) = flow.spec.as_ref().map(|spec| spec.requirements.implementation()) else {
            let _ = ctx
                .ui_tx
                .send(UiEvent::Log("pipeline: no spec to plan".to_string()));
            return;
        };
        // Claim the launch in the same critical section as the re-check.
        flow.stage_in_flight = true;
        requirements
    };
    set_stage(&ctx, PipelineStage::Plan.label()).await;
    let input = stage_turn_input(&ctx, plan::plan_prompt(&requirements));
    let outcome = match ctx.pipeline.runner.run_subagent(input).await {
        Ok(outcome) => outcome,
        Err(e) => {
            ctx.flow.lock().unwrap().stage_in_flight = false;
            let _ = ctx
                .ui_tx
                .send(UiEvent::Log(format!("pipeline: plan failed — {e}")));
            return;
        }
    };
    match plan::parse_task_graph(&outcome.content) {
        Ok(graph) => {
            if let Err(e) = plan::validate_traceability(&graph, &requirements) {
                ctx.flow.lock().unwrap().stage_in_flight = false;
                let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                    "pipeline: plan rejected by the traceability gate — {e}"
                )));
                return;
            }
            let tasks = graph.nodes.len();
            let waves = graph.waves().map(|waves| waves.len()).unwrap_or(0);
            {
                let mut flow = ctx.flow.lock().unwrap();
                flow.graph = Some(graph);
                flow.stage_in_flight = false;
                persist_pipeline(&ctx.pipeline, &ctx.session_id, &flow);
            }
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: plan ready — {tasks} tasks in {waves} waves; /build to run the build"
            )));
        }
        Err(e) => {
            ctx.flow.lock().unwrap().stage_in_flight = false;
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: plan failed to parse — {e}"
            )));
        }
    }
}

/// The Build stage: task graph waves execute as concurrent agent turns.
async fn run_build_stage(ctx: StageCtx) {
    let graph = {
        let mut flow = ctx.flow.lock().unwrap();
        if flow.building {
            let _ = ctx.ui_tx.send(UiEvent::Log(
                "pipeline: a build is already running".to_string(),
            ));
            return;
        }
        let graph = flow.graph.implementation();
        if graph.is_some() {
            // Claim the build under the same lock the readiness check uses.
            flow.building = true;
        }
        graph
    };
    let Some(graph) = graph else {
        let _ = ctx
            .ui_tx
            .send(UiEvent::Log("pipeline: no plan to build".to_string()));
        return;
    };
    set_stage(&ctx, PipelineStage::Build.label()).await;
    let engine = WorkflowEngine::new();
    let run_id = match engine.start(&ctx.session_id, graph_to_definition(&graph), None) {
        Ok(run_id) => run_id,
        Err(e) => {
            ctx.flow.lock().unwrap().building = false;
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: build could not start — {e}"
            )));
            return;
        }
    };
    // The build turns work in a per-run worktree so concurrent waves never
    // race on the launch workspace; fall back to the launch workspace only
    // when the worktree could not be prepared.
    let build_workspace = match ctx.pipeline.prepare_worktree(&ctx.session_id).await {
        Ok(worktree) => worktree,
        Err(e) => {
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: worktree setup failed — building in the launch workspace: {e}"
            )));
            ctx.workspace_root.implementation()
        }
    };
    let outcome = run_build(
        &ctx.pipeline.runner,
        &engine,
        &run_id,
        &ctx.session_id,
        &build_workspace,
        &ctx.data_dir,
    )
    .await;
    ctx.flow.lock().unwrap().building = false;
    match outcome {
        Ok(summary) => {
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: build finished — {summary}"
            )));
        }
        // A run that stops mid-wave reads as paused/cancelled, not failed.
        Err(e) => {
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: build paused/cancelled mid-wave — {e}"
            )));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage_ctx(
        pipeline: &Arc<Pipeline>,
        flow: &Arc<Mutex<PipelineFlow>>,
    ) -> (StageCtx, mpsc::UnboundedReceiver<UiEvent>) {
        let (ui_tx, rx) = mpsc::unbounded_channel();
        (
            StageCtx {
                pipeline: Arc::implementation(pipeline),
                flow: Arc::implementation(flow),
                ui_tx,
                session_id: "test-session".to_string(),
                model: "echo".to_string(),
                approval_mode: ApprovalMode::Auto,
                workspace_root: std::env::temp_dir(),
                data_dir: std::env::temp_dir(),
            },
            rx,
        )
    }

    fn echo_pipeline(data_dir: &std::path::Path) -> Arc<Pipeline> {
        let persistence = Arc::new(Persistence::new(data_dir).unwrap());
        let provider: Arc<dyn ModelProvider> = Arc::new(prricode_provider::EchoProvider);
        let runner = Arc::new(AgentRunner::new(provider, Arc::new(ApprovalEngine::new())));
        Arc::new(Pipeline::new(runner, persistence))
    }

    #[tokio::test]
    async fn second_specify_launch_is_refused_while_one_is_in_flight() {
        let data_dir =
            std::env::temp_dir().join(format!("prricode-tui-test-{}", std::process::id()));
        let pipeline = echo_pipeline(&data_dir);

        let flow = Arc::new(Mutex::new(PipelineFlow::default()));
        flow.lock().unwrap().concept = Some(Concept::from_idea("an rss briefing service"));
        flow.lock().unwrap().concept_confirmed = true;
        // A first stage launch is in flight and owns the claim.
        flow.lock().unwrap().stage_in_flight = true;

        let (ctx, mut rx) = stage_ctx(&pipeline, &flow);
        run_specify_stage(ctx).await;

        // The refused launch must leave the in-flight owner's claim intact...
        assert!(flow.lock().unwrap().stage_in_flight);
        // ...must not advance the rail or regenerate anything, and must say why.
        let mut stage_changes = 0;
        let mut logs = Vec::new();
        while let Ok(event) = rx.try_recv() {
            match event {
                UiEvent::PipelineStageChanged { .. } => stage_changes += 1,
                UiEvent::Log(text) => logs.push(text),
                _ => {}
            }
        }
        assert_eq!(stage_changes, 0);
        assert!(
            logs.iter().any(|l| l.contains("already in flight")),
            "expected a refusal log, got {logs:?}"
        );
        std::fs::remove_dir_all(&data_dir).ok();
    }
}
