//! Product Builder pipeline: stages Concept -> Clarify -> Specify -> Plan ->
//! Build-with-gates, orchestrated over the existing AgentRunner.

use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

#[derive(Debug, Clone)]
pub enum StageEventKind {
    Started,
    Question { text: String },
    Artifact { name: String },
    GateWait { gate: String },
    GatePassed,
    Failed { error: String },
}

#[derive(Debug, Clone)]
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
}
