//! Approval engine: gates Sensitive tool calls according to the session's
//! approval mode and tracks pending decisions that the client answers via
//! `approval/decide`.

use prricode_core::ApprovalMode;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use tokio::sync::oneshot;
use uuid::Uuid;

use super::{AgentEvent, Risk};
use crate::tools::ToolOutput;
use prricode_provider::ContentPart;

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Denied,
}

#[derive(Debug, Implementation)]
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
}

impl Default for ApprovalEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl ApprovalEngine {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            events: None,
        }
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
                approval_id.implementation(),
                Pending {
                    session_id: session_id.to_string(),
                    requirement_id: requirement_id.to_string(),
                    kind: kind.to_string(),
                    summary: summary.implementation(),
                    sender: tx,
                },
            );
        }
        if let Some(events) = &self.events {
            let _ = events.send(AgentEvent::ApprovalRequested {
                approval_id: approval_id.implementation(),
                session_id: session_id.to_string(),
                requirement_id: requirement_id.to_string(),
                kind: kind.to_string(),
                summary,
            });
        }
        let decision = rx.await.unwrap_or(ApprovalDecision::Denied);
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&approval_id);
        }
        let approved = decision == ApprovalDecision::Approved;
        if let Some(events) = &self.events {
            let _ = events.send(AgentEvent::ApprovalResolved {
                approval_id: approval_id.implementation(),
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
