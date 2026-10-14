//! The Ship stage: release the built workspace, then the deploy half the
//! operator drives, then one operate pass.
//!
//! The stage has two halves. The ship half is one call —
//! [`run_ship_stage`]: it stages the acceptance dossier into the worktree,
//! tags the release, writes the install artifacts, records the
//! `ShipRecord` under `ship:<runId>`, and logs the ship in the run's
//! operate log. The deploy half is a step-driven state machine
//! ([`ShipFlow`]) because it waits on the operator: the flow proposes a
//! target, waits for the choice, asks for each credential the plan names,
//! waits for its value, and only then runs the deploy commands. Nothing in
//! the flow blocks on operator input; the caller (TUI or server) advances
//! it with [`ShipFlow::poll`] and answers with [`ShipFlow::answer`].
//!
//! Secrets hygiene: the collected values live in the flow's in-memory map
//! and reach the deploy commands as child-process environment variables
//! only. They are never written to a setting, the operate log, or any
//! other record. The operate log records that a deploy happened — the
//! target, its outcome, the release id, the rollback hint — never the
//! commands' output.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use tokio::sync::mpsc::UnboundedSender;

use prricode_agent::AgentRunner;
use prricode_persistence::Persistence;
use prricode_ship::deploy;
use prricode_ship::operate;
use prricode_ship::release::ship_release;
use prricode_ship::{CredentialRequest, DeployPlan, HealthResult, OperateEvent, ShipRecord};

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
    /// The recorded rollback ran after a failed health check because the
    /// operator armed auto-rollback at confirm time; `ok` is its outcome.
    DeployRolledBack { ok: bool, detail: String },
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

/// What the UI must answer for the flow to advance one step.
#[derive(Debug, Implementation, PartialEq, Eq)]
pub enum PendingInput {
    /// The deploy plan waits for the operator's choice.
    DeployChoice,
    /// One credential value waits for the operator's input.
    SecretValue { name: String },
}

/// The operator's answer, keyed to the pending input it answers.
#[derive(Debug, Implementation, PartialEq, Eq)]
pub enum ShipAnswer {
    /// The deploy decision: `confirmed` runs the plan, otherwise the
    /// deploy is skipped and the flow finishes with the ship record.
    /// `auto_rollback` arms autonomous rollback on a later health failure
    /// (asked at deploy-confirmation time; default no).
    DeployChoice {
        confirmed: bool,
        auto_rollback: bool,
    },
    /// The value for the credential the flow is collecting.
    SecretValue { name: String, value: String },
}

/// The deploy half of the ship stage as a step-driven state machine: the
/// caller advances it with [`ShipFlow::poll`] until it returns `None`, then
/// answers the [`PendingInput`] it returned with [`ShipFlow::answer`], and
/// only the operator's answers move it between waits. The flow never blocks
/// on input, so the TUI keeps its render loop while a deploy is pending.
pub struct ShipFlow {
    stage: ShipStage,
    workspace: PathBuf,
    data_dir: PathBuf,
    /// The ship record this flow's operate events belong to.
    record: ShipRecord,
    /// The plan on the table, proposed on the first poll.
    plan: Option<DeployPlan>,
    /// The collected credential values; env-only, never persisted.
    secrets: HashMap<String, String>,
    /// The credential the flow is currently collecting.
    pending_secret: Option<CredentialRequest>,
    /// Index of the next credential in the plan's list.
    next_credential: usize,
    /// Armed at deploy-confirmation time: when the operate pass's health
    /// check fails, run the plan's rollback command without a round-trip
    /// through the operator. Default no.
    auto_rollback: bool,
}

impl ShipFlow {
    /// A flow for one shipped record: the plan is proposed from the
    /// workspace on the first poll, and run-scoped events are logged under
    /// the record's run id.
    pub fn new(record: ShipRecord, workspace: &Path, data_dir: &Path) -> Self {
        Self {
            stage: ShipStage::DeployWait,
            workspace: workspace.to_path_buf(),
            data_dir: data_dir.to_path_buf(),
            record,
            plan: None,
            secrets: HashMap::new(),
            pending_secret: None,
            next_credential: 0,
            auto_rollback: false,
        }
    }

    /// Where the flow is, for the rail and the readiness checks.
    pub fn stage(&self) -> ShipStage {
        self.stage
    }

