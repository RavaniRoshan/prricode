//! prricode terminal UI: startup pickers, chat session, streaming turns,
//! inline tool approvals, and slash commands.

mod app;
mod theme;
mod ui;

pub use app::{App, PendingApproval, PipelineView, TurnMessage, UiEvent};
pub use theme::{Theme, ThemeStore};

use anyhow::Result;
use prricode_agent::{
    AgentEvent, AgentRunner, ApprovalEngine, GoalContext, TurnHandle, TurnInput, TurnTicket,
};
use prricode_core::ApprovalMode;
use prricode_persistence::Persistence;
use prricode_pipeline::{
    build::{graph_to_definition, run_build},
    clarify::Clarifier,
    plan, run_verify_stage,
    ship::{run_ship_stage, ShipAnswer, ShipEventKind, ShipFlow, ShipStage},
    specify, verify, Pipeline, PipelineStage, VerifyEventKind,
};
use prricode_provider::{
    create_provider, load_config, resolve_settings, AssistantMessage, ChatMessage, ContentPart,
    ModelProvider, ProviderKind,
};
use prricode_spec::{Concept, Spec, TaskGraph};
use prricode_verify::Verdict;
use prricode_workflow::WorkflowEngine;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

/// Commands the UI sends to the agent task.
pub enum UiCommand {
    Submit(String),
    Cancel,
    Approve {
        approval_id: String,
        approved: bool,
    },
    SetModel {
        model: String,
    },
    SetApprovalMode(ApprovalMode),
    /// Persist an "always allow in this workspace" policy amendment.
    RecordAmendment {
        amendment: crate::app::PolicyAmendment,
    },
    PipelineConcept {
        idea: String,
    },
    PipelineAnswer {
        answer: String,
    },
    PipelineConfirm {
        stage: String,
        ok: bool,
    },
    PipelineAdvance {
        stage: String,
    },
    /// Start the ship stage: the release runs behind the confirmation
    /// gate, and a deploy plan is proposed once the release is out.
    ShipStart,
    /// The operator's answer to a proposed deploy plan: confirmed runs the
    /// plan's commands, otherwise the deploy is skipped.
    DeployConfirm {
        confirmed: bool,
    },
    /// One credential value for the plan the ship flow is collecting. The
    /// value is env-only: it is forwarded here and never persisted.
    DeploySecret {
        name: String,
        value: String,
    },
    /// Run a standalone operate health pass.
    OperateRun,
    /// Switch the persisted TUI theme (settings key `theme`).
    SetTheme {
        slug: String,
    },
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
    let settings = config.providers.get(kind.id()).cloned();
    let mut overrides = HashMap::new();
    if let Some(base_url) = &launch.base_url {
        overrides.insert("base_url".to_string(), base_url.clone());
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    let provider_config = resolve_settings(kind, settings.as_ref(), &overrides, &env);
    let provider: Arc<dyn ModelProvider> = Arc::from(create_provider(provider_config));
    let default_model = launch
        .model
        .clone()
        .or_else(|| config.defaults.model.clone())
        .unwrap_or_default();

    let data_dir = launch.data_dir.clone().unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
            .join(".local/share/prricode")
    });
    let persistence = Arc::new(Persistence::new(&data_dir)?);

    // Channels: agent -> ui (events), ui -> agent (commands).
    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<AgentEvent>();
    let (ui_tx, mut ui_rx) = mpsc::unbounded_channel::<UiEvent>();
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<UiCommand>();
    let cmd_tx_agent = cmd_tx.clone();

    let approvals = Arc::new(ApprovalEngine::new().with_events(events_tx.clone()));
    let runner = Arc::new(
        AgentRunner::new(Arc::clone(&provider), Arc::clone(&approvals))
            .with_events(events_tx.clone())
            .with_persistence(Arc::clone(&persistence))
            .with_default_model(default_model.clone()),
    );
    AgentRunner::init_self_weak(&runner);

    // Agent task: owns the runner, session state, and active turn handle.
    let agent_persistence = Arc::clone(&persistence);
    let agent_runner = Arc::clone(&runner);
    let agent_approvals = Arc::clone(&approvals);
    let agent_data_dir = data_dir.clone();
    let agent_launch = LaunchConfig {
        provider: kind,
        model: Some(default_model.clone()),
        base_url: launch.base_url.clone(),
        approval_mode: launch.approval_mode,
        workspace_root: launch.workspace_root.clone(),
        data_dir: Some(data_dir.clone()),
        resume_session: launch.resume_session.clone(),
    };
    let cmd_tx_agent = cmd_tx_agent;
    tokio::spawn(async move {
        let session_id = agent_launch
            .resume_session
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let mut model = agent_launch.model.clone().unwrap_or_default();
        let mut approval_mode = agent_launch.approval_mode;
        let mut active_turn: Option<TurnHandle> = None;
        let mut queued: Option<String> = None;
        // Product-builder pipeline: the stage runner plus per-session flow
        // state shared with the spawned stage tasks.
        let pipeline = Arc::new(Pipeline::new(
            Arc::clone(&agent_runner),
            Arc::clone(&agent_persistence),
        ));
        let flow = Arc::new(Mutex::new(PipelineFlow::default()));
        // The running ship flow's answer half: the loop forwards the deploy
        // confirmation and the collected credential values to the flow task.
        let mut ship_answers: Option<mpsc::UnboundedSender<ShipAnswer>> = None;
        let stage_workspace = agent_launch
            .workspace_root
            .clone()
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
                        id: session_id.clone(),
                        workspace_root: agent_launch
                            .workspace_root
                            .as_ref()
                            .map(|p| p.display().to_string()),
                        model_id: Some(model.clone()),
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
                    active_turn = Some(handle.clone());
                    let input = TurnInput {
                        session_id: session_id.clone(),
                        model: model.clone(),
                        approval_mode,
                        workspace_root: agent_launch.workspace_root.clone().unwrap_or_else(|| {
                            std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
                        }),
                        data_dir: agent_data_dir.clone(),
                        history,
                        user_content: vec![ContentPart::text(text)],
                        goal,
                        skills_prompt: None,
                        max_iterations: 25,
                        turn_id: uuid::Uuid::now_v7().to_string(),
                    };
                    let runner = Arc::clone(&agent_runner);
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
                UiCommand::RecordAmendment { amendment } => {
                    // Durable "always allow in this workspace" rule.
                    if let Err(e) = agent_persistence.set_setting(
                        &format!("approvalAmendment:{}", session_id),
                        &serde_json::to_string(&amendment).unwrap_or_default(),
                    ) {
                        tracing::warn!("amendment persist failed: {e}");
                    }
                }
                UiCommand::PipelineConcept { idea } => {
                    let concept = Concept::from_idea(&idea);
                    let question = Clarifier::new(concept.clone()).next_question();
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
                            (clarifier.next_question(), clarifier.concept.clone())
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
                        let current = flow.lock().unwrap().stage.clone();
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
                                    pipeline: Arc::clone(&pipeline),
                                    flow: Arc::clone(&flow),
                                    ui_tx: ui_tx.clone(),
                                    session_id: session_id.clone(),
                                    model: model.clone(),
                                    approval_mode,
                                    workspace_root: stage_workspace.clone(),
                                    data_dir: agent_data_dir.clone(),
                                },
                            );
                        }
                        "spec-confirmation" => {
                            flow.lock().unwrap().spec_confirmed = true;
                            persist_pipeline(&pipeline, &session_id, &flow.lock().unwrap());
                            spawn_stage(
                                run_plan_stage,
                                StageCtx {
                                    pipeline: Arc::clone(&pipeline),
                                    flow: Arc::clone(&flow),
                                    ui_tx: ui_tx.clone(),
                                    session_id: session_id.clone(),
                                    model: model.clone(),
                                    approval_mode,
                                    workspace_root: stage_workspace.clone(),
                                    data_dir: agent_data_dir.clone(),
                                },
                            );
                        }
                        "ship-confirmation" => {
                            let (workspace, dossier) = {
                                let flow = flow.lock().unwrap();
                                ship_target(&flow, &stage_workspace, &agent_data_dir)
                            };
                            let (answer_tx, answer_rx) = mpsc::unbounded_channel();
                            ship_answers = Some(answer_tx);
                            spawn_stage(
                                run_ship_flow,
                                ShipCtx {
                                    pipeline: Arc::clone(&pipeline),
                                    ui_tx: ui_tx.clone(),
                                    session_id: session_id.clone(),
                                    workspace,
                                    data_dir: agent_data_dir.clone(),
                                    dossier_path: dossier,
                                    answer_rx,
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
                        pipeline: Arc::clone(&pipeline),
                        flow: Arc::clone(&flow),
                        ui_tx: ui_tx.clone(),
                        session_id: session_id.clone(),
                        model: model.clone(),
                        approval_mode,
                        workspace_root: stage_workspace.clone(),
                        data_dir: agent_data_dir.clone(),
                    };
                    match stage.as_str() {
                        "specify" => spawn_stage(run_specify_stage, ctx),
                        "plan" => spawn_stage(run_plan_stage, ctx),
                        "build" => spawn_stage(run_build_stage, ctx),
                        _ => {}
                    }
                }
                UiCommand::ShipStart => {
                    // A finished flow drops its answer half: retire it so the
                    // next ship can start.
                    if ship_answers.as_ref().is_some_and(|tx| tx.is_closed()) {
                        ship_answers = None;
                    }
                    if ship_answers.is_some() {
                        let _ = ui_tx.send(UiEvent::Log(
                            "ship: a ship/deploy flow is already running".to_string(),
                        ));
                        continue;
                    }
                    let (workspace, building) = {
                        let flow = flow.lock().unwrap();
                        (
                            flow.build_workspace
                                .clone()
                                .unwrap_or_else(|| stage_workspace.clone()),
                            flow.building,
                        )
                    };
                    if building {
                        let _ = ui_tx.send(UiEvent::Log(
                            "ship: a build is still running — wait for it to finish".to_string(),
                        ));
                        continue;
                    }
                    // The release is irreversible: open the confirmation
                    // gate first, exactly as the spec and concept gates do.
                    let _ = ui_tx.send(UiEvent::Log(format!(
                        "ship: will release the workspace {} — press y to confirm, n to cancel",
                        workspace.display()
                    )));
                    let _ = ui_tx.send(UiEvent::PipelineGate {
                        gate: "ship-confirmation".to_string(),
                    });
                }
                UiCommand::DeployConfirm { confirmed } => {
                    let Some(answers) = ship_answers.as_ref() else {
                        let _ = ui_tx.send(UiEvent::Log(
                            "deploy: no deploy flow is waiting — /ship first".to_string(),
                        ));
                        continue;
                    };
                    let _ = answers.send(ShipAnswer::DeployChoice { confirmed });
                }
                UiCommand::DeploySecret { name, value } => {
                    let Some(answers) = ship_answers.as_ref() else {
                        let _ = ui_tx.send(UiEvent::Log(
                            "deploy: no deploy flow is waiting — /ship first".to_string(),
                        ));
                        continue;
                    };
                    // The value only ever travels this one hop; nothing
                    // persists it.
                    let _ = answers.send(ShipAnswer::SecretValue { name, value });
                }
                UiCommand::OperateRun => {
                    let workspace = {
                        let flow = flow.lock().unwrap();
                        ship_target(&flow, &stage_workspace, &agent_data_dir).0
                    };
                    operate_pass(&ui_tx, &agent_persistence, &session_id, &workspace).await;
                }
                UiCommand::SetTheme { slug } => {
                    if let Err(e) = agent_persistence.set_setting("theme", &slug) {
                        tracing::warn!("theme save failed: {e}");
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
    // Theme selection: the config file names a starting theme, and the last
    // `/theme` choice (persisted under the settings key `theme`) wins over
    // it. An unknown name falls back to the default with a log line.
    if let Some(theme) = &config.theme {
        app.apply_theme_setting(theme);
    }
    let persisted_theme = persistence.get_setting("theme").ok().flatten();
    if let Some(theme) = persisted_theme {
        app.apply_theme_setting(&theme);
    }
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
            approval_id: approval_id.clone(),
            kind: kind.clone(),
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
    let input = item.get("input").cloned().unwrap_or(serde_json::json!({}));
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
    /// The current build's workflow run id, persisted with the pipeline
    /// state so the server's `pipeline/verifyRead` resolves this session's
    /// verification report by run id.
    run_id: Option<String>,
    /// The workspace the build ran in (its worktree), released by the ship
    /// stage.
    build_workspace: Option<PathBuf>,
    /// Specify and plan share one in-flight claim: a late specify must not
    /// regenerate the spec while a plan is consuming it.
    stage_in_flight: bool,
}

impl PipelineFlow {
    /// Start a fresh concept interview, discarding any prior run.
    fn start(&mut self, concept: Concept) {
        self.clarifier = Some(Clarifier::new(concept.clone()));
        self.concept = Some(concept);
        self.spec = None;
        self.graph = None;
        self.concept_confirmed = false;
        self.spec_confirmed = false;
        self.building = false;
        self.run_id = None;
        self.build_workspace = None;
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

fn spawn_stage<C, F>(stage: fn(C) -> F, ctx: C)
where
    F: std::future::Future<Output = ()> + Send + 'static,
{
    tokio::spawn(stage(ctx));
}

/// The workspace the ship stage releases (the build's worktree when a build
/// ran, else the launch workspace) and the v0.2 dossier to attach to the
/// release notes.
fn ship_target(
    flow: &PipelineFlow,
    fallback: &Path,
    data_dir: &Path,
) -> (PathBuf, Option<PathBuf>) {
    let workspace = flow
        .build_workspace
        .clone()
        .unwrap_or_else(|| fallback.to_path_buf());
    let dossier = flow.run_id.as_ref().map(|run_id| {
        data_dir
            .join("runs")
            .join(run_id)
            .join("acceptance-dossier.md")
    });
    (workspace, dossier)
}

/// The session's run id from its persisted pipeline state, else the session
/// id itself — the resolution the ship stage persists and reads by.
fn resolve_run_id(persistence: &Persistence, session_id: &str) -> String {
    persistence
        .get_setting(&format!("pipeline:{session_id}"))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|state| {
            state
                .get("runId")
                .and_then(|run_id| run_id.as_str())
                .map(str::to_string)
        })
        .filter(|run_id| !run_id.is_empty())
        .unwrap_or_else(|| session_id.to_string())
}

/// Context for the ship flow task: the release plus the step-driven deploy
/// flow, whose steps the operator answers on the answer channel.
struct ShipCtx {
    pipeline: Arc<Pipeline>,
    ui_tx: mpsc::UnboundedSender<UiEvent>,
    session_id: String,
    workspace: PathBuf,
    data_dir: PathBuf,
    dossier_path: Option<PathBuf>,
    /// The operator's answers, forwarded by the agent loop.
    answer_rx: mpsc::UnboundedReceiver<ShipAnswer>,
}

/// The ship stage's surface half: release the workspace, then drive the
/// deploy flow step by step — each step's events become UI events, and each
/// pending input waits for the operator's answer. The flow ends when it is
/// done, the deploy is declined, or the answer channel closes.
async fn run_ship_flow(mut ctx: ShipCtx) {
    let record = match run_ship_stage(
        &ctx.pipeline.runner,
        &ctx.pipeline.persistence,
        &ctx.session_id,
        &ctx.workspace,
        &ctx.data_dir,
        ctx.dossier_path.as_deref(),
    )
    .await
    {
        Ok(record) => record,
        Err(e) => {
            let _ = ctx.ui_tx.send(UiEvent::Log(format!("ship: failed — {e}")));
            return;
        }
    };
    let _ = ctx.ui_tx.send(UiEvent::ShipReady {
        tag: record.tag.clone().unwrap_or_else(|| "untagged".to_string()),
        release_url: record.release_url.clone(),
        install_steps: record.install_steps.clone(),
    });

    let mut flow = ShipFlow::new(record, &ctx.workspace, &ctx.data_dir);
    let (ship_tx, mut ship_rx) = mpsc::unbounded_channel::<ShipEventKind>();
    while flow.stage() != ShipStage::Done {
        let pending = flow.poll(&ship_tx).await;
        while let Ok(event) = ship_rx.try_recv() {
            match event {
                // A manual plan has no commands to run — the operator would
                // deploy by hand — so the TUI refuses the deploy with a log
                // line and the flow short-circuits to done.
                ShipEventKind::DeployProposed { target, .. } if target == "manual" => {
                    let _ = ctx.ui_tx.send(UiEvent::Log(
                        "deploy: refused — the plan target is manual (no commands to run; \
                         deploy by hand, then /operate to check health)"
                            .to_string(),
                    ));
                    flow.answer(ShipAnswer::DeployChoice { confirmed: false });
                }
                other => emit_ship_event(&ctx.ui_tx, &flow, other),
            }
        }
        // The event handling above may have finished the flow already.
        if flow.stage() == ShipStage::Done {
            break;
        }
        // A step that ran work needs no answer; keep driving the flow.
        if pending.is_none() {
            continue;
        }
        // The flow ignores answers that do not match the pending input, so
        // whatever arrives is safe to forward.
        match ctx.answer_rx.recv().await {
            Some(answer) => flow.answer(answer),
            // The UI went away: stop driving the flow.
            None => break,
        }
    }
}

/// Translate one ship-flow event into the UI events the surfaces render.
fn emit_ship_event(ui_tx: &mpsc::UnboundedSender<UiEvent>, flow: &ShipFlow, event: ShipEventKind) {
    match event {
        ShipEventKind::DeployProposed {
            target,
            credentials,
        } => {
            let reason = flow
                .plan()
                .map(|plan| plan.reason.clone())
                .unwrap_or_else(|| "detected from the workspace".to_string());
            let _ = ui_tx.send(UiEvent::DeployProposed {
                target,
                reason,
                credentials,
            });
        }
        ShipEventKind::DeploySecretRequested { name, purpose, .. } => {
            let _ = ui_tx.send(UiEvent::DeploySecret { name, purpose });
        }
        ShipEventKind::DeployDone { ok } => {
            let _ = ui_tx.send(UiEvent::DeployDone { ok });
        }
        ShipEventKind::HealthOk { name } => {
            let _ = ui_tx.send(UiEvent::HealthChecked {
                name,
                ok: true,
                detail: None,
            });
        }
        ShipEventKind::HealthFailed { name, issue } => {
            let _ = ui_tx.send(UiEvent::HealthChecked {
                name,
                ok: false,
                detail: issue,
            });
        }
        // The ship half reports through ShipReady before the flow starts.
        ShipEventKind::ShipReady { .. } => {}
    }
}

/// One standalone operate health pass: read the session's ship record and
/// probe that its release tag still resolves in the build workspace. The
/// probe is local and dependency-free; a session that never shipped says
/// so instead of probing.
async fn operate_pass(
    ui_tx: &mpsc::UnboundedSender<UiEvent>,
    persistence: &Persistence,
    session_id: &str,
    workspace: &Path,
) {
    let run_id = resolve_run_id(persistence, session_id);
    let tag = persistence
        .get_setting(&format!("ship:{run_id}"))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|record| {
            record
                .get("tag")
                .and_then(|tag| tag.as_str())
                .map(str::to_string)
        });
    let Some(tag) = tag else {
        let _ = ui_tx.send(UiEvent::Log(
            "operate: nothing shipped for this session yet — /ship first".to_string(),
        ));
        return;
    };
    let probe = format!(
        "git -C '{}' rev-parse --verify 'refs/tags/{tag}'",
        workspace.display()
    );
    match tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&probe)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let _ = ui_tx.send(UiEvent::HealthChecked {
                name: "release".to_string(),
                ok: true,
                detail: Some(format!("tag {tag} resolves")),
            });
        }
        Ok(output) => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let _ = ui_tx.send(UiEvent::HealthChecked {
                name: "release".to_string(),
                ok: false,
                detail: Some(format!("tag {tag} does not resolve: {detail}")),
            });
        }
        Err(e) => {
            let _ = ui_tx.send(UiEvent::Log(format!("operate: probe could not run — {e}")));
        }
    }
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
                .map(|wave| wave.iter().map(|node| node.id.clone()).collect())
                .collect()
        })
        .unwrap_or_default();
    let state = serde_json::json!({
        "stage": flow.stage,
        "concept": flow.concept.as_ref().and_then(|c| serde_json::to_value(c).ok()),
        "spec": flow.spec.as_ref().and_then(|s| serde_json::to_value(s).ok()),
        "waves": waves,
        "runId": flow.run_id,
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
        session_id: ctx.session_id.clone(),
        model: ctx.model.clone(),
        approval_mode: ctx.approval_mode,
        workspace_root: ctx.workspace_root.clone(),
        data_dir: ctx.data_dir.clone(),
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
            ContentPart::Text(text) => text.clone(),
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
        let Some(concept) = flow.concept.clone() else {
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
        let Some(requirements) = flow.spec.as_ref().map(|spec| spec.requirements.clone()) else {
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
        let graph = flow.graph.clone();
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
    {
        // Record the run id so the verify pass and pipeline/verifyRead can
        // resolve this session's dossier.
        let mut flow = ctx.flow.lock().unwrap();
        flow.run_id = Some(run_id.clone());
        persist_pipeline(&ctx.pipeline, &ctx.session_id, &flow);
    }
    // The build turns work in a per-run worktree so concurrent waves never
    // race on the launch workspace; fall back to the launch workspace only
    // when the worktree could not be prepared.
    let build_workspace = match ctx.pipeline.prepare_worktree(&ctx.session_id).await {
        Ok(worktree) => worktree,
        Err(e) => {
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: worktree setup failed — building in the launch workspace: {e}"
            )));
            ctx.workspace_root.clone()
        }
    };
    {
        // Record the workspace the ship stage releases, alongside the run id.
        let mut flow = ctx.flow.lock().unwrap();
        flow.build_workspace = Some(build_workspace.clone());
    }
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
            // Only verify a completed build: cancelled/paused runs read as
            // Ok with a non-completed summary (build.rs) and an incomplete
            // workspace would burn a verifier turn on red gates.
            if summary == "build completed" {
                run_verify_after_build(&ctx, &engine, &run_id, &build_workspace).await;
            }
        }
        // A run that stops mid-wave reads as paused/cancelled, not failed.
        Err(e) => {
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: build paused/cancelled mid-wave — {e}"
            )));
        }
    }
}

