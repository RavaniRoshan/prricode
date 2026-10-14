//! Ship, deploy, and operate record types.
//!
//! A ship record captures one release action (repo, tag, release URL,
//! install steps); a deploy plan describes where a built artifact goes and
//! which credentials it needs; health results and operate events capture
//! what happened after the ship.

use serde::{Deserialize, Serialize};

/// One shipped release: where it went, what it is called, and how to run it.
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ShipRecord {
    pub run_id: String,
    pub repo: String,
    pub release_url: Option<String>,
    pub tag: Option<String>,
    pub install_steps: Vec<String>,
    pub rolled_back_from: Option<String>,
    pub created_at: String,
}

impl ShipRecord {
    /// New record for a run: only the run id and creation date are set;
    /// the ship path fills in repo, tag, release URL, and install steps.
    pub fn new(run_id: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            repo: String::new(),
            release_url: None,
            tag: None,
            install_steps: Vec::new(),
            rolled_back_from: None,
            created_at: today_lite(),
        }
    }

    /// The install steps as a markdown bullet list.
    pub fn render_install_steps(&self) -> String {
        self.install_steps
            .iter()
            .map(|step| format!("- {step}"))
            .collect::<Vec<_>>()
            .join("\n")
    }
}

/// Where a built artifact should be deployed, how, and how to undo it.
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct DeployPlan {
    pub target: String,
    pub reason: String,
    pub required_credentials: Vec<CredentialRequest>,
    pub commands: Vec<String>,
    pub rollback: String,
}

/// One credential a deploy needs. Requests live in deploy plans only; they
/// are never copied into ship records or any other persisted record.
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct CredentialRequest {
    pub name: String,
    pub purpose: String,
    pub secret: bool,
}

impl CredentialRequest {
    pub fn new(name: &str, purpose: &str, secret: bool) -> Self {
        Self {
            name: name.to_string(),
            purpose: purpose.to_string(),
            secret,
        }
    }
}

/// Outcome of one post-deploy health probe.
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct HealthResult {
    pub name: String,
    pub url: Option<String>,
    pub command: Option<String>,
    pub ok: bool,
    pub detail: String,
}

impl HealthResult {
    /// Map a probe exit code onto a result: exit code 0 is healthy.
    pub fn from_exit(code: i32) -> Self {
        Self {
            name: String::new(),
            url: None,
            command: None,
            ok: code == 0,
            detail: format!("exit code {code}"),
        }
    }
}

/// One event in the operate log (health probe, rollback, redeploy).
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct OperateEvent {
    pub run_id: String,
    pub kind: String,
    pub detail: String,
    pub at: String,
}

impl OperateEvent {
    pub fn new(run_id: &str, kind: &str, detail: &str) -> Self {
        Self {
            run_id: run_id.to_string(),
            kind: kind.to_string(),
            detail: detail.to_string(),
            at: today_lite(),
        }
    }
}

/// Small date helper without pulling in chrono.
pub(crate) fn today_lite() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    let days = secs / 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant's civil-from-days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    ((if m <= 2 { y + 1 } else { y }), m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ship_record_serialization_carries_no_credentials() {
        // A secret credential request must never leak into a persisted
        // ShipRecord: the record has no field that could hold one.
        let cred = CredentialRequest::new("DEPLOY_TOKEN", "authenticate the deploy", true);
        assert!(cred.secret);
        let record = ShipRecord::new("run-1");
        let json = serde_json::to_string(&record).expect("record serializes");
        assert!(!json.contains("DEPLOY_TOKEN"), "{json}");
        assert!(!json.contains("secret"), "{json}");
        assert!(!json.contains("credential"), "{json}");
    }

    #[test]
    fn render_install_steps_renders_each_step_as_markdown() {
        let mut record = ShipRecord::new("run-2");
        record.install_steps = vec!["cargo build".to_string(), "cargo run".to_string()];
        let rendered = record.render_install_steps();
        assert!(rendered.contains("- cargo build"), "{rendered}");
        assert!(rendered.contains("- cargo run"), "{rendered}");
    }

    #[test]
    fn health_result_from_exit_maps_zero_to_ok() {
        assert!(HealthResult::from_exit(0).ok);
        assert!(!HealthResult::from_exit(1).ok);
        assert!(!HealthResult::from_exit(127).ok);
    }

    #[test]
    fn operate_event_new_fills_a_timestamp() {
        let event = OperateEvent::new("run-3", "rollback", "reverted to v0.2");
        assert_eq!(event.run_id, "run-3");
        assert_eq!(event.kind, "rollback");
        assert_eq!(event.detail, "reverted to v0.2");
        assert!(!event.at.is_empty());
        assert!(event.at.contains('-'), "date-shaped: {}", event.at);
    }

    #[test]
    fn deploy_plan_holds_commands_rollback_and_credentials() {
        let plan = DeployPlan {
            target: "staging".to_string(),
            reason: "verify before promote".to_string(),
            required_credentials: vec![CredentialRequest::new("SSH_KEY", "reach the host", true)],
            commands: vec!["scp artifact host:/srv".to_string()],
            rollback: "redeploy the previous artifact".to_string(),
        };
        assert_eq!(plan.required_credentials.len(), 1);
        assert!(plan.required_credentials[0].secret);
        assert!(!plan.commands.is_empty());
        assert!(!plan.rollback.is_empty());
    }
}
