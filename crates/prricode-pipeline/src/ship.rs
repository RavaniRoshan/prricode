//! The Ship stage: release the built workspace, then the deploy half the
//! operator drives, then one operate pass.
//!
//! The stage has two halves. The ship half is one call —
//! [`run_ship_stage`]: it stages the acceptance dossier into the worktree,
//! tags the release, writes the install artifacts, and records the
//! `ShipRecord`. The deploy half is a step-driven state machine
//! ([`ShipFlow`]) because it waits on the operator: the flow proposes a
//! target, waits for the choice, asks for each credential the plan names,
//! waits for its value, and only then runs the deploy commands. Nothing in
//! the flow blocks on operator input; the caller (TUI or server) advances
//! it with [`ShipFlow::poll`] and answers with
//! [`ShipFlow::confirm_deploy`] / [`ShipFlow::provide_secret`].
//!
//! Secrets hygiene: the collected values live in the flow's in-memory map
//! and reach the deploy commands as child-process environment variables
//! only. They are never written to a setting, the operate log, or any
//! other record. The operate log records that a deploy happened — the
//! target, its outcome, the release id, the rollback hint — never the
//! commands' output.

/// Events the ship stage produces for the TUI rail.
#[derive(Debug, Implementation, PartialEq, Eq)]
pub enum ShipEventKind {
    /// The workspace shipped: its tag and how many install steps it carries.
    ShipReady { tag: String, install_steps: usize },
    /// A deploy plan is on the table, waiting for the operator's choice.
    DeployProposed {
        target: String,
        credentials: Vec<String>,
    },
    /// One credential the confirmed plan needs, waiting for its value.
    DeploySecretRequested {
        name: String,
        purpose: String,
        secret: bool,
    },
    /// The deploy commands finished.
    DeployDone { ok: bool },
    /// A health probe passed.
    HealthOk { name: String },
    /// A health probe failed, with the reopened issue's url when one was
    /// opened (a workspace with no GitHub remote opens none).
    HealthFailed { name: String, issue: Option<String> },
}

/// Where the deploy half of the stage is.
#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum ShipStage {
    /// The plan is proposed; the operator's choice is outstanding.
    DeployWait,
    /// The deploy was confirmed; one credential value is outstanding.
    SecretWait,
    /// Every credential is in; the deploy commands run next.
    DeployRun,
    /// The deploy finished; one health pass runs next.
    Operate,
    /// The stage is finished (deployed, declined, or failed).
    Done,
}

impl ShipStage {
    pub fn label(&self) -> &'static str {
        match self {
            Self::DeployWait => "deploy-wait",
            Self::SecretWait => "deploy-secret",
            Self::DeployRun => "deploy-run",
            Self::Operate => "operate",
            Self::Done => "done",
        }
    }
}
