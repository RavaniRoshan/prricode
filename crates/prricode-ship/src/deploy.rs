//! Deploy: propose a target from the workspace's own config, name exactly
//! the credentials it needs, and run the target's commands with those
//! credentials as child-process environment variables only.
//!
//! Secrets hygiene (founder ruling): the secrets map is handed to the
//! child through `Command::envs` and nowhere else. It is never written to
//! a file, the operate log, the dossier, or the DB, and any captured
//! output is redacted before it is returned or stored.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{Context, Result};
use regex::Regex;
use tokio::process::Command;

use serde::{Deserialize, Serialize};

use prricode_verify::gates::StackKind;

use crate::{CredentialRequest, DeployPlan};

/// The output convention a deploy command honors so its release id can be
/// captured: the command prints `release_id: <id>`. Plans carry this
/// pattern in `DeployPlan::release_id_regex`.
pub const RELEASE_ID_PATTERN: &str = r"release_id:[ \t]*(\S+)";

/// What replaces redacted material in captured deploy output.
pub const REDACTED: &str = "[REDACTED]";

/// How long one deploy command may run before the child is killed.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(600);

/// How much of the captured output a plan outcome keeps.
const TAIL_CHARS: usize = 2000;

/// One row of the target table: the config marker that identifies a
/// deploy target and everything the plan for it needs.
struct TargetRow {
    /// Marker file whose presence identifies the target.
    marker: &'static str,
    /// Target name reported to the operator.
    target: &'static str,
    /// One-line reason shown when the marker is present.
    reason: &'static str,
    /// Reason used instead of `reason` when the workspace also has a
    /// Dockerfile (a container deploy rather than a source deploy).
    container_reason: Option<&'static str>,
    /// (env var name, what the deploy needs it for)
    credentials: &'static [(&'static str, &'static str)],
    /// Commands run in order, each through the shell in the workspace.
    commands: &'static [&'static str],
    /// One command that undoes the deploy.
    rollback: &'static str,
}

/// The marker table, in detection order: the first marker present in the
/// workspace wins. Adding a target means adding one row here; a workspace
/// with no row matches gets the manual plan below.
const TARGET_TABLE: &[TargetRow] = &[
    TargetRow {
        marker: "wrangler.toml",
        target: "cloudflare-workers",
        reason: "wrangler.toml is present, so this workspace deploys to Cloudflare Workers/Pages",
        container_reason: None,
        credentials: &[(
            "CLOUDFLARE_API_TOKEN",
            "authenticate the wrangler CLI for this deploy",
        )],
        commands: &["wrangler deploy"],
        rollback: "wrangler rollback",
    },
    TargetRow {
        marker: "fly.toml",
        target: "fly",
        reason: "fly.toml is present, so this workspace deploys as a Fly app",
        container_reason: Some(
            "fly.toml plus a Dockerfile means the container image is built and deployed to Fly",
        ),
        credentials: &[("FLY_API_TOKEN", "authenticate the fly CLI for this deploy")],
        commands: &["fly deploy"],
        rollback: "fly releases rollback",
    },
    TargetRow {
        marker: "vercel.json",
        target: "vercel",
        reason: "vercel.json is present, so this workspace deploys to Vercel",
        container_reason: None,
        credentials: &[(
            "VERCEL_TOKEN",
            "authenticate the Vercel CLI for this deploy",
        )],
        commands: &["vercel deploy --prod"],
        rollback: "vercel rollback",
    },
    TargetRow {
        marker: "Procfile",
        target: "heroku",
        reason: "Procfile is present, so this workspace deploys to Heroku",
        container_reason: None,
        credentials: &[(
            "HEROKU_API_KEY",
            "authenticate the Heroku CLI for this deploy",
        )],
        commands: &["git push heroku main"],
        rollback: "heroku rollback",
    },
];

/// The outcome of running a deploy plan's commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployOutcome {
    /// True when every command in the plan exited zero.
    pub ok: bool,
    /// The release id the deploy printed, when the plan says how to read it.
    pub release_id: Option<String>,
    /// The plan's rollback command, or a note when the plan has none.
    pub rollback_hint: String,
    /// Redacted tail of the commands' combined output.
    pub output_tail: String,
}

