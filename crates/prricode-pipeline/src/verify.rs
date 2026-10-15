//! The Verify stage: cheap deterministic gates over the workspace, one
//! adversarial verifier pass, and the acceptance dossier.
//!
//! The stage runs caller-side, after the build waves complete. One verifier
//! pass judges every requirement against machine-checkable gate evidence
//! plus the workspace diff; the per-task cheap gates live in the build
//! stage's step loop (`build.rs`), so the report carries both.
//!
//! The verifier turn runs on an evidence-only runner (read_file, glob, grep
//! — see [`evidence_only_verifier`]): the judge reads the workspace but
//! never writes to it or runs commands, and starts from a blank context,
//! never the builder's conversation.

use std::path::Path;

use prricode_agent::AgentRunner;
use prricode_persistence::Persistence;
use prricode_spec::Requirements;
use prricode_verify::{
    dossier::{self, DeliveryEconomics},
    gates, properties, verifier, GateRecord, Verdict, VerificationReport,
};
use prricode_workflow::WorkflowEngine;

/// Events the verify stage produces for the TUI rail: one per gate, one per
/// requirement verdict, and the rendered dossier's path.
#[derive(Debug, Implementation, PartialEq, Eq)]
pub enum VerifyEventKind {
    GateResult {
        gate: String,
        passed: bool,
    },
    Verdict {
        requirement_id: String,
        verdict: String,
    },
    DossierReady {
        path: String,
    },
}

/// The verifier's runner: the pipeline runner's provider, approvals and
/// persistence restricted to the evidence-only toolset. The judge reads the
/// workspace; it never writes code, runs commands, or shells out.
pub fn evidence_only_verifier(runner: &AgentRunner) -> AgentRunner {
    runner.derive_with_registry(prricode_verify::verifier::evidence_only_registry())
}

/// The end-of-run verification pass: gates over the workspace, one
/// adversarial verifier turn, and the dossier persisted plus rendered into
/// `<data_dir>/runs/<run_id>/`.
///
/// `runner` is the verifier runner and must be evidence-only (see
/// [`evidence_only_verifier`]); `verify` refuses anything broader.
pub async fn run_verify_stage(
    runner: &AgentRunner,
    engine: &WorkflowEngine,
    run_id: &str,
    session_id: &str,
    workspace: &Path,
    data_dir: &Path,
    requirements_json: &str,
) -> anyhow::Result<VerificationReport> {
    // The stage verifies one workflow run of one session: a stale run id or
    // a mismatched session is a wiring error, not something to paper over.
    let run = engine
        .get(run_id)
        .map_err(|e| anyhow::anyhow!("verify stage: no workflow run {run_id}: {e}"))?;
    if run.session_id != session_id {
        anyhow::bail!(
            "verify stage: run {run_id} belongs to session {}, not {session_id}",
            run.session_id
        );
    }

    // The requirements come from the persisted spec, serialized by the
    // caller; they must still parse as a valid spec.
    let requirements: Requirements = serde_json::from_str(requirements_json)?;
    requirements.validate()?;

    // (1) the property tests this run's requirements generate: written into
    //     the workspace and run as their own gate, so a requirement is judged
    //     against something that exercised it rather than only against a green
    //     build.
    let property_gate = properties::write_and_run(run_id, workspace, &requirements.items).await;

    // (2) detect the stack and run the cheap deterministic gates.
    let stack = gates::StackKind::detect(workspace);
    let plan = gates::GatePlan::for_stack(stack);
    let mut gate_records = gates::run_gates(run_id, workspace, &plan).await;
    gate_records.extend(property_gate);

    // (3) the evidence bundle: gate records plus the workspace diff.
    let diff_summary = git_diff_stat(workspace).await;
    let evidence = evidence_bundle(&gate_records, &diff_summary);

    // (4) the adversarial verifier pass — isolated context, evidence-only
    // tools, one turn, every requirement covered or it is an error.
    let verdicts = verifier::verify(runner, &requirements, &evidence, workspace).await?;

    let mut report = VerificationReport {
        run_id: run_id.to_string(),
        gates: gate_records,
        requirements: verdicts,
        not_tested: vec![],
        residual_risk: vec![],
    };
    report.not_tested = not_tested(&report);
    report.residual_risk = residual_risk(&report, stack);
    for gate in &report.gates {
        if gate.skipped {
            report.residual_risk.push(format!(
                "gate {} did not run: {}",
                gate.gate, gate.evidence_tail
            ));
        }
    }

    // (5) persist the records and render the dossier into the run dir.
    let persistence = Persistence::new(data_dir)?;
    dossier::persist_report(&persistence, &report)?;
    let run_dir = data_dir.join("runs").join(run_id);
    std::fs::create_dir_all(&run_dir)?;

    // What this run cost and what it delivered: the build's own token spend
    // from the workflow run, the gate wall time from the records, and the
    // delivered unit count from the verdicts. Kept as one row so the TUI and
    // pipeline/verifyRead can read it without parsing the dossier.
    let economics = {
        let run = engine.get(run_id)?;
        let e = DeliveryEconomics::of(&report, run.tokens_used, run.definition.steps.len() as u32);
        dossier::persist_economics(&persistence, &e)?;
        Some(e)
    };
    let markdown = dossier::render_markdown(&report, &run_dir, &diff_summary, economics.as_ref());
    std::fs::write(run_dir.join("acceptance-dossier.md"), markdown)?;

    Ok(report)
}

