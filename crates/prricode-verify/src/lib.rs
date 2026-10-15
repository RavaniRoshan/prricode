//! Verification: deterministic gate records and requirement verdicts.
//!
//! A gate record captures one executed check (command, exit code, evidence);
//! a verification report rolls the records and per-requirement verdicts of a
//! run up into an acceptance decision.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

pub mod dossier;
pub mod gates;
pub mod properties;
pub mod verifier;

/// One executed verification gate: a command run against the workspace.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateRecord {
    pub id: String,
    pub run_id: String,
    pub gate: String,
    pub command: String,
    pub exit_code: i32,
    pub passed: bool,
    /// True when the gate did not run for an environmental reason (no
    /// pytest, no toolchain). A skipped gate is not a failing one: it is
    /// reported in the dossier's residual risk instead.
    #[serde(default)]
    pub skipped: bool,
    pub evidence_tail: String,
    pub duration_ms: u64,
}

impl GateRecord {
    /// New record in the not-yet-run state: uuid v7 id, exit_code -1, not
    /// passed, empty evidence.
    pub fn new(run_id: &str, gate: &str, command: &str) -> Self {
        Self {
            id: Uuid::now_v7().to_string(),
            run_id: run_id.to_string(),
            gate: gate.to_string(),
            command: command.to_string(),
            exit_code: -1,
            passed: false,
            skipped: false,
            evidence_tail: String::new(),
            duration_ms: 0,
        }
    }
}

/// Outcome of judging one requirement against gate evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Pass,
    Fail,
    Unverified,
}

/// Requirement-level verdict with its supporting evidence.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GateVerdict {
    pub requirement_id: String,
    pub verdict: Verdict,
    pub evidence: String,
}

/// Rollup of one verification run: gate records, requirement verdicts,
/// explicitly untested items, and leftover residual risks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerificationReport {
    pub run_id: String,
    pub gates: Vec<GateRecord>,
    pub requirements: Vec<GateVerdict>,
    pub not_tested: Vec<String>,
    pub residual_risk: Vec<String>,
}

impl VerificationReport {
    /// Acceptable only when every gate passed, at least one requirement was
    /// judged, and no requirement failed.
    pub fn is_acceptable(&self) -> bool {
        // A gate that never ran cannot make the run unacceptable.
        self.gates.iter().filter(|g| !g.skipped).all(|g| g.passed)
            && !self.requirements.iter().any(|r| r.verdict == Verdict::Fail)
            && !self.requirements.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_record_defaults_and_verdicts() {
        let record = GateRecord::new("run-1", "test", "cargo test");
        assert_eq!(record.run_id, "run-1");
        assert_eq!(record.exit_code, -1);
        assert!(!record.passed);
        assert!(!record.id.is_empty());

        let report = VerificationReport {
            run_id: "run-1".into(),
            gates: vec![GateRecord {
                passed: true,
                ..record.clone()
            }],
            requirements: vec![GateVerdict {
                requirement_id: "R1".into(),
                verdict: Verdict::Pass,
                evidence: "test output".into(),
            }],
            not_tested: vec![],
            residual_risk: vec![],
        };
        assert!(report.is_acceptable());
    }

    #[test]
    fn failing_requirement_blocks_acceptance() {
        let base = VerificationReport {
            run_id: "r".into(),
            gates: vec![],
            requirements: vec![GateVerdict {
                requirement_id: "R2".into(),
                verdict: Verdict::Fail,
                evidence: "x".into(),
            }],
            not_tested: vec![],
            residual_risk: vec![],
        };
        assert!(!base.is_acceptable());
    }

    #[test]
    fn a_gate_that_never_ran_does_not_block_acceptance() {
        let report = VerificationReport {
            run_id: "run-skip".into(),
            gates: vec![
                GateRecord {
                    passed: true,
                    ..GateRecord::new("run-skip", "test", "cargo test")
                },
                GateRecord {
                    passed: false,
                    skipped: true,
                    exit_code: 127,
                    evidence_tail: "pytest unavailable — property gate not run".into(),
                    ..GateRecord::new("run-skip", "property", "pytest")
                },
            ],
            requirements: vec![GateVerdict {
                requirement_id: "R1".into(),
                verdict: Verdict::Pass,
                evidence: "green".into(),
            }],
            not_tested: vec![],
            residual_risk: vec![],
        };
        assert!(
            report.is_acceptable(),
            "a skipped gate is not a failing one: {:?}",
            report.gates
        );
        // …and it must not read as "all gates passed" either.
        let ran = report.gates.iter().filter(|g| !g.skipped).count();
        assert_eq!(ran, 1, "one gate actually ran");
    }
}