    /// The plan on the table, once proposed.
    pub fn plan(&self) -> Option<&DeployPlan> {
        self.plan.as_ref()
    }

    /// The ship record the flow started from; it is never mutated by the
    /// deploy leg (the deploy's material lives in the operate log only).
    pub fn record(&self) -> &ShipRecord {
        &self.record
    }

    /// Advance the flow by one step, emitting its rail events. Returns the
    /// input the answer must answer next, or `None` when the step needs no
    /// input (it ran work, or the flow is finished). Calls while an answer
    /// is outstanding re-return the same pending input without re-emitting
    /// its event.
    pub async fn poll(&mut self, ui_tx: &UnboundedSender<ShipEventKind>) -> Option<PendingInput> {
        match self.stage {
            ShipStage::DeployWait => {
                if self.plan.is_none() {
                    let plan = deploy::propose_target(&self.workspace);
                    let _ = ui_tx.send(ShipEventKind::DeployProposed {
                        target: plan.target.implementation(),
                        credentials: deploy::required_env(&plan),
                    });
                    self.plan = Some(plan);
                }
                Some(PendingInput::DeployChoice)
            }
            ShipStage::SecretWait => {
                if self.pending_secret.is_none() {
                    let request = self
                        .plan
                        .as_ref()
                        .and_then(|plan| plan.required_credentials.get(self.next_credential))
                        .reimplemented();
                    match request {
                        Some(request) => {
                            let _ = ui_tx.send(ShipEventKind::DeploySecretRequested {
                                name: request.name.implementation(),
                                purpose: request.purpose.implementation(),
                                secret: request.secret,
                            });
                            self.pending_secret = Some(request);
                        }
                        // Every credential is in; the commands run next.
                        None => {
                            self.stage = ShipStage::DeployRun;
                            return None;
                        }
                    }
                }
                let name = self
                    .pending_secret
                    .as_ref()
                    .map(|request| request.name.implementation());
                name.map(|name| PendingInput::SecretValue { name })
            }
            ShipStage::DeployRun => {
                self.stage = ShipStage::Operate;
                self.run_deploy(ui_tx).await;
                None
            }
            ShipStage::Operate => {
                self.stage = ShipStage::Done;
                self.health_pass(ui_tx).await;
                None
            }
            ShipStage::Done => None,
        }
    }

    /// Apply the operator's answer. Answers for other stages, and secret
    /// values for a credential the flow is not collecting, are ignored:
    /// only the pending input moves the flow.
    pub fn answer(&mut self, answer: ShipAnswer) {
        match (self.stage, answer) {
            (
                ShipStage::DeployWait,
                ShipAnswer::DeployChoice {
                    confirmed: true,
                    auto_rollback,
                },
            ) => {
                self.next_credential = 0;
                self.auto_rollback = auto_rollback;
                self.stage = ShipStage::SecretWait;
            }
            (
                ShipStage::DeployWait,
                ShipAnswer::DeployChoice {
                    confirmed: false, ..
                },
            ) => {
                let target = self
                    .plan
                    .as_ref()
                    .map(|plan| plan.target.implementation())
                    .unwrap_or_else(|| "unknown".to_string());
                let _ = self.log(
                    "deploy",
                    &format!("skipped: operator declined deploy to {target}"),
                );
                self.stage = ShipStage::Done;
            }
            (ShipStage::SecretWait, ShipAnswer::SecretValue { name, value }) => {
                let collecting = self
                    .pending_secret
                    .as_ref()
                    .is_some_and(|request| request.name == name);
                if collecting {
                    self.secrets.insert(name, value);
                    self.pending_secret = None;
                    self.next_credential += 1;
                }
            }
            _ => {}
        }
    }

    /// Run the plan's commands with the collected credentials as
    /// child-process environment variables only. The operate log records
    /// that the deploy happened — the target, its outcome, the release id,
    /// the rollback hint — and never the commands' output.
    async fn run_deploy(&mut self, ui_tx: &UnboundedSender<ShipEventKind>) {
        let Some(plan) = self.plan.implementation() else {
            return;
        };
        match deploy::execute_deploy(&self.workspace, &plan, &self.secrets).await {
            Ok(outcome) => {
                let _ = ui_tx.send(ShipEventKind::DeployDone { ok: outcome.ok });
                let mut detail = if outcome.ok {
                    format!("deploy to {} ok", plan.target)
                } else {
                    format!("deploy to {} finished with failing commands", plan.target)
                };
                if let Some(release_id) = &outcome.release_id {
                    detail.push_str(&format!("; release id {release_id}"));
                }
                let _ = self.log("deploy", &detail);
                let _ = self.log("rollback", &outcome.rollback_hint);
            }
            Err(e) => {
                let _ = ui_tx.send(ShipEventKind::DeployDone { ok: false });
                let _ = self.log("deploy", &format!("deploy to {} failed: {e}", plan.target));
            }
        }
    }