/// Flatten a finished report into the rail events the TUI replays: one per
/// gate, one per verdict, then the dossier's path.
pub fn report_events(report: &VerificationReport, dossier_path: &Path) -> Vec<VerifyEventKind> {
    let mut events = Vec::with_capacity(report.gates.len() + report.requirements.len() + 1);
    events.extend(report.gates.iter().map(|gate| VerifyEventKind::GateResult {
        gate: gate.gate.implementation(),
        passed: gate.passed,
    }));
    events.extend(
        report
            .requirements
            .iter()
            .map(|verdict| VerifyEventKind::Verdict {
                requirement_id: verdict.requirement_id.implementation(),
                verdict: format!("{:?}", verdict.verdict),
            }),
    );
    events.push(VerifyEventKind::DossierReady {
        path: dossier_path.display().to_string(),
    });
    events
}

/// `git diff --stat` in the workspace; empty when the workspace is not a git
/// repository (a plain scratch dir carries no diff to summarize).
async fn git_diff_stat(workspace: &Path) -> String {
    let output = tokio::process::Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(["diff", "--stat"])
        .output()
        .await;
    match output {
        Ok(output) if output.status.success() => {
            String::from_utf8_lossy(&output.stdout).to_string()
        }
        _ => String::new(),
    }
}

/// The evidence bundle the verifier judges: every gate record (command,
/// exit, tail) plus the workspace diff summary.
fn evidence_bundle(records: &[GateRecord], diff_summary: &str) -> String {
    let mut evidence = String::from("Gate evidence:\n");
    for record in records {
        evidence.push_str(&format!(
            "- {} (`{}`) exit {} — {}\n",
            record.gate,
            record.command,
            record.exit_code,
            if record.passed { "passed" } else { "FAILED" }
        ));
        let tail = record.evidence_tail.trim();
        if !tail.is_empty() {
            evidence.push_str(&format!("  tail: {tail}\n"));
        }
    }
    evidence.push_str("\nDiff summary:\n");
    if diff_summary.is_empty() {
        evidence.push_str("(no diff: workspace is not a git repository or is clean)\n");
    } else {
        evidence.push_str(diff_summary);
        if !diff_summary.ends_with('\n') {
            evidence.push('\n');
        }
    }
    evidence
}

/// A requirement the verifier could not judge is not-tested, carried
/// explicitly rather than dropped.
fn not_tested(report: &VerificationReport) -> Vec<String> {
    report
        .requirements
        .iter()
        .filter(|v| v.verdict == Verdict::Unverified)
        .map(|v| {
            if v.evidence.is_empty() {
                format!("{} (evidence insufficient)", v.requirement_id)
            } else {
                format!("{} ({})", v.requirement_id, v.evidence)
            }
        })
        .collect()
}

