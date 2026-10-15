//! TUI application state and event handling (pure logic, unit-tested).
//!
//! The keymap follows the terminal-agent evidence: Return submits the
//! composer, Ctrl+J inserts a newline, Ctrl+R/P/N walk history, Ctrl+G edits
//! in $EDITOR, Ctrl+L clears, Alt+B/F move by word, Ctrl+K/Y kill/yank, Alt+D
//! deletes a word, Alt+Enter queues, Ctrl+B backgrounds, Ctrl+O expands the
//! last tool output, Esc cancels, and approvals answer y (allow once) /
//! s (allow for session) / a (always in this workspace) / n (deny).
//! Product-builder pipeline gates answer the same y/n keys.

use crate::theme::ThemeStore;
use base64::Engine;
use prricode_core::ApprovalMode;
use prricode_provider::{ContentPart, ProviderKind};

/// A rendered line in the conversation.
#[derive(Debug, Clone)]
pub struct TurnMessage {
    pub role: Role,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    Tool,
    System,
}

/// A persisted "always allow in this workspace" rule, mirroring the spec's
/// PolicyAmendment { effect, durability, reason } with command matchers.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PolicyAmendment {
    pub tool: String,
    /// Prefix of the call summary this amendment covers (e.g. a shell command).
    pub matcher: String,
    pub durability: String,
}

impl PolicyAmendment {
    pub fn workspace(tool: &str, matcher: &str) -> Self {
        Self {
            tool: tool.to_string(),
            matcher: matcher.to_string(),
            durability: "workspace".to_string(),
        }
    }

    pub fn matches(&self, tool: &str, summary: &str) -> bool {
        self.tool == tool && summary.starts_with(&self.matcher)
    }
}

/// Workspace file-path picker ('@' keybinding).
#[derive(Debug, Clone, Default)]
pub struct FilePicker {
    pub items: Vec<String>,
    pub index: usize,
}

impl FilePicker {
    pub fn selected(&self) -> Option<&String> {
        self.items.get(self.index)
    }
}

/// Risk classes from the spec's approval footers; they relabel the modal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskClass {
    ReviewNeeded,
    Elevated,
    Blocking,
}

impl RiskClass {
    pub fn label(&self) -> &'static str {
        match self {
            Self::ReviewNeeded => "review needed",
            Self::Elevated => "elevated",
            Self::Blocking => "blocking",
        }
    }

    pub fn for_tool(tool: &str) -> Self {
        match tool {
            // Computer control and shell writes are the irreversible classes.
            "computer" => Self::Blocking,
            "shell" | "write_file" | "edit_file" => Self::Elevated,
            _ => Self::ReviewNeeded,
        }
    }
}

#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub approval_id: String,
    pub kind: String,
    pub summary: String,
    /// The spec's three choice rows, in order; `choice_index` selects one.
    pub choices: Vec<&'static str>,
    pub choice_index: usize,
}

impl PendingApproval {
    pub fn new(approval_id: String, kind: String, summary: String) -> Self {
        Self {
            approval_id,
            kind,
            summary,
            choices: vec![
                "Allow once",
                "Allow for this session",
                "Always allow in this workspace",
            ],
            choice_index: 0,
        }
    }
}

/// Product-builder pipeline rail state: the current stage label plus the
/// confirmation gate awaiting an answer, if any.
#[derive(Debug, Clone)]
pub struct PipelineView {
    pub stage: String,
    pub gate: Option<String>,
    /// Verify counts once a verification pass has run; `None` before the
    /// verify stage produces a report.
    pub verify: Option<VerifyCounts>,
    /// Ship/operate counts once a release shipped; `None` before the ship
    /// stage runs.
    pub ship: Option<ShipCounts>,
}

/// Gate and verdict tallies the rail renders as its verify segment.
#[derive(Debug, Clone)]
pub struct VerifyCounts {
    pub gates_passed: usize,
    pub gates_total: usize,
    pub pass: usize,
    pub fail: usize,
    pub unverified: usize,
}

/// Ship, deploy, and health tallies the rail renders as its ship segment.
#[derive(Debug, Clone)]
pub struct ShipCounts {
    /// The released tag, once the ship stage ran.
    pub tag: Option<String>,
    /// The proposed deploy target, once a plan is on the table.
    pub deploy: Option<String>,
    pub health_ok: usize,
    pub health_total: usize,
}

impl PipelineView {
    /// The rail's verify segment: `verify: gates 3/3 · verdicts 1P/0F/1U`.
    pub fn verify_segment(&self) -> Option<String> {
        self.verify.as_ref().map(|verify| {
            format!(
                "verify: gates {}/{} · verdicts {}P/{}F/{}U",
                verify.gates_passed,
                verify.gates_total,
                verify.pass,
                verify.fail,
                verify.unverified
            )
        })
    }

    /// The rail's ship segment:
    /// `ship: v… · deploy: cloudflare · health: 2/2`.
    pub fn ship_segment(&self) -> Option<String> {
        self.ship.as_ref().map(|ship| {
            format!(
                "ship: {} · deploy: {} · health: {}/{}",
                ship.tag.as_deref().unwrap_or("—"),
                ship.deploy.as_deref().unwrap_or("—"),
                ship.health_ok,
                ship.health_total,
            )
        })
    }
}

/// A deploy plan awaiting the operator's choice: the target, why it was
/// proposed, and the exact credentials the plan will ask for.
#[derive(Debug, Clone)]
pub struct DeployPrompt {
    pub target: String,
    pub reason: String,
    pub credentials: Vec<String>,
}

/// A pending image attachment in the composer: raw PNG bytes read from the
/// clipboard (Ctrl+V), held until the next submit. The image rides along on
/// the turn as an image part and never enters the composer history list.
#[derive(Debug, Clone)]
pub struct PendingImage {
    pub bytes: Vec<u8>,
    pub media_type: String,
}

/// Events delivered from the agent task to the UI.
#[derive(Debug, Clone)]
pub enum UiEvent {
    Delta(String),
    /// '@' file picker results.
    FilePickerItems {
        items: Vec<String>,
    },
    ToolUse {
        name: String,
        summary: String,
    },
    ToolResult {
        is_error: bool,
    },
    Approval {
        approval_id: String,
        kind: String,
        summary: String,
    },
    PipelineInterview {
        question: String,
    },
    PipelineGate {
        gate: String,
    },
    PipelineStageChanged {
        stage: String,
    },
    /// The verify stage finished: rail counts plus the rendered dossier path.
    VerifyDone {
        report_path: String,
        gates_passed: usize,
        gates_total: usize,
        pass: usize,
        fail: usize,
        unverified: usize,
    },
    /// The ship stage released the workspace: its tag, the release URL, and
    /// the install steps to show.
    ShipReady {
        tag: String,
        release_url: Option<String>,
        install_steps: Vec<String>,
    },
    /// A deploy plan is on the table: the target, why it was proposed, and
    /// the exact credentials it will ask for. The operator answers y/n.
    DeployProposed {
        target: String,
        reason: String,
        credentials: Vec<String>,
    },
    /// The plan asked for one credential value: the composer switches to
    /// masked secret-input mode until it is submitted.
    DeploySecret {
        name: String,
        purpose: String,
    },
    /// The deploy commands finished.
    DeployDone {
        ok: bool,
    },
    /// The recorded rollback ran after a failed health check (auto-rollback);
    /// `detail` names the target and outcome.
    DeployRolledBack {
        ok: bool,
        detail: String,
    },
    /// One health probe finished; the failed case carries its detail.
    HealthChecked {
        name: String,
        ok: bool,
        detail: Option<String>,
    },
    TurnStarted,
    TurnEnded {
        failed: bool,
    },
    Usage {
        input: u64,
        output: u64,
    },
    Log(String),
}

/// Terminal key actions, mirroring the documented composer keymap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyAction {
    Char(char),
    Backspace,
    Delete,
    Enter,
    Tab,
    Esc,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    Ctrl(char),
    Alt(char),
}

pub struct App {
    pub provider: ProviderKind,
    pub model: String,
    pub approval_mode: ApprovalMode,
    pub session_id: String,
    pub messages: Vec<TurnMessage>,
    pub input: String,
    pub cursor: usize,
    pub streaming: String,
    pub status: String,
    pub pending_approval: Option<PendingApproval>,
    pub pipeline: Option<PipelineView>,
    /// The rendered acceptance dossier's path, set by the verify stage.
    dossier_path: Option<String>,
    /// The deploy plan awaiting the operator's choice, set when the ship
    /// flow proposes one.
    pub deploy_pending: Option<DeployPrompt>,
    /// Masked secret collection: while set, the composer holds one
    /// credential value, renders it as `*` per character, and only ever
    /// sends it out as a `DeploySecret` command.
    pub secret_input: bool,
    /// The credential the value being typed answers; `Some` while the
    /// ship flow waits for it.
    pub secret_name: Option<String>,
    /// Set between confirming a deploy target and arming auto-rollback: the
    /// composer awaits the "auto-rollback on health failure? y/n" answer for
    /// this target (default no).
    pub auto_rollback_prompt: Option<String>,
    /// A pending image attachment (Ctrl+V), sent on the next submit.
    pub pending_image: Option<PendingImage>,
    pub scroll: u16,
    pub should_quit: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub turn_active: bool,
    pub show_help: bool,
    /// Loaded themes plus the active palette the renderer draws with.
    pub theme_store: ThemeStore,
    history: Vec<String>,
    history_index: Option<usize>,
    kill_ring: String,
    session_auto_approve: Vec<String>,
    /// "Always allow in this workspace" rules (spec durability tier 3).
    workspace_amendments: Vec<PolicyAmendment>,
    /// File-path picker opened by '@' (spec keybinding).
    file_picker: Option<FilePicker>,
    /// Ctrl+o: expand the last tool result in a modal.
    expand_last_tool: bool,
    interview_active: bool,
}

