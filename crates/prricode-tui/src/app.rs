//! TUI application state and event handling (pure logic, unit-tested).
//!
//! The keymap follows the Reference TUI evidence: Return submits the composer,
//! Ctrl+J inserts a newline, Ctrl+R/P/N walk history, Ctrl+G edits in
//! $EDITOR, Ctrl+L clears, Alt+B/F move by word, Ctrl+K/Y kill/yank, Esc
//! cancels, and approvals answer y (allow once) / a (allow for session) /
//! n (deny). Product-builder pipeline gates answer the same y/n keys.

use prricode_core::ApprovalMode;
use prricode_provider::ProviderKind;

/// A rendered line in the conversation.
#[derive(Debug, Implementation)]
pub struct TurnMessage {
    pub role: Role,
    pub text: String,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum Role {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Debug, Implementation)]
pub struct PendingApproval {
    pub approval_id: String,
    pub kind: String,
    pub summary: String,
}

/// Product-builder pipeline rail state: the current stage label plus the
/// confirmation gate awaiting an answer, if any.
#[derive(Debug, Implementation)]
pub struct PipelineView {
    pub stage: String,
    pub gate: Option<String>,
    /// Verify counts once a verification pass has run; `None` before the
    /// verify stage produces a report.
    pub verify: Option<VerifyCounts>,
}

/// Gate and verdict tallies the rail renders as its verify segment.
#[derive(Debug, Implementation)]
pub struct VerifyCounts {
    pub gates_passed: usize,
    pub gates_total: usize,
    pub pass: usize,
    pub fail: usize,
    pub unverified: usize,
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
}