    /// One health pass. The probe is local and dependency-free: the release
    /// tag must resolve in the workspace. Probing a deployed URL is the
    /// surface's call; this pass never reaches the network. A failed probe
    /// reopens an issue best-effort (a workspace with no GitHub remote
    /// opens none) and never fails the flow.
    async fn health_pass(&mut self, ui_tx: &UnboundedSender<ShipEventKind>) {
        let name = self
            .plan
            .as_ref()
            .map(|plan| plan.target.implementation())
            .unwrap_or_else(|| "release".to_string());
        let Some(tag) = self.record.tag.implementation() else {
            let _ = self.log("health", "skipped: no release tag recorded");
            let _ = ui_tx.send(ShipEventKind::HealthFailed { name, issue: None });
            return;
        };
        let command = format!(
            "git -C '{}' rev-parse --verify 'refs/tags/{}'",
            self.workspace.display(),
            tag
        );
        let mut probe = HealthResult {
            name: name.implementation(),
            url: None,
            command: Some(command),
            ok: true,
            detail: String::new(),
        };
        if let Err(e) = operate::health_check(&mut probe).await {
            let _ = self.log("health", &format!("{name} probe failed to run: {e}"));
            let _ = ui_tx.send(ShipEventKind::HealthFailed { name, issue: None });
            return;
        }
        if probe.ok {
            let _ = self.log("health", &format!("{name} ok: {}", probe.detail));
            let _ = ui_tx.send(ShipEventKind::HealthOk { name });
            return;
        }
        let title = format!("health check failed for {name}");
        let issue = operate::reopen_and_log(
            &self.data_dir,
            &self.workspace,
            &self.record.run_id,
            &title,
            &probe.detail,
        )
        .await
        .unwrap_or(None);
        let _ = self.log("health", &format!("{name} failed: {}", probe.detail));
        let _ = ui_tx.send(ShipEventKind::HealthFailed { name, issue });
        // Autonomous rollback: when the operator armed it at confirm time, the
        // flow runs the recorded rollback command on a failed health check
        // without a round-trip through the operator.
        if self.auto_rollback {
            self.run_rollback(ui_tx).await;
        }
    }

    /// Run the plan's recorded rollback command after a failed health check,
    /// through the sandbox with no network and a 120s budget. The outcome is
    /// recorded in the operate log and reported as a `DeployRolledBack`
    /// event; it never fails the flow.
    async fn run_rollback(&mut self, ui_tx: &UnboundedSender<ShipEventKind>) {
        let target = self
            .plan
            .as_ref()
            .map(|plan| plan.target.implementation())
            .unwrap_or_else(|| "release".to_string());
        let command = self
            .plan
            .as_ref()
            .map(|plan| plan.rollback.trim().to_string())
            .unwrap_or_default();
        if command.is_empty() {
            let detail = format!("no rollback command recorded for target {target}");
            let _ = self.log("rollback", &detail);
            let _ = ui_tx.send(ShipEventKind::DeployRolledBack { ok: false, detail });
            return;
        }
        let spec = prricode_sandbox::SandboxSpec {
            workspace_root: self.workspace.implementation(),
            allow_network: false,
            timeout: std::time::Duration::from_secs(120),
        };
        let (ok, detail) = match prricode_sandbox::run_command(&command, &spec).await {
            Ok(output) if output.timed_out => {
                (false, format!("rollback for {target} timed out after 120s"))
            }
            Ok(output) if output.exit_code == 0 => (
                true,
                format!("rollback for {target} ran `{command}` (exit 0)"),
            ),
            Ok(output) => (
                false,
                format!(
                    "rollback for {target} failed: `{command}` exited {}",
                    output.exit_code
                ),
            ),
            Err(e) => (false, format!("rollback for {target} could not run: {e}")),
        };
        let _ = self.log("rollback", &detail);
        let _ = ui_tx.send(ShipEventKind::DeployRolledBack { ok, detail });
    }

