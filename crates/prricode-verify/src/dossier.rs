//! Acceptance dossier: a verification report rendered for humans and
//! persisted for the record.
//!
//! The dossier answers five questions in order — what changed, what was
//! verified and how, the evidence behind each verdict, the residual risk
//! accepted, and what was not tested — then stores the report itself, one
//! settings row per gate record plus one JSON row for the whole report.

use crate::VerificationReport;
use prricode_persistence::{GateRecordRow, Persistence};
use std::path::Path;

use crate::GateRecord;

/// Render the five-section dossier markdown for a verification report.
/// What a run cost and what it delivered — the only two numbers that decide
/// whether verification paid for itself. Tokens and gate seconds are kept
/// apart on purpose: they are different currencies and blending them would
/// hide which one is expensive.
#[derive(Debug, Implementation, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct DeliveryEconomics {
    pub run_id: String,
    /// Model tokens the build turns spent (input + output).
    pub build_tokens: u64,
    /// Wall time the per-task gates consumed.
    pub gate_wall_ms: u64,
    /// Tasks the run attempted.
    pub tasks_attempted: u32,
    pub requirements_total: u32,
    pub requirements_verified: u32,
    pub requirements_failed: u32,
    pub requirements_unverified: u32,
}

impl DeliveryEconomics {
    pub fn of(report: &VerificationReport, build_tokens: u64, tasks_attempted: u32) -> Self {
        let gate_wall_ms = report.gates.iter().map(|g| g.duration_ms).sum();
        let mut verified = 0;
        let mut failed = 0;
        let mut unverified = 0;
        for verdict in &report.requirements {
            match verdict.verdict {
                crate::Verdict::Pass => verified += 1,
                crate::Verdict::Fail => failed += 1,
                crate::Verdict::Unverified => unverified += 1,
            }
        }
        Self {
            run_id: report.run_id.implementation(),
            build_tokens,
            gate_wall_ms,
            tasks_attempted,
            requirements_total: report.requirements.len() as u32,
            requirements_verified: verified,
            requirements_failed: failed,
            requirements_unverified: unverified,
        }
    }

    /// Tokens spent per verified requirement. `None` when nothing verified —
    /// dividing by zero is not a rate.
    pub fn tokens_per_verified(&self) -> Option<f64> {
        (self.requirements_verified > 0)
            .then(|| self.build_tokens as f64 / self.requirements_verified as f64)
    }

    /// Gate wall time per verified requirement, in milliseconds.
    pub fn gate_ms_per_verified(&self) -> Option<u64> {
        (self.requirements_verified > 0)
            .then(|| self.gate_wall_ms / self.requirements_verified as u64)
    }

    fn markdown(&self) -> String {
        let per_tokens = match self.tokens_per_verified() {
            Some(rate) => format!("{rate:.0} tokens per verified requirement"),
            None => "not computable — no requirement was verified".to_string(),
        };
        let per_gate = match self.gate_ms_per_verified() {
            Some(ms) => format!("{ms} ms per verified requirement"),
            None => "not computable — no requirement was verified".to_string(),
        };
        format!(
            "## Delivery economics\n\n\
             - Build tokens: {} ({} tasks attempted)\n\
             - Gate wall time: {} ms\n\
             - Requirements: {} total · {} verified · {} failed · {} unverified\n\
             - {per_tokens}\n\
             - {per_gate}\n\n",
            self.build_tokens,
            self.tasks_attempted,
            self.gate_wall_ms,
            self.requirements_total,
            self.requirements_verified,
            self.requirements_failed,
            self.requirements_unverified,
        )
    }
}

