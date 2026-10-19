//! prricode terminal UI: startup pickers, chat session, streaming turns,
//! inline tool approvals, and slash commands.

mod app;
mod theme;
mod ui;

pub use app::{App, PendingApproval, PipelineView, Role, SessionSummary, TurnMessage, UiEvent};
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
#[derive(Debug)]
pub enum UiCommand {
    Submit {
        text: String,
        /// A pending pasted image, base64-encoded, sent exactly once.
        image: Option<ContentPart>,
    },
    Cancel,
    Approve {
        approval_id: String,
        approved: bool,
    },
    SetModel {
        model: String,
    },
    SetApprovalMode(ApprovalMode),
    HooksList,
    SwitchSession {
        session_id: String,
    },
    /// `/sessions` picker: request every stored session summary.
    SessionsList,
    /// `/message <session> <text>`: queue a cross-session message into the
    /// workspace's `.prricode/messages` JSONL queue (same file contract as
    /// the send_message tool).
    SendMessage {
        to: String,
        text: String,
    },
    /// `/hooks add <event>[@tool] <command> [args…]`: register a command hook
    /// with the runner's engine for this session.
    AddHook {
        event: String,
        command: String,
        args: Vec<String>,
        matcher: Option<String>,
    },
    /// `/stats` (totals) and `/insights` (per-day) over the workspace DB.
    WorkspaceStats {
        insights: bool,
    },
    /// Persist an "always allow in this workspace" policy amendment.
    RecordAmendment {
        amendment: crate::app::PolicyAmendment,
    },
    /// `/keybind`: persist the whole chord remap map under
    /// `tui:keybindings` so rebinds reload at the next launch.
    SetKeybindings {
        json: String,
    },
    /// '!' shell mode: run a command in the workspace (spec keybinding).
    ShellRun {
        command: String,
    },
    /// '@' file picker: request workspace paths.
    GlobRequest {
        pattern: String,
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
    /// plan's commands, otherwise the deploy is skipped. `auto_rollback`
    /// arms autonomous rollback when the later health check fails (default
    /// no); it is asked at deploy-confirmation time.
    DeployConfirm {
        confirmed: bool,
        auto_rollback: bool,
    },
    /// One credential value for the plan the ship flow is collecting. The
    /// value is env-only: it is forwarded here and never persisted.
    DeploySecret {
        name: String,
        value: String,
    },
    /// Run a standalone operate health pass.
    OperateRun,
    /// Draft the market/competitive research brief. The output is a draft a
    /// human confirms; unsourced claims are reported, not hidden.
    BusinessResearch,
    /// Draft the pricing model. Tiers and prices come from the operator.
    BusinessPricing,
    /// Draft the landing page plan.
    BusinessLanding,
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
        let mut session_id = agent_launch
            .resume_session
            .implementation()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let mut model = agent_launch.model.implementation().unwrap_or_default();
        let mut approval_mode = agent_launch.approval_mode;
        let mut active_turn: Option<TurnHandle> = None;
        let mut queued: Option<(String, Option<ContentPart>)> = None;
        // Product-builder pipeline: the stage runner plus per-session flow
        // state shared with the spawned stage tasks.
        let pipeline = Arc::new(Pipeline::new(
            Arc::implementation(&agent_runner),
            Arc::implementation(&agent_persistence),
        ));
        let flow = Arc::new(Mutex::new(PipelineFlow::default()));
        // The running ship flow's answer half: the loop forwards the deploy
        // confirmation and the collected credential values to the flow task.
        let mut ship_answers: Option<mpsc::UnboundedSender<ShipAnswer>> = None;
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
                if let Some((text, image)) = queued.take() {
                    let _ = cmd_tx_agent.send(UiCommand::Submit { text, image });
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
                UiCommand::Submit { text, image } => {
                    if active_turn.is_some() {
                        queued = Some((text, image));
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
                        user_content: submit_user_content(text, image),
                        goal,
                        skills_prompt: None,
                        allowed_tools: Vec::new(),
                        max_iterations: 25,
                        turn_id: uuid::Uuid::now_v7().to_string(),
                        provider_override: None,
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
                UiCommand::HooksList => {
                    let runner = Arc::implementation(&agent_runner);
                    let ui_tx_hooks = ui_tx.implementation();
                    tokio::spawn(async move {
                        let text = if let Some(engine) = runner.hooks() {
                            let hooks = engine.list();
                            if hooks.is_empty() {
                                "hooks: none registered".to_string()
                            } else {
                                let lines: Vec<String> = hooks
                                    .iter()
                                    .map(|h| {
                                        format!(
                                            "{} [{}] {} (supported: {})",
                                            h.id,
                                            h.event.as_str(),
                                            h.hook_type.as_str(),
                                            h.hook_type.supported()
                                        )
                                    })
                                    .collect();
                                format!(
                                    "hooks:
{}",
                                    lines.join(
                                        "
"
                                    )
                                )
                            }
                        } else {
                            "hooks: engine unavailable".to_string()
                        };
                        let _ = ui_tx_hooks.send(UiEvent::Log(text));
                    });
                }
                UiCommand::AddHook {
                    event,
                    command,
                    args,
                    matcher,
                } => {
                    let runner = Arc::implementation(&agent_runner);
                    let ui_tx_add = ui_tx.implementation();
                    tokio::spawn(async move {
                        let Some(engine) = runner.hooks() else {
                            let _ = ui_tx_add.send(UiEvent::Log(
                                "hook add failed: engine unavailable".to_string(),
                            ));
                            return;
                        };
                        let Some(parsed) = prricode_agent::HookEvent::parse(&event) else {
                            let known = prricode_agent::HookEvent::all()
                                .iter()
                                .map(|e| e.as_str())
                                .collect::<Vec<_>>()
                                .join(", ");
                            let _ = ui_tx_add.send(UiEvent::Log(format!(
                                "unknown hook event '{event}'; known: {known}"
                            )));
                            return;
                        };
                        let hook = prricode_agent::HookDefinition::command(
                            format!("tui-{}", uuid::Uuid::now_v7()),
                            parsed,
                            command.implementation(),
                        )
                        .with_args(args.implementation());
                        let matcher_note = matcher
                            .as_deref()
                            .map(|m| format!(" (matcher: {m})"))
                            .unwrap_or_default();
                        let hook = match matcher {
                            Some(m) => hook.with_matcher(m),
                            None => hook,
                        };
                        engine.add(hook);
                        let _ = ui_tx_add.send(UiEvent::Log(format!(
                            "hook registered: {} {command} {}{matcher_note}",
                            event,
                            args.join(" ")
                        )));
                    });
                }
                UiCommand::WorkspaceStats { insights } => {
                    let text = match agent_persistence.workspace_stats() {
                        Ok(stats) => crate::app::format_workspace_stats(&stats, insights),
                        Err(e) => format!("stats failed: {e}"),
                    };
                    let _ = ui_tx.send(UiEvent::Log(text));
                }
                UiCommand::SwitchSession { session_id: new_id } => {
                    session_id = new_id.implementation();
                    let messages = load_display_messages(&agent_persistence, &session_id);
                    let _ = ui_tx.send(UiEvent::SessionSwitched {
                        session_id: new_id,
                        messages,
                    });
                }
                UiCommand::SessionsList => {
                    let mut sessions: Vec<SessionSummary> = agent_persistence
                        .list_sessions()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|record| SessionSummary {
                            id: record.id.implementation(),
                            model: record.model_id.unwrap_or_default(),
                            workspace: record.workspace_root.unwrap_or_default(),
                        })
                        .collect();
                    sessions.sort_by(|a, b| a.id.cmp(&b.id));
                    let _ = ui_tx.send(UiEvent::SessionsListed { sessions });
                }
                UiCommand::SendMessage { to, text } => {
                    // Same queue contract as the send_message tool:
                    // <workspace>/.prricode/messages/<to>.jsonl, one JSON
                    // object per line. The composer reports acceptance; a
                    // failure surfaces honestly.
                    let queue = stage_workspace
                        .implementation()
                        .join(".prricode")
                        .join("messages")
                        .join(format!("{to}.jsonl"));
                    let ui_tx_msg = ui_tx.implementation();
                    tokio::spawn(async move {
                        let line = serde_json::json!({ "to": to, "message": text });
                        let outcome = (|| -> std::io::Result<()> {
                            std::fs::create_dir_all(
                                queue
                                    .parent()
                                    .ok_or_else(|| std::io::Error::other("no parent"))?,
                            )?;
                            let mut f = std::fs::OpenOptions::new()
                                .create(true)
                                .append(true)
                                .open(&queue)?;
                            use std::io::Write;
                            writeln!(f, "{line}")
                        })();
                        match outcome {
                            Ok(()) => {
                                let _ = ui_tx_msg.send(UiEvent::Log(format!(
                                    "message queued to {}",
                                    queue.display()
                                )));
                            }
                            Err(e) => {
                                let _ =
                                    ui_tx_msg.send(UiEvent::Log(format!("message failed: {e}")));
                            }
                        }
                    });
                }
                UiCommand::ShellRun { command } => {
                    // '!' shell mode: run in the workspace through the sandbox,
                    // stream the result as a system message (never as a turn).
                    let workspace = stage_workspace.implementation();
                    let ui_tx_shell = ui_tx.implementation();
                    tokio::spawn(async move {
                        let spec = prricode_sandbox::SandboxSpec {
                            workspace_root: workspace,
                            allow_network: false,
                            timeout: std::time::Duration::from_secs(120),
                            extra_ro_paths: Vec::new(),
                        };
                        let outcome = prricode_sandbox::run_command(&command, &spec).await;
                        let message = match outcome {
                            Ok(output) => {
                                let mut text = output.stdout;
                                if !output.stderr.is_empty() {
                                    text.push_str("\nstderr:\n");
                                    text.push_str(&output.stderr);
                                }
                                format!("$ {command}\n{text}\nexit: {}", output.exit_code)
                            }
                            Err(e) => format!("$ {command}\nfailed: {e}"),
                        };
                        let _ = ui_tx_shell.send(UiEvent::Log(format!("shell: {message}")));
                    });
                }
                UiCommand::GlobRequest { pattern } => {
                    // '@' picker: glob the workspace (bounded, no VCS dirs).
                    let workspace = stage_workspace.implementation();
                    let ui_tx_glob = ui_tx.implementation();
                    tokio::spawn(async move {
                        let full = format!("{}/{}", workspace.display(), pattern);
                        let mut items: Vec<String> =
                            walkdir_glob(&full).into_iter().take(200).collect();
                        items.sort();
                        let _ = ui_tx_glob.send(UiEvent::FilePickerItems { items });
                    });
                }
                UiCommand::RecordAmendment { amendment } => {
                    // Durable "always allow in this workspace" rule.
                    let key = format!(
                        "approvalAmendment:{}:{}:{}",
                        stage_workspace.display(),
                        amendment.tool,
                        amendment.matcher
                    );
                    if let Err(e) = agent_persistence
                        .set_setting(&key, &serde_json::to_string(&amendment).unwrap_or_default())
                    {
                        tracing::warn!("amendment persist failed: {e}");
                    }
                }
                UiCommand::SetKeybindings { json } => {
                    if let Err(e) = agent_persistence.set_setting("tui:keybindings", &json) {
                        tracing::warn!("keybinding persist failed: {e}");
                    }
                }
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
                                    pipeline: Arc::implementation(&pipeline),
                                    ui_tx: ui_tx.implementation(),
                                    session_id: session_id.implementation(),
                                    workspace,
                                    data_dir: agent_data_dir.implementation(),
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
                                .implementation()
                                .unwrap_or_else(|| stage_workspace.implementation()),
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
                UiCommand::DeployConfirm {
                    confirmed,
                    auto_rollback,
                } => {
                    let Some(answers) = ship_answers.as_ref() else {
                        let _ = ui_tx.send(UiEvent::Log(
                            "deploy: no deploy flow is waiting — /ship first".to_string(),
                        ));
                        continue;
                    };
                    let _ = answers.send(ShipAnswer::DeployChoice {
                        confirmed,
                        auto_rollback,
                    });
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
                // The business layer drafts. Each is written to the run
                // directory and opened for review; nothing here deploys,
                // publishes, or prices on its own.
                UiCommand::BusinessResearch => {
                    business_draft(&ui_tx, &agent_data_dir, &session_id, DraftKind::Research);
                }
                UiCommand::BusinessPricing => {
                    business_draft(&ui_tx, &agent_data_dir, &session_id, DraftKind::Pricing);
                }
                UiCommand::BusinessLanding => {
                    business_draft(&ui_tx, &agent_data_dir, &session_id, DraftKind::Landing);
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
    let initial_session_id = launch
        .resume_session
        .implementation()
        .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
    app.session_id = initial_session_id.implementation();
    if launch.resume_session.is_some() {
        let history = load_display_messages(&persistence, &initial_session_id);
        if !history.is_empty() {
            app.messages = history;
        }
        app.push_system(format!("resumed session {initial_session_id}"));
    }

    let stage_workspace = launch
        .workspace_root
        .implementation()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let workspace_prefix = format!("approvalAmendment:{}:", stage_workspace.display());
    if let Ok(settings) = persistence.list_settings() {
        for (k, v) in settings {
            if k.starts_with(&workspace_prefix) {
                if let Ok(amendment) = serde_json::from_str::<app::PolicyAmendment>(&v) {
                    app.add_workspace_amendment(amendment);
                }
            }
        }
    }

    // Theme selection: the config file names a starting theme, and the last
    // `/theme` choice (persisted under the settings key `theme`) wins over
    // it. An unknown name falls back to the default with a log line.
    // Rebound chords (`/keybind`) reload from `tui:keybindings` the same way.
    if let Ok(Some(json)) = persistence.get_setting("tui:keybindings") {
        if let Ok(map) = serde_json::from_str::<Vec<(String, String)>>(&json) {
            for (chord, target) in map {
                if let Some(action) = app::parse_chord(&target) {
                    app.bindings.push((chord, action));
                }
            }
        }
    }
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
                let action = app.translate(event);
                app.handle_key(action, &cmd_tx);
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

/// The user content for one composer submit: the typed text, plus exactly one
/// pasted image part when the composer carried an attachment. The image is
/// appended once so the turn sees it exactly once.
fn submit_user_content(text: String, image: Option<ContentPart>) -> Vec<ContentPart> {
    let mut parts = vec![ContentPart::text(text)];
    if let Some(image) = image {
        parts.push(image);
    }
    parts
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

/// Cap on rendered diff lines for edit_file summaries so one big edit
/// cannot flood the transcript.
const DIFF_SUMMARY_CAP: usize = 12;

/// A terse unified-style block: the old lines as `-`, the new lines as `+`,
/// then an `(N more diff lines)` footer when truncating.
fn diff_block(old: &str, new: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let old_trim = old.trim_end_matches('\n');
    if !old_trim.is_empty() {
        for line in old_trim.lines() {
            out.push(format!("- {line}"));
        }
    }
    let new_trim = new.trim_end_matches('\n');
    if !new_trim.is_empty() {
        for line in new_trim.lines() {
            out.push(format!("+ {line}"));
        }
    }
    if out.len() > DIFF_SUMMARY_CAP {
        let rest = out.len() - DIFF_SUMMARY_CAP;
        out.truncate(DIFF_SUMMARY_CAP);
        out.push(format!("… ({rest} more diff lines)"));
    }
    out.join("\n")
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
        "edit_file" => {
            let path = input
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();
            let old = input
                .get("old_string")
                .and_then(|s| s.as_str())
                .unwrap_or("");
            let new = input
                .get("new_string")
                .and_then(|s| s.as_str())
                .unwrap_or("");
            let mut block = format!("diff: {path}\n{}", diff_block(old, new));
            if input.get("replace_all").and_then(|r| r.as_bool()) == Some(true) {
                block.push_str("\n(replace_all)");
            }
            block
        }
        "write_file" => {
            let path = input.get("path").and_then(|p| p.as_str()).unwrap_or("");
            let lines = input
                .get("content")
                .and_then(|c| c.as_str())
                .map(|c| c.lines().count())
                .unwrap_or(0);
            format!("write_file: {path} ({lines} lines)")
        }
        "read_file" => input
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

fn load_display_messages(persistence: &Arc<Persistence>, session_id: &str) -> Vec<TurnMessage> {
    let items = persistence.list_items(session_id, None).unwrap_or_default();
    let mut messages = Vec::new();
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
                    messages.push(TurnMessage {
                        role: Role::User,
                        text,
                    });
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
                    messages.push(TurnMessage {
                        role: Role::Assistant,
                        text,
                    });
                }
            }
            "tool_use" => {
                let name = content.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                let summary = summarize_tool(&content);
                messages.push(TurnMessage {
                    role: Role::Tool,
                    text: format!("{name}: {summary}"),
                });
            }
            "tool_result" => {
                let is_error = content
                    .get("isError")
                    .and_then(|e| e.as_bool())
                    .unwrap_or(false);
                let mark = if is_error { "✗" } else { "✓" };
                messages.push(TurnMessage {
                    role: Role::Tool,
                    text: format!("{mark} result"),
                });
            }
            "summary" => {
                if let Some(text) = content.as_str() {
                    messages.push(TurnMessage {
                        role: Role::System,
                        text: text.to_string(),
                    });
                }
            }
            _ => {}
        }
    }
    messages
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
        self.clarifier = Some(Clarifier::new(concept.implementation()));
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
        .implementation()
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
/// The kind of business-layer draft a slash command asked for.
#[derive(Debug, Implementation, Copy)]
enum DraftKind {
    Research,
    Pricing,
    Landing,
}

/// Write one business-layer draft into the session's run directory.
///
/// The drafts are deliberately *unfilled*: the model is never allowed to
/// invent a price or an unsourced claim, and the harness's job is to hand the
/// operator a form with the invariants stated. The dossier-style file is what
/// lands in the run directory, and the operator fills the rest.
fn business_draft(
    ui_tx: &tokio::sync::mpsc::UnboundedSender<UiEvent>,
    data_dir: &std::path::Path,
    session_id: &str,
    kind: DraftKind,
) {
    let dir = data_dir.join("runs").join(session_id).join("business");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        let _ = ui_tx.send(UiEvent::Log(format!(
            "business: cannot create {dir:?}: {e}"
        )));
        return;
    }
    let (name, body) = match kind {
        DraftKind::Research => (
            "research.md",
            prricode_pipeline::business::render_research(
                &prricode_pipeline::business::ResearchBrief::default(),
            ),
        ),
        DraftKind::Pricing => (
            "pricing.md",
            prricode_pipeline::business::render_pricing(
                &prricode_pipeline::business::PricingModel::default(),
            ),
        ),
        DraftKind::Landing => (
            "landing.md",
            prricode_pipeline::business::render_landing(
                &prricode_pipeline::business::LandingPlan::default(),
            ),
        ),
    };
    let path = dir.join(name);
    match std::fs::write(&path, body) {
        Ok(()) => {
            let _ = ui_tx.send(UiEvent::Log(format!(
                "{}: draft written to {} — edit it; the harness refuses unsourced claims, unpriced tiers, and a page with no call to action",
                name.trim_end_matches(".md"),
                path.display()
            )));
        }
        Err(e) => {
            let _ = ui_tx.send(UiEvent::Log(format!(
                "business: cannot write {path:?}: {e}"
            )));
        }
    }
}

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
        tag: record.tag.implementation().unwrap_or_else(|| "untagged".to_string()),
        release_url: record.release_url.implementation(),
        install_steps: record.install_steps.implementation(),
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
                    flow.answer(ShipAnswer::DeployChoice {
                        confirmed: false,
                        auto_rollback: false,
                    });
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
                .map(|plan| plan.reason.implementation())
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
        ShipEventKind::DeployRolledBack { ok, detail } => {
            let _ = ui_tx.send(UiEvent::DeployRolledBack { ok, detail });
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
                .map(|wave| wave.iter().map(|node| node.id.implementation()).collect())
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
    // A workspace that already holds a project changes the prompt: the spec
    // and plan are written against what is there, not for an empty directory.
    let survey = prricode_pipeline::survey::survey(&ctx.workspace_root);
    // The repair loop lives in the pipeline crate (bounded, gate error fed
    // back to the model); the TUI only surfaces its notices.
    let requirements = match specify::produce_requirements_for(
        &ctx.pipeline.runner,
        &concept,
        preset,
        &ctx.model,
        ctx.approval_mode,
        &survey,
        |notice| {
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: EARS gate sent it back — {notice}"
            )));
        },
    )
    .await
    {
        Ok(requirements) => requirements,
        Err(e) => {
            ctx.flow.lock().unwrap().stage_in_flight = false;
            let _ = ctx
                .ui_tx
                .send(UiEvent::Log(format!("pipeline: specify failed — {e}")));
            return;
        }
    };
    {
        let count = requirements.items.len();
        let mut flow = ctx.flow.lock().unwrap();
        let spec = flow.spec.get_or_insert_with(|| Spec::draft(concept));
        spec.regenerate(requirements);
        flow.stage_in_flight = false;
        persist_pipeline(&ctx.pipeline, &ctx.session_id, &flow);
        let _ = ctx.ui_tx.send(UiEvent::PipelineGate {
            gate: "spec-confirmation".to_string(),
        });
        let _ = ctx.ui_tx.send(UiEvent::Log(format!(
            "pipeline: spec ready — {count} requirements; y to confirm, n to reject"
        )));
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
    let survey = prricode_pipeline::survey::survey(&ctx.workspace_root);
    let graph = match plan::produce_task_graph_for(
        &ctx.pipeline.runner,
        &requirements,
        &ctx.model,
        ctx.approval_mode,
        &survey,
        |notice| {
            let _ = ctx.ui_tx.send(UiEvent::Log(format!(
                "pipeline: traceability gate sent it back — {notice}"
            )));
        },
    )
    .await
    {
        Ok(graph) => graph,
        Err(e) => {
            ctx.flow.lock().unwrap().stage_in_flight = false;
            let _ = ctx
                .ui_tx
                .send(UiEvent::Log(format!("pipeline: plan failed — {e}")));
            return;
        }
    };
    // A brownfield plan must edit files that are really there.
    if let Err(e) = plan::validate_reuse(&graph, &survey) {
        ctx.flow.lock().unwrap().stage_in_flight = false;
        let _ = ctx.ui_tx.send(UiEvent::Log(format!(
            "pipeline: plan rejected by the reuse gate — {e}"
        )));
        return;
    }
    {
        let tasks = graph.nodes.len();
        let waves = graph.waves().map(|waves| waves.len()).unwrap_or(0);
        let mut flow = ctx.flow.lock().unwrap();
        flow.graph = Some(graph);
        flow.stage_in_flight = false;
        persist_pipeline(&ctx.pipeline, &ctx.session_id, &flow);
        let _ = ctx.ui_tx.send(UiEvent::Log(format!(
            "pipeline: plan ready — {tasks} tasks in {waves} waves; /build to run the build"
        )));
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
    {
        // Record the run id so the verify pass and pipeline/verifyRead can
        // resolve this session's dossier.
        let mut flow = ctx.flow.lock().unwrap();
        flow.run_id = Some(run_id.implementation());
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
            ctx.workspace_root.implementation()
        }
    };
    {
        // Record the workspace the ship stage releases, alongside the run id.
        let mut flow = ctx.flow.lock().unwrap();
        flow.build_workspace = Some(build_workspace.implementation());
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
    let economics = match Persistence::new(&ctx.data_dir) {
        Ok(persistence) => prricode_verify::dossier::load_economics(&persistence, run_id),
        Err(_) => None,
    };
    let _ = ctx.ui_tx.send(UiEvent::VerifyDone {
        report_path: dossier_path.display().to_string(),
        gates_passed,
        gates_total: report.gates.len(),
        pass: tally(Verdict::Pass),
        fail: tally(Verdict::Fail),
        unverified: tally(Verdict::Unverified),
        build_tokens: economics.as_ref().map(|e| e.build_tokens).unwrap_or(0),
        tasks_attempted: economics.as_ref().map(|e| e.tasks_attempted).unwrap_or(0),
    });
    if let Some(e) = economics {
        let per = e.tokens_per_verified();
        let _ = ctx.ui_tx.send(UiEvent::Log(format!(
            "cost: {} tokens over {} tasks · {} ms of gates · {} verified of {} requirements{}",
            e.build_tokens,
            e.tasks_attempted,
            e.gate_wall_ms,
            e.requirements_verified,
            e.requirements_total,
            per.map(|r| format!(" · {r:.0} tokens per verified requirement"))
                .unwrap_or_default()
        )));
    }
}

/// Bounded filesystem glob for the '@' picker (no VCS/build dirs).
fn walkdir_glob(pattern: &str) -> Vec<String> {
    let (root, file_pattern) = match pattern.rsplit_once('/') {
        Some((root, file)) => (root.to_string(), file.to_string()),
        None => (".".to_string(), pattern.to_string()),
    };
    let regex = regex::Regex::new(&format!(
        "^{}$",
        regex::escape(&file_pattern)
            .replace("\\*", "[^/]*")
            .replace("\\?", ".")
    ))
    .ok();
    let mut results = Vec::new();
    let mut stack = vec![std::path::PathBuf::from(root)];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            let matches = regex.as_ref().map(|r| r.is_match(&name)).unwrap_or(false);
            if matches && path.is_file() {
                results.push(path.to_string_lossy().to_string());
            }
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    results
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_edit_file_shows_a_diff_block() {
        let item = serde_json::json!({
            "kind": "tool_use",
            "name": "edit_file",
            "input": {
                "path": "src/main.rs",
                "old_string": "fn old() {\n}\n",
                "new_string": "fn new() {\n    step();\n}\n"
            }
        });
        let summary = summarize_tool(&item);
        assert!(summary.contains("src/main.rs"), "got: {summary}");
        assert!(summary.contains("- fn old() {"), "got: {summary}");
        assert!(
            summary.contains("+ fn new() {") && summary.contains("+     step();"),
            "got: {summary}"
        );
    }

    #[test]
    fn summarize_edit_file_caps_long_diffs() {
        let old = (0..20)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let item = serde_json::json!({
            "kind": "tool_use",
            "name": "edit_file",
            "input": {
                "path": "big.txt",
                "old_string": old,
                "new_string": "replaced"
            }
        });
        let summary = summarize_tool(&item);
        assert!(summary.contains("more diff lines"), "got: {summary}");
        assert!(
            summary.matches("- line ").count() <= 12,
            "cap keeps the block bounded: {summary}"
        );
    }

    #[test]
    fn summarize_edit_file_replace_all_is_noted() {
        let item = serde_json::json!({
            "kind": "tool_use",
            "name": "edit_file",
            "input": {
                "path": "a.rs",
                "old_string": "todo",
                "new_string": "done",
                "replace_all": true
            }
        });
        assert!(summarize_tool(&item).contains("replace_all"));
    }

    #[test]
    fn summarize_write_file_reports_size_and_shape() {
        let create = serde_json::json!({
            "kind": "tool_use",
            "name": "write_file",
            "input": { "path": "new.txt", "content": "a\nb\nc\n" }
        });
        let summary = summarize_tool(&create);
        assert!(summary.contains("new.txt"), "got: {summary}");
        assert!(summary.contains("3 lines"), "got: {summary}");
    }

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
            workspace: dir.implementation(),
            data_dir: data_dir.implementation(),
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
            workspace: dir.implementation(),
            data_dir: data_dir.implementation(),
            dossier_path: None,
            answer_rx,
        };
        let flow_task = tokio::spawn(run_ship_flow(ctx));

        // The plan is proposed; confirm it, then hand over the credential.
        let mut events = Vec::new();
        await_event(&mut events, &mut ui_rx, "proposed").await;
        answer_tx
            .send(ShipAnswer::DeployChoice {
                confirmed: true,
                auto_rollback: false,
            })
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