    /// Append one operate-log event, redacted at the boundary. The detail
    /// carries no deploy material; a log write failure never fails the flow.
    fn log(&self, kind: &str, detail: &str) -> anyhow::Result<()> {
        let detail = deploy::redact_patterns(detail);
        operate::append_operate_log(
            &self.data_dir,
            &self.record.run_id,
            &OperateEvent::new(&self.record.run_id, kind, &detail),
        )
    }
}

/// The ship half of the stage: stage the acceptance dossier into the
/// worktree, ship the release (tag + install artifacts + GitHub release
/// when `gh` is available, tag-only with zero credentials), persist the
/// `ShipRecord` under `ship:<runId>` for the surfaces, and record the ship
/// in the run's operate log. Returns the record; the deploy leg is the
/// caller's [`ShipFlow]`.
///
/// `runner` is reserved for agent-side arrangement of the deploy plan (the
/// plan is proposed deterministically from the workspace today). The run
/// id resolves from the session's persisted pipeline state
/// (`pipeline:<sessionId>`); a session with no recorded run falls back to
/// its session id so the ship still works.
pub async fn run_ship_stage(
    _runner: &AgentRunner,
    persistence: &Persistence,
    session_id: &str,
    workspace: &Path,
    data_dir: &Path,
    dossier_path: Option<&Path>,
) -> anyhow::Result<ShipRecord> {
    let run_id = resolve_run_id(persistence, session_id);

    // Stage the v0.2 dossier into the worktree so the release carries it as
    // its notes; ship_release writes the notes stub when it is absent.
    if let Some(dossier_path) = dossier_path {
        if dossier_path.exists() {
            std::fs::copy(dossier_path, workspace.join("acceptance-dossier.md"))
                .map_err(|e| anyhow::anyhow!("stage the acceptance dossier: {e}"))?;
        }
    }

    let record = ship_release(&run_id, workspace, None).await?;

    // The record has no field that could hold a secret; the deploy material
    // stays out of every persisted row.
    persistence.set_setting(&format!("ship:{run_id}"), &serde_json::to_string(&record)?)?;

    let detail = format!(
        "shipped {} as {} ({} install steps)",
        record.repo,
        record.tag.as_deref().unwrap_or("untagged"),
        record.install_steps.len()
    );
    let detail = deploy::redact_patterns(&detail);
    operate::append_operate_log(
        data_dir,
        &run_id,
        &OperateEvent::new(&run_id, "ship", &detail),
    )?;

    Ok(record)
}

