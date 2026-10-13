//! TUI application state and event handling (pure logic, unit-tested).
//!
//! The keymap follows the Reference TUI evidence: Return submits the composer,
//! Ctrl+J inserts a newline, Ctrl+R/P/N walk history, Ctrl+G edits in
//! $EDITOR, Ctrl+L clears, Alt+B/F move by word, Ctrl+K/Y kill/yank, Esc
//! cancels, and approvals answer y (allow once) / a (allow for session) /
//! n (deny).

use prricode_core::ApprovalMode;
use prricode_provider::ProviderKind;

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

#[derive(Debug, Clone)]
pub struct PendingApproval {
    pub approval_id: String,
    pub kind: String,
    pub summary: String,
}

/// Events delivered from the agent task to the UI.
#[derive(Debug, Clone)]
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
#[derive(Debug, Clone, PartialEq, Eq)]
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
        }
    }

    pub fn status_line(&self) -> String {
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
                KeyAction::Char('y') | KeyAction::Enter => {
                    let _ = commands.send(UiCommand::Approve {
                        approval_id: approval.approval_id.clone(),
                        approved: true,
                    });
                    self.pending_approval = None;
                    self.push_system(format!("allow:approved — {}", approval.summary));
                    return;
                }
                KeyAction::Char('a') => {
                    self.session_auto_approve.push(approval.kind.clone());
                    let _ = commands.send(UiCommand::Approve {
                        approval_id: approval.approval_id.clone(),
                        approved: true,
                    });
                    self.pending_approval = None;
                    self.push_system(format!("allow:approved_for_session — {}", approval.summary));
                    return;
                }
                KeyAction::Char('n') | KeyAction::Esc => {
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
                other => self.push_system(format!("unknown command: /{other} (try /help)")),
            }
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

    fn flush_stream(&mut self) {
        if !self.streaming.is_empty() {
            let text = std::mem::take(&mut self.streaming);
            self.messages.push(TurnMessage {
                role: Role::Assistant,
                text,
            });
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn new_app() -> App {
        App::new(ProviderKind::Echo, "echo".into())
    }

    fn channel() -> (
        mpsc::UnboundedSender<super::super::UiCommand>,
        mpsc::UnboundedReceiver<super::super::UiCommand>,
    ) {
        mpsc::unbounded_channel()
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
    fn ctrl_c_cancels_only_when_running() {
        let (tx, mut rx) = mpsc::unbounded_channel();
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
