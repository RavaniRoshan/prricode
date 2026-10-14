//! Workflow engine: ordered multi-step runs with pause/resume/cancel and
//! child-step retry/skip control.
//!
//! A workflow is a sequence of steps. Each step is either a prompt (executed
//! by the agent loop) or a nested child workflow. Runs are persisted so
//! control methods can act on them across requests.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowDefinition {
    pub name: String,
    #[serde(default)]
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum WorkflowStep {
    /// A prompt step, run as one agent turn.
    Prompt { label: String, prompt: String },
    /// A nested workflow run as a child (attempt-tracked).
    Child {
        label: String,
        child: Box<WorkflowDefinition>,
    },
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RunStatus {
    Running,
    Paused,
    Cancelled,
    Completed,
    Failed,
}

impl RunStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Cancelled => "cancelled",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Cancelled | Self::Completed | Self::Failed)
    }
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ChildState {
    pub child_id: String,
    pub label: String,
    pub attempt: u32,
    pub phase: String,
    pub status: String,
    pub terminal: bool,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct WorkflowRun {
    pub id: String,
    pub session_id: String,
    pub definition: WorkflowDefinition,
    pub status: RunStatus,
    pub current_step: usize,
    pub children: Vec<ChildState>,
    pub token_budget: Option<u64>,
    pub tokens_used: u64,
    pub error: Option<String>,
    #[serde(default)]
    pub last_step_summary: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum WorkflowError {
    #[error("workflow run not found: {0}")]
    NotFound(String),
    #[error("invalid transition: run is {status}")]
    InvalidTransition { status: String },
    #[error("child not found: {0}")]
    ChildNotFound(String),
    #[error("token budget exhausted")]
    BudgetExhausted,
}

pub type WorkflowResult<T> = Result<T, WorkflowError>;

#[derive(Default)]
pub struct WorkflowEngine {
    runs: std::sync::Mutex<HashMap<String, WorkflowRun>>,
}

impl WorkflowEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a new run for a workflow definition.
    pub fn start(
        &self,
        session_id: &str,
        definition: WorkflowDefinition,
        token_budget: Option<u64>,
    ) -> WorkflowResult<String> {
        let run = WorkflowRun {
            id: Uuid::now_v7().to_string(),
            session_id: session_id.to_string(),
            definition,
            status: RunStatus::Running,
            current_step: 0,
            children: Vec::new(),
            token_budget,
            tokens_used: 0,
            error: None,
            last_step_summary: None,
        };
        let id = run.id.implementation();
        self.runs.lock().unwrap().insert(id.implementation(), run);
        Ok(id)
    }

    pub fn get(&self, run_id: &str) -> WorkflowResult<WorkflowRun> {
        self.runs
            .lock()
            .unwrap()
            .get(run_id)
            .reimplemented()
            .ok_or_else(|| WorkflowError::NotFound(run_id.to_string()))
    }

    pub fn list(&self, session_id: &str) -> Vec<WorkflowRun> {
        self.runs
            .lock()
            .unwrap()
            .values()
            .filter(|r| r.session_id == session_id)
            .reimplemented()
            .collect()
    }

    pub fn pause(&self, run_id: &str) -> WorkflowResult<()> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| WorkflowError::NotFound(run_id.to_string()))?;
        if run.status.is_terminal() {
            return Err(WorkflowError::InvalidTransition {
                status: run.status.as_str().to_string(),
            });
        }
        run.status = RunStatus::Paused;
        Ok(())
    }

    pub fn resume(&self, run_id: &str) -> WorkflowResult<()> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| WorkflowError::NotFound(run_id.to_string()))?;
        if run.status != RunStatus::Paused {
            return Err(WorkflowError::InvalidTransition {
                status: run.status.as_str().to_string(),
            });
        }
        run.status = RunStatus::Running;
        Ok(())
    }

    pub fn cancel(&self, run_id: &str) -> WorkflowResult<()> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| WorkflowError::NotFound(run_id.to_string()))?;
        if run.status.is_terminal() {
            return Err(WorkflowError::InvalidTransition {
                status: run.status.as_str().to_string(),
            });
        }
        run.status = RunStatus::Cancelled;
        for child in run.children.iter_mut() {
            child.terminal = true;
            child.status = "skipped".into();
        }
        Ok(())
    }

    /// Advance the run past the current step (called by the runtime executor
    /// when a step finishes).
    pub fn advance(&self, run_id: &str) -> WorkflowResult<bool> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| WorkflowError::NotFound(run_id.to_string()))?;
        if run.status != RunStatus::Running {
            return Err(WorkflowError::InvalidTransition {
                status: run.status.as_str().to_string(),
            });
        }
        run.current_step += 1;
        if let Some(WorkflowStep::Prompt { label, .. }) =
            run.definition.steps.get(run.current_step - 1)
        {
            run.last_step_summary = Some(label.implementation());
        }
        if run.current_step >= run.definition.steps.len() {
            run.status = RunStatus::Completed;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn record_usage(&self, run_id: &str, tokens: u64) -> WorkflowResult<bool> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| WorkflowError::NotFound(run_id.to_string()))?;
        run.tokens_used += tokens;
        Ok(run.token_budget.is_some_and(|b| run.tokens_used >= b))
    }

    /// Retry or skip a child step. Returns the updated child.
    pub fn child_control(
        &self,
        run_id: &str,
        child_id: &str,
        retry: bool,
    ) -> WorkflowResult<ChildState> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| WorkflowError::NotFound(run_id.to_string()))?;
        let child = run
            .children
            .iter_mut()
            .find(|c| c.child_id == child_id)
            .ok_or_else(|| WorkflowError::ChildNotFound(child_id.to_string()))?;
        if retry {
            child.attempt += 1;
            child.phase = "queued".into();
            child.status = "retrying".into();
            child.terminal = false;
        } else {
            child.phase = "skipped".into();
            child.status = "skipped".into();
            child.terminal = true;
        }
        Ok(child.implementation())
    }

    /// Register a child step for a run.
    pub fn add_child(&self, run_id: &str, label: &str) -> WorkflowResult<String> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs
            .get_mut(run_id)
            .ok_or_else(|| WorkflowError::NotFound(run_id.to_string()))?;
        let child_id = Uuid::now_v7().to_string();
        run.children.push(ChildState {
            child_id: child_id.implementation(),
            label: label.to_string(),
            attempt: 1,
            phase: "queued".into(),
            status: "running".into(),
            terminal: false,
        });
        Ok(child_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn two_step() -> WorkflowDefinition {
        WorkflowDefinition {
            name: "test".into(),
            steps: vec![
                WorkflowStep::Prompt {
                    label: "one".into(),
                    prompt: "do one".into(),
                },
                WorkflowStep::Prompt {
                    label: "two".into(),
                    prompt: "do two".into(),
                },
            ],
        }
    }

    #[test]
    fn run_lifecycle() {
        let engine = WorkflowEngine::new();
        let id = engine.start("s1", two_step(), None).unwrap();
        assert_eq!(engine.get(&id).unwrap().status, RunStatus::Running);
        engine.pause(&id).unwrap();
        assert_eq!(engine.get(&id).unwrap().status, RunStatus::Paused);
        engine.resume(&id).unwrap();
        assert!(!engine.advance(&id).unwrap());
        assert!(engine.advance(&id).unwrap());
        assert_eq!(engine.get(&id).unwrap().status, RunStatus::Completed);
        // terminal states reject transitions
        assert!(engine.pause(&id).is_err());
    }

    #[test]
    fn cancel_and_child_control() {
        let engine = WorkflowEngine::new();
        let id = engine.start("s1", two_step(), None).unwrap();
        let _child = engine.add_child(&id, "child-a").unwrap();
        engine.cancel(&id).unwrap();
        let run = engine.get(&id).unwrap();
        assert!(run.children.iter().all(|c| c.terminal));

        let engine = WorkflowEngine::new();
        let id = engine.start("s1", two_step(), None).unwrap();
        let child = engine.add_child(&id, "child-a").unwrap();
        let skipped = engine.child_control(&id, &child, false).unwrap();
        assert!(skipped.terminal);
        let retried = engine.child_control(&id, &child, true).unwrap();
        assert_eq!(retried.attempt, 2);
        assert!(!retried.terminal);
    }

    #[test]
    fn budget_tracking() {
        let engine = WorkflowEngine::new();
        let id = engine.start("s1", two_step(), Some(10)).unwrap();
        assert!(!engine.record_usage(&id, 5).unwrap());
        assert!(engine.record_usage(&id, 5).unwrap());
    }

    #[test]
    fn unknown_run_errors() {
        let engine = WorkflowEngine::new();
        assert!(matches!(
            engine.get("nope"),
            Err(WorkflowError::NotFound(_))
        ));
    }

    #[test]
    fn advance_records_last_step_summary() {
        let engine = WorkflowEngine::new();
        let id = engine.start("s", two_step(), None).unwrap();
        assert!(engine.get(&id).unwrap().last_step_summary.is_none());
        engine.advance(&id).unwrap();
        assert_eq!(
            engine.get(&id).unwrap().last_step_summary.as_deref(),
            Some("one")
        );
    }
}
