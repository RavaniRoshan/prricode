//! Operate: probe the shipped artifact, keep an append-only run log, and
//! reopen a GitHub issue when a probe fails.
//!
//! A health probe is either an HTTP GET (2s timeout, 2xx/3xx is healthy)
//! or a command (exit 0 is healthy). Everything the log, the issue body,
//! and the probe detail carry is redacted first: the operate artifacts
//! record that a deploy happened, never the secret material.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::process::Command;

use crate::deploy;
use crate::{HealthResult, OperateEvent};

/// How long an HTTP probe waits before it counts as failed.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// How much of a command probe's output is kept in its detail.
const PROBE_TAIL_CHARS: usize = 200;

/// The operate log kind recorded for one issue-reopen attempt.
const REOPEN_EVENT_KIND: &str = "issue-reopen";

/// Run one health probe: HTTP GET the url when the probe has one (2xx/3xx
/// is healthy), else run the command (exit 0 is healthy). The probe is
/// filled in place; a refused connection or a non-zero exit is a failed
/// probe, not an error.
pub async fn health_check(result: &mut HealthResult) -> Result<()> {
    match result.url.implementation() {
        Some(url) => check_url(result, &url).await,
        None => {
            let command = result.command.implementation().ok_or_else(|| {
                anyhow::anyhow!(
                    "a health probe needs a url or a command, {} has neither",
                    result.name
                )
            })?;
            check_command(result, &command).await
        }
    }
}

/// Append one event to the run's JSONL log at
/// `<data_dir>/operate/<run_id>.jsonl`, creating the file and its
/// directory on first use.
pub fn append_operate_log(data_dir: &Path, run_id: &str, event: &OperateEvent) -> Result<()> {
    let path = log_path(data_dir, run_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("create the operate log directory")?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("open the operate log {}", path.display()))?;
    serde_json::to_writer(&mut file, event).context("write the operate event")?;
    file.write_all(b"\n")
        .context("terminate the operate event line")?;
    Ok(())
}

/// Read the run's operate log back, oldest event first. A run with no
/// events yet (no file) is an empty log, not an error; a line that does
/// not parse is skipped rather than failing the whole read.
pub fn read_operate_log(data_dir: &Path, run_id: &str) -> Result<Vec<OperateEvent>> {
    let path = log_path(data_dir, run_id);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(e).with_context(|| format!("read the operate log {}", path.display()))
        }
    };
    Ok(text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<OperateEvent>(line).ok())
        .collect())
}

/// Reopen a GitHub issue describing a failed operate pass. Returns the
/// issue URL, or None when there is nothing to open it on (no GitHub
/// remote), no `gh` on PATH, or the `gh` call itself failed: a failed
/// reopen is recorded in the operate log and never fails the pipeline.
pub async fn reopen_issue_on_failure(
    workspace: &Path,
    run_id: &str,
    title: &str,
    evidence: &str,
) -> Result<Option<String>> {
    Ok(reopen_attempt(workspace, run_id, title, evidence)
        .await
        .issue)
}

/// The reopen plus its operate-log record. Use this when the caller has
/// a data dir: the attempt is logged whether or not an issue was opened,
/// so a missing `gh` or remote is visible after the fact.
pub async fn reopen_and_log(
    data_dir: &Path,
    workspace: &Path,
    run_id: &str,
    title: &str,
    evidence: &str,
) -> Result<Option<String>> {
    let attempt = reopen_attempt(workspace, run_id, title, evidence).await;
    append_operate_log(
        data_dir,
        run_id,
        &OperateEvent::new(run_id, REOPEN_EVENT_KIND, &attempt.note),
    )?;
    Ok(attempt.issue)
}

/// One attempt to reopen an issue: the opened issue's URL (when it was
/// opened) and the note that explains either outcome.
struct ReopenAttempt {
    issue: Option<String>,
    note: String,
}

impl ReopenAttempt {
    fn skipped(reason: &str) -> Self {
        Self {
            issue: None,
            note: format!("skipped: {reason}"),
        }
    }

    fn opened(url: String) -> Self {
        Self {
            note: format!("opened {url}"),
            issue: Some(url),
        }
    }

    fn failed(detail: &str) -> Self {
        Self {
            issue: None,
            note: format!("failed: {detail}"),
        }
    }
}

async fn reopen_attempt(
    workspace: &Path,
    run_id: &str,
    title: &str,
    evidence: &str,
) -> ReopenAttempt {
    if crate::release::detect_remote(workspace).await.is_none() {
        return ReopenAttempt::skipped("no GitHub remote in this workspace");
    }
    if !crate::release::gh_on_path().await {
        return ReopenAttempt::skipped("gh is not on PATH");
    }
    let body = issue_body(run_id, title, evidence);
    let spawned = Command::new("gh")
        .args(["issue", "create", "--title", title, "--body", &body])
        .current_dir(workspace)
        .output()
        .await;
    match spawned {
        Err(e) => ReopenAttempt::failed(&deploy::redact_patterns(&e.to_string())),
        Ok(output) => attempt_from_output(Some(output)),
    }
}

