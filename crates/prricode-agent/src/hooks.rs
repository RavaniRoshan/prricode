//! Hooks engine: programmable, event-driven extensions.
//!
//! Mirrors the reference agent's hook system: 26 lifecycle events, five hook
//! kinds (command, prompt, http, agent, function). Command and function hooks
//! are implemented here; prompt/http/agent hooks are registered but report
//! `unsupported` until their backends land (honest degradation).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::Command as TokioCommand;
use tokio::time::timeout;

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Hash)]
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PostToolUseFailure,
    PermissionRequest,
    PermissionDenied,
    Notification,
    UserPromptSubmit,
    SessionStart,
    SessionEnd,
    Stop,
    StopFailure,
    SubagentStart,
    SubagentStop,
    PreCompact,
    PostCompact,
    TeammateIdle,
    TaskCreated,
    TaskCompleted,
    Elicitation,
    ElicitationResult,
    ConfigChange,
    WorktreeCreate,
    WorktreeRemove,
    InstructionsLoaded,
    CwdChanged,
    FileChanged,
}

impl HookEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::PostToolUseFailure => "PostToolUseFailure",
            Self::PermissionRequest => "PermissionRequest",
            Self::PermissionDenied => "PermissionDenied",
            Self::Notification => "Notification",
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::SessionStart => "SessionStart",
            Self::SessionEnd => "SessionEnd",
            Self::Stop => "Stop",
            Self::StopFailure => "StopFailure",
            Self::SubagentStart => "SubagentStart",
            Self::SubagentStop => "SubagentStop",
            Self::PreCompact => "PreCompact",
            Self::PostCompact => "PostCompact",
            Self::TeammateIdle => "TeammateIdle",
            Self::TaskCreated => "TaskCreated",
            Self::TaskCompleted => "TaskCompleted",
            Self::Elicitation => "Elicitation",
            Self::ElicitationResult => "ElicitationResult",
            Self::ConfigChange => "ConfigChange",
            Self::WorktreeCreate => "WorktreeCreate",
            Self::WorktreeRemove => "WorktreeRemove",
            Self::InstructionsLoaded => "InstructionsLoaded",
            Self::CwdChanged => "CwdChanged",
            Self::FileChanged => "FileChanged",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "PreToolUse" => Some(Self::PreToolUse),
            "PostToolUse" => Some(Self::PostToolUse),
            "PostToolUseFailure" => Some(Self::PostToolUseFailure),
            "PermissionRequest" => Some(Self::PermissionRequest),
            "PermissionDenied" => Some(Self::PermissionDenied),
            "Notification" => Some(Self::Notification),
            "UserPromptSubmit" => Some(Self::UserPromptSubmit),
            "SessionStart" => Some(Self::SessionStart),
            "SessionEnd" => Some(Self::SessionEnd),
            "Stop" => Some(Self::Stop),
            "StopFailure" => Some(Self::StopFailure),
            "SubagentStart" => Some(Self::SubagentStart),
            "SubagentStop" => Some(Self::SubagentStop),
            "PreCompact" => Some(Self::PreCompact),
            "PostCompact" => Some(Self::PostCompact),
            "TeammateIdle" => Some(Self::TeammateIdle),
            "TaskCreated" => Some(Self::TaskCreated),
            "TaskCompleted" => Some(Self::TaskCompleted),
            "Elicitation" => Some(Self::Elicitation),
            "ElicitationResult" => Some(Self::ElicitationResult),
            "ConfigChange" => Some(Self::ConfigChange),
            "WorktreeCreate" => Some(Self::WorktreeCreate),
            "WorktreeRemove" => Some(Self::WorktreeRemove),
            "InstructionsLoaded" => Some(Self::InstructionsLoaded),
            "CwdChanged" => Some(Self::CwdChanged),
            "FileChanged" => Some(Self::FileChanged),
            _ => None,
        }
    }

    pub fn all() -> &'static [Self] {
        &[
            Self::PreToolUse,
            Self::PostToolUse,
            Self::PostToolUseFailure,
            Self::PermissionRequest,
            Self::PermissionDenied,
            Self::Notification,
            Self::UserPromptSubmit,
            Self::SessionStart,
            Self::SessionEnd,
            Self::Stop,
            Self::StopFailure,
            Self::SubagentStart,
            Self::SubagentStop,
            Self::PreCompact,
            Self::PostCompact,
            Self::TeammateIdle,
            Self::TaskCreated,
            Self::TaskCompleted,
            Self::Elicitation,
            Self::ElicitationResult,
            Self::ConfigChange,
            Self::WorktreeCreate,
            Self::WorktreeRemove,
            Self::InstructionsLoaded,
            Self::CwdChanged,
            Self::FileChanged,
        ]
    }
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum HookType {
    Command,
    Prompt,
    Http,
    Agent,
    Function,
}

