//! Approval engine: gates Sensitive tool calls according to the session's
//! approval mode and tracks pending decisions that the client answers via
//! `approval/decide`.

use prricode_core::ApprovalMode;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::{AgentEvent, Risk};
use crate::tools::ToolOutput;
use prricode_provider::ContentPart;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Denied,
    /// The waiting approval never got an answer before the timeout elapsed,
    /// so it resolved as a denial whose reason is `timed_out`.
    TimedOut,
}

#[derive(Debug, Clone)]
pub struct ApprovalOutcome {
    pub approved: bool,
    pub approval_id: Option<String>,
}

struct Pending {
    session_id: String,
    requirement_id: String,
    kind: String,
    summary: Value,
    sender: oneshot::Sender<ApprovalDecision>,
}

pub struct ApprovalEngine {
    pending: Mutex<HashMap<String, Pending>>,
    events: Option<tokio::sync::mpsc::UnboundedSender<AgentEvent>>,
    /// How long a pending approval waits for a decision before it resolves as
    /// denied with reason `timed_out`.
    timeout: Duration,
}

impl Default for ApprovalEngine {
    fn default() -> Self {
        Self::new()
    }
}

/// The approval timeout from the environment: `PRRICODE_APPROVAL_TIMEOUT_SECS`
/// seconds, or the default of ten minutes when it is unset or unparseable.
fn approval_timeout_from_env() -> Duration {
    let secs = std::env::var("PRRICODE_APPROVAL_TIMEOUT_SECS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(600);
    Duration::from_secs(secs)
}

impl ApprovalEngine {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            events: None,
            timeout: approval_timeout_from_env(),
        }
    }

    /// Override the approval timeout (ignores the environment). Used by tests
    /// to force a fast timeout.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_events(mut self, events: tokio::sync::mpsc::UnboundedSender<AgentEvent>) -> Self {
        self.events = Some(events);
        self
    }

    fn needs_prompt(risk: Risk, mode: ApprovalMode) -> bool {
        match mode {
            ApprovalMode::Open => false,
            ApprovalMode::Closed | ApprovalMode::Auto | ApprovalMode::Suggestive => {
                risk == Risk::Sensitive
            }
        }
    }

    fn is_suggestive(mode: ApprovalMode) -> bool {
        matches!(mode, ApprovalMode::Suggestive)
    }

    /// Ask the engine whether a call may proceed. Sensitive calls in
    /// Closed/Auto/Suggestive modes produce a pending approval and wait for
    /// the client's `approval/decide`.
    pub async fn authorize(
        &self,
        session_id: &str,
        requirement_id: &str,
        kind: &str,
        summary: Value,
        risk: Risk,
        mode: ApprovalMode,
    ) -> ApprovalOutcome {
        if !Self::needs_prompt(risk, mode) {
            return ApprovalOutcome {
                approved: true,
                approval_id: None,
            };
        }
        if Self::is_suggestive(mode) {
            // Suggestive never executes sensitive calls; the loop turns the
            // call into a suggestion instead.
            return ApprovalOutcome {
                approved: false,
                approval_id: None,
            };
        }

        let approval_id = Uuid::now_v7().to_string();
        let (tx, rx) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(
                approval_id.clone(),
                Pending {
                    session_id: session_id.to_string(),
                    requirement_id: requirement_id.to_string(),
                    kind: kind.to_string(),
                    summary: summary.clone(),
                    sender: tx,
                },
            );
        }
        if let Some(events) = &self.events {
            let _ = events.send(AgentEvent::ApprovalRequested {
                approval_id: approval_id.clone(),
                session_id: session_id.to_string(),
                requirement_id: requirement_id.to_string(),
                kind: kind.to_string(),
                summary,
            });
        }
        // Wait for the client's decision, but only up to the configured
        // timeout: a pending approval that nobody answers resolves as denied
        // with reason `timed_out` rather than waiting forever.
        let decision = match tokio::time::timeout(self.timeout, rx).await {
            Ok(Ok(decision)) => decision,
            // The answer channel closed without a decision (the flow was
            // dropped): a plain denial.
            Ok(Err(_)) => ApprovalDecision::Denied,
            // No decision arrived in time.
            Err(_) => ApprovalDecision::TimedOut,
        };
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&approval_id);
        }
        let approved = decision == ApprovalDecision::Approved;
        if let Some(events) = &self.events {
            let _ = events.send(AgentEvent::ApprovalResolved {
                approval_id: approval_id.clone(),
                session_id: session_id.to_string(),
                approved,
            });
        }
        ApprovalOutcome {
            approved,
            approval_id: Some(approval_id),
        }
    }

    /// Answer a pending approval.
    pub fn decide(&self, approval_id: &str, approved: bool) -> bool {
        let sender = {
            let mut pending = match self.pending.lock() {
                Ok(p) => p,
                Err(_) => return false,
            };
            pending.remove(approval_id).map(|p| p.sender)
        };
        match sender {
            Some(sender) => {
                let decision = if approved {
                    ApprovalDecision::Approved
                } else {
                    ApprovalDecision::Denied
                };
                sender.send(decision).is_ok()
            }
            None => false,
        }
    }

    pub fn list_pending(&self, session_id: &str) -> Vec<Value> {
        let pending = match self.pending.lock() {
            Ok(p) => p,
            Err(_) => return Vec::new(),
        };
        pending
            .iter()
            .filter(|(_, p)| p.session_id == session_id)
            .map(|(id, p)| {
                json!({
                    "approvalId": id,
                    "requirementId": p.requirement_id,
                    "kind": p.kind,
                    "summary": p.summary,
                    "sessionId": p.session_id,
                })
            })
            .collect()
    }

    pub fn resolve_suggestive(&self, output: ToolOutput, summary: &str) -> ToolOutput {
        let suggestion = summary.to_string();
        ToolOutput {
            content: vec![
                ContentPart::text(format!(
                    "[suggestion only — not executed under suggestive approval]\n{suggestion}"
                )),
                ContentPart::text(format!(
                    "the call would have produced:\n{}",
                    super::text_of(&output.content)
                )),
            ],
            is_error: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sensitive_summary() -> Value {
        json!({ "tool": "shell", "summary": "run shell command: echo hi" })
    }

    #[test]
    fn the_default_approval_timeout_is_ten_minutes() {
        // The fallback applies when the env var is unset (tests never set it).
        if std::env::var("PRRICODE_APPROVAL_TIMEOUT_SECS").is_err() {
            assert_eq!(approval_timeout_from_env(), Duration::from_secs(600));
        }
    }

    #[tokio::test]
    async fn a_pending_approval_times_out_as_denied() {
        let engine = ApprovalEngine::new().with_timeout(Duration::from_millis(50));
        // A sensitive shell call in Closed mode opens a pending approval that
        // nobody answers; it resolves as denied once the timeout elapses.
        let outcome = engine
            .authorize(
                "session-timeout",
                "req-1",
                "shell",
                sensitive_summary(),
                Risk::Sensitive,
                ApprovalMode::Closed,
            )
            .await;
        assert!(
            !outcome.approved,
            "a timed-out approval must resolve as denied"
        );
        assert!(outcome.approval_id.is_some());
        // The pending map is cleaned up after the timeout.
        assert!(engine.list_pending("session-timeout").is_empty());
    }

    #[tokio::test]
    async fn an_explicit_denial_resolves_before_the_long_timeout() {
        let engine =
            std::sync::Arc::new(ApprovalEngine::new().with_timeout(Duration::from_secs(30)));
        let job = {
            let engine = std::sync::Arc::clone(&engine);
            tokio::spawn(async move {
                engine
                    .authorize(
                        "session-deny",
                        "req-1",
                        "shell",
                        sensitive_summary(),
                        Risk::Sensitive,
                        ApprovalMode::Closed,
                    )
                    .await
            })
        };
        // Wait for the pending approval to register, then deny it explicitly.
        let approval_id = loop {
            let pending = engine.list_pending("session-deny");
            if let Some(first) = pending.first() {
                break first
                    .get("approvalId")
                    .and_then(|id| id.as_str())
                    .unwrap()
                    .to_string();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        };
        assert!(engine.decide(&approval_id, false));
        let outcome = job.await.unwrap();
        assert!(!outcome.approved, "an explicit denial resolves as denied");
        assert!(engine.list_pending("session-deny").is_empty());
    }
}