/// Map a finished (or missing) `gh` invocation onto the attempt outcome.
/// A non-zero exit is a failed reopen, not an error, and its stderr is
/// redacted before it reaches the note.
fn attempt_from_output(output: Option<Output>) -> ReopenAttempt {
    let output = match output {
        Some(output) => output,
        None => return ReopenAttempt::failed("gh could not be started"),
    };
    if output.status.success() {
        return ReopenAttempt::opened(String::from_utf8_lossy(&output.stdout).trim().to_string());
    }
    let code = output.status.code().unwrap_or(-1);
    let stderr = deploy::redact_patterns(String::from_utf8_lossy(&output.stderr).trim());
    ReopenAttempt::failed(&format!("gh issue create exited {code}: {stderr}"))
}

/// The issue body: what failed, the run it belongs to, and the redacted
/// evidence.
fn issue_body(run_id: &str, title: &str, evidence: &str) -> String {
    format!(
        "## What failed\n\n{title}\n\n## Run\n\n{run_id}\n\n## Evidence\n\n```\n{}\n```\n",
        deploy::redact_patterns(evidence.trim())
    )
}

async fn check_url(result: &mut HealthResult, url: &str) -> Result<()> {
    let client = match reqwest::Client::builder().timeout(HEALTH_TIMEOUT).build() {
        Ok(client) => client,
        Err(e) => {
            result.ok = false;
            result.detail = format!("client error: {e}");
            return Ok(());
        }
    };
    match client.get(url).send().await {
        Ok(response) => {
            let status = response.status();
            result.ok = status.is_success() || status.is_redirection();
            result.detail = format!("HTTP {status}");
        }
        // A url can carry a token of its own, so the error is redacted too.
        Err(e) => {
            result.ok = false;
            result.detail = format!(
                "request failed: {}",
                deploy::redact_patterns(&e.to_string())
            );
        }
    }
    Ok(())
}

async fn check_command(result: &mut HealthResult, command: &str) -> Result<()> {
    let output = Command::new("sh")
        .arg("-c")
        .arg(command)
        .output()
        .await
        .with_context(|| format!("run health probe `{command}`"))?;
    let code = output.status.code().unwrap_or(-1);
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let tail = tail_chars(&deploy::redact_patterns(combined.trim()), PROBE_TAIL_CHARS);
    result.ok = output.status.success();
    result.detail = if tail.is_empty() {
        format!("exit code {code}")
    } else {
        format!("exit code {code}; {tail}")
    };
    Ok(())
}

/// The run's log path: `<data_dir>/operate/<run_id>.jsonl`. A run id is
/// reduced to a file name so it can only ever name a file inside the
/// operate directory.
fn log_path(data_dir: &Path, run_id: &str) -> PathBuf {
    let safe: String = run_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.is_empty() {
        "run".to_string()
    } else {
        safe
    };
    data_dir.join("operate").join(format!("{safe}.jsonl"))
}