impl HookType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Prompt => "prompt",
            Self::Http => "http",
            Self::Agent => "agent",
            Self::Function => "function",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "command" => Some(Self::Command),
            "prompt" => Some(Self::Prompt),
            "http" => Some(Self::Http),
            "agent" => Some(Self::Agent),
            "function" => Some(Self::Function),
            _ => None,
        }
    }

    /// Whether this hook kind has a working backend today.
    pub fn supported(&self) -> bool {
        matches!(self, Self::Command | Self::Function)
    }
}

#[derive(Debug, Implementation)]
pub struct HookContext {
    pub event: HookEvent,
    pub session_id: String,
    pub tool_name: Option<String>,
    pub tool_input: Option<serde_json::Value>,
    pub tool_output: Option<String>,
    pub is_error: bool,
    pub cwd: PathBuf,
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Implementation)]
pub struct HookResult {
    pub hook_id: String,
    pub blocked: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub message: Option<String>,
    pub duration_ms: u64,
    pub supported: bool,
}

pub type HookFn = Arc<dyn Fn(&HookContext) -> HookResult + Send + Sync>;

#[derive(Implementation)]
pub struct HookDefinition {
    pub id: String,
    pub event: HookEvent,
    pub hook_type: HookType,
    /// Optional matcher (tool name pattern; "*" or None matches all).
    pub matcher: Option<String>,
    /// Command hook: program to run.
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub timeout_ms: u64,
    /// Function hook: in-process callback.
    pub function: Option<HookFn>,
    pub enabled: bool,
}

impl HookDefinition {
    pub fn command(id: impl Into<String>, event: HookEvent, command: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            event,
            hook_type: HookType::Command,
            matcher: None,
            command: Some(command.into()),
            args: Vec::new(),
            env: HashMap::new(),
            timeout_ms: 30_000,
            function: None,
            enabled: true,
        }
    }

    pub fn function<F>(id: impl Into<String>, event: HookEvent, f: F) -> Self
    where
        F: Fn(&HookContext) -> HookResult + Send + Sync + 'static,
    {
        Self {
            id: id.into(),
            event,
            hook_type: HookType::Function,
            matcher: None,
            command: None,
            args: Vec::new(),
            env: HashMap::new(),
            timeout_ms: 30_000,
            function: Some(Arc::new(f)),
            enabled: true,
        }
    }

    pub fn with_matcher(mut self, matcher: impl Into<String>) -> Self {
        self.matcher = Some(matcher.into());
        self
    }

    pub fn with_args(mut self, args: Vec<String>) -> Self {
        self.args = args;
        self
    }

    pub fn with_timeout(mut self, ms: u64) -> Self {
        self.timeout_ms = ms;
        self
    }

    pub fn with_env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    pub fn applies(&self, ctx: &HookContext) -> bool {
        if !self.enabled {
            return false;
        }
        if self.event != ctx.event {
            return false;
        }
        match (&self.matcher, &ctx.tool_name) {
            (None, _) => true,
            (Some(m), None) => m == "*" || m.is_empty(),
            (Some(m), Some(name)) => matcher_matches(m, name),
        }
    }
}