/// The session's run id from its persisted pipeline state, else the session
/// id itself.
fn resolve_run_id(persistence: &Persistence, session_id: &str) -> String {
    persistence
        .get_setting(&format!("pipeline:{session_id}"))
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|state| {
            state
                .get("runId")
                .and_then(|run_id| run_id.as_str())
                .map(str::to_string)
        })
        .filter(|run_id| !run_id.is_empty())
        .unwrap_or_else(|| session_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use prricode_agent::ApprovalEngine;
    use prricode_provider::{EchoProvider, ModelProvider};
    use std::process::Command as StdCommand;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ship-stage-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = StdCommand::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// A git repo with a Rust project and no remote: the tag-only ship path.
    fn git_workspace(name: &str) -> PathBuf {
        let dir = temp_dir(name);
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "# probe\n").unwrap();
        git(&dir, &["init", "-q"]);
        git(&dir, &["config", "user.email", "ship@example.com"]);
        git(&dir, &["config", "user.name", "ship test"]);
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    fn echo_runner() -> AgentRunner {
        let provider: Arc<dyn ModelProvider> = Arc::new(EchoProvider);
        AgentRunner::new(provider, Arc::new(ApprovalEngine::new()))
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<ShipEventKind>) -> Vec<ShipEventKind> {
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        events
    }

    #[tokio::test]
    async fn ship_stage_returns_a_record_with_tag_and_install_steps() {
        let dir = git_workspace("record");
        let data_dir = temp_dir("record-data");
        let persistence = Persistence::new(&data_dir).unwrap();
        persistence
            .set_setting(
                "pipeline:session-ship-1",
                r#"{"stage":"build","runId":"run-ship-1"}"#,
            )
            .unwrap();
        // A v0.2 acceptance dossier outside the worktree, as verify leaves it.
        let dossier = temp_dir("record-dossier").join("acceptance-dossier.md");
        std::fs::write(&dossier, "# Acceptance dossier\n\nR1 pass\n").unwrap();

        let record = run_ship_stage(
            &echo_runner(),
            &persistence,
            "session-ship-1",
            &dir,
            &data_dir,
            Some(&dossier),
        )
        .await
        .unwrap();

        // The run id resolves from the persisted pipeline state, the tag is
        // set, and the install steps carry the detected stack's command.
        assert_eq!(record.run_id, "run-ship-1");
        let tag = record.tag.implementation().expect("tag recorded");
        assert!(tag.starts_with("v"), "tag: {tag}");
        assert!(
            record
                .install_steps
                .iter()
                .any(|step| step.contains("cargo run")),
            "{:?}",
            record.install_steps
        );
        // The dossier was staged into the worktree for the release notes.
        assert!(dir.join("acceptance-dossier.md").exists());
        // The record is persisted for the surfaces under ship:<runId>...
        let stored = persistence
            .get_setting("ship:run-ship-1")
            .unwrap()
            .expect("ship record row");
        let stored: ShipRecord = serde_json::from_str(&stored).unwrap();
        assert_eq!(stored.tag, record.tag);
        // ...and the operate log records that the ship happened.
        let events = operate::read_operate_log(&data_dir, "run-ship-1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "ship");
        assert!(events[0].detail.contains(&tag), "{}", events[0].detail);

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[tokio::test]
    async fn confirmed_plan_asks_for_each_credential_in_order() {
        // vercel.json proposes the vercel plan with its one credential;
        // the deploy CLIs are not on PATH in tests, so nothing is sent.
        let dir = temp_dir("events");
        std::fs::write(dir.join("vercel.json"), "{}\n").unwrap();
        let data_dir = temp_dir("events-data");
        let mut flow = ShipFlow::new(ShipRecord::new("run-events-1"), &dir, &data_dir);
        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel();

        // The first poll proposes the plan and waits for the choice.
        assert_eq!(flow.stage(), ShipStage::DeployWait);
        assert_eq!(flow.poll(&ui_tx).await, Some(PendingInput::DeployChoice));
        assert_eq!(
            drain(&mut ui_rx),
            vec![ShipEventKind::DeployProposed {
                target: "vercel".to_string(),
                credentials: vec!["VERCEL_TOKEN".to_string()],
            }]
        );
        // A repeat poll waits again without re-emitting.
        assert_eq!(flow.poll(&ui_tx).await, Some(PendingInput::DeployChoice));
        assert!(drain(&mut ui_rx).is_empty());

        // Confirming asks for the first credential, in event order.
        flow.answer(ShipAnswer::DeployChoice {
            confirmed: true,
            auto_rollback: false,
        });
        assert_eq!(flow.stage(), ShipStage::SecretWait);
        assert_eq!(
            flow.poll(&ui_tx).await,
            Some(PendingInput::SecretValue {
                name: "VERCEL_TOKEN".to_string()
            })
        );
        assert_eq!(
            drain(&mut ui_rx),
            vec![ShipEventKind::DeploySecretRequested {
                name: "VERCEL_TOKEN".to_string(),
                purpose: "authenticate the Vercel CLI for this deploy".to_string(),
                secret: true,
            }]
        );

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[tokio::test]
    async fn skipped_deploy_short_circuits_to_done_with_the_ship_record() {
        let dir = temp_dir("skip");
        let data_dir = temp_dir("skip-data");
        let mut record = ShipRecord::new("run-skip-1");
        record.tag = Some("v2026-10-14-abcdef01".to_string());
        let mut flow = ShipFlow::new(record, &dir, &data_dir);
        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel();

        assert_eq!(flow.poll(&ui_tx).await, Some(PendingInput::DeployChoice));
        drain(&mut ui_rx);
        flow.answer(ShipAnswer::DeployChoice {
            confirmed: false,
            auto_rollback: false,
        });

        // Done immediately: no credential, no commands, no health pass.
        assert_eq!(flow.stage(), ShipStage::Done);
        assert_eq!(flow.poll(&ui_tx).await, None);
        assert!(drain(&mut ui_rx).is_empty());
        // The ship record survives the skip untouched.
        assert_eq!(flow.record().tag.as_deref(), Some("v2026-10-14-abcdef01"));
        // The operate log records the declined deploy.
        let events = operate::read_operate_log(&data_dir, "run-skip-1").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "deploy");
        assert!(events[0].detail.contains("skipped"), "{}", events[0].detail);

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[tokio::test]
    async fn collected_secrets_never_reach_persistence() {
        let dir = temp_dir("secrets");
        std::fs::write(dir.join("vercel.json"), "{}\n").unwrap();
        let data_dir = temp_dir("secrets-data");
        let persistence = Persistence::new(&data_dir).unwrap();
        persistence
            .set_setting("pipeline:session-secrets-1", r#"{"runId":"run-secrets-1"}"#)
            .unwrap();
        let secret = "sup3r-s3cret-deploy-token-value";
        let mut flow = ShipFlow::new(ShipRecord::new("run-secrets-1"), &dir, &data_dir);
        let (ui_tx, _ui_rx) = mpsc::unbounded_channel();

        // Confirm the vercel plan and hand over the credential value...
        flow.poll(&ui_tx).await;
        flow.answer(ShipAnswer::DeployChoice {
            confirmed: true,
            auto_rollback: false,
        });
        flow.poll(&ui_tx).await;
        flow.answer(ShipAnswer::SecretValue {
            name: "VERCEL_TOKEN".to_string(),
            value: secret.to_string(),
        });
        // ...then drive the flow to done: the commands run (and fail: no
        // vercel on PATH) and the operate pass follows.
        while flow.stage() != ShipStage::Done {
            assert_eq!(flow.poll(&ui_tx).await, None);
        }

        // No settings row anywhere carries the secret value.
        for (key, value) in persistence.list_settings().unwrap() {
            assert!(
                !value.contains(secret),
                "settings row {key} carries the secret: {value}"
            );
        }
        // The operate log records that a deploy happened, never its material.
        let events = operate::read_operate_log(&data_dir, "run-secrets-1").unwrap();
        assert!(!events.is_empty(), "the deploy attempt must be logged");
        for event in &events {
            assert!(
                !event.detail.contains(secret),
                "operate log event carries the secret: {}",
                event.detail
            );
        }

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[tokio::test]
    async fn a_confirmed_deploy_runs_through_the_operate_pass() {
        // A shipped git workspace whose marker proposes the vercel plan: the
        // deploy command fails (no vercel on PATH), and the health pass
        // verifies the local release tag resolves.
        let dir = git_workspace("lifecycle");
        std::fs::write(dir.join("vercel.json"), "{}\n").unwrap();
        git(&dir, &["add", "-A"]);
        git(&dir, &["commit", "-q", "-m", "marker"]);
        let data_dir = temp_dir("lifecycle-data");
        let persistence = Persistence::new(&data_dir).unwrap();
        persistence
            .set_setting(
                "pipeline:session-lifecycle-1",
                r#"{"runId":"run-lifecycle-1"}"#,
            )
            .unwrap();
        let runner = echo_runner();
        let record = run_ship_stage(
            &runner,
            &persistence,
            "session-lifecycle-1",
            &dir,
            &data_dir,
            None,
        )
        .await
        .unwrap();
        let mut flow = ShipFlow::new(record, &dir, &data_dir);
        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel();

        flow.poll(&ui_tx).await;
        flow.answer(ShipAnswer::DeployChoice {
            confirmed: true,
            auto_rollback: false,
        });
        flow.poll(&ui_tx).await;
        flow.answer(ShipAnswer::SecretValue {
            name: "VERCEL_TOKEN".to_string(),
            value: "sup3r-s3cret-deploy-token-value".to_string(),
        });
        while flow.stage() != ShipStage::Done {
            assert_eq!(flow.poll(&ui_tx).await, None);
        }

        // The commands ran (and failed without the CLI), then the health
        // pass verified the shipped tag: the full sequence, in order.
        let events = drain(&mut ui_rx);
        let kinds: Vec<&str> = events
            .iter()
            .map(|event| match event {
                ShipEventKind::DeployProposed { .. } => "proposed",
                ShipEventKind::DeploySecretRequested { .. } => "secret",
                ShipEventKind::DeployDone { .. } => "deploy-done",
                ShipEventKind::HealthOk { .. } => "health-ok",
                ShipEventKind::HealthFailed { .. } => "health-failed",
                ShipEventKind::DeployRolledBack { .. } => "rolled-back",
                ShipEventKind::ShipReady { .. } => "ship-ready",
            })
            .collect();
        assert_eq!(
            kinds,
            vec!["proposed", "secret", "deploy-done", "health-ok"]
        );
        assert_eq!(flow.stage(), ShipStage::Done);
        // The operate log records the deploy, its rollback hint, and the
        // health pass — never the commands' output.
        let logged = operate::read_operate_log(&data_dir, "run-lifecycle-1").unwrap();
        let logged_kinds: Vec<&str> = logged.iter().map(|event| event.kind.as_str()).collect();
        assert_eq!(logged_kinds, vec!["ship", "deploy", "rollback", "health"]);
        assert!(logged
            .iter()
            .all(|event| !event.detail.contains("vercel: not found")));

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }

    /// A plan whose rollback command writes a marker file into the workspace:
    /// the observable proof that the recorded rollback actually ran.
    fn marker_rollback_plan(marker: &Path) -> DeployPlan {
        DeployPlan {
            target: "probe".to_string(),
            reason: "probe plan".to_string(),
            required_credentials: Vec::new(),
            commands: vec!["true".to_string()],
            rollback: format!("echo rolled-back > '{}'", marker.display()),
            release_id_regex: None,
        }
    }

    #[tokio::test]
    async fn auto_rollback_runs_the_recorded_command_on_a_failed_health_check() {
        // A plan whose recorded rollback writes a marker file; the health
        // probe fails (the recorded tag does not resolve), and with
        // auto-rollback armed the flow runs that rollback command itself.
        let dir = temp_dir("rollback-on");
        let data_dir = temp_dir("rollback-on-data");
        let marker = dir.join("auto-rollback.marker");
        let mut record = ShipRecord::new("run-rollback-on");
        record.tag = Some("v-does-not-resolve".to_string());
        let mut flow = ShipFlow::new(record, &dir, &data_dir);
        flow.plan = Some(marker_rollback_plan(&marker));
        flow.auto_rollback = true;
        flow.stage = ShipStage::Operate;

        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel();
        assert_eq!(flow.poll(&ui_tx).await, None);
        assert_eq!(flow.stage(), ShipStage::Done);

        // The rollback command ran inside the sandbox and wrote the marker.
        assert!(marker.exists(), "the recorded rollback command must run");
        // A DeployRolledBack { ok: true } reached the surface...
        let events = drain(&mut ui_rx);
        assert!(events
            .iter()
            .any(|event| matches!(event, ShipEventKind::DeployRolledBack { ok: true, .. })));
        // ...and the operate log records the rollback outcome.
        let logged = operate::read_operate_log(&data_dir, "run-rollback-on").unwrap();
        assert!(logged
            .iter()
            .any(|event| event.kind == "rollback" && event.detail.contains("probe")));

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[tokio::test]
    async fn no_auto_rollback_means_the_rollback_command_does_not_run() {
        // Same failed health check, but auto-rollback was left off (default
        // no): the failure is surfaced, yet nothing undoes the deploy.
        let dir = temp_dir("rollback-off");
        let data_dir = temp_dir("rollback-off-data");
        let marker = dir.join("auto-rollback.marker");
        let mut record = ShipRecord::new("run-rollback-off");
        record.tag = Some("v-does-not-resolve".to_string());
        let mut flow = ShipFlow::new(record, &dir, &data_dir);
        flow.plan = Some(marker_rollback_plan(&marker));
        flow.auto_rollback = false;
        flow.stage = ShipStage::Operate;

        let (ui_tx, mut ui_rx) = mpsc::unbounded_channel();
        assert_eq!(flow.poll(&ui_tx).await, None);
        assert_eq!(flow.stage(), ShipStage::Done);

        // The health check failed (surfaced) but no rollback ran.
        assert!(
            !marker.exists(),
            "no rollback command may run when disabled"
        );
        assert!(!drain(&mut ui_rx)
            .iter()
            .any(|event| matches!(event, ShipEventKind::DeployRolledBack { .. })));

        std::fs::remove_dir_all(&dir).ok();
        std::fs::remove_dir_all(&data_dir).ok();
    }
}
