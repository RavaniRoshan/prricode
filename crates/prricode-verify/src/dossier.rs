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
pub fn render_markdown(report: &VerificationReport, run_dir: &Path, diff_summary: &str) -> String {
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
        let outcome = if gate.passed { "passed" } else { "FAILED" };
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

    md
}

/// Persist one report: a settings row per gate record plus one JSON row
/// holding the whole report under `dossier:<run_id>`.
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
            id: record.id.clone(),
            run_id: record.run_id.clone(),
            gate: record.gate.clone(),
            command: record.command.clone(),
            exit_code: record.exit_code,
            passed: record.passed,
            evidence_tail: record.evidence_tail.clone(),
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
        let markdown =
            render_markdown(&report, Path::new("/tmp/run-9"), "5 files changed, +120/-3");
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
}