/// Propose a deploy target from the workspace's own config markers, in
/// table order (Cloudflare, Fly, Vercel, Heroku). When nothing matches,
/// the plan is `manual`: no commands, no credentials, and a reason asking
/// the operator to describe the target they want.
pub fn propose_target(workspace: &Path) -> DeployPlan {
    let has_dockerfile = workspace.join("Dockerfile").exists();
    for row in TARGET_TABLE {
        if !workspace.join(row.marker).exists() {
            continue;
        }
        let reason = match (row.container_reason, has_dockerfile) {
            (Some(container), true) => container,
            _ => row.reason,
        };
        return DeployPlan {
            target: row.target.to_string(),
            reason: reason.to_string(),
            required_credentials: row
                .credentials
                .iter()
                .map(|(name, purpose)| CredentialRequest::new(name, purpose, true))
                .collect(),
            commands: row.commands.iter().map(|c| c.to_string()).collect(),
            rollback: row.rollback.to_string(),
            release_id_regex: Some(RELEASE_ID_PATTERN.to_string()),
        };
    }
    manual_plan(workspace)
}

/// The env var names a plan's credentials need, for the collection UI.
pub fn required_env(plan: &DeployPlan) -> Vec<String> {
    plan.required_credentials
        .iter()
        .map(|cred| cred.name.clone())
        .collect()
}

/// Run the plan's commands in the workspace with the collected secrets
/// passed as child-process environment variables only. The captured
/// output is redacted before it is returned; the release id is read from
/// the raw output first, so redaction cannot eat it.
pub async fn execute_deploy(
    workspace: &Path,
    plan: &DeployPlan,
    secrets: &HashMap<String, String>,
) -> Result<DeployOutcome> {
    if plan.commands.is_empty() {
        anyhow::bail!(
            "deploy plan for target {:?} has no commands to run; describe the target first",
            plan.target
        );
    }

    let mut combined = String::new();
    let mut ok = true;
    for command in &plan.commands {
        let child = tokio::time::timeout(
            COMMAND_TIMEOUT,
            Command::new("sh")
                .arg("-c")
                .arg(command)
                .current_dir(workspace)
                .envs(secrets)
                .output(),
        )
        .await;
        let output = match child {
            Ok(result) => result.with_context(|| format!("run deploy command `{command}`"))?,
            Err(_) => {
                anyhow::bail!("deploy command `{command}` timed out");
            }
        };
        combined.push_str(&String::from_utf8_lossy(&output.stdout));
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        if !output.status.success() {
            ok = false;
        }
    }

    let release_id = if ok {
        extract_release_id(&combined, plan)
    } else {
        None
    };

    Ok(DeployOutcome {
        ok,
        release_id,
        rollback_hint: rollback_hint(plan),
        output_tail: tail_chars(&redact(&combined, secrets), TAIL_CHARS),
    })
}

/// Redact the collected secrets' values and every token-shaped pattern
/// from `text`. Secret values are matched exactly, so a value is redacted
/// wherever it appears, including inside a larger line.
pub fn redact(text: &str, secrets: &HashMap<String, String>) -> String {
    let mut redacted = text.to_string();
    for value in secrets.values() {
        if value.len() < MIN_SECRET_CHARS {
            continue;
        }
        redacted = redacted.replace(value, REDACTED);
    }
    redact_patterns(&redacted)
}

/// Pattern-only redaction: assignments whose variable name marks secret
/// material (`*_TOKEN=...`, `api_key: ...`) and the well-known token
/// shapes. Operate uses this because it has no collected values to match.
pub fn redact_patterns(text: &str) -> String {
    let mut redacted = text.to_string();
    for pattern in token_patterns() {
        redacted = pattern.replace_all(&redacted, REDACTED).to_string();
    }
    for captures in env_secret_assignments().captures_iter(text) {
        let whole = captures.get(0).map(|m| m.as_str()).unwrap_or_default();
        let name = captures
            .get(1)
            .map(|m| m.as_str())
            .unwrap_or_default()
            .to_string();
        if whole.is_empty() {
            continue;
        }
        redacted = redacted.replace(whole, &format!("{name}={REDACTED}"));
    }
    redacted
}

/// The plan for a workspace nothing matches: the operator describes the
/// target, so the plan carries nothing an agent could run.
fn manual_plan(workspace: &Path) -> DeployPlan {
    let stack = match StackKind::detect(workspace) {
        StackKind::Node => "Node.js",
        StackKind::Python => "Python",
        StackKind::Rust => "Rust",
        StackKind::Unknown => "unrecognized",
    };
    DeployPlan {
        target: "manual".to_string(),
        reason: format!(
            "no deploy target was recognized (looked for wrangler.toml, fly.toml, vercel.json, \
             Procfile) in this {stack} workspace; describe the target you want and the commands \
             that ship to it"
        ),
        required_credentials: Vec::new(),
        commands: Vec::new(),
        rollback: String::new(),
        release_id_regex: None,
    }
}

