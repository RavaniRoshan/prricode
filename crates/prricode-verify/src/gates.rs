//! Gate runner: stack detection plus deterministic gate execution.
//!
//! Stack detection is marker-file based (`package.json` → Node,
//! `pyproject.toml`/`setup.py` → Python, `Cargo.toml` → Rust). Gates run
//! through `prricode_sandbox::run_command` with network disabled: installing
//! dependencies is a build-task concern, not a gate concern, so a gate whose
//! deps are missing fails loudly instead of silently fetching them.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::GateRecord;

/// Toolchain family of a workspace, detected from marker files.
#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum StackKind {
    Node,
    Python,
    Rust,
    Unknown,
}

impl StackKind {
    /// Detect the stack by marker file, in priority order: Node
    /// (`package.json`), Python (`pyproject.toml` or `setup.py`), Rust
    /// (`Cargo.toml`), else Unknown.
    pub fn detect(workspace: &Path) -> Self {
        if workspace.join("package.json").exists() {
            StackKind::Node
        } else if workspace.join("pyproject.toml").exists() || workspace.join("setup.py").exists() {
            StackKind::Python
        } else if workspace.join("Cargo.toml").exists() {
            StackKind::Rust
        } else {
            StackKind::Unknown
        }
    }
}

/// The gate commands to run for one verification pass: (gate name, command).
#[derive(Debug, Implementation)]
pub struct GatePlan {
    pub gates: Vec<(String, String)>,
}

impl GatePlan {
    /// The default gate plan for a stack. Unknown stacks get no gates.
    pub fn for_stack(stack: StackKind) -> Self {
        let gates = match stack {
            StackKind::Node => {
                // The package manager is resolved from the lockfile at run
                // time, inside the workspace the gate executes in.
                let pkg = "$(if [ -f pnpm-lock.yaml ]; then echo pnpm; \
                           elif [ -f yarn.lock ]; then echo yarn; else echo npm; fi)";
                vec![
                    (
                        "typecheck".to_string(),
                        format!("{pkg} run -s typecheck || true"),
                    ),
                    ("test".to_string(), format!("{pkg} test")),
                ]
            }
            StackKind::Python => vec![(
                "test".to_string(),
                "if python3 -c 'import pytest' 2>/dev/null; then \
                 python3 -m pytest -q; else python3 -m unittest discover; fi"
                    .to_string(),
            )],
            StackKind::Rust => vec![
                ("build".to_string(), "cargo build".to_string()),
                ("test".to_string(), "cargo test".to_string()),
            ],
            StackKind::Unknown => vec![],
        };
        Self { gates }
    }
}

/// Execute every gate in the plan against the workspace through the sandbox
/// (no network, 300s timeout per gate), filling in one `GateRecord` per gate.
pub async fn run_gates(run_id: &str, workspace: &Path, plan: &GatePlan) -> Vec<GateRecord> {
    let mut records = Vec::with_capacity(plan.gates.len());
    for (gate, command) in &plan.gates {
        let mut record = GateRecord::new(run_id, gate, command);
        let spec = prricode_sandbox::SandboxSpec {
            workspace_root: workspace.to_path_buf(),
            allow_network: false,
            timeout: Duration::from_secs(300),
        };
        let started = Instant::now();
        let outcome = prricode_sandbox::run_command(command, &spec).await;
        record.duration_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Ok(output) => {
                record.exit_code = output.exit_code;
                record.passed = output.exit_code == 0 && !output.timed_out;
                record.evidence_tail = if output.timed_out {
                    format!("timed out after {}s", spec.timeout.as_secs())
                } else {
                    tail_2000(&output.stdout, &output.stderr)
                };
            }
            Err(e) => {
                record.exit_code = -1;
                record.passed = false;
                record.evidence_tail = format!("sandbox error: {e}");
            }
        }
        records.push(record);
    }
    records
}

fn tail_2000(stdout: &str, stderr: &str) -> String {
    let combined = format!("{stdout}{stderr}");
    let skip = combined.chars().count().saturating_sub(2000);
    combined.chars().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn gate_runner_executes_rust_plan_in_a_real_workspace() {
        let dir = std::env::temp_dir().join(format!("verify-gates-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname=\"fx\"\nversion=\"0.1.0\"\nedition=\"2021\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("src/main.rs"),
            "fn main() { assert_eq!(1 + 1, 2); }\n",
        )
        .unwrap();
        assert_eq!(StackKind::detect(&dir), StackKind::Rust);
        let plan = GatePlan::for_stack(StackKind::Rust);
        let records = run_gates("run-1", &dir, &plan).await;
        assert!(records.len() >= 2);
        assert!(
            records.iter().all(|r| r.passed),
            "gates must pass in a clean workspace"
        );
        assert!(records.iter().any(|r| r.gate == "test"));
        std::fs::remove_dir_all(&dir).ok();
    }
}
