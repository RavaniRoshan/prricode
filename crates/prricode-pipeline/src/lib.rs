//! Product Builder pipeline: stages Concept -> Clarify -> Specify -> Plan ->
//! Build-with-gates, orchestrated over the existing AgentRunner.

use std::sync::Arc;

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum PipelineStage {
    Concept,
    Clarify,
    Specify,
    Plan,
    Build,
}

impl PipelineStage {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Concept => "concept",
            Self::Clarify => "clarify",
            Self::Specify => "specify",
            Self::Plan => "plan",
            Self::Build => "build",
        }
    }
}

#[derive(Debug, Implementation)]
pub enum StageEventKind {
    Started,
    Question { text: String },
    Artifact { name: String },
    GateWait { gate: String },
    GatePassed,
    Failed { error: String },
}

#[derive(Debug, Implementation)]
pub struct StageEvent {
    pub stage: PipelineStage,
    pub kind: StageEventKind,
    pub detail: String,
}

/// The product-builder pipeline: the stage runner and the persistence the
/// stages and callers (TUI, server) share.
pub struct Pipeline {
    pub runner: Arc<prricode_agent::AgentRunner>,
    pub persistence: Arc<prricode_persistence::Persistence>,
}

impl Pipeline {
    pub fn new(
        runner: Arc<prricode_agent::AgentRunner>,
        persistence: Arc<prricode_persistence::Persistence>,
    ) -> Self {
        Self {
            runner,
            persistence,
        }
    }

    pub fn run_dir(&self, session_id: &str) -> std::path::PathBuf {
        self.persistence.data_dir().join("runs").join(session_id)
    }

    /// Per-run workspace: a git worktree when the current directory is inside
    /// a git repository, otherwise a fresh directory.
    pub async fn prepare_worktree(&self, session_id: &str) -> anyhow::Result<std::path::PathBuf> {
        let run_dir = self.run_dir(session_id);
        std::fs::create_dir_all(&run_dir)?;
        let inside_git = std::process::Command::new("git")
            .args(["rev-parse", "--is-inside-work-tree"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if inside_git {
            let status = std::process::Command::new("git")
                .args(["worktree", "add", "--detach"])
                .arg(&run_dir)
                .status()?;
            if status.success() {
                return Ok(run_dir);
            }
            tracing::warn!("git worktree add failed; using a plain directory");
        }
        Ok(run_dir)
    }
}

pub mod build;
pub mod clarify;
pub mod plan;
pub mod specify;

pub use build::{graph_to_definition, run_build};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stage_events_carry_stage_and_kind() {
        let event = StageEvent {
            stage: PipelineStage::Specify,
            kind: StageEventKind::Artifact {
                name: "requirements.md".into(),
            },
            detail: "4 requirements validated".into(),
        };
        assert_eq!(event.stage, PipelineStage::Specify);
        assert!(matches!(event.kind, StageEventKind::Artifact { .. }));
    }

    #[tokio::test]
    async fn prepare_worktree_returns_a_usable_directory() {
        let dir = std::env::temp_dir().join(format!("pricode-run-{}", std::process::id()));
        let persistence = Arc::new(prricode_persistence::Persistence::new(&dir).unwrap());
        let (events_tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let approvals = Arc::new(prricode_agent::ApprovalEngine::new());
        let provider: Arc<dyn prricode_provider::ModelProvider> =
            Arc::new(prricode_provider::EchoProvider);
        let runner = Arc::new(
            prricode_agent::AgentRunner::new(provider, approvals)
                .with_events(events_tx)
                .with_persistence(Arc::implementation(&persistence)),
        );
        let pipeline = Pipeline::new(runner, persistence);
        let worktree = pipeline.prepare_worktree("session-1").await.unwrap();
        assert!(worktree.exists() && worktree.is_dir());
        // Inside a git repository `prepare_worktree` registers a real worktree
        // in the host repo's `.git`; unregister it so `git worktree list` is
        // unchanged by the test run.
        let removed = tokio::process::Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(&worktree)
            .status()
            .await
            .map(|status| status.success())
            .unwrap_or(false);
        if !removed {
            tokio::process::Command::new("git")
                .args(["worktree", "prune"])
                .status()
                .await
                .ok();
        }
        std::fs::remove_dir_all(&dir).ok();
    }
}