/// The plan's rollback command, or a note when it has none.
fn rollback_hint(plan: &DeployPlan) -> String {
    if plan.rollback.trim().is_empty() {
        return format!(
            "no rollback command recorded for target {:?}; record the previous release id \
             before redeploying",
            plan.target
        );
    }
    plan.rollback.clone()
}

/// Shortest value `redact` will replace. Short strings collide with
/// ordinary output far too often to be worth the false positives.
const MIN_SECRET_CHARS: usize = 4;

/// Read the release id out of the raw deploy output using the plan's
/// pattern. An id that redaction would strip is dropped rather than
/// returned: anything secret-shaped is not an id.
fn extract_release_id(output: &str, plan: &DeployPlan) -> Option<String> {
    let pattern = plan.release_id_regex.as_deref()?;
    let regex = Regex::new(pattern).ok()?;
    let id = regex.captures(output)?.get(1)?.as_str().to_string();
    if redact(&id, &HashMap::new()).contains(REDACTED) {
        return None;
    }
    Some(id)
}

/// The last `chars` characters of `text`.
fn tail_chars(text: &str, chars: usize) -> String {
    let skip = text.chars().count().saturating_sub(chars);
    text.chars().skip(skip).collect()
}

/// A variable assignment whose name marks secret material, with a value
/// long enough to be a credential rather than a flag or a number.
fn env_secret_assignments() -> &'static Regex {
    static ASSIGNMENTS: OnceLock<Regex> = OnceLock::new();
    ASSIGNMENTS.get_or_init(|| {
        Regex::new(
            r#"(?i)\b([A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)[ \t]*[=:][ \t]*"?[^\s"']{8,}"?"#,
        )
        .expect("env-secret assignment pattern compiles")
    })
}