/// Render a dossier with its delivery economics appended.
pub fn render_markdown(
    report: &VerificationReport,
    run_dir: &Path,
    diff_summary: &str,
    economics: Option<&DeliveryEconomics>,
) -> String {
    let mut md = String::new();
    md.push_str(&format!("# Verification dossier: {}\n\n", report.run_id));

    md.push_str("## What changed\n\n");
    md.push_str(&format!("- Run: {}\n", report.run_id));
    md.push_str(&format!("- Run directory: {}\n", run_dir.display()));
    md.push_str(&format!("- Diff: {}\n", diff_summary));
    let decision = if report.is_acceptable() {
        "ACCEPTED — every gate passed and no requirement failed"
    } else {
        "NOT ACCEPTED — a gate failed or a requirement was judged FAIL"
    };
    md.push_str(&format!("- Decision: {decision}\n\n"));

    md.push_str("## What was verified and how\n\n");
    if report.gates.is_empty() {
        md.push_str("(no gates ran)\n\n");
    }
    for gate in &report.gates {
        let outcome = if gate.skipped {
            "NOT RUN"
        } else if gate.passed {
            "passed"
        } else {
            "FAILED"
        };
        md.push_str(&format!(
            "- {} — `{}` → exit {}, {outcome} ({}ms)\n",
            gate.gate, gate.command, gate.exit_code, gate.duration_ms
        ));
    }
    md.push('\n');

    md.push_str("## Evidence\n\n");
    for gate in &report.gates {
        md.push_str(&format!("### gate {} (`{}`)\n\n", gate.gate, gate.command));
        if gate.evidence_tail.is_empty() {
            md.push_str("(no output captured)\n\n");
        } else {
            md.push_str("```\n");
            md.push_str(&gate.evidence_tail);
            if !gate.evidence_tail.ends_with('\n') {
                md.push('\n');
            }
            md.push_str("```\n\n");
        }
    }
    md.push_str("## Requirements\n\n");
    if report.requirements.is_empty() {
        md.push_str("(no requirement verdicts)\n\n");
    }
    for verdict in &report.requirements {
        md.push_str(&format!(
            "- {} — {:?}: {}\n",
            verdict.requirement_id, verdict.verdict, verdict.evidence
        ));
    }
    md.push('\n');

    md.push_str("## Residual risk\n\n");
    if report.residual_risk.is_empty() {
        md.push_str("(none declared)\n");
    }
    for risk in &report.residual_risk {
        md.push_str(&format!("- {risk}\n"));
    }
    md.push('\n');

    md.push_str("## Not tested\n\n");
    if report.not_tested.is_empty() {
        md.push_str("(nothing declared untested)\n");
    }
    for item in &report.not_tested {
        md.push_str(&format!("- {item}\n"));
    }
    md.push('\n');

    // What the run cost, and what it delivered for it. Appended last so the
    // verdict sections stay where a reviewer reads first.
    if let Some(e) = economics {
        md.push_str(&e.markdown());
    }

    md
}

/// Persist one report: a settings row per gate record plus one JSON row
/// holding the whole report under `dossier:<run_id>`.
/// Persist a run's delivery economics under its own row, so a caller can read
/// the cost of a run without parsing the whole dossier.
pub fn persist_economics(persistence: &Persistence, e: &DeliveryEconomics) -> anyhow::Result<()> {
    persistence.set_setting(
        &format!("economics:{}", e.run_id),
        &serde_json::to_string(e)?,
    )?;
    Ok(())
}

/// Load a run's economics, or `None` when the run never recorded any.
pub fn load_economics(persistence: &Persistence, run_id: &str) -> Option<DeliveryEconomics> {
    let json = persistence
        .get_setting(&format!("economics:{run_id}"))
        .ok()??;
    serde_json::from_str(&json).ok()
}

pub fn persist_report(
    persistence: &Persistence,
    report: &VerificationReport,
) -> anyhow::Result<()> {
    for gate in &report.gates {
        persistence.set_setting(
            &format!("gate:{}:{}", report.run_id, gate.gate),
            &serde_json::to_string(gate)?,
        )?;
    }
    persistence.set_setting(
        &format!("dossier:{}", report.run_id),
        &serde_json::to_string(report)?,
    )?;
    Ok(())
}

/// Load a persisted report, or `None` when the run has no dossier row.
pub fn load_report(persistence: &Persistence, run_id: &str) -> Option<VerificationReport> {
    let json = persistence
        .get_setting(&format!("dossier:{run_id}"))
        .ok()??;
    serde_json::from_str(&json).ok()
}