impl App {
    pub fn new(provider: ProviderKind, model: String) -> Self {
        Self {
            provider,
            model,
            approval_mode: ApprovalMode::Closed,
            session_id: uuid::Uuid::now_v7().to_string(),
            messages: vec![TurnMessage {
                role: Role::System,
                text: "prricode — Return sends, Ctrl+J newline, Ctrl+R history, Esc cancels, \
                        /help for commands."
                    .to_string(),
            }],
            input: String::new(),
            cursor: 0,
            streaming: String::new(),
            status: "idle".to_string(),
            pending_approval: None,
            pipeline: None,
            dossier_path: None,
            deploy_pending: None,
            secret_input: false,
            secret_name: None,
            auto_rollback_prompt: None,
            pending_image: None,
            scroll: 0,
            should_quit: false,
            input_tokens: 0,
            output_tokens: 0,
            turn_active: false,
            show_help: false,
            theme_store: ThemeStore::load(
                &crate::theme::bundled_themes_dir(),
                &crate::theme::user_themes_dir(),
            ),
            history: Vec::new(),
            history_index: None,
            kill_ring: String::new(),
            session_auto_approve: Vec::new(),
            workspace_amendments: Vec::new(),
            file_picker: None,
            expand_last_tool: false,
            interview_active: false,
        }
    }

    /// The status line without the pipeline rail; the UI styles the rail
    /// as its own segment.
    pub fn status_base_line(&self) -> String {
        format!(
            "{} / {} | {} | turn: {} | tokens: {}in/{}out",
            self.provider.id(),
            self.model,
            format!("{:?}", self.approval_mode).to_lowercase(),
            if self.turn_active { "running" } else { "idle" },
            self.input_tokens,
            self.output_tokens,
        )
    }

    pub fn status_line(&self) -> String {
        let mut line = self.status_base_line();
        if let Some(pipeline) = &self.pipeline {
            line.push_str(&format!(" · stage: {}", pipeline.stage));
            if let Some(gate) = &pipeline.gate {
                line.push_str(&format!(" · gate: {gate}"));
            }
            if let Some(verify) = pipeline.verify_segment() {
                line.push_str(&format!(" · {verify}"));
            }
            if let Some(ship) = pipeline.ship_segment() {
                line.push_str(&format!(" · {ship}"));
            }
        }
        line
    }

    /// The composer text: masked to one `*` per character while a secret
    /// value is being collected, so the value never renders.
    pub fn composer_text(&self) -> String {
        if self.secret_input {
            "*".repeat(self.input.chars().count())
        } else {
            self.input.clone()
        }
    }

    /// Attach an image (raw bytes + media type) read from the clipboard, and
    /// show it in the input box. It rides along on the next submit and never
    /// touches the composer history list.
    pub fn attach_image(&mut self, bytes: Vec<u8>, media_type: impl Into<String>) {
        let count = bytes.len();
        self.pending_image = Some(PendingImage {
            bytes,
            media_type: media_type.into(),
        });
        self.push_system(format!("image attached ({count} bytes)"));
    }

    /// Clear a pending image attachment, if any.
    pub fn detach_image(&mut self) {
        if self.pending_image.take().is_some() {
            self.push_system("image attachment cleared".to_string());
        }
    }

    /// The input-box hint for a pending image, or None.
    pub fn image_hint(&self) -> Option<String> {
        self.pending_image
            .as_ref()
            .map(|image| format!("image attached ({} bytes)", image.bytes.len()))
    }

    /// Take the pending image as a base64-encoded provider image part,
    /// clearing the attachment. Returns None when no image is pending.
    fn take_image_part(&mut self) -> Option<ContentPart> {
        let image = self.pending_image.take()?;
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(&image.bytes);
        Some(ContentPart::Image {
            media_type: image.media_type,
            data_base64,
        })
    }

    /// Apply a theme name coming from a setting (the config file or the
    /// persisted last choice): switches when the name is known, otherwise
    /// keeps the active theme and logs the fallback with what is available.
    pub fn apply_theme_setting(&mut self, name: &str) {
        if self.theme_store.set_by_slug(name) {
            return;
        }
        self.push_system(format!(
            "unknown theme '{name}' — keeping {}; available: {}",
            self.theme_store.active_slug(),
            self.theme_store.available_slugs().join(", ")
        ));
    }

    fn char_len(&self) -> usize {
        self.input.chars().count()
    }