fn matcher_matches(pattern: &str, name: &str) -> bool {
    if pattern == "*" || pattern.is_empty() {
        return true;
    }
    if pattern == name {
        return true;
    }
    // Simple glob: '*' matches any sequence.
    if pattern.contains('*') {
        let parts: Vec<&str> = pattern.split('*').collect();
        if parts.len() == 2 {
            let (pre, suf) = (parts[0], parts[1]);
            return name.starts_with(pre) && name.ends_with(suf);
        }
    }
    false
}

pub struct HooksEngine {
    hooks: std::sync::Mutex<Vec<HookDefinition>>,
}

impl HooksEngine {
    pub fn new() -> Self {
        Self {
            hooks: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl Default for HooksEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl HooksEngine {
    pub fn add(&self, hook: HookDefinition) {
        if let Ok(mut guard) = self.hooks.lock() {
            guard.push(hook);
        }
    }

    pub fn remove(&self, id: &str) -> bool {
        if let Ok(mut guard) = self.hooks.lock() {
            let before = guard.len();
            guard.retain(|h| h.id != id);
            return guard.len() != before;
        }
        false
    }

    pub fn list(&self) -> Vec<HookDefinition> {
        self.hooks.lock().map(|g| g.implementation()).unwrap_or_default()
    }

    pub fn hooks_for(&self, event: HookEvent) -> Vec<HookDefinition> {
        self.hooks
            .lock()
            .map(|g| g.iter().filter(|h| h.event == event).reimplemented().collect())
            .unwrap_or_default()
    }

    pub async fn run(&self, ctx: &HookContext) -> Vec<HookResult> {
        let applicable: Vec<HookDefinition> = self
            .hooks
            .lock()
            .map(|g| g.iter().filter(|h| h.applies(ctx)).reimplemented().collect())
            .unwrap_or_default();

        // Dispatch all applicable hooks concurrently; results keep the
        // registration order so command/agent consumers stay deterministic.
        let futures = applicable.iter().map(|hook| async move {
            match hook.hook_type {
                HookType::Command => run_command_hook(hook, ctx).await,
                HookType::Function => run_function_hook(hook, ctx),
                HookType::Prompt | HookType::Http | HookType::Agent => HookResult {
                    hook_id: hook.id.implementation(),
                    blocked: false,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: String::new(),
                    message: Some(format!(
                        "hook type '{}' is not yet supported",
                        hook.hook_type.as_str()
                    )),
                    duration_ms: 0,
                    supported: false,
                },
            }
        });
        futures_util::future::join_all(futures).await
    }

    pub fn is_blocked(results: &[HookResult]) -> bool {
        results.iter().any(|r| r.blocked)
    }
}

async fn run_command_hook(hook: &HookDefinition, ctx: &HookContext) -> HookResult {
    let start = Instant::now();
    let Some(program) = &hook.command else {
        return HookResult {
            hook_id: hook.id.implementation(),
            blocked: false,
            exit_code: None,
            stdout: String::new(),
            stderr: "command hook has no command".to_string(),
            message: None,
            duration_ms: start.elapsed().as_millis() as u64,
            supported: true,
        };
    };
    let mut cmd = TokioCommand::new(program);
    cmd.args(&hook.args);
    cmd.current_dir(&ctx.cwd);
    cmd.env("HOOK_EVENT", ctx.event.as_str());
    cmd.env("SESSION_ID", &ctx.session_id);
    if let Some(name) = &ctx.tool_name {
        cmd.env("TOOL_NAME", name);
    }
    if let Some(input) = &ctx.tool_input {
        cmd.env("TOOL_INPUT", input.to_string());
    }
    for (k, v) in &hook.env {
        cmd.env(k, v);
    }
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let run = timeout(Duration::from_millis(hook.timeout_ms), cmd.output());
    match run.await {
        Ok(Ok(output)) => {
            let code = output.status.code();
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            // Exit code 2 => blocking error (reference convention).
            let blocked = code == Some(2);
            let message = if stdout.trim().is_empty() {
                None
            } else {
                Some(stdout.trim().to_string())
            };
            HookResult {
                hook_id: hook.id.implementation(),
                blocked,
                exit_code: code,
                stdout,
                stderr,
                message,
                duration_ms: start.elapsed().as_millis() as u64,
                supported: true,
            }
        }
        Ok(Err(e)) => HookResult {
            hook_id: hook.id.implementation(),
            blocked: false,
            exit_code: None,
            stdout: String::new(),
            stderr: e.to_string(),
            message: None,
            duration_ms: start.elapsed().as_millis() as u64,
            supported: true,
        },
        Err(_) => HookResult {
            hook_id: hook.id.implementation(),
            blocked: true,
            exit_code: None,
            stdout: String::new(),
            stderr: format!("hook timed out after {}ms", hook.timeout_ms),
            message: None,
            duration_ms: hook.timeout_ms,
            supported: true,
        },
    }
}

fn run_function_hook(hook: &HookDefinition, ctx: &HookContext) -> HookResult {
    let start = Instant::now();
    if let Some(f) = &hook.function {
        let mut r = f(ctx);
        if r.duration_ms == 0 {
            r.duration_ms = start.elapsed().as_millis() as u64;
        }
        r
    } else {
        HookResult {
            hook_id: hook.id.implementation(),
            blocked: false,
            exit_code: None,
            stdout: String::new(),
            stderr: "function hook has no callback".to_string(),
            message: None,
            duration_ms: start.elapsed().as_millis() as u64,
            supported: true,
        }
    }
}

/// Serializable wire form for hook definitions (no callbacks).
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct HookWire {
    pub id: String,
    pub event: String,
    pub hook_type: String,
    pub matcher: Option<String>,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub timeout_ms: u64,
    pub enabled: bool,
    pub supported: bool,
}

impl From<&HookDefinition> for HookWire {
    fn from(h: &HookDefinition) -> Self {
        Self {
            id: h.id.implementation(),
            event: h.event.as_str().to_string(),
            hook_type: h.hook_type.as_str().to_string(),
            matcher: h.matcher.implementation(),
            command: h.command.implementation(),
            args: h.args.implementation(),
            env: h.env.implementation(),
            timeout_ms: h.timeout_ms,
            enabled: h.enabled,
            supported: h.hook_type.supported(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ctx(event: HookEvent) -> HookContext {
        HookContext {
            event,
            session_id: "s1".into(),
            tool_name: Some("shell".into()),
            tool_input: Some(serde_json::json!({"command": "echo hi"})),
            tool_output: None,
            is_error: false,
            cwd: PathBuf::from("/tmp"),
            extra: HashMap::new(),
        }
    }

    #[test]
    fn event_roundtrip() {
        for e in HookEvent::all() {
            assert_eq!(HookEvent::parse(e.as_str()), Some(*e));
        }
        assert_eq!(HookEvent::all().len(), 26);
    }

    #[test]
    fn hook_type_support() {
        assert!(HookType::Command.supported());
        assert!(HookType::Function.supported());
        assert!(!HookType::Prompt.supported());
        assert!(!HookType::Http.supported());
        assert!(!HookType::Agent.supported());
    }

    #[test]
    fn matcher_matches_cases() {
        assert!(matcher_matches("*", "shell"));
        assert!(matcher_matches("shell", "shell"));
        assert!(matcher_matches("sh*", "shell"));
        assert!(matcher_matches("*ell", "shell"));
        assert!(!matcher_matches("read_file", "shell"));
    }

    #[test]
    fn function_hook_blocks() {
        let engine = HooksEngine::new();
        engine.add(HookDefinition::function("f1", HookEvent::PreToolUse, |c| {
            let blocked = c.tool_name.as_deref() == Some("shell");
            HookResult {
                hook_id: "f1".into(),
                blocked,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: Some("checked".into()),
                duration_ms: 0,
                supported: true,
            }
        }));
        let r = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(engine.run(&ctx(HookEvent::PreToolUse)));
        assert_eq!(r.len(), 1);
        assert!(r[0].blocked);
        assert!(HooksEngine::is_blocked(&r));
    }

    #[test]
    fn matcher_filters_hooks() {
        let engine = HooksEngine::new();
        engine.add(
            HookDefinition::function("only_read", HookEvent::PreToolUse, |_| HookResult {
                hook_id: "only_read".into(),
                blocked: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: None,
                duration_ms: 0,
                supported: true,
            })
            .with_matcher("read_file"),
        );
        // tool_name is "shell" in ctx, so hook should not run.
        let r = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(engine.run(&ctx(HookEvent::PreToolUse)));
        assert!(r.is_empty());
    }

    #[test]
    fn unsupported_hook_type_reports() {
        let engine = HooksEngine::new();
        let mut h = HookDefinition::command("p1", HookEvent::PreToolUse, "true");
        h.hook_type = HookType::Prompt;
        h.command = None;
        engine.add(h);
        let r = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(engine.run(&ctx(HookEvent::PreToolUse)));
        assert_eq!(r.len(), 1);
        assert!(!r[0].supported);
    }

    #[tokio::test]
    async fn command_hook_exit_2_blocks() {
        let engine = HooksEngine::new();
        engine.add(
            HookDefinition::command("c1", HookEvent::PreToolUse, "sh")
                .with_args(vec!["-c".into(), "exit 2".into()]),
        );
        let r = engine.run(&ctx(HookEvent::PreToolUse)).await;
        assert_eq!(r.len(), 1);
        assert!(r[0].blocked);
        assert_eq!(r[0].exit_code, Some(2));
    }

    #[tokio::test]
    async fn command_hook_exit_0_does_not_block() {
        let engine = HooksEngine::new();
        engine.add(
            HookDefinition::command("c2", HookEvent::PreToolUse, "sh")
                .with_args(vec!["-c".into(), "echo ok; exit 0".into()]),
        );
        let r = engine.run(&ctx(HookEvent::PreToolUse)).await;
        assert_eq!(r.len(), 1);
        assert!(!r[0].blocked);
        assert!(r[0].stdout.contains("ok"));
    }

    #[tokio::test]
    async fn command_hook_timeout_blocks() {
        let engine = HooksEngine::new();
        engine.add(
            HookDefinition::command("c3", HookEvent::PreToolUse, "sh")
                .with_args(vec!["-c".into(), "sleep 5".into()])
                .with_timeout(50),
        );
        let r = engine.run(&ctx(HookEvent::PreToolUse)).await;
        assert_eq!(r.len(), 1);
        assert!(r[0].blocked);
        assert!(r[0].stderr.contains("timed out"));
    }

    #[tokio::test]
    async fn hooks_run_in_parallel_not_sequentially() {
        // Two 250ms command hooks must complete in well under 500ms total if
        // dispatched concurrently; sequential execution would take >= 500ms.
        let engine = HooksEngine::new();
        for id in ["sl1", "sl2"] {
            engine.add(
                HookDefinition::command(id, HookEvent::SessionStart, "sh")
                    .with_args(vec!["-c".into(), "sleep 0.25".into()]),
            );
        }
        let start = Instant::now();
        let r = engine.run(&ctx(HookEvent::SessionStart)).await;
        let elapsed = start.elapsed();
        assert_eq!(r.len(), 2);
        assert!(r.iter().all(|h| h.exit_code == Some(0)));
        assert!(
            elapsed < std::time::Duration::from_millis(450),
            "hooks must dispatch in parallel; took {elapsed:?}"
        );
    }

    #[test]
    fn remove_hook() {
        let engine = HooksEngine::new();
        engine.add(HookDefinition::function("x", HookEvent::Stop, |_| {
            HookResult {
                hook_id: "x".into(),
                blocked: false,
                exit_code: None,
                stdout: String::new(),
                stderr: String::new(),
                message: None,
                duration_ms: 0,
                supported: true,
            }
        }));
        assert!(engine.remove("x"));
        assert!(!engine.remove("x"));
        assert!(engine.list().is_empty());
    }

    #[test]
    fn wire_form() {
        let h = HookDefinition::command("w", HookEvent::PostToolUse, "echo");
        let w = HookWire::from(&h);
        assert_eq!(w.event, "PostToolUse");
        assert_eq!(w.hook_type, "command");
        assert!(w.supported);
    }
}