/// The well-known token shapes: the prefixes a scanning tool would flag.
/// Each is anchored so ordinary prose ("risk-…", "task-…") does not match.
fn token_patterns() -> &'static Vec<Regex> {
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            r"\bghp_[A-Za-z0-9]{20,}",
            r"\bgithub_pat_[A-Za-z0-9_]{20,}",
            r"\bsk-[A-Za-z0-9_-]{20,}",
            r"\bAKIA[0-9A-Z]{12,}",
            r"\bxox[bap]-[A-Za-z0-9-]{10,}",
            r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        ]
        .iter()
        .map(|pattern| Regex::new(pattern).expect("token pattern compiles"))
        .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_workspace(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ship-deploy-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn plan_for(commands: Vec<&str>) -> DeployPlan {
        DeployPlan {
            target: "probe".to_string(),
            reason: "probe plan".to_string(),
            required_credentials: vec![CredentialRequest::new(
                "DEPLOY_TOKEN",
                "authenticate",
                true,
            )],
            commands: commands.into_iter().map(str::to_string).collect(),
            rollback: "echo rolled back".to_string(),
            release_id_regex: Some(RELEASE_ID_PATTERN.to_string()),
        }
    }

    #[test]
    fn wrangler_toml_proposes_cloudflare_with_its_credential() {
        let dir = temp_workspace("wrangler");
        std::fs::write(
            dir.join("wrangler.toml"),
            "name = \"probe\"\nmain = \"src/index.ts\"\n",
        )
        .unwrap();

        let plan = propose_target(&dir);

        assert!(
            plan.target.contains("cloudflare"),
            "target: {}",
            plan.target
        );
        assert_eq!(
            required_env(&plan),
            vec!["CLOUDFLARE_API_TOKEN".to_string()]
        );
        assert!(
            plan.commands.iter().any(|c| c.contains("wrangler deploy")),
            "commands: {:?}",
            plan.commands
        );
        assert_eq!(plan.rollback, "wrangler rollback");
        assert!(plan.release_id_regex.is_some());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn marker_table_proposes_a_target_per_config_marker() {
        // Dockerfile + fly.toml is a container deploy on Fly; fly.toml
        // alone is the same target by a different route; vercel.json and
        // Procfile carry their own CLI + credential.
        let fly = temp_workspace("fly-container");
        std::fs::write(fly.join("fly.toml"), "app = \"probe\"\n").unwrap();
        std::fs::write(fly.join("Dockerfile"), "FROM scratch\n").unwrap();
        let container = propose_target(&fly);
        assert!(
            container.target.contains("fly"),
            "target: {}",
            container.target
        );
        assert!(
            container.reason.contains("container"),
            "reason: {}",
            container.reason
        );
        assert_eq!(required_env(&container), vec!["FLY_API_TOKEN".to_string()]);
        assert!(container.commands.iter().any(|c| c.contains("fly deploy")));
        assert_eq!(container.rollback, "fly releases rollback");

        let bare_fly = temp_workspace("fly-bare");
        std::fs::write(bare_fly.join("fly.toml"), "app = \"probe\"\n").unwrap();
        let bare = propose_target(&bare_fly);
        assert!(bare.target.contains("fly"), "target: {}", bare.target);
        assert!(
            !bare.reason.contains("container"),
            "reason: {}",
            bare.reason
        );

        let vercel = temp_workspace("vercel");
        std::fs::write(vercel.join("vercel.json"), "{}\n").unwrap();
        let vercel_plan = propose_target(&vercel);
        assert!(
            vercel_plan.target.contains("vercel"),
            "target: {}",
            vercel_plan.target
        );
        assert_eq!(required_env(&vercel_plan), vec!["VERCEL_TOKEN".to_string()]);

        let heroku = temp_workspace("heroku");
        std::fs::write(heroku.join("Procfile"), "web: node server.js\n").unwrap();
        let heroku_plan = propose_target(&heroku);
        assert_eq!(
            required_env(&heroku_plan),
            vec!["HEROKU_API_KEY".to_string()]
        );
        assert!(
            heroku_plan
                .commands
                .iter()
                .any(|c| c.contains("git push heroku")),
            "commands: {:?}",
            heroku_plan.commands
        );

        for dir in [fly, bare_fly, vercel, heroku] {
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    #[test]
    fn empty_workspace_proposes_a_manual_plan() {
        let dir = temp_workspace("manual");

        let plan = propose_target(&dir);

        assert_eq!(plan.target, "manual");
        assert!(plan.commands.is_empty(), "commands: {:?}", plan.commands);
        assert!(plan.required_credentials.is_empty());
        assert!(
            plan.reason.to_lowercase().contains("describe"),
            "reason: {}",
            plan.reason
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn redact_replaces_a_secret_value_and_a_token_pattern() {
        let mut secrets = HashMap::new();
        secrets.insert(
            "DEPLOY_TOKEN".to_string(),
            "sup3r-s3cret-deploy-token-value".to_string(),
        );
        let raw = concat!(
            "handoff value sup3r-s3cret-deploy-token-value\n",
            "API_KEY=abcdef1234567890\n",
            "GH_TOKEN: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
            "release_id: rel-42\n",
        );

        let redacted = redact(raw, &secrets);

        assert!(
            !redacted.contains("sup3r-s3cret-deploy-token-value"),
            "{redacted}"
        );
        assert!(!redacted.contains("abcdef1234567890"), "{redacted}");
        assert!(
            !redacted.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            "{redacted}"
        );
        assert!(redacted.contains("[REDACTED]"), "{redacted}");
        // The release-id convention must survive redaction untouched.
        assert!(redacted.contains("release_id: rel-42"), "{redacted}");
    }

    #[tokio::test]
    async fn execute_deploy_passes_secrets_as_env_only_and_hides_them() {
        let dir = temp_workspace("env-only");
        let secret = "sup3r-s3cret-deploy-token-value";
        let mut secrets = HashMap::new();
        secrets.insert("DEPLOY_TOKEN".to_string(), secret.to_string());
        let plan = plan_for(vec![r#"printf 'token_len=%s\n' "${#DEPLOY_TOKEN}""#]);

        let outcome = execute_deploy(&dir, &plan, &secrets).await.unwrap();

        assert!(outcome.ok, "tail: {}", outcome.output_tail);
        // The child process saw the credential through its environment.
        assert!(
            outcome
                .output_tail
                .contains(&format!("token_len={}", secret.len())),
            "tail: {}",
            outcome.output_tail
        );
        // The captured tail never carries the secret material.
        assert!(
            !outcome.output_tail.contains(secret),
            "tail: {}",
            outcome.output_tail
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn execute_deploy_extracts_the_release_id_and_redacts_leaked_tokens() {
        let dir = temp_workspace("release-id");
        let plan = plan_for(vec![
            r#"printf 'deploying\nrelease_id: rel-42\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked\n'"#,
        ]);

        let outcome = execute_deploy(&dir, &plan, &HashMap::new()).await.unwrap();

        assert_eq!(outcome.release_id.as_deref(), Some("rel-42"));
        assert!(outcome.ok);
        assert!(
            outcome.output_tail.contains("[REDACTED]"),
            "tail: {}",
            outcome.output_tail
        );
        assert!(
            !outcome
                .output_tail
                .contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            "tail: {}",
            outcome.output_tail
        );
        assert_eq!(outcome.rollback_hint, "echo rolled back");

        std::fs::remove_dir_all(&dir).ok();
    }
}