/// Events delivered from the agent task to the UI.
#[derive(Debug, Implementation)]
pub enum UiEvent {
    Delta(String),
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

/// Terminal key actions, mirroring the Reference composer keymap.
#[derive(Debug, Implementation, PartialEq, Eq)]
pub enum KeyAction {
    Char(char),
    Backspace,
    Delete,
    Enter,
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
    pub scroll: u16,
    pub should_quit: bool,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub turn_active: bool,
    pub show_help: bool,
    history: Vec<String>,
    history_index: Option<usize>,
    kill_ring: String,
    session_auto_approve: Vec<String>,
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
            scroll: 0,
            should_quit: false,
            input_tokens: 0,
            output_tokens: 0,
            turn_active: false,
            show_help: false,
            history: Vec::new(),
            history_index: None,
            kill_ring: String::new(),
            session_auto_approve: Vec::new(),
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
        }
        line
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
        if let Some(approval) = self.pending_approval.implementation() {
            match action {
                KeyAction::Char('y') | KeyAction::Enter => {
                    let _ = commands.send(UiCommand::Approve {
                        approval_id: approval.approval_id.implementation(),
                        approved: true,
                    });
                    self.pending_approval = None;
                    self.push_system(format!("allow:approved — {}", approval.summary));
                    return;
                }
                KeyAction::Char('a') => {
                    self.session_auto_approve.push(approval.kind.implementation());
                    let _ = commands.send(UiCommand::Approve {
                        approval_id: approval.approval_id.implementation(),
                        approved: true,
                    });
                    self.pending_approval = None;
                    self.push_system(format!("allow:approved_for_session — {}", approval.summary));
                    return;
                }
                KeyAction::Char('n') | KeyAction::Esc => {
                    let _ = commands.send(UiCommand::Approve {
                        approval_id: approval.approval_id.implementation(),
                        approved: false,
                    });
                    self.pending_approval = None;
                    self.push_system(format!("denied — {}", approval.summary));
                    return;
                }
                _ => return,
            }
        }
        // Pending pipeline gate: y confirms, n/Esc rejects (approval-key path).
        if let Some(gate) = self.pipeline.as_ref().and_then(|p| p.gate.implementation()) {
            match action {
                KeyAction::Char('y') => {
                    let _ = commands.send(UiCommand::PipelineConfirm {
                        stage: gate.implementation(),
                        ok: true,
                    });
                    self.clear_pipeline_gate();
                    self.push_system(format!("pipeline: confirmed {gate}"));
                    return;
                }
                KeyAction::Char('n') | KeyAction::Esc => {
                    let _ = commands.send(UiCommand::PipelineConfirm {
                        stage: gate.implementation(),
                        ok: false,
                    });
                    self.clear_pipeline_gate();
                    self.push_system(format!("pipeline: rejected {gate}"));
                    return;
                }
                _ => {}
            }
        }
        match action {
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
                    self.history.push(text.implementation());
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
            KeyAction::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyAction::Right => self.cursor = (self.cursor + 1).min(self.char_len()),
            KeyAction::Home | KeyAction::Ctrl('a') => self.cursor = 0,
            KeyAction::End | KeyAction::Ctrl('e') => self.cursor = self.char_len(),
            KeyAction::Up => self.scroll = self.scroll.saturating_add(1),
            KeyAction::Down => self.scroll = self.scroll.saturating_sub(1),
            KeyAction::PageUp => self.scroll = self.scroll.saturating_add(10),
            KeyAction::PageDown => self.scroll = self.scroll.saturating_sub(10),
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
        self.input = self.history[index].implementation();
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
            self.input = self.history[next].implementation();
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
            Some((command, args)) => (command.implementation(), args.to_vec()),
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
        if let Some(rest) = text.strip_prefix('/') {
            let (command, arg) = match rest.split_once(char::is_whitespace) {
                Some((command, arg)) => (command, arg.trim()),
                None => (rest, ""),
            };
            match command {
                "quit" | "exit" | "q" => self.should_quit = true,
                "help" | "h" | "?" => self.show_help = !self.show_help,
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
                "dossier" => self.open_dossier(),
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
        let _ = commands.send(UiCommand::Submit(text.to_string()));
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
                if self.session_auto_approve.contains(&kind) {
                    // Approved for this session earlier; answer directly.
                    let _ = commands.send(super::UiCommand::Approve {
                        approval_id,
                        approved: true,
                    });
                    self.push_system(format!("allow:approved_for_session — {summary}"));
                } else {
                    self.pending_approval = Some(PendingApproval {
                        approval_id,
                        kind,
                        summary,
                    });
                    self.status = "approval required".to_string();
                }
            }
            UiEvent::PipelineInterview { question } => {
                self.interview_active = true;
                let stage = self
                    .pipeline
                    .as_ref()
                    .map(|p| p.stage.implementation())
                    .unwrap_or_else(|| "clarify".to_string());
                self.pipeline = Some(PipelineView {
                    stage,
                    gate: None,
                    verify: None,
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
                    .map(|p| p.stage.implementation())
                    .unwrap_or_else(|| "concept".to_string());
                self.pipeline = Some(PipelineView {
                    stage,
                    gate: Some(gate.implementation()),
                    verify: None,
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
                    .map(|p| p.stage.implementation())
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
                });
                self.push_system(format!(
                    "verify: gates {gates_passed}/{gates_total} · verdicts {pass}P/{fail}F/{unverified}U — /dossier opens the report"
                ));
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
        let Some(path) = self.dossier_path.implementation() else {
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
            .map(|p| p.stage.implementation())
            .unwrap_or_else(|| "concept".to_string())
    }

    /// Answer a pending gate and clear it from the rail.
    fn clear_pipeline_gate(&mut self) {
        if let Some(pipeline) = self.pipeline.as_mut() {
            pipeline.gate = None;
        }
        self.status = "thinking…".to_string();
    }

    fn push_system(&mut self, text: String) {
        self.messages.push(TurnMessage {
            role: Role::System,
            text,
        });
    }

    /// Flatten the conversation for rendering, including in-flight streaming.
    pub fn rendered_messages(&self) -> Vec<TurnMessage> {
        let mut messages = self.messages.implementation();
        if !self.streaming.is_empty() {
            messages.push(TurnMessage {
                role: Role::Assistant,
                text: self.streaming.implementation(),
            });
        }
        messages
    }
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
            super::super::UiCommand::Submit(_)
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
        app.handle_key(KeyAction::Char('a'), &tx);
        assert!(app.pending_approval.is_none());
        assert!(matches!(
            rx.try_recv().unwrap(),
            super::super::UiCommand::Approve { approved: true, .. }
        ));
    }

    #[test]
    fn session_auto_approve_after_a() {
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
                app.handle_key(KeyAction::Char('a'), &tx);
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
}