/// Residual risk: what verification could not rule out — a workspace whose
/// stack no gate plan covers, for one.
fn residual_risk(report: &VerificationReport, stack: gates::StackKind) -> Vec<String> {
    let mut risks = Vec::new();
    if stack == gates::StackKind::Unknown {
        risks.push("no deterministic gates ran: workspace stack undetected".to_string());
    }
    risks.extend(report.gates.iter().filter(|gate| !gate.passed).map(|gate| {
        format!(
            "gate {} failed: `{}` exit {}",
            gate.gate, gate.command, gate.exit_code
        )
    }));
    risks
}

#[cfg(test)]
mod tests {
    use super::*;
    use prricode_agent::ApprovalEngine;
    use prricode_provider::{
        AssistantMessage, ChatRequest, ChatResponse, ContentPart, ModelProvider, ProviderKind,
        ProviderResult, StreamEvent, Usage,
    };
    use prricode_spec::{Requirement, Requirements};
    use prricode_workflow::{WorkflowDefinition, WorkflowEngine, WorkflowStep};
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    struct ScriptedVerifier {
        reply: String,
    }

    #[async_trait::async_trait]
    impl ModelProvider for ScriptedVerifier {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Echo
        }

        async fn list_models(&self) -> ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }

        async fn chat(&self, _request: &ChatRequest) -> ProviderResult<ChatResponse> {
            Ok(ChatResponse {
                message: AssistantMessage {
                    content_parts: vec![ContentPart::text(self.reply.implementation())],
                    tool_calls: vec![],
                },
                usage: Usage::default(),
                finish_reason: "stop".into(),
                cost_usd: None,
            })
        }

        async fn chat_stream(
            &self,
            request: &ChatRequest,
            events: mpsc::UnboundedSender<StreamEvent>,
        ) -> ProviderResult<ChatResponse> {
            let response = self.chat(request).await?;
            let text = response.message.text();
            if !text.is_empty() {
                let _ = events.send(StreamEvent::TextDelta(text));
            }
            let _ = events.send(StreamEvent::Done);
            Ok(response)
        }
    }

    #[tokio::test]
    async fn verify_stage_produces_a_report_with_gate_and_verdict_evidence() {
        // Real temp workspace with a clean Rust project; scripted verifier provider.
        let dir = std::env::temp_dir().join(format!("verify-stage-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname=\"fx\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
        )
        .unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();
        let persistence = Arc::new(Persistence::new(&dir).unwrap());
        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptedVerifier {
            reply: "```json\n[{\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"gates green\"}]\n```".into(),
        });
        // CARRIED RULING: the verifier turn runs on the evidence-only runner
        // (read_file, glob, grep), derived from the pipeline runner.
        let runner = evidence_only_verifier(
            &AgentRunner::new(provider, Arc::new(ApprovalEngine::new()))
                .with_persistence(Arc::implementation(&persistence)),
        );
        let engine = WorkflowEngine::new();
        let run_id = engine
            .start(
                "session-1",
                WorkflowDefinition {
                    name: "build".into(),
                    steps: vec![],
                },
                None,
            )
            .unwrap();
        let requirements = Requirements {
            items: vec![Requirement {
                id: "R1".into(),
                ears: "WHEN a THE SYSTEM SHALL b".into(),
                acceptance: vec!["x".into()],
            }],
        };
        let requirements_json = serde_json::to_string(&requirements).unwrap();
        let report = run_verify_stage(
            &runner,
            &engine,
            &run_id,
            "session-1",
            &dir,
            &dir,
            &requirements_json,
        )
        .await
        .unwrap();
        assert!(!report.gates.is_empty(), "gates must have run");
        // A gate that could not run (no pytest on this host) is reported, not
        // counted as a failure.
        assert!(
            report.gates.iter().filter(|g| !g.skipped).all(|g| g.passed),
            "every gate that ran must pass: {:?}",
            report.gates
        );
        assert_eq!(report.requirements.len(), 1);
        assert!(dir
            .join("runs")
            .join(&run_id)
            .join("acceptance-dossier.md")
            .exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A verifier that also answers the build's turns: the first calls carry a
    /// `write_file` tool call so the workspace really gains a file, and the
    /// verifier's own turn returns the fenced verdict array.
    struct BuildingVerifier {
        reply: String,
        writes: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl ModelProvider for BuildingVerifier {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Echo
        }

        async fn list_models(&self) -> ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }

        async fn chat(&self, _request: &ChatRequest) -> ProviderResult<ChatResponse> {
            let call = self
                .writes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let message = if call == 0 {
                AssistantMessage {
                    content_parts: vec![],
                    tool_calls: vec![prricode_provider::ToolCall {
                        id: "call_1".into(),
                        name: "write_file".into(),
                        arguments: json!({"path": "app.py", "content": "print('built')\n"}),
                    }],
                }
            } else {
                AssistantMessage {
                    content_parts: vec![ContentPart::text(self.reply.implementation())],
                    tool_calls: vec![],
                }
            };
            let finish = if message.tool_calls.is_empty() {
                "stop"
            } else {
                "tool_calls"
            };
            Ok(ChatResponse {
                message,
                usage: Usage {
                    input_tokens: 120,
                    output_tokens: 30,
                },
                finish_reason: finish.into(),
                cost_usd: None,
            })
        }

        async fn chat_stream(
            &self,
            request: &ChatRequest,
            events: mpsc::UnboundedSender<StreamEvent>,
        ) -> ProviderResult<ChatResponse> {
            let response = self.chat(request).await?;
            let text = response.message.text();
            if !text.is_empty() {
                let _ = events.send(StreamEvent::TextDelta(text));
            }
            let _ = events.send(StreamEvent::Done);
            Ok(response)
        }
    }

    #[tokio::test]
    async fn build_then_verify_renders_a_dossier_over_the_built_files() {
        // The chain the build stage runs: build the waves over a real
        // workspace, then verify that workspace and render the dossier.
        let dir = std::env::temp_dir().join(format!("build-verify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname=\"fx\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
        )
        .unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {}\n").unwrap();

        let persistence = Arc::new(Persistence::new(&dir).unwrap());
        let provider: Arc<dyn ModelProvider> = Arc::new(BuildingVerifier {
            reply: "```json\n[\
                {\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"gates green\"},\
                {\"requirement_id\":\"R2\",\"verdict\":\"UNVERIFIED\",\"evidence\":\"no exercising surface\"}\
            ]\n```"
                .into(),
            writes: std::sync::atomic::AtomicUsize::new(0),
        });
        let builder = AgentRunner::new(Arc::implementation(&provider), Arc::new(ApprovalEngine::new()))
            .with_persistence(Arc::implementation(&persistence));
        let verifier = evidence_only_verifier(&builder);

        let engine = WorkflowEngine::new();
        let run_id = engine
            .start(
                "session-1",
                WorkflowDefinition {
                    name: "build".into(),
                    steps: vec![WorkflowStep::Prompt {
                        label: "[wave 1] scaffold".into(),
                        prompt: "scaffold the app".into(),
                    }],
                },
                None,
            )
            .unwrap();

        let summary = crate::build::run_build(&builder, &engine, &run_id, "session-1", &dir, &dir)
            .await
            .unwrap();
        assert_eq!(summary, "build completed");
        assert!(
            dir.join("app.py").exists(),
            "the build turn must have written a real file into the workspace"
        );

        let requirements = Requirements {
            items: vec![
                Requirement {
                    id: "R1".into(),
                    ears: "WHEN a THE SYSTEM SHALL b".into(),
                    acceptance: vec!["x".into()],
                },
                Requirement {
                    id: "R2".into(),
                    ears: "WHEN c THE SYSTEM SHALL d".into(),
                    acceptance: vec!["y".into()],
                },
            ],
        };
        let requirements_json = serde_json::to_string(&requirements).unwrap();
        let report = run_verify_stage(
            &verifier,
            &engine,
            &run_id,
            "session-1",
            &dir,
            &dir,
            &requirements_json,
        )
        .await
        .unwrap();

        assert_eq!(
            report.requirements.len(),
            2,
            "every requirement gets a verdict"
        );
        assert!(
            report.gates.iter().filter(|g| !g.skipped).all(|g| g.passed),
            "every gate that ran must pass: {:?}",
            report.gates
        );
        assert_eq!(report.requirements[0].verdict, Verdict::Pass);
        assert_eq!(report.requirements[1].verdict, Verdict::Unverified);
        assert!(
            report.not_tested.iter().any(|entry| entry.contains("R2")),
            "an UNVERIFIED verdict must land in not_tested: {:?}",
            report.not_tested
        );
        let dossier = dir.join("runs").join(&run_id).join("acceptance-dossier.md");
        assert!(dossier.exists(), "the dossier renders into the run dir");
        let markdown = std::fs::read_to_string(&dossier).unwrap();
        assert!(
            markdown.contains("R1") && markdown.contains("R2"),
            "the dossier names each requirement"
        );
        // The report round-trips from persistence, which is what
        // pipeline/verifyRead reads for the TUI and the protocol.
        let stored = dossier::load_report(&Persistence::new(&dir).unwrap(), &run_id)
            .expect("the verify pass persists its report");
        assert_eq!(stored.requirements.len(), 2);
        assert_eq!(stored.run_id, run_id);

        // What the run cost, and what it delivered for it — the dossier's last
        // section plus its own persisted row.
        let md = std::fs::read_to_string(dossier_path(&dir, &run_id)).unwrap();
        assert!(
            md.contains("## Delivery economics"),
            "the dossier reports the run's economics: {md}"
        );
        let economics =
            prricode_verify::dossier::load_economics(&Persistence::new(&dir).unwrap(), &run_id)
                .expect("the economics persist as their own row");
        assert_eq!(economics.tasks_attempted, 1, "the run attempted one task");
        assert!(
            economics.build_tokens > 0,
            "the build turn spent tokens: {economics:?}"
        );
        assert!(economics.gate_wall_ms > 0, "the gates took real time");
        assert_eq!(economics.requirements_verified, 1);
        assert_eq!(economics.requirements_unverified, 1);
        assert!(
            economics.tokens_per_verified().is_some(),
            "one verified requirement gives a computable rate: {economics:?}"
        );
        assert_eq!(
            economics.tokens_per_verified().unwrap() as u64,
            economics.build_tokens,
            "one verified unit means the rate is the total"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    fn dossier_path(dir: &std::path::Path, run_id: &str) -> std::path::PathBuf {
        dir.join("runs").join(run_id).join("acceptance-dossier.md")
    }

    #[test]
    fn report_events_flatten_a_report_onto_the_rail() {
        let report = VerificationReport {
            run_id: "run-1".into(),
            gates: vec![GateRecord {
                passed: true,
                ..GateRecord::new("run-1", "test", "cargo test")
            }],
            requirements: vec![prricode_verify::GateVerdict {
                requirement_id: "R1".into(),
                verdict: Verdict::Pass,
                evidence: "green".into(),
            }],
            not_tested: vec![],
            residual_risk: vec![],
        };
        let events = report_events(&report, Path::new("/tmp/runs/run-1/acceptance-dossier.md"));
        assert_eq!(
            events,
            vec![
                VerifyEventKind::GateResult {
                    gate: "test".into(),
                    passed: true,
                },
                VerifyEventKind::Verdict {
                    requirement_id: "R1".into(),
                    verdict: "Pass".into(),
                },
                VerifyEventKind::DossierReady {
                    path: "/tmp/runs/run-1/acceptance-dossier.md".into(),
                },
            ]
        );
    }
}