    pub fn handle_key(
        &mut self,
        action: KeyAction,
        commands: &tokio::sync::mpsc::UnboundedSender<super::UiCommand>,
    ) {
        use super::UiCommand;
        // Approval modal: y = once, a = for session, n/Esc = deny.
        if let Some(approval) = self.pending_approval.clone() {
            match action {
                KeyAction::Tab => {
                    // Switch choice (spec §4.2: tab switches the selected row).
                    if let Some(pending) = self.pending_approval.as_mut() {
                        pending.choice_index = (pending.choice_index + 1) % pending.choices.len();
                    }
                    return;
                }
                KeyAction::Ctrl('o') => {
                    // Expanded detail (spec: ctrl+o expands).
                    self.expand_last_tool = !self.expand_last_tool;
                    return;
                }
                KeyAction::Char('y') | KeyAction::Enter => {
                    // Enter approves the selected choice; y is the direct
                    // alias for "Allow once".
                    let index = approval.choice_index;
                    if index == 1 {
                        self.session_auto_approve.push(approval.kind.clone());
                    }
                    if index == 2 {
                        let amendment =
                            PolicyAmendment::workspace(&approval.kind, &approval.summary);
                        self.workspace_amendments.push(amendment.clone());
                        let _ = commands.send(super::UiCommand::RecordAmendment { amendment });
                    }
                    let _ = commands.send(UiCommand::Approve {
                        approval_id: approval.approval_id.clone(),
                        approved: true,
                    });
                    self.pending_approval = None;
                    let label = approval.choices.get(index).copied().unwrap_or("Allow once");
                    self.push_system(format!("{label} — {}", approval.summary));
                    return;
                }
                KeyAction::Char('s') | KeyAction::Char('a') => {
                    // Direct aliases for the second/third choice rows.
                    let index = if matches!(action, KeyAction::Char('s')) {
                        1
                    } else {
                        2
                    };
                    if let Some(pending) = self.pending_approval.as_mut() {
                        pending.choice_index = index;
                    }
                }
                KeyAction::Char(' ') | KeyAction::Char('n') | KeyAction::Esc => {
                    let _ = commands.send(UiCommand::Approve {
                        approval_id: approval.approval_id.clone(),
                        approved: false,
                    });
                    self.pending_approval = None;
                    self.push_system(format!("denied — {}", approval.summary));
                    return;
                }
                _ => return,
            }
        } // Pending pipeline gate: y confirms, n/Esc rejects (approval-key path).
        if let Some(gate) = self.pipeline.as_ref().and_then(|p| p.gate.clone()) {
            match action {
                KeyAction::Char('y') => {
                    let _ = commands.send(UiCommand::PipelineConfirm {
                        stage: gate.clone(),
                        ok: true,
                    });
                    self.clear_pipeline_gate();
                    self.push_system(format!("pipeline: confirmed {gate}"));
                    return;
                }
                KeyAction::Char('n') | KeyAction::Esc => {
                    let _ = commands.send(UiCommand::PipelineConfirm {
                        stage: gate.clone(),
                        ok: false,
                    });
                    self.clear_pipeline_gate();
                    self.push_system(format!("pipeline: rejected {gate}"));
                    return;
                }
                _ => {}
            }
        }
        // Pending deploy plan: y confirms and opens the auto-rollback
        // sub-choice, then credential collection; n/Esc declines the deploy.
        if let Some(prompt) = self.deploy_pending.clone() {
            match action {
                KeyAction::Char('y') => {
                    let target = prompt.target.clone();
                    self.deploy_pending = None;
                    self.auto_rollback_prompt = Some(target.clone());
                    self.push_system(format!(
                        "deploy: auto-rollback on health failure? press y to enable, n to skip \
                         (default no) for {target}"
                    ));
                    return;
                }
                KeyAction::Char('n') | KeyAction::Esc => {
                    let _ = commands.send(UiCommand::DeployConfirm {
                        confirmed: false,
                        auto_rollback: false,
                    });
                    self.deploy_pending = None;
                    self.push_system(format!(
                        "deploy: declined {} — operating without a deploy",
                        prompt.target
                    ));
                    return;
                }
                _ => {}
            }
        }
        // Auto-rollback sub-choice, asked right after confirming the deploy
        // target: y arms it, anything else leaves it off (default no).
        if let Some(target) = self.auto_rollback_prompt.clone() {
            match action {
                KeyAction::Char('y') => {
                    let _ = commands.send(UiCommand::DeployConfirm {
                        confirmed: true,
                        auto_rollback: true,
                    });
                    self.auto_rollback_prompt = None;
                    self.push_system(format!(
                        "deploy: confirming {target} with auto-rollback on health failure"
                    ));
                }
                _ => {
                    let _ = commands.send(UiCommand::DeployConfirm {
                        confirmed: true,
                        auto_rollback: false,
                    });
                    self.auto_rollback_prompt = None;
                    self.push_system(format!("deploy: confirming {target} without auto-rollback"));
                }
            }
            return;
        }
        // Secret collection: the composer holds the value, renders it
        // masked, and Enter forwards it to the agent task as a DeploySecret
        // command. The value never lands in messages or history, and the
        // composer is cleared on submit.
        if self.secret_input {
            match action {
                KeyAction::Enter => {
                    let value = std::mem::take(&mut self.input);
                    self.cursor = 0;
                    self.history_index = None;
                    self.secret_input = false;
                    let name = self.secret_name.clone().unwrap_or_default();
                    if value.trim().is_empty() {
                        // The flow still waits for this credential.
                        self.push_system(format!(
                            "deploy: no value entered for {name} — /deploy to retry"
                        ));
                        return;
                    }
                    let _ = commands.send(UiCommand::DeploySecret {
                        name: name.clone(),
                        value,
                    });
                    self.secret_name = None;
                    self.push_system(format!(
                        "deploy: value for {name} sent — masked, never stored"
                    ));
                    return;
                }
                // Abandon the entry: the half-typed value must not survive
                // into the plain-text composer.
                KeyAction::Esc => {
                    self.secret_input = false;
                    self.input.clear();
                    self.cursor = 0;
                    self.push_system(
                        "deploy: secret entry cancelled — /deploy to retype".to_string(),
                    );
                    return;
                }
                _ => {}
            }
        }
        // '@' file picker owns the keyboard while open (like the approval
        // modal). '@' opens it; results arrive via UiEvent::FilePickerItems.
        if self.file_picker.is_some() {
            let picker_index = self.file_picker.as_ref().unwrap().index;
            let items_len = self.file_picker.as_ref().unwrap().items.len();
            match action {
                KeyAction::Esc => self.file_picker = None,
                KeyAction::Up => {
                    self.file_picker.as_mut().unwrap().index = picker_index.saturating_sub(1);
                }
                KeyAction::Down => {
                    self.file_picker.as_mut().unwrap().index =
                        (picker_index + 1).min(items_len.saturating_sub(1));
                }
                KeyAction::Enter | KeyAction::Tab => {
                    if let Some(path) = self.file_picker.as_ref().unwrap().selected().cloned() {
                        let idx = self.byte_index();
                        self.input.insert_str(idx, &path);
                        self.cursor += path.chars().count();
                    }
                    self.file_picker = None;
                }
                _ => {}
            }
            return;
        }

        match action {
            KeyAction::Char('@') => {
                self.file_picker = Some(FilePicker::default());
                let _ = commands.send(super::UiCommand::GlobRequest {
                    pattern: "*".into(),
                });
            }
            KeyAction::Char(c) => {
                let idx = self.byte_index();
                self.input.insert(idx, c);
                self.cursor += 1;
            }
            KeyAction::Backspace => {
                if self.cursor > 0 {
                    let start = self.byte_index();
                    let prev = self.input[..start]
                        .chars()
                        .last()
                        .map(|c| start - c.len_utf8())
                        .unwrap_or(0);
                    self.input.replace_range(prev..start, "");
                    self.cursor -= 1;
                }
            }
            KeyAction::Delete => {
                if self.cursor < self.char_len() {
                    let start = self.byte_index();
                    let next = self.input[start..]
                        .chars()
                        .next()
                        .map(|c| start + c.len_utf8())
                        .unwrap_or(start);
                    self.input.replace_range(start..next, "");
                }
            }
            KeyAction::Enter => {
                let text = std::mem::take(&mut self.input);
                self.cursor = 0;
                self.history_index = None;
                if !text.trim().is_empty() {
                    self.history.push(text.clone());
                    self.submit(&text, commands);
                }
            }
            KeyAction::Ctrl('j') | KeyAction::Ctrl('m') => {
                let idx = self.byte_index();
                self.input.insert(idx, '\n');
                self.cursor += 1;
            }
            KeyAction::Ctrl('c') => {
                if self.turn_active {
                    let _ = commands.send(UiCommand::Cancel);
                    self.push_system("interrupting…".to_string());
                } else {
                    self.should_quit = true;
                }
            }
            // The external editor and history could carry a typed secret
            // outside the composer buffer; both are disabled while one is
            // being entered. Pasting an image mid-secret is likewise refused.
            KeyAction::Ctrl('g')
            | KeyAction::Ctrl('r')
            | KeyAction::Ctrl('p')
            | KeyAction::Ctrl('n')
            | KeyAction::Ctrl('v')
                if self.secret_input =>
            {
                self.push_system(
                    "deploy: editor, history, and image paste are disabled while entering a secret"
                        .to_string(),
                );
            }
            KeyAction::Ctrl('r') => self.history_prev(commands),
            KeyAction::Ctrl('p') => self.history_prev(commands),
            KeyAction::Ctrl('n') => self.history_next(),
            KeyAction::Ctrl('l') => {
                self.messages.clear();
                self.streaming.clear();
            }
            KeyAction::Ctrl('g') => self.edit_in_editor(),
            KeyAction::Ctrl('k') => {
                let start = self.byte_index();
                self.kill_ring = self.input[start..].to_string();
                self.input.truncate(start);
            }
            KeyAction::Ctrl('y') => {
                let killed = std::mem::take(&mut self.kill_ring);
                let idx = self.byte_index();
                self.input.insert_str(idx, &killed);
                self.cursor += killed.chars().count();
            }
            KeyAction::Alt('b') => {
                self.cursor = self.cursor.saturating_sub(self.word_left_len());
            }
            KeyAction::Alt('f') => {
                self.cursor = (self.cursor + self.word_right_len()).min(self.char_len());
            }
            KeyAction::Alt('d') => {
                // Delete the word to the right of the cursor (spec keymap).
                let len = self.word_right_len();
                let start = self.byte_index();
                let end = self.input[start..]
                    .chars()
                    .take(len)
                    .map(|c| c.len_utf8())
                    .sum::<usize>()
                    + start;
                self.input.replace_range(start..end, "");
            }
            KeyAction::Alt('\r') | KeyAction::Alt('\n') => {
                // Alt+Enter: queue the message behind a running turn.
                let text = std::mem::take(&mut self.input);
                self.cursor = 0;
                if !text.trim().is_empty() {
                    self.history.push(text.clone());
                    self.submit(text.as_str(), commands);
                }
            }
            KeyAction::Ctrl('b') => {
                if self.turn_active {
                    self.push_system(
                        "background turns are not supported yet — the turn keeps running; Esc interrupts"
                            .to_string(),
                    );
                }
            }
            KeyAction::Ctrl('o') => {
                self.expand_last_tool = !self.expand_last_tool;
            }
            KeyAction::Ctrl('v') => match read_clipboard_image() {
                Some((media_type, bytes)) => self.attach_image(bytes, media_type),
                None => self.push_system(
                    "no image on the clipboard (needs wl-paste or xclip on PATH)".to_string(),
                ),
            },
            KeyAction::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyAction::Right => self.cursor = (self.cursor + 1).min(self.char_len()),
            KeyAction::Home | KeyAction::Ctrl('a') => self.cursor = 0,
            KeyAction::End | KeyAction::Ctrl('e') => self.cursor = self.char_len(),
            KeyAction::Up => self.scroll = self.scroll.saturating_add(1),
            KeyAction::Down => self.scroll = self.scroll.saturating_sub(1),
            KeyAction::PageUp => self.scroll = self.scroll.saturating_add(10),
            KeyAction::PageDown => self.scroll = self.scroll.saturating_sub(10),
            // Esc clears a pending image attachment when nothing else is
            // active (a running turn still cancels with Esc, and the
            // secret/deploy takes of Esc are handled above).
            KeyAction::Esc if self.pending_image.is_some() && !self.turn_active => {
                self.detach_image();
            }
            KeyAction::Esc if self.turn_active => {
                let _ = commands.send(UiCommand::Cancel);
                self.push_system("interrupting…".to_string());
            }
            _ => {}
        }
    }

    fn byte_index(&self) -> usize {
        self.input
            .char_indices()
            .nth(self.cursor)
            .map(|(i, _)| i)
            .unwrap_or(self.input.len())
    }

    fn word_left_len(&self) -> usize {
        let chars: Vec<char> = self.input.chars().collect();
        let mut i = self.cursor.min(chars.len());
        while i > 0 && chars[i - 1].is_whitespace() {
            i -= 1;
        }
        while i > 0 && !chars[i - 1].is_whitespace() {
            i -= 1;
        }
        self.cursor.min(chars.len()) - i
    }

    fn word_right_len(&self) -> usize {
        let chars: Vec<char> = self.input.chars().collect();
        let mut i = self.cursor;
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        while i < chars.len() && !chars[i].is_whitespace() {
            i += 1;
        }
        i - self.cursor
    }

    fn history_prev(&mut self, commands: &tokio::sync::mpsc::UnboundedSender<super::UiCommand>) {
        let _ = commands;
        if self.history.is_empty() {
            return;
        }
        let index = match self.history_index {
            Some(index) => index.saturating_sub(1),
            None => self.history.len().saturating_sub(1),
        };
        self.history_index = Some(index);
        self.input = self.history[index].clone();
        self.cursor = self.char_len();
    }

    fn history_next(&mut self) {
        let Some(index) = self.history_index else {
            return;
        };
        let next = index + 1;
        if next >= self.history.len() {
            self.history_index = None;
            self.input.clear();
            self.cursor = 0;
        } else {
            self.history_index = Some(next);
            self.input = self.history[next].clone();
            self.cursor = self.char_len();
        }
    }