/// The last `chars` characters of `text`.
fn tail_chars(text: &str, chars: usize) -> String {
    let skip = text.chars().count().saturating_sub(chars);
    text.chars().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("ship-operate-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A probe with no result yet: one url or one command, never both.
    fn probe(name: &str, url: Option<&str>, command: Option<&str>) -> HealthResult {
        HealthResult {
            name: name.to_string(),
            url: url.map(str::to_string),
            command: command.map(str::to_string),
            ok: true,
            detail: String::new(),
        }
    }

    #[test]
    fn operate_log_round_trips_events_as_jsonl() {
        let data = temp_dir("log");
        let run = "run-operate-1";

        append_operate_log(&data, run, &OperateEvent::new(run, "deploy", "target fly")).unwrap();
        append_operate_log(
            &data,
            run,
            &OperateEvent::new(run, "health", "http ok: HTTP 200 OK"),
        )
        .unwrap();

        let events = read_operate_log(&data, run).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].run_id, run);
        assert_eq!(events[0].kind, "deploy");
        assert_eq!(events[0].detail, "target fly");
        assert_eq!(events[1].kind, "health");

        // The file is JSONL: one self-describing object per line.
        let path = data.join("operate").join(format!("{run}.jsonl"));
        let raw = std::fs::read_to_string(&path).unwrap();
        assert_eq!(raw.lines().count(), 2, "{raw}");
        assert!(
            raw.lines()
                .all(|line| line.starts_with('{') && line.contains("\"run_id\"")),
            "{raw}"
        );

        std::fs::remove_dir_all(&data).ok();
    }

    #[test]
    fn read_operate_log_is_empty_for_a_run_with_no_events() {
        let data = temp_dir("empty-log");
        assert!(read_operate_log(&data, "never-seen").unwrap().is_empty());
        std::fs::remove_dir_all(&data).ok();
    }

    #[tokio::test]
    async fn health_check_runs_the_command_and_maps_the_exit_code() {
        let mut ok = probe("cli", None, Some("exit 0"));
        health_check(&mut ok).await.unwrap();
        assert!(ok.ok, "{}", ok.detail);
        assert!(ok.detail.contains("exit code 0"), "{}", ok.detail);

        let mut failed = probe("cli", None, Some("echo boom 1>&2; exit 3"));
        health_check(&mut failed).await.unwrap();
        assert!(!failed.ok);
        assert!(failed.detail.contains("exit code 3"), "{}", failed.detail);
        assert!(failed.detail.contains("boom"), "{}", failed.detail);

        // A probe that leaks a token into its output must not carry it
        // into the recorded detail.
        let mut leaky = probe(
            "cli",
            None,
            Some(r#"echo 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'"#),
        );
        health_check(&mut leaky).await.unwrap();
        assert!(leaky.ok, "{}", leaky.detail);
        assert!(
            !leaky
                .detail
                .contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            "{}",
            leaky.detail
        );
        assert!(leaky.detail.contains("[REDACTED]"), "{}", leaky.detail);

        let mut neither = probe("cli", None, None);
        assert!(health_check(&mut neither).await.is_err());
    }

    #[tokio::test]
    async fn health_check_gets_the_url_and_treats_2xx_and_3xx_as_ok() {
        let healthy = spawn_status_line("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await;
        let mut ok = probe("http", Some(&healthy), None);
        health_check(&mut ok).await.unwrap();
        assert!(ok.ok, "{}", ok.detail);
        assert!(ok.detail.contains("200"), "{}", ok.detail);

        let redirect =
            spawn_status_line("HTTP/1.1 304 Not Modified\r\nContent-Length: 0\r\n\r\n").await;
        let mut cached = probe("http", Some(&redirect), None);
        health_check(&mut cached).await.unwrap();
        assert!(cached.ok, "{}", cached.detail);
        assert!(cached.detail.contains("304"), "{}", cached.detail);
    }

    /// A one-connection HTTP server that always answers with `status_line`.
    async fn spawn_status_line(status_line: &str) -> String {
        use tokio::io::AsyncWriteExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let line = status_line.to_string();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let _ = socket.write_all(line.as_bytes()).await;
            }
        });
        format!("http://{address}/")
    }

    #[tokio::test]
    async fn reopen_issue_on_failure_returns_none_without_a_github_remote() {
        // A temp dir that is not a git repo at all: no remote, and no
        // `gh issue create` may run against the operator's real remote.
        let workspace = temp_dir("reopen-nonrepo");

        let issue = reopen_issue_on_failure(
            &workspace,
            "run-reopen-1",
            "health check failed",
            "evidence",
        )
        .await
        .unwrap();

        assert!(issue.is_none());
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn a_failed_gh_call_maps_to_none_with_a_redacted_note() {
        // A gh-shaped failure (non-zero exit, token-shaped stderr) must
        // become Ok(None), never an Err, and must not leak the token.
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg("echo 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' 1>&2; exit 1")
            .output()
            .unwrap();
        let attempt = attempt_from_output(Some(output));
        assert!(attempt.issue.is_none());
        assert!(attempt.note.contains("[REDACTED]"), "{}", attempt.note);
        assert!(
            !attempt
                .note
                .contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            "{}",
            attempt.note
        );
    }

    #[test]
    fn a_successful_gh_call_reports_the_issue_url() {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg("echo https://example.invalid/issues/7")
            .output()
            .unwrap();
        let attempt = attempt_from_output(Some(output));
        assert_eq!(
            attempt.issue.as_deref(),
            Some("https://example.invalid/issues/7")
        );
        assert!(attempt.note.contains("issues/7"), "{}", attempt.note);
    }

    #[tokio::test]
    async fn reopen_and_log_records_the_attempt_in_the_operate_log() {
        let data = temp_dir("reopen-log-data");
        let workspace = temp_dir("reopen-log-ws");

        let issue = reopen_and_log(
            &data,
            &workspace,
            "run-reopen-2",
            "health check failed",
            "evidence without tokens",
        )
        .await
        .unwrap();

        assert!(issue.is_none(), "no GitHub remote, so nothing is opened");
        let events = read_operate_log(&data, "run-reopen-2").unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "issue-reopen");
        assert!(
            events[0].detail.contains("no GitHub remote"),
            "{}",
            events[0].detail
        );

        std::fs::remove_dir_all(&data).ok();
        std::fs::remove_dir_all(&workspace).ok();
    }

    #[test]
    fn issue_body_names_the_failure_the_run_and_the_redacted_evidence() {
        let body = issue_body(
            "run-reopen-3",
            "health check failed for the web probe",
            "API_KEY=abcdef1234567890\nghp_abcdefghijklmnopqrstuvwxyz0123456789\nconnection refused",
        );

        assert!(body.contains("health check failed for the web probe"));
        assert!(body.contains("run-reopen-3"));
        assert!(body.contains("connection refused"));
        assert!(body.contains("[REDACTED]"));
        assert!(!body.contains("abcdef1234567890"), "{body}");
        assert!(
            !body.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"),
            "{body}"
        );
    }
}