/// The verify pass after a successful build: run the verify stage on the
/// build's workspace, relay one log line per gate and verdict plus the
/// dossier's path, and finish with the `VerifyDone` rail counts.
async fn run_verify_after_build(
    ctx: &StageCtx,
    engine: &WorkflowEngine,
    run_id: &str,
    workspace: &Path,
) {
    let requirements_json = {
        let flow = ctx.flow.lock().unwrap();
        let Some(spec) = flow.spec.as_ref() else {
            let _ = ctx.ui_tx.send(UiEvent::Log(
                "pipeline: verify skipped — no spec to verify".to_string(),
            ));
            return;
        };
        match serde_json::to_string(&spec.requirements) {
            Ok(json) => json,
            Err(e) => {
                let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                    "pipeline: verify skipped — spec requirements do not serialize: {e}"
                )));
                return;
            }
        }
    };
    // The verifier runs on the evidence-only runner derived from the
    // pipeline runner: it reads the workspace, never writes or executes.
    let verifier = verify::evidence_only_verifier(&ctx.pipeline.runner);
    let report = match run_verify_stage(
        &verifier,
        engine,
        run_id,
        &ctx.session_id,
        workspace,
        &ctx.data_dir,
        &requirements_json,
    )
    .await
    {
        Ok(report) => report,
        Err(e) => {
            let _ = ctx
                .ui_tx
                .send(UiEvent::Log(format!("pipeline: verify failed — {e}")));
            return;
        }
    };
    let dossier_path = ctx
        .data_dir
        .join("runs")
        .join(run_id)
        .join("acceptance-dossier.md");
    for event in verify::report_events(&report, &dossier_path) {
        let _ = ctx.ui_tx.send(match event {
            VerifyEventKind::GateResult { gate, passed } => UiEvent::Log(format!(
                "verify: gate {gate} {}",
                if passed { "passed" } else { "FAILED" }
            )),
            VerifyEventKind::Verdict {
                requirement_id,
                verdict,
            } => UiEvent::Log(format!("verify: {requirement_id} — {verdict}")),
            VerifyEventKind::DossierReady { path } => {
                UiEvent::Log(format!("verify: dossier ready — {path}"))
            }
        });
    }
    let gates_passed = report.gates.iter().filter(|gate| gate.passed).count();
    let tally = |verdict: Verdict| {
        report
            .requirements
            .iter()
            .filter(|v| v.verdict == verdict)
            .count()
    };
    let _ = ctx.ui_tx.send(UiEvent::VerifyDone {
        report_path: dossier_path.display().to_string(),
        gates_passed,
        gates_total: report.gates.len(),
        pass: tally(Verdict::Pass),
        fail: tally(Verdict::Fail),
        unverified: tally(Verdict::Unverified),
    });
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
                pipeline: Arc::clone(pipeline),
                flow: Arc::clone(flow),
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

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("prricode-tui-ship-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A git repo with a Rust project and no deploy markers: the plan
    /// target is manual, so the TUI refuses the deploy.
    fn git_workspace(name: &str) -> std::path::PathBuf {
        let dir = temp_dir(name);
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "# probe\n").unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.email", "ship@example.com"]);
        git(&dir, &["config", "user.name", "ship test"]);
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[tokio::test]
    async fn a_manual_plan_short_circuits_the_deploy_with_a_log() {
        // A git workspace with no deploy markers proposes the manual plan:
        // there are no commands to run, so the TUI refuses the deploy with
        // a log line and the flow finishes with the ship record alone.
        let dir = git_workspace("manual");
        let data_dir = temp_dir("manual-data");
        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel();
        let (_answer_tx, answer_rx) = mpsc::unbounded_channel();
        let ctx = ShipCtx {
            pipeline: echo_pipeline(&data_dir),
            ui_tx,
            session_id: "session-manual".to_string(),
            workspace: dir.clone(),
            data_dir: data_dir.clone(),
            dossier_path: None,
            answer_rx,
        };

        // The answer channel is never written to: the task can only return
        // because nothing waited for an operator answer.
        run_ship_flow(ctx).await;

        let mut ship_ready = false;
        let mut logs = Vec::new();
        let mut proposed = 0;
        while let Ok(event) = ui_rx.try_recv() {
            match event {
                UiEvent::ShipReady { .. } => ship_ready = true,
                UiEvent::Log(text) => logs.push(text),
                UiEvent::DeployProposed { .. } => proposed += 1,
                _ => {}
            }
        }
        // The release shipped, its record on the rail...
        assert!(ship_ready, "the release must report ready, got {logs:?}");
        // ...the manual plan was refused with a log line, never proposed...
        assert!(
            logs.iter().any(|l| l.contains("manual")),
            "expected a manual-plan refusal log, got {logs:?}"
        );
        assert_eq!(proposed, 0, "a manual plan must not be proposed to the UI");

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }

    /// Drain the UI event stream until an event of kind `wanted` arrives,
    /// keeping every event seen meanwhile in `events`.
    async fn await_event(
        events: &mut Vec<UiEvent>,
        rx: &mut mpsc::UnboundedReceiver<UiEvent>,
        wanted: &str,
    ) {
        loop {
            while let Ok(event) = rx.try_recv() {
                let hit = matches!(&event, UiEvent::DeployProposed { .. } if wanted == "proposed")
                    || matches!(&event, UiEvent::DeploySecret { .. } if wanted == "secret");
                events.push(event);
                if hit {
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    #[tokio::test]
    async fn a_confirmed_deploy_collects_the_secret_and_runs_through_operate() {
        // A shipped git workspace whose marker proposes the vercel plan: the
        // deploy CLI is not on PATH, so the commands fail, but the flow still
        // reaches the health pass — the full sequence, in order.
        let dir = git_workspace("deploy");
        std::fs::write(dir.join("vercel.json"), "{}\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "marker"]);
        let data_dir = temp_dir("deploy-data");
        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel();
        let (answer_tx, answer_rx) = mpsc::unbounded_channel();
        let ctx = ShipCtx {
            pipeline: echo_pipeline(&data_dir),
            ui_tx,
            session_id: "session-deploy".to_string(),
            workspace: dir.clone(),
            data_dir: data_dir.clone(),
            dossier_path: None,
            answer_rx,
        };
        let flow_task = tokio::spawn(run_ship_flow(ctx));

        // The plan is proposed; confirm it, then hand over the credential.
        let mut events = Vec::new();
        await_event(&mut events, &mut ui_rx, "proposed").await;
        answer_tx
            .send(ShipAnswer::DeployChoice { confirmed: true })
            .unwrap();
        await_event(&mut events, &mut ui_rx, "secret").await;
        assert!(events.iter().any(
            |event| matches!(event, UiEvent::DeploySecret { name, .. } if name == "VERCEL_TOKEN")
        ));
        let secret = "s3cret-deploy-token-value";
        answer_tx
            .send(ShipAnswer::SecretValue {
                name: "VERCEL_TOKEN".to_string(),
                value: secret.to_string(),
            })
            .unwrap();
        flow_task.await.unwrap();
        while let Ok(event) = ui_rx.try_recv() {
            events.push(event);
        }

        // The commands ran and failed (no vercel on PATH), then the health
        // pass verified the shipped tag: the whole sequence, in order.
        let kinds: Vec<&str> = events
            .iter()
            .map(|event| match event {
                UiEvent::ShipReady { .. } => "ship-ready",
                UiEvent::DeployProposed { .. } => "proposed",
                UiEvent::DeploySecret { .. } => "secret",
                UiEvent::DeployDone { ok } => {
                    if *ok {
                        "deploy-ok"
                    } else {
                        "deploy-failed"
                    }
                }
                UiEvent::HealthChecked { ok, .. } => {
                    if *ok {
                        "health-ok"
                    } else {
                        "health-failed"
                    }
                }
                _ => "other",
            })
            .collect();
        assert_eq!(
            kinds,
            vec![
                "ship-ready",
                "proposed",
                "secret",
                "deploy-failed",
                "health-ok"
            ]
        );
        // The value never lands in any persisted row or the operate log.
        for (key, value) in Persistence::new(&data_dir)
            .unwrap()
            .list_settings()
            .unwrap()
        {
            assert!(
                !value.contains(secret),
                "settings row {key} carries the secret: {value}"
            );
        }
        let operate_dir = data_dir.join("operate");
        if let Ok(entries) = std::fs::read_dir(&operate_dir) {
            for entry in entries.flatten() {
                let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                assert!(
                    !text.contains(secret),
                    "{} carries the secret",
                    entry.path().display()
                );
            }
        }

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }
}