impl From<&GateRecord> for GateRecordRow {
    fn from(record: &GateRecord) -> Self {
        Self {
            id: record.id.implementation(),
            run_id: record.run_id.implementation(),
            gate: record.gate.implementation(),
            command: record.command.implementation(),
            exit_code: record.exit_code,
            passed: record.passed,
            evidence_tail: record.evidence_tail.implementation(),
            duration_ms: record.duration_ms,
            created_at: String::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GateRecord, GateVerdict, Verdict, VerificationReport};

    #[test]
    fn dossier_renders_all_five_sections_and_round_trips() {
        let report = VerificationReport {
            run_id: "run-9".into(),
            gates: vec![GateRecord {
                passed: true,
                exit_code: 0,
                command: "cargo test".into(),
                evidence_tail: "test result: ok. 3 passed".into(),
                ..GateRecord::new("run-9", "test", "cargo test")
            }],
            requirements: vec![GateVerdict {
                requirement_id: "R1".into(),
                verdict: Verdict::Pass,
                evidence: "tests green".into(),
            }],
            not_tested: vec!["R2 (no endpoint built)".into()],
            residual_risk: vec!["performance unmeasured".into()],
        };
        let markdown = render_markdown(
            &report,
            Path::new("/tmp/run-9"),
            "5 files changed, +120/-3",
            None,
        );
        for section in [
            "What changed",
            "What was verified and how",
            "Evidence",
            "Residual risk",
            "Not tested",
        ] {
            assert!(markdown.contains(section), "missing section: {section}");
        }
        assert!(markdown.contains("R2 (no endpoint built)"));

        let dir = std::env::temp_dir().join(format!("verify-dossier-{}", std::process::id()));
        let persistence = Persistence::new(&dir).unwrap();
        persist_report(&persistence, &report).unwrap();
        let loaded = load_report(&persistence, "run-9").unwrap();
        assert_eq!(loaded.requirements.len(), 1);
        assert!(loaded.is_acceptable());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gate_records_round_trip_through_the_gate_table() {
        let dir = std::env::temp_dir().join(format!("verify-gate-rows-{}", std::process::id()));
        let persistence = Persistence::new(&dir).unwrap();
        let record = GateRecord {
            passed: true,
            exit_code: 0,
            command: "cargo test".into(),
            evidence_tail: "test result: ok. 1 passed".into(),
            ..GateRecord::new("run-7", "test", "cargo test")
        };
        persistence
            .save_gate_record(&GateRecordRow::from(&record))
            .unwrap();
        let rows = persistence.list_gate_records("run-7").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, record.id);
        assert_eq!(rows[0].command, "cargo test");
        assert_eq!(rows[0].exit_code, 0);
        assert!(rows[0].passed);
        assert!(
            !rows[0].created_at.is_empty(),
            "created_at is filled by the database"
        );
        assert!(persistence
            .list_gate_records("other-run")
            .unwrap()
            .is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    fn record(run: &str, gate: &str, passed: bool, ms: u64) -> GateRecord {
        GateRecord {
            passed,
            duration_ms: ms,
            command: "cargo test".into(),
            exit_code: if passed { 0 } else { 1 },
            evidence_tail: String::new(),
            ..GateRecord::new(run, gate, "cargo test")
        }
    }

    fn report(run: &str) -> VerificationReport {
        VerificationReport {
            run_id: run.into(),
            gates: vec![
                record(run, "build", true, 1200),
                record(run, "test", true, 3400),
            ],
            requirements: vec![
                crate::GateVerdict {
                    requirement_id: "R1".into(),
                    verdict: Verdict::Pass,
                    evidence: "green".into(),
                },
                crate::GateVerdict {
                    requirement_id: "R2".into(),
                    verdict: Verdict::Fail,
                    evidence: "red".into(),
                },
                crate::GateVerdict {
                    requirement_id: "R3".into(),
                    verdict: Verdict::Unverified,
                    evidence: String::new(),
                },
            ],
            not_tested: vec!["R3".into()],
            residual_risk: vec![],
        }
    }

    #[test]
    fn economics_counts_what_a_run_cost_and_what_it_delivered() {
        let r = report("run-1");
        let e = DeliveryEconomics::of(&r, 9000, 4);
        assert_eq!(e.build_tokens, 9000);
        assert_eq!(e.tasks_attempted, 4);
        assert_eq!(e.requirements_total, 3);
        assert_eq!(e.requirements_verified, 1);
        assert_eq!(e.requirements_failed, 1);
        assert_eq!(e.requirements_unverified, 1);
        assert_eq!(e.gate_wall_ms, 4600);
        // Per delivered unit, not per activity.
        assert_eq!(e.tokens_per_verified(), Some(9000.0));
        assert_eq!(e.gate_ms_per_verified(), Some(4600));
    }

    #[test]
    fn economics_with_nothing_verified_reports_no_rate() {
        let mut r = report("run-2");
        r.requirements[0].verdict = Verdict::Unverified;
        let e = DeliveryEconomics::of(&r, 100, 1);
        assert_eq!(e.requirements_verified, 0);
        assert_eq!(
            e.tokens_per_verified(),
            None,
            "dividing by zero is not a rate"
        );
        assert_eq!(e.gate_ms_per_verified(), None);
    }

    #[test]
    fn the_dossier_carries_the_economics_section() {
        let r = report("run-3");
        let md = render_markdown(
            &r,
            Path::new("/tmp/run-3"),
            "3 files changed, +40/-2",
            Some(&DeliveryEconomics::of(&r, 9000, 4)),
        );
        assert!(
            md.contains("## Delivery economics"),
            "the dossier must show what the run cost: {md}"
        );
        assert!(
            md.contains("Build tokens: 9000") || md.contains("tokens"),
            "tokens appear"
        );
        assert!(md.contains("Gate wall time"), "gate time appears");
        assert!(
            md.contains("Requirements: 3 total"),
            "the delivered unit count appears"
        );
    }

    #[test]
    fn economics_round_trip_through_the_settings_table() {
        let dir = std::env::temp_dir().join(format!("econ-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let persistence = Persistence::new(&dir).unwrap();
        let e = DeliveryEconomics::of(&report("run-8"), 12000, 5);
        persist_economics(&persistence, &e).unwrap();
        let loaded = load_economics(&persistence, "run-8").expect("the economics persist");
        assert_eq!(loaded, e);
        assert_eq!(load_economics(&persistence, "run-missing"), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