    fn edit_in_editor(&mut self) {
        let editor = std::env::var("VISUAL")
            .or_else(|_| std::env::var("EDITOR"))
            .unwrap_or_else(|_| "vi".to_string());
        let path = std::env::temp_dir().join(format!("prricode-composer-{}", std::process::id()));
        if std::fs::write(&path, &self.input).is_err() {
            self.push_system("cannot open editor".to_string());
            return;
        }
        let parts: Vec<String> = editor.split_whitespace().map(String::from).collect();
        let (command, args) = match parts.split_first() {
            Some((command, args)) => (command.clone(), args.to_vec()),
            None => return,
        };
        let status = std::process::Command::new(command)
            .args(args)
            .arg(&path)
            .status();
        match status {
            Ok(status) if status.success() => {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    self.input = text.trim_end_matches('\n').to_string();
                    self.cursor = self.char_len();
                }
            }
            _ => self.push_system("editor exited without saving".to_string()),
        }
        std::fs::remove_file(&path).ok();
    }

    fn submit(
        &mut self,
        text: &str,
        commands: &tokio::sync::mpsc::UnboundedSender<super::UiCommand>,
    ) {
        use super::UiCommand;
        // '!' shell mode (spec keybinding): run in the workspace, not a turn.
        if let Some(command) = text.strip_prefix('!') {
            let command = command.trim().to_string();
            if !command.is_empty() {
                self.messages.push(TurnMessage {
                    role: Role::System,
                    text: format!("$ {command}"),
                });
                let _ = commands.send(UiCommand::ShellRun { command });
            }
            return;
        }
        if let Some(rest) = text.strip_prefix('/') {
            let (command, arg) = match rest.split_once(char::is_whitespace) {
                Some((command, arg)) => (command, arg.trim()),
                None => (rest, ""),
            };
            match command {
                "quit" | "exit" | "q" => self.should_quit = true,
                "help" | "h" | "?" => {
                    self.show_help = !self.show_help;
                    if self.show_help {
                        self.push_system(
                            "commands: /model /sessions /new /resume /clear /approval /provider                              /concept /spec /plan /build /ship /deploy /operate /dossier /theme                              /goal /yolo /compact — keys: Enter send, Ctrl+J newline, Alt+Enter                              queue, @ files, ! shell, Esc cancel, /quit quits"
                                .to_string(),
                        );
                    }
                }
                "model" => {
                    if arg.is_empty() {
                        self.push_system(format!("current model: {}", self.model));
                    } else {
                        self.model = arg.to_string();
                        let _ = commands.send(UiCommand::SetModel {
                            model: arg.to_string(),
                        });
                        self.push_system(format!("model set to {arg}"));
                    }
                }
                "sessions" | "resume" => {
                    if arg.is_empty() {
                        self.push_system(format!(
                            "session: {} — /resume <id> to switch (ids from the server's session/list)",
                            self.session_id
                        ));
                    } else {
                        self.session_id = arg.to_string();
                        self.messages.clear();
                        self.push_system(format!("resumed session {arg}"));
                    }
                }
                "new" => {
                    self.session_id = uuid::Uuid::now_v7().to_string();
                    self.messages.clear();
                    self.streaming.clear();
                    self.push_system(format!("new session {}", self.session_id));
                }
                "clear" => {
                    self.messages.clear();
                    self.streaming.clear();
                }
                "approval" => {
                    let mode = match arg {
                        "open" => ApprovalMode::Open,
                        "auto" => ApprovalMode::Auto,
                        "suggestive" => ApprovalMode::Suggestive,
                        _ => ApprovalMode::Closed,
                    };
                    self.approval_mode = mode;
                    let _ = commands.send(UiCommand::SetApprovalMode(mode));
                    self.push_system(format!(
                        "approval mode: {}",
                        format!("{mode:?}").to_lowercase()
                    ));
                }
                "provider" => {
                    if let Some(kind) = match arg {
                        "echo" => Some(ProviderKind::Echo),
                        "ollama" => Some(ProviderKind::Ollama),
                        "openrouter" => Some(ProviderKind::OpenRouter),
                        "kilo" => Some(ProviderKind::Kilo),
                        "openai" => Some(ProviderKind::OpenAI),
                        _ => None,
                    } {
                        self.provider = kind;
                        self.push_system(format!(
                            "provider set to {} (restart for full effect)",
                            kind.id()
                        ));
                    } else {
                        self.push_system(
                            "unknown provider; known: echo, ollama, openrouter, kilo, openai"
                                .to_string(),
                        );
                    }
                }
                "concept" => {
                    self.pipeline = Some(PipelineView {
                        stage: "concept".to_string(),
                        gate: None,
                        verify: None,
                        ship: None,
                    });
                    self.interview_active = false;
                    let _ = commands.send(UiCommand::PipelineConcept {
                        idea: arg.to_string(),
                    });
                    self.push_system(format!("pipeline: starting concept — {arg}"));
                }
                "spec" => {
                    let _ = commands.send(UiCommand::PipelineAdvance {
                        stage: "specify".to_string(),
                    });
                    self.push_system("pipeline: advancing to spec".to_string());
                }
                "plan" => {
                    let _ = commands.send(UiCommand::PipelineAdvance {
                        stage: "plan".to_string(),
                    });
                    self.push_system("pipeline: advancing to plan".to_string());
                }
                "build" => {
                    let _ = commands.send(UiCommand::PipelineAdvance {
                        stage: "build".to_string(),
                    });
                    self.push_system("pipeline: starting build".to_string());
                }
                "ship" => {
                    let _ = commands.send(UiCommand::ShipStart);
                    self.push_system(
                        "ship: starting — the release needs a confirmation".to_string(),
                    );
                }
                "deploy" => {
                    if let Some(name) = self.secret_name.clone() {
                        // The flow is waiting for this credential: re-open
                        // the masked entry instead of starting anything.
                        self.secret_input = true;
                        self.push_system(format!(
                            "deploy: enter {name} — the value is masked and never stored"
                        ));
                    } else if let Some(prompt) = &self.deploy_pending {
                        self.push_system(format!(
                            "deploy: {} proposed ({}) — press y to confirm, n to decline",
                            prompt.target, prompt.reason
                        ));
                    } else {
                        self.push_system(
                            "deploy: no deploy in play — /ship ships, then proposes a plan"
                                .to_string(),
                        );
                    }
                }
                "operate" => {
                    let _ = commands.send(UiCommand::OperateRun);
                    self.push_system("operate: running a health pass".to_string());
                }
                "dossier" => self.open_dossier(),
                "theme" => {
                    if arg.is_empty() {
                        let available = self
                            .theme_store
                            .list()
                            .iter()
                            .map(|(slug, name)| {
                                if *slug == self.theme_store.active_slug() {
                                    format!("{slug} ({name}, active)")
                                } else {
                                    format!("{slug} ({name})")
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(", ");
                        self.push_system(format!("themes: {available}"));
                    } else if self.theme_store.set_by_slug(arg) {
                        let theme = self.theme_store.active();
                        let slug = theme.slug.clone();
                        let display = theme.display_name.clone();
                        let _ = commands.send(UiCommand::SetTheme { slug: slug.clone() });
                        self.push_system(format!("theme: {display} ({slug})"));
                    } else {
                        self.push_system(format!(
                            "unknown theme '{arg}' — available: {}",
                            self.theme_store.available_slugs().join(", ")
                        ));
                    }
                }
                "yolo" => {
                    // Toggle unattended approval: open <-> previous mode.
                    let next = if self.approval_mode == ApprovalMode::Open {
                        ApprovalMode::Closed
                    } else {
                        ApprovalMode::Open
                    };
                    self.approval_mode = next;
                    let _ = commands.send(UiCommand::SetApprovalMode(next));
                    self.push_system(format!(
                        "approval mode: {} (yolo {})",
                        format!("{next:?}").to_lowercase(),
                        if next == ApprovalMode::Open {
                            "on"
                        } else {
                            "off"
                        }
                    ));
                }
                "goal" => {
                    // View/set the session goal. Setting is a pipeline command;
                    // viewing reads the pipeline state when a run is active.
                    if arg.is_empty() {
                        match self.pipeline.as_ref() {
                            Some(view) if view.stage != "idle" => {
                                self.push_system(format!(
                                    "pipeline stage: {} — goal work runs through the pipeline",
                                    view.stage
                                ));
                            }
                            _ => self.push_system(
                                "no active goal; set one with the server's goal/set".to_string(),
                            ),
                        }
                    } else {
                        self.push_system(format!(
                            "goal requested: {arg} — persistent goals are set via the protocol (goal/set)"
                        ));
                    }
                }
                "compact" => {
                    // Context compaction is a server-side operation.
                    // future work: TUI-side compaction once sessions are local.
                    self.push_system("compaction runs on the server (session/compact)".to_string());
                }
                "message" | "ts" | "ps" => {
                    // Cross-session messaging and task/process listings are
                    // server-side surfaces.
                    // future work: wire to the protocol methods when the TUI
                    // owns a session id on the server side.
                    self.push_system(format!(
                        "/{command} is a server-side surface — not available in this build"
                    ));
                }
                other => self.push_system(format!("unknown command: /{other} (try /help)")),
            }
            return;
        }
        // An active clarifier interview turns a plain message into the
        // interview answer instead of a new agent turn.
        if self.interview_active {
            self.messages.push(TurnMessage {
                role: Role::User,
                text: text.to_string(),
            });
            self.status = "answering…".to_string();
            let _ = commands.send(UiCommand::PipelineAnswer {
                answer: text.to_string(),
            });
            return;
        }
        self.messages.push(TurnMessage {
            role: Role::User,
            text: text.to_string(),
        });
        self.streaming.clear();
        self.status = "thinking…".to_string();
        // A pending image rides along on the turn as an image part; it is
        // never written to the composer history (only the text is pushed).
        let image = self.take_image_part();
        let _ = commands.send(UiCommand::Submit {
            text: text.to_string(),
            image,
        });
    }

    pub fn apply_ui_event(
        &mut self,
        event: UiEvent,
        commands: &tokio::sync::mpsc::UnboundedSender<super::UiCommand>,
    ) {
        match event {
            UiEvent::Delta(text) => {
                self.streaming.push_str(&text);
                self.status = "receiving…".to_string();
            }
            UiEvent::ToolUse { name, summary } => {
                self.flush_stream();
                self.messages.push(TurnMessage {
                    role: Role::Tool,
                    text: format!("{name}: {summary}"),
                });
            }
            UiEvent::ToolResult { is_error } => {
                let _ = is_error;
            }
            UiEvent::Approval {
                approval_id,
                kind,
                summary,
            } => {
                self.flush_stream();
                if let Some(_amendment) = self
                    .workspace_amendments
                    .iter()
                    .find(|a| a.matches(&kind, &summary))
                {
                    // "Always allow in this workspace" rule matched.
                    let _ = commands.send(super::UiCommand::Approve {
                        approval_id,
                        approved: true,
                    });
                    self.push_system(format!("allow:always_in_workspace — {summary}"));
                } else if self.session_auto_approve.contains(&kind) {
                    // Approved for this session earlier; answer directly.
                    let _ = commands.send(super::UiCommand::Approve {
                        approval_id,
                        approved: true,
                    });
                    self.push_system(format!("allow:approved_for_session — {summary}"));
                } else {
                    self.pending_approval = Some(PendingApproval::new(approval_id, kind, summary));
                    self.status = "approval required".to_string();
                }
            }
            UiEvent::PipelineInterview { question } => {
                self.interview_active = true;
                let stage = self
                    .pipeline
                    .as_ref()
                    .map(|p| p.stage.clone())
                    .unwrap_or_else(|| "clarify".to_string());
                self.pipeline = Some(PipelineView {
                    stage,
                    gate: None,
                    verify: None,
                    ship: None,
                });
                self.status = "clarifying…".to_string();
                self.messages.push(TurnMessage {
                    role: Role::Assistant,
                    text: question,
                });
            }
            UiEvent::PipelineGate { gate } => {
                self.interview_active = false;
                let stage = self
                    .pipeline
                    .as_ref()
                    .map(|p| p.stage.clone())
                    .unwrap_or_else(|| "concept".to_string());
                self.pipeline = Some(PipelineView {
                    stage,
                    gate: Some(gate.clone()),
                    verify: None,
                    ship: None,
                });
                self.status = "confirmation required".to_string();
                self.push_system(format!(
                    "pipeline gate: {gate} — press y to confirm, n to reject"
                ));
            }
            UiEvent::PipelineStageChanged { stage } => {
                self.pipeline = Some(PipelineView {
                    stage,
                    gate: None,
                    verify: None,
                    ship: None,
                });
                self.push_system(format!("pipeline stage: {}", self.pipeline_stage()));
            }
            UiEvent::VerifyDone {
                report_path,
                gates_passed,
                gates_total,
                pass,
                fail,
                unverified,
            } => {
                self.dossier_path = Some(report_path);
                let stage = self
                    .pipeline
                    .as_ref()
                    .map(|p| p.stage.clone())
                    .unwrap_or_else(|| "build".to_string());
                self.pipeline = Some(PipelineView {
                    stage,
                    gate: None,
                    verify: Some(VerifyCounts {
                        gates_passed,
                        gates_total,
                        pass,
                        fail,
                        unverified,
                    }),
                    ship: None,
                });
                self.push_system(format!(
                    "verify: gates {gates_passed}/{gates_total} · verdicts {pass}P/{fail}F/{unverified}U — /dossier opens the report"
                ));
            }
            UiEvent::ShipReady {
                tag,
                release_url,
                install_steps,
            } => {
                self.set_ship(ShipCounts {
                    tag: Some(tag.clone()),
                    deploy: None,
                    health_ok: 0,
                    health_total: 0,
                });
                self.status = "shipped".to_string();
                self.push_system(format!("ship: released {tag}"));
                if let Some(url) = release_url {
                    self.push_system(format!("ship: release — {url}"));
                }
                if !install_steps.is_empty() {
                    self.push_system(format!(
                        "ship: install steps\n{}",
                        install_steps
                            .iter()
                            .map(|step| format!("- {step}"))
                            .collect::<Vec<_>>()
                            .join("\n")
                    ));
                }
            }
            UiEvent::DeployProposed {
                target,
                reason,
                credentials,
            } => {
                self.deploy_pending = Some(DeployPrompt {
                    target: target.clone(),
                    reason: reason.clone(),
                    credentials: credentials.clone(),
                });
                self.set_ship_deploy(Some(target.clone()));
                self.status = "confirmation required".to_string();
                self.push_system(format!(
                    "deploy: proposed {target} — {reason}; asks for {}",
                    if credentials.is_empty() {
                        "no credentials".to_string()
                    } else {
                        credentials.join(", ")
                    }
                ));
                self.push_system("deploy: press y to confirm, n to decline".to_string());
            }
            UiEvent::DeploySecret { name, purpose } => {
                self.interview_active = false;
                self.deploy_pending = None;
                self.secret_input = true;
                self.secret_name = Some(name.clone());
                self.status = "secret required".to_string();
                self.push_system(format!("deploy: {name} — {purpose}"));
                self.push_system(format!(
                    "deploy: type the value for {name} and press Return (masked, never stored)"
                ));
            }
            UiEvent::DeployDone { ok } => {
                self.deploy_pending = None;
                self.status = if ok {
                    "idle".into()
                } else {
                    "deploy failed".into()
                };
                self.push_system(if ok {
                    "deploy: finished ok".to_string()
                } else {
                    "deploy: finished with failing commands".to_string()
                });
            }
            UiEvent::DeployRolledBack { ok, detail } => {
                self.status = "rolled back".into();
                self.push_system(if ok {
                    format!("deploy: rolled back — {detail}")
                } else {
                    format!("deploy: rollback failed — {detail}")
                });
            }
            UiEvent::HealthChecked { name, ok, detail } => {
                self.count_health(ok);
                self.push_system(match (ok, detail) {
                    (true, _) => format!("health: {name} ok"),
                    (false, Some(detail)) => format!("health: {name} FAILED — {detail}"),
                    (false, None) => format!("health: {name} FAILED"),
                });
            }
            UiEvent::TurnStarted => {
                self.turn_active = true;
                self.status = "thinking…".to_string();
            }
            UiEvent::TurnEnded { failed } => {
                self.turn_active = false;
                self.status = if failed {
                    "turn failed".into()
                } else {
                    "idle".into()
                };
                self.flush_stream();
            }
            UiEvent::FilePickerItems { items } => {
                if let Some(picker) = self.file_picker.as_mut() {
                    picker.items = items;
                    picker.index = 0;
                }
            }
            UiEvent::Usage { input, output } => {
                self.input_tokens += input;
                self.output_tokens += output;
            }
            UiEvent::Log(message) => self.push_system(message),
        }
    }

    /// Open the rendered acceptance dossier: log its path, then page it with
    /// `$PAGER` (or `less`) when one is available. A missing report — none
    /// produced yet, or a file that is gone — is a graceful log line that
    /// prints the path, never an error.
    fn open_dossier(&mut self) {
        let Some(path) = self.dossier_path.clone() else {
            self.push_system(
                "dossier: no verification report yet — /build runs the verify stage".to_string(),
            );
            return;
        };
        if !std::path::Path::new(&path).exists() {
            self.push_system(format!("dossier: no file at {path}"));
            return;
        }
        self.push_system(format!("dossier: {path}"));
        let pager = std::env::var("PAGER").unwrap_or_else(|_| "less".to_string());
        let mut parts = pager.split_whitespace();
        let command = parts.next().unwrap_or("less");
        let args: Vec<&str> = parts.collect();
        if std::process::Command::new(command)
            .args(args)
            .arg(&path)
            .status()
            .is_err()
        {
            self.push_system(format!("dossier: no pager available — open {path} by hand"));
        }
    }

    fn flush_stream(&mut self) {
        if !self.streaming.is_empty() {
            let text = std::mem::take(&mut self.streaming);
            self.messages.push(TurnMessage {
                role: Role::Assistant,
                text,
            });
        }
    }

    /// The rail's stage label, defaulting to the concept stage.
    fn pipeline_stage(&self) -> String {
        self.pipeline
            .as_ref()
            .map(|p| p.stage.clone())
            .unwrap_or_else(|| "concept".to_string())
    }

    /// Answer a pending gate and clear it from the rail.
    fn clear_pipeline_gate(&mut self) {
        if let Some(pipeline) = self.pipeline.as_mut() {
            pipeline.gate = None;
        }
        self.status = "thinking…".to_string();
    }

    /// The rail view, created on first use so ship events can arrive
    /// before any pipeline event did.
    fn rail(&mut self) -> &mut PipelineView {
        let stage = self.pipeline_stage();
        self.pipeline.get_or_insert(PipelineView {
            stage,
            gate: None,
            verify: None,
            ship: None,
        })
    }

    /// Replace the rail's ship segment, keeping the rest of the rail.
    fn set_ship(&mut self, ship: ShipCounts) {
        self.rail().ship = Some(ship);
    }

    /// Record the proposed deploy target on the rail.
    fn set_ship_deploy(&mut self, target: Option<String>) {
        let ship = self.rail().ship.get_or_insert(ShipCounts {
            tag: None,
            deploy: None,
            health_ok: 0,
            health_total: 0,
        });
        ship.deploy = target;
    }

    /// Count one finished health probe on the rail.
    fn count_health(&mut self, ok: bool) {
        let ship = self.rail().ship.get_or_insert(ShipCounts {
            tag: None,
            deploy: None,
            health_ok: 0,
            health_total: 0,
        });
        ship.health_total += 1;
        if ok {
            ship.health_ok += 1;
        }
    }

    fn push_system(&mut self, text: String) {
        self.messages.push(TurnMessage {
            role: Role::System,
            text,
        });
    }

    /// Flatten the conversation for rendering, including in-flight streaming.
    pub fn rendered_messages(&self) -> Vec<TurnMessage> {
        let mut messages = self.messages.clone();
        if !self.streaming.is_empty() {
            messages.push(TurnMessage {
                role: Role::Assistant,
                text: self.streaming.clone(),
            });
        }
        messages
    }
}

/// Read an image from the clipboard: prefer `wl-paste` (Wayland), fall back to
/// `xclip` (X11). Returns the PNG bytes and media type when one is present,
/// else None so the composer can degrade gracefully.
pub(crate) fn read_clipboard_image() -> Option<(String, Vec<u8>)> {
    if let Some(bytes) = clipboard_bytes("wl-paste", &["--type", "image/png"]) {
        return Some(("image/png".to_string(), bytes));
    }
    if let Some(bytes) = clipboard_bytes(
        "xclip",
        &["-selection", "clipboard", "-t", "image/png", "-o"],
    ) {
        return Some(("image/png".to_string(), bytes));
    }
    None
}

/// Spawn one clipboard reader and return its raw bytes when it succeeds with
/// non-empty output, else None (a missing tool, an empty clipboard, or a
/// non-zero exit all degrade to None).
fn clipboard_bytes(cmd: &str, args: &[&str]) -> Option<Vec<u8>> {
    let output = std::process::Command::new(cmd).args(args).output().ok()?;
    (output.status.success() && !output.stdout.is_empty()).then_some(output.stdout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn new_app() -> App {
        App::new(ProviderKind::Echo, "echo".into())
    }

    #[test]
    fn status_line_reports_state() {
        let mut app = new_app();
        assert!(app.status_line().contains("echo"));
        app.turn_active = true;
        assert!(app.status_line().contains("running"));
        app.input_tokens = 12;
        assert!(app.status_line().contains("12in"));
    }

    #[test]
    fn typing_submits_user_message() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "hi".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(app
            .messages
            .iter()
            .any(|m| m.role == Role::User && m.text == "hi"));
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::Submit { .. }
        ));
    }

    #[test]
    fn ctrl_j_inserts_newline() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.handle_key(KeyAction::Char('a'), &tx);
        app.handle_key(KeyAction::Ctrl('j'), &tx);
        app.handle_key(KeyAction::Char('b'), &tx);
        app.handle_key(KeyAction::Enter, &tx);
        assert!(app.messages.iter().any(|m| m.text == "a\nb"));
    }

    #[test]
    fn cursor_edit_and_word_moves() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "hello world".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Alt('b'), &tx);
        app.handle_key(KeyAction::Char('!'), &tx);
        assert_eq!(app.input, "hello !world");
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "one two".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Home, &tx);
        app.handle_key(KeyAction::Alt('f'), &tx);
        app.handle_key(KeyAction::Char('X'), &tx);
        assert_eq!(app.input, "oneX two");
    }

    #[test]
    fn kill_and_yank() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "keep drop".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        for _ in 0..5 {
            app.handle_key(KeyAction::Left, &tx);
        }
        app.handle_key(KeyAction::Ctrl('k'), &tx);
        assert_eq!(app.input, "keep");
        app.handle_key(KeyAction::End, &tx);
        app.handle_key(KeyAction::Ctrl('y'), &tx);
        assert_eq!(app.input, "keep drop");
    }

    #[test]
    fn history_navigation() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for text in ["first", "second"] {
            for c in text.chars() {
                app.handle_key(KeyAction::Char(c), &tx);
            }
            app.handle_key(KeyAction::Enter, &tx);
        }
        app.handle_key(KeyAction::Ctrl('r'), &tx);
        assert_eq!(app.input, "second");
        app.handle_key(KeyAction::Ctrl('r'), &tx);
        assert_eq!(app.input, "first");
        app.handle_key(KeyAction::Ctrl('n'), &tx);
        assert_eq!(app.input, "second");
    }

    #[test]
    fn slash_commands() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "/model llama3".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert_eq!(app.model, "llama3");
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::SetModel { .. }
        ));

        for c in "/quit".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(app.should_quit);
    }

    #[test]
    fn approval_keys_answer_pending() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::Approval {
                approval_id: "a1".into(),
                kind: "shell".into(),
                summary: "run ls".into(),
            },
            &tx,
        );
        assert!(app.pending_approval.is_some());
        app.handle_key(KeyAction::Char('s'), &tx);
        app.handle_key(KeyAction::Enter, &tx);
        assert!(app.pending_approval.is_none());
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::Approve { approved: true, .. }
        ));
    }

    #[test]
    fn at_opens_picker_and_enter_inserts_path() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.handle_key(KeyAction::Char('@'), &tx);
        assert!(app.file_picker.is_some());
        // The agent task gets a glob request...
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::GlobRequest { .. }
        ));
        // ...and its results populate the picker.
        app.apply_ui_event(
            UiEvent::FilePickerItems {
                items: vec!["src/main.rs".into(), "src/lib.rs".into()],
            },
            &tx,
        );
        assert_eq!(app.file_picker.as_ref().unwrap().items.len(), 2);
        // Esc closes without inserting.
        app.handle_key(KeyAction::Esc, &tx);
        assert!(app.file_picker.is_none());
        assert!(app.input.is_empty());
        // Reopen, navigate, insert.
        app.handle_key(KeyAction::Char('@'), &tx);
        app.apply_ui_event(
            UiEvent::FilePickerItems {
                items: vec!["src/main.rs".into(), "src/lib.rs".into()],
            },
            &tx,
        );
        app.handle_key(KeyAction::Down, &tx);
        app.handle_key(KeyAction::Enter, &tx);
        assert_eq!(app.input, "src/lib.rs");
        assert!(app.file_picker.is_none());
    }

    #[test]
    fn bang_prefix_routes_to_shell_run() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "!ls -la".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::ShellRun { command } if command == "ls -la"
        ));
        // A '!' message is never a normal turn submit.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn alt_d_deletes_word_right() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "keep drop".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Home, &tx);
        app.handle_key(KeyAction::Alt('d'), &tx);
        assert_eq!(app.input, " drop");
        app.handle_key(KeyAction::Alt('d'), &tx);
        assert_eq!(app.input, "");
    }

    #[test]
    fn ctrl_o_toggles_expand_and_ctrl_b_explains() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        assert!(!app.expand_last_tool);
        app.handle_key(KeyAction::Ctrl('o'), &tx);
        assert!(app.expand_last_tool);
        app.handle_key(KeyAction::Ctrl('o'), &tx);
        assert!(!app.expand_last_tool);
        // Ctrl+B is honest: no fake backgrounding.
        app.turn_active = true;
        app.handle_key(KeyAction::Ctrl('b'), &tx);
        assert!(app
            .messages
            .iter()
            .any(|m| m.text.contains("background turns are not supported")));
    }

    #[test]
    fn always_in_workspace_tier_records_and_matches() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::Approval {
                approval_id: "a1".into(),
                kind: "shell".into(),
                summary: "run cargo test".into(),
            },
            &tx,
        );
        app.handle_key(KeyAction::Char('a'), &tx);
        app.handle_key(KeyAction::Enter, &tx);
        assert_eq!(app.workspace_amendments.len(), 1);
        // The amendment is persisted through the command channel...
        let mut recorded = false;
        let mut approved = false;
        while let Ok(command) = rx.try_recv() {
            match command {
                super::super::UiCommand::RecordAmendment { amendment } => {
                    assert_eq!(amendment.tool, "shell");
                    assert_eq!(amendment.durability, "workspace");
                    recorded = true;
                }
                super::super::UiCommand::Approve { .. } => approved = true,
                _ => {}
            }
        }
        assert!(recorded && approved);
        // A matching later call auto-answers...
        app.apply_ui_event(
            UiEvent::Approval {
                approval_id: "a2".into(),
                kind: "shell".into(),
                summary: "run cargo test".into(),
            },
            &tx,
        );
        assert!(app.pending_approval.is_none());
        // ...but a different command still prompts.
        app.apply_ui_event(
            UiEvent::Approval {
                approval_id: "a3".into(),
                kind: "shell".into(),
                summary: "run rm -rf build".into(),
            },
            &tx,
        );
        assert!(app.pending_approval.is_some());
        app.handle_key(KeyAction::Char('n'), &tx);
    }

    #[test]
    fn spec_keys_tab_switches_and_enter_approves_selected() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::Approval {
                approval_id: "a1".into(),
                kind: "shell".into(),
                summary: "run ls".into(),
            },
            &tx,
        );
        assert_eq!(app.pending_approval.as_ref().unwrap().choice_index, 0);
        // Tab cycles the three choice rows (spec section 4.2).
        app.handle_key(KeyAction::Tab, &tx);
        assert_eq!(app.pending_approval.as_ref().unwrap().choice_index, 1);
        app.handle_key(KeyAction::Tab, &tx);
        assert_eq!(app.pending_approval.as_ref().unwrap().choice_index, 2);
        app.handle_key(KeyAction::Tab, &tx);
        assert_eq!(app.pending_approval.as_ref().unwrap().choice_index, 0);
        // Enter approves the selected row with the session durability.
        app.handle_key(KeyAction::Tab, &tx);
        app.handle_key(KeyAction::Enter, &tx);
        assert!(app.pending_approval.is_none());
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::Approve { approved: true, .. }
        ));
        assert_eq!(app.session_auto_approve, vec!["shell".to_string()]);
    }

    #[test]
    fn space_rejects_like_esc() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::Approval {
                approval_id: "a1".into(),
                kind: "shell".into(),
                summary: "run ls".into(),
            },
            &tx,
        );
        app.handle_key(KeyAction::Char(' '), &tx);
        assert!(app.pending_approval.is_none());
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::Approve {
                approved: false,
                ..
            }
        ));
    }

    #[test]
    fn session_auto_approve_after_s() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for i in 0..2 {
            app.apply_ui_event(
                UiEvent::Approval {
                    approval_id: format!("a{i}"),
                    kind: "shell".into(),
                    summary: format!("run {i}"),
                },
                &tx,
            );
            if i == 0 {
                app.handle_key(KeyAction::Char('s'), &tx);
                app.handle_key(KeyAction::Enter, &tx);
            }
        }
        // Second approval auto-answers without a modal.
        assert!(app.pending_approval.is_none());
        let mut approvals = 0;
        while let Ok(command) = rx.try_recv() {
            if matches!(command, super::super::UiCommand::Approve { .. }) {
                approvals += 1;
            }
        }
        // First: answered by the 'a' key. Second: auto-answered for session.
        assert_eq!(approvals, 2);
    }

    #[test]
    fn delta_events_accumulate_then_flush() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(UiEvent::TurnStarted, &tx);
        app.apply_ui_event(UiEvent::Delta("he".into()), &tx);
        app.apply_ui_event(UiEvent::Delta("llo".into()), &tx);
        assert_eq!(app.rendered_messages().last().unwrap().text, "hello");
        app.apply_ui_event(UiEvent::TurnEnded { failed: false }, &tx);
        assert!(app
            .messages
            .iter()
            .any(|m| m.role == Role::Assistant && m.text == "hello"));
        assert!(app.streaming.is_empty());
    }

    #[test]
    fn yolo_toggles_open_and_back() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        assert_eq!(app.approval_mode, ApprovalMode::Closed);
        for c in "/yolo".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert_eq!(app.approval_mode, ApprovalMode::Open);
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::SetApprovalMode(ApprovalMode::Open)
        ));
        for c in "/yolo".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert_eq!(app.approval_mode, ApprovalMode::Closed);
    }

    #[test]
    fn server_side_commands_are_honest_stubs() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for command in ["/compact", "/message x", "/ts", "/ps"] {
            for c in command.chars() {
                app.handle_key(KeyAction::Char(c), &tx);
            }
            app.handle_key(KeyAction::Enter, &tx);
        }
        // Each explains where the surface lives; none fakes success.
        assert!(app
            .messages
            .iter()
            .any(|m| m.text.contains("session/compact")));
        // All three server-side stubs say the same honest thing.
        let stubs = app
            .messages
            .iter()
            .filter(|m| m.text.contains("not available in this build"))
            .count();
        assert_eq!(stubs, 3);
    }

    #[test]
    fn risk_class_maps_tools_to_footer_labels() {
        assert_eq!(RiskClass::for_tool("computer"), RiskClass::Blocking);
        assert_eq!(RiskClass::for_tool("shell"), RiskClass::Elevated);
        assert_eq!(RiskClass::for_tool("write_file"), RiskClass::Elevated);
        assert_eq!(RiskClass::for_tool("mcp__x__y"), RiskClass::ReviewNeeded);
        assert_eq!(RiskClass::Blocking.label(), "blocking");
    }

    #[test]
    fn slash_commands_start_and_advance_the_pipeline() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "/concept an rss briefing service".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::PipelineConcept { .. }
        ));

        // While an interview is active, a plain message answers it.
        app.apply_ui_event(
            UiEvent::PipelineInterview {
                question: "Who is the primary user?".into(),
            },
            &tx,
        );
        for c in "commuters".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::PipelineAnswer { .. }
        ));
    }

    #[test]
    fn interview_answers_then_the_gate_keys_confirm_or_reject() {
        // The whole concept->clarify->confirm key path: a plain message
        // answers the interview, and once the gate is pending `y` confirms
        // while `n` rejects. A key that is neither falls through to the
        // composer instead of answering the gate.
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();

        for c in "/concept an rss briefing service".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::PipelineConcept { .. }
        ));

        app.apply_ui_event(
            UiEvent::PipelineInterview {
                question: "Who is the primary user?".into(),
            },
            &tx,
        );
        assert!(
            app.interview_active,
            "the interview takes over the composer"
        );

        // While the interview is live, a plain message answers it.
        for c in "commuters".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::PipelineAnswer { .. }
        ));

        // The gate opens and waits for y/n.
        app.apply_ui_event(
            UiEvent::PipelineGate {
                gate: "concept-confirmation".into(),
            },
            &tx,
        );
        app.handle_key(KeyAction::Char('y'), &tx);
        match rx.try_recv().unwrap() {
            super::super::UiCommand::PipelineConfirm { stage, ok } => {
                assert_eq!(stage, "concept-confirmation");
                assert!(ok, "y confirms the gate");
            }
            other => {
                let _ = other;
                panic!("expected a pipeline confirm, got another command")
            }
        }

        // Re-open and reject: n is a refusal, not a composer character.
        app.apply_ui_event(
            UiEvent::PipelineGate {
                gate: "spec-confirmation".into(),
            },
            &tx,
        );
        app.handle_key(KeyAction::Char('n'), &tx);
        match rx.try_recv().unwrap() {
            super::super::UiCommand::PipelineConfirm { stage, ok } => {
                assert_eq!(stage, "spec-confirmation");
                assert!(!ok, "n rejects the gate");
            }
            other => {
                let _ = other;
                panic!("expected a pipeline confirm, got another command")
            }
        }
    }

    #[test]
    fn pipeline_rail_shows_stage_and_gate() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::PipelineGate {
                gate: "spec-confirmation".into(),
            },
            &tx,
        );
        assert!(app.pipeline.is_some());
        assert_eq!(
            app.pipeline.as_ref().unwrap().gate.as_deref(),
            Some("spec-confirmation")
        );
        assert!(app.status_line().contains("spec-confirmation"));
    }

    #[test]
    fn verify_done_event_updates_the_rail_counts() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::VerifyDone {
                report_path: "/tmp/runs/run-1/acceptance-dossier.md".into(),
                gates_passed: 3,
                gates_total: 3,
                pass: 1,
                fail: 0,
                unverified: 1,
            },
            &tx,
        );
        assert!(app
            .status_line()
            .contains("verify: gates 3/3 · verdicts 1P/0F/1U"));
        assert_eq!(
            app.dossier_path.as_deref(),
            Some("/tmp/runs/run-1/acceptance-dossier.md")
        );
    }

    #[test]
    fn dossier_command_logs_a_missing_report_gracefully() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        // No verification report has been produced yet.
        for c in "/dossier".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(app
            .messages
            .iter()
            .any(|m| m.role == Role::System && m.text.contains("no verification report")));
        // A report path whose file is gone logs the path, and never opens it.
        app.dossier_path = Some("/nonexistent/prricode/acceptance-dossier.md".into());
        for c in "/dossier".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(app.messages.iter().any(|m| m.role == Role::System
            && m.text
                .contains("/nonexistent/prricode/acceptance-dossier.md")));
    }

    #[test]
    fn ctrl_c_cancels_only_when_running() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.handle_key(KeyAction::Ctrl('c'), &tx);
        assert!(app.should_quit);
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.turn_active = true;
        app.handle_key(KeyAction::Ctrl('c'), &tx);
        assert!(!app.should_quit);
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::Cancel
        ));
    }

    #[test]
    fn theme_command_switches_lists_and_falls_back() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        // Switching by slug repaints from the new palette and persists it.
        for c in "/theme dracula".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert_eq!(app.theme_store.active_slug(), "dracula");
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::SetTheme { .. }
        ));
        assert!(app
            .messages
            .iter()
            .any(|m| m.role == Role::System && m.text.contains("Dracula (dracula)")));
        // With no argument it lists the themes, marking the active one.
        for c in "/theme".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        let listing = app
            .messages
            .iter()
            .find(|m| m.text.starts_with("themes:"))
            .expect("a listing line")
            .text
            .clone();
        assert!(listing.contains("dracula (Dracula, active)"), "{listing}");
        assert!(listing.contains("prricode (prricode)"), "{listing}");
        // An unknown name keeps the active theme and says what is available.
        for c in "/theme no-such-theme".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert_eq!(app.theme_store.active_slug(), "dracula");
        assert!(app.messages.iter().any(|m| m.role == Role::System
            && m.text.contains("unknown theme 'no-such-theme'")
            && m.text.contains("available:")));
    }

    #[test]
    fn theme_setting_falls_back_with_a_log() {
        let mut app = new_app();
        app.apply_theme_setting("does-not-exist");
        assert_eq!(app.theme_store.active_slug(), "prricode");
        assert!(app
            .messages
            .iter()
            .any(|m| m.role == Role::System && m.text.contains("unknown theme 'does-not-exist'")));
        // A known name from the setting applies without a log line.
        app.apply_theme_setting("tokyo-night");
        assert_eq!(app.theme_store.active_slug(), "tokyo-night");
    }

    #[test]
    fn theme_command_switches_one_of_the_newly_added_themes() {
        // `/theme <slug>` on a newly bundled palette repaints and persists it.
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "/theme gruvbox-dark-medium".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert_eq!(app.theme_store.active_slug(), "gruvbox-dark-medium");
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::SetTheme { .. }
        ));
        assert!(app.messages.iter().any(|m| m.role == Role::System
            && m.text.contains("Gruvbox Dark Medium (gruvbox-dark-medium)")));
    }

    #[test]
    fn attach_and_detach_image_transitions() {
        let mut app = new_app();
        assert!(app.image_hint().is_none());
        // Attaching shows the byte count in the input box and the conversation.
        app.attach_image(vec![0x89, b'P', b'N', b'G'], "image/png");
        assert_eq!(
            app.image_hint().as_deref(),
            Some("image attached (4 bytes)")
        );
        assert!(app
            .messages
            .iter()
            .any(|m| m.role == Role::System && m.text.contains("image attached (4 bytes)")));
        // Detaching clears it exactly once.
        app.detach_image();
        assert!(app.image_hint().is_none());
        let cleared = app
            .messages
            .iter()
            .filter(|m| m.text.contains("image attachment cleared"))
            .count();
        assert_eq!(cleared, 1);
        // Detaching again is a silent no-op.
        app.detach_image();
        assert!(app.image_hint().is_none());
        assert_eq!(
            app.messages
                .iter()
                .filter(|m| m.text.contains("image attachment cleared"))
                .count(),
            cleared
        );
    }

    #[test]
    fn submit_carries_the_pasted_image_once_and_never_into_history() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        let bytes = vec![1u8, 2, 3, 4, 5];
        app.attach_image(bytes.clone(), "image/png");
        for c in "what is in this screenshot?".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);

        // Exactly one Submit carries the image, base64-encoded, exactly once.
        let data_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let mut submits = 0usize;
        let mut image_parts = 0usize;
        while let Ok(command) = rx.try_recv() {
            if let super::super::UiCommand::Submit { text, image } = command {
                submits += 1;
                assert_eq!(text, "what is in this screenshot?");
                match image {
                    Some(prricode_provider::ContentPart::Image {
                        media_type,
                        data_base64,
                    }) => {
                        image_parts += 1;
                        assert_eq!(media_type, "image/png");
                        assert_eq!(data_base64, data_b64);
                    }
                    other => panic!("expected an image part, got {other:?}"),
                }
            }
        }
        assert_eq!(submits, 1, "the submit fires exactly once");
        assert_eq!(image_parts, 1, "the image rides along exactly once");

        // The attachment is consumed: a later submit without re-attaching has
        // no image.
        for c in "another message".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        let mut second_image = false;
        while let Ok(command) = rx.try_recv() {
            if let super::super::UiCommand::Submit { image, .. } = command {
                second_image |= image.is_some();
            }
        }
        assert!(!second_image, "the attachment is one-shot");

        // History holds the typed text only — never the attachment material.
        assert_eq!(
            app.history,
            vec![
                "what is in this screenshot?".to_string(),
                "another message".to_string()
            ]
        );
        app.handle_key(KeyAction::Ctrl('r'), &tx);
        assert!(!app.input.contains(&data_b64));
    }

    #[test]
    fn ctrl_v_intercepts_the_key_and_degrades_without_an_image() {
        // Ctrl+V is intercepted as paste (never inserts a literal 'v'); with
        // no clipboard image it degrades with a message rather than attaching.
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.handle_key(KeyAction::Ctrl('v'), &tx);
        assert!(
            !app.input.contains('v'),
            "the paste key is not typed into the composer"
        );
        if app.pending_image.is_none() {
            assert!(app
                .messages
                .iter()
                .any(|m| m.text.contains("no image on the clipboard")));
        }
    }

    #[test]
    fn clipboard_bytes_degrades_when_the_tool_yields_nothing() {
        // A missing tool, or one whose output is empty, degrades to None.
        assert!(clipboard_bytes("definitely-not-a-real-binary-prricode", &[]).is_none());
        assert!(clipboard_bytes("true", &[]).is_none());
    }

    #[test]
    fn ship_command_opens_the_release_confirmation_gate() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        for c in "/ship".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::ShipStart
        ));
        // The release gate arrives from the agent task and renders on the
        // rail; the y/n keys answer it through the pipeline confirm path.
        app.apply_ui_event(
            UiEvent::PipelineGate {
                gate: "ship-confirmation".into(),
            },
            &tx,
        );
        assert_eq!(
            app.pipeline.as_ref().unwrap().gate.as_deref(),
            Some("ship-confirmation")
        );
        app.handle_key(KeyAction::Char('y'), &tx);
        match rx.try_recv().unwrap() {
            super::super::UiCommand::PipelineConfirm { stage, ok } => {
                assert_eq!(stage, "ship-confirmation");
                assert!(ok);
            }
            _ => panic!("expected PipelineConfirm for the ship gate"),
        }
    }

    #[test]
    fn secret_collection_masks_input_and_never_persists_the_value() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::DeploySecret {
                name: "CLOUDFLARE_API_TOKEN".into(),
                purpose: "authenticate the deploy CLI for this deploy".into(),
            },
            &tx,
        );
        assert!(app.secret_input);
        for c in "s3cret-value".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        // The composer renders one mask character per character typed...
        assert_eq!(app.composer_text(), "*".repeat("s3cret-value".len()));
        // ...while the real value only ever lives in the composer buffer.
        assert_eq!(app.input, "s3cret-value");

        app.handle_key(KeyAction::Enter, &tx);
        // The value went out as a DeploySecret command and nowhere else.
        match rx.try_recv().unwrap() {
            super::super::UiCommand::DeploySecret { name, value } => {
                assert_eq!(name, "CLOUDFLARE_API_TOKEN");
                assert_eq!(value, "s3cret-value");
            }
            _ => panic!("expected DeploySecret"),
        }
        // The composer is cleared and the mode is off after submit.
        assert!(app.input.is_empty());
        assert!(!app.secret_input);
        // The value never lands in messages...
        assert!(app
            .messages
            .iter()
            .all(|m| !m.text.contains("s3cret-value")));
        // ...and never in history: a recall recovers nothing.
        app.handle_key(KeyAction::Ctrl('r'), &tx);
        assert!(!app.input.contains("s3cret-value"));
    }

    #[test]
    fn esc_abandons_a_secret_entry_and_clears_the_value() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::DeploySecret {
                name: "FLY_API_TOKEN".into(),
                purpose: "authenticate the fly CLI for this deploy".into(),
            },
            &tx,
        );
        for c in "half-typed".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Esc, &tx);
        // The mode is off and the half-typed value is cleared...
        assert!(!app.secret_input);
        assert!(app.input.is_empty());
        // ...nothing was sent, and the flow still waits for the value.
        assert!(rx.try_recv().is_err());
        assert_eq!(app.secret_name.as_deref(), Some("FLY_API_TOKEN"));
        // /deploy re-opens the masked entry for the same credential.
        for c in "/deploy".chars() {
            app.handle_key(KeyAction::Char(c), &tx);
        }
        app.handle_key(KeyAction::Enter, &tx);
        assert!(app.secret_input);
        assert_eq!(app.secret_name.as_deref(), Some("FLY_API_TOKEN"));
    }

    #[test]
    fn deploy_prompt_asks_for_auto_rollback_then_confirms() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::DeployProposed {
                target: "cloudflare".into(),
                reason: "wrangler.toml present".into(),
                credentials: vec!["CLOUDFLARE_API_TOKEN".into()],
            },
            &tx,
        );
        assert!(app.deploy_pending.is_some());
        assert!(app
            .messages
            .iter()
            .any(|m| m.text.contains("deploy: proposed cloudflare")));
        // Confirming the target opens the auto-rollback sub-choice; nothing
        // is confirmed yet.
        app.handle_key(KeyAction::Char('y'), &tx);
        assert!(app.deploy_pending.is_none());
        assert_eq!(app.auto_rollback_prompt.as_deref(), Some("cloudflare"));
        assert!(rx.try_recv().is_err(), "the deploy is not confirmed yet");
        // Skipping the sub-choice confirms the deploy without auto-rollback.
        app.handle_key(KeyAction::Char('n'), &tx);
        match rx.try_recv().unwrap() {
            super::super::UiCommand::DeployConfirm {
                confirmed,
                auto_rollback,
            } => {
                assert!(confirmed);
                assert!(!auto_rollback);
            }
            _ => panic!("expected DeployConfirm"),
        }
        assert!(app.auto_rollback_prompt.is_none());

        // Arming the sub-choice (default no, so only y enables) confirms with
        // auto-rollback on.
        app.apply_ui_event(
            UiEvent::DeployProposed {
                target: "fly".into(),
                reason: "fly.toml present".into(),
                credentials: vec![],
            },
            &tx,
        );
        app.handle_key(KeyAction::Char('y'), &tx);
        app.handle_key(KeyAction::Char('y'), &tx);
        match rx.try_recv().unwrap() {
            super::super::UiCommand::DeployConfirm {
                confirmed,
                auto_rollback,
            } => {
                assert!(confirmed);
                assert!(auto_rollback);
            }
            _ => panic!("expected DeployConfirm"),
        }

        // Declining the target short-circuits with no auto-rollback question.
        app.apply_ui_event(
            UiEvent::DeployProposed {
                target: "vercel".into(),
                reason: "vercel.json present".into(),
                credentials: vec![],
            },
            &tx,
        );
        app.handle_key(KeyAction::Char('n'), &tx);
        match rx.try_recv().unwrap() {
            super::super::UiCommand::DeployConfirm {
                confirmed,
                auto_rollback,
            } => {
                assert!(!confirmed);
                assert!(!auto_rollback);
            }
            _ => panic!("expected DeployConfirm"),
        }
        assert!(app.auto_rollback_prompt.is_none());
    }

    #[test]
    fn a_deploy_rollback_event_is_reported_in_the_conversation() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::DeployRolledBack {
                ok: true,
                detail: "rollback for vercel ran `vercel rollback` (exit 0)".into(),
            },
            &tx,
        );
        assert!(app
            .messages
            .iter()
            .any(|m| m.role == Role::System && m.text.contains("deploy: rolled back")));
        app.apply_ui_event(
            UiEvent::DeployRolledBack {
                ok: false,
                detail: "rollback for fly timed out after 120s".into(),
            },
            &tx,
        );
        assert!(app
            .messages
            .iter()
            .any(|m| m.text.contains("deploy: rollback failed")));
    }

    #[test]
    fn ship_rail_segment_tracks_the_release_deploy_and_health() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let mut app = new_app();
        app.apply_ui_event(
            UiEvent::ShipReady {
                tag: "v2026-10-14-abcdef01".into(),
                release_url: Some("https://example.invalid/releases/tagged".into()),
                install_steps: vec!["cargo run".into()],
            },
            &tx,
        );
        assert!(app
            .status_line()
            .contains("ship: v2026-10-14-abcdef01 · deploy: — · health: 0/0"));
        // The release URL and install steps are shown in the conversation.
        assert!(app
            .messages
            .iter()
            .any(|m| m.text.contains("https://example.invalid/releases/tagged")));
        assert!(app.messages.iter().any(|m| m.text.contains("cargo run")));
        // A proposed deploy fills the deploy segment; probes tally health.
        app.apply_ui_event(
            UiEvent::DeployProposed {
                target: "cloudflare".into(),
                reason: "wrangler.toml".into(),
                credentials: vec!["CLOUDFLARE_API_TOKEN".into()],
            },
            &tx,
        );
        assert!(app.status_line().contains("deploy: cloudflare"));
        app.apply_ui_event(
            UiEvent::HealthChecked {
                name: "release".into(),
                ok: true,
                detail: None,
            },
            &tx,
        );
        assert!(app.status_line().contains("health: 1/1"));
    }
}
