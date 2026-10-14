//! Ship: install artifacts, a git tag, and a GitHub release via `gh`.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use tokio::process::Command;
use uuid::Uuid;

use prricode_verify::gates::StackKind;

use crate::{today_lite, ShipRecord};

/// Ship the current workspace: install artifacts in the worktree, a git
/// tag, and a GitHub release when `gh` is available and authenticated.
/// With zero credentials (no remote, no gh) the ship still succeeds and
/// records a tag-only release.
pub async fn ship_release(
    run_id: &str,
    workspace: &Path,
    version: Option<&str>,
) -> Result<ShipRecord> {
    // (1) The remote repo, normalized to owner/name; None when the remote
    // is missing or is not a GitHub remote.
    let repo = detect_remote(workspace).await;

    // Decide the release path up front (the probes are read-only) so the
    // tag can carry the tag-only note.
    let mut note = match &repo {
        None => Some("no GitHub remote configured".to_string()),
        Some(_) => {
            if !gh_on_path().await {
                Some("gh CLI not found on PATH".to_string())
            } else if !gh_authenticated().await {
                Some("gh not authenticated".to_string())
            } else {
                None
            }
        }
    };

    // (2) Install artifacts: INSTALL.md is written only when absent, so
    // operator edits survive a re-ship.
    let stack = StackKind::detect(workspace);
    let (install_md, install_steps) = install_artifacts(stack);
    let install_path = workspace.join("INSTALL.md");
    if !install_path.exists() {
        std::fs::write(&install_path, install_md).context("write INSTALL.md")?;
    }
    let has_readme = workspace.join("README.md").exists();

    // (3) Commit the artifacts; an empty worktree is not an error.
    git(workspace, &["add", "-A"]).await?;
    let commit = git(workspace, &["commit", "-m", "chore: install steps"]).await?;
    if !commit.success && !commit.combined().contains("nothing to commit") {
        anyhow::bail!("git commit failed: {}", commit.last_line(&commit.stderr));
    }

    // (4) Tag v<date>-<run-short>, or the supplied version.
    let tag = match version {
        Some(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => format!("v{}-{}", today_lite(), run_short(run_id)),
    };
    let mut message = tag_message(&tag, run_id, note.as_deref());
    git(workspace, &["tag", "-a", &tag, "-m", &message]).await?;

    // Push the branch + tag. A failed push is tolerated (zero-credential
    // ships keep the local tag) and folded into the tag's note.
    let branch = git(workspace, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await?
        .stdout_line();
    let (pushed, push_note) = push_branch_and_tag(workspace, &branch, &tag).await;
    if !pushed {
        note = Some(match note {
            Some(n) => format!("{n}; {push_note}"),
            None => push_note,
        });
        message = tag_message(&tag, run_id, note.as_deref());
        // The tag never reached a remote, so the local annotation is safe
        // to correct with the final note.
        git(workspace, &["tag", "-f", "-a", &tag, "-m", &message]).await?;
    }

    // (5) GitHub release only when gh is on PATH and authenticated; the
    // tag-only path stops here.
    let mut release_url = None;
    if note.is_none() {
        let dossier = release_notes(
            workspace,
            &tag,
            run_id,
            repo.as_deref(),
            &install_steps,
            has_readme,
        )
        .await?;
        let out = Command::new("gh")
            .args(["release", "create", &tag])
            .arg("--title")
            .arg(format!("Release {tag}"))
            .arg("--notes-file")
            .arg(&dossier)
            .current_dir(workspace)
            .output()
            .await
            .context("run gh release create")?;
        if !out.status.success() {
            anyhow::bail!(
                "gh release create {tag} failed: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            );
        }
        release_url = Some(String::from_utf8_lossy(&out.stdout).trim().to_string());
        if dossier != workspace.join("acceptance-dossier.md") {
            std::fs::remove_file(&dossier).ok();
        }
    }

    // (6) The record: tag set, release URL only on the GitHub path.
    let mut record = ShipRecord::new(run_id);
    record.repo = repo.unwrap_or_else(|| "local".to_string());
    record.tag = Some(tag);
    record.release_url = release_url;
    record.install_steps = install_steps;
    Ok(record)
}

struct GitOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

impl GitOutput {
    fn stdout_line(&self) -> String {
        self.stdout.trim().to_string()
    }

    fn combined(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }

    fn last_line(&self, text: &str) -> String {
        text.lines().last().unwrap_or_default().trim().to_string()
    }
}

async fn git(workspace: &Path, args: &[&str]) -> Result<GitOutput> {
    let out = Command::new("git")
        .args(args)
        .current_dir(workspace)
        .output()
        .await
        .with_context(|| format!("run git {args:?}"))?;
    Ok(GitOutput {
        success: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).to_string(),
        stderr: String::from_utf8_lossy(&out.stderr).to_string(),
    })
}

async fn push_branch_and_tag(workspace: &Path, branch: &str, tag: &str) -> (bool, String) {
    for args in [
        vec!["push", "-u", "origin", branch],
        vec!["push", "origin", tag],
    ] {
        match git(workspace, &args).await {
            Ok(out) if out.success => {}
            Ok(out) => {
                return (
                    false,
                    format!("git push failed: {}", out.last_line(&out.stderr)),
                )
            }
            Err(e) => return (false, format!("git push failed: {e}")),
        }
    }
    (true, String::new())
}

/// The remote repo as owner/name; None when there is no GitHub remote.
pub(crate) async fn detect_remote(workspace: &Path) -> Option<String> {
    let out = git(workspace, &["remote", "get-url", "origin"])
        .await
        .ok()?;
    if !out.success {
        return None;
    }
    normalize_github_remote(out.stdout_line().as_str())
}

/// Normalize a GitHub remote URL (https or scp-like ssh) to owner/name.
/// Non-GitHub remotes return None: gh cannot release against them.
fn normalize_github_remote(url: &str) -> Option<String> {
    let path = if let Some(rest) = url.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        if !is_github_host(host) {
            return None;
        }
        path
    } else if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .or_else(|| url.strip_prefix("ssh://"))
    {
        let (host, path) = rest.split_once('/')?;
        if !is_github_host(host) {
            return None;
        }
        path
    } else {
        return None;
    };
    let path = path.strip_suffix(".git").unwrap_or(path).trim_matches('/');
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(format!("{owner}/{name}"))
}

fn is_github_host(host: &str) -> bool {
    let host = host.rsplit('@').next().unwrap_or(host);
    let host = host.split(':').next().unwrap_or(host);
    matches!(
        host.to_ascii_lowercase().as_str(),
        "github.com" | "www.github.com"
    )
}

pub(crate) async fn gh_on_path() -> bool {
    Command::new("gh")
        .arg("--version")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn gh_authenticated() -> bool {
    Command::new("gh")
        .args(["auth", "status"])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// The markdown body and the one-command quickstart for the detected
/// stack, matching the GatePlan command set.
fn install_artifacts(stack: StackKind) -> (String, Vec<String>) {
    let (label, quickstart) = match stack {
        StackKind::Node => ("Node.js", "pnpm install && pnpm dev"),
        StackKind::Python => (
            "Python",
            "pip install -r requirements.txt && python3 -m <app>",
        ),
        StackKind::Rust => ("Rust", "cargo run"),
        StackKind::Unknown => ("unknown", ""),
    };
    if quickstart.is_empty() {
        return (
            "# Install\n\nNo recognized stack markers (package.json, pyproject.toml, \
             setup.py, Cargo.toml) were found; see README.md.\n"
                .to_string(),
            Vec::new(),
        );
    }
    let md = format!("# Install\n\nDetected stack: {label}\n\n```sh\n{quickstart}\n```\n");
    (md, vec![quickstart.to_string()])
}

fn tag_message(tag: &str, run_id: &str, note: Option<&str>) -> String {
    match note {
        Some(n) => format!("Release {tag} (run {run_id}) - {n}"),
        None => format!("Release {tag} (run {run_id})"),
    }
}

fn run_short(run_id: &str) -> String {
    run_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect()
}

/// The v0.2 acceptance dossier when present, else a generated notes stub.
async fn release_notes(
    workspace: &Path,
    tag: &str,
    run_id: &str,
    repo: Option<&str>,
    install_steps: &[String],
    has_readme: bool,
) -> Result<PathBuf> {
    let dossier = workspace.join("acceptance-dossier.md");
    if dossier.exists() {
        return Ok(dossier);
    }
    let mut notes = format!("# Release {tag}\n\nRun: {run_id}\nRepo: {repo:?}\n");
    if !install_steps.is_empty() {
        notes.push_str("\n## Install and run\n\n");
        for step in install_steps {
            notes.push_str(&format!("- {step}\n"));
        }
    }
    if !has_readme {
        notes.push_str("\n_No README.md in the worktree._\n");
    }
    let path = std::env::temp_dir().join(format!("prricode-notes-{}.md", Uuid::now_v7()));
    std::fs::write(&path, notes).context("write release notes stub")?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    async fn git(workspace: &Path, args: &[&str]) {
        let out = StdCommand::new("git")
            .args(args)
            .current_dir(workspace)
            .output()
            .unwrap_or_else(|e| panic!("git {args:?}: {e}"));
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[tokio::test]
    async fn ship_release_writes_install_artifacts_and_tags_without_remote() {
        let dir = std::env::temp_dir().join(format!("ship-release-{}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();

        // A Rust workspace with no remote: the gh-free, tag-only path.
        std::fs::write(
            dir.join("Cargo.toml"),
            "[package]\nname = \"probe\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
        )
        .unwrap();
        std::fs::write(dir.join("README.md"), "# probe\n").unwrap();
        git(&dir, &["init", "-q"]).await;
        git(&dir, &["config", "user.email", "ship@example.com"]).await;
        git(&dir, &["config", "user.name", "ship test"]).await;
        git(&dir, &["add", "-A"]).await;
        git(&dir, &["commit", "-q", "-m", "init"]).await;

        let record = ship_release("run-ship-1", &dir, None).await.unwrap();

        // INSTALL.md carries the detected stack's one-command install+run,
        // and the worktree is clean because it was committed.
        let install = std::fs::read_to_string(dir.join("INSTALL.md")).unwrap();
        assert!(install.contains("cargo run"), "{install}");
        assert!(
            record.install_steps.iter().any(|s| s.contains("cargo run")),
            "{:?}",
            record.install_steps
        );
        let status = StdCommand::new("git")
            .args(["status", "--porcelain"])
            .current_dir(&dir)
            .output()
            .unwrap();
        assert!(
            String::from_utf8_lossy(&status.stdout).trim().is_empty(),
            "install artifacts must be committed"
        );

        // The tag exists in the repo and is recorded; without a remote
        // there is no release URL and ship still succeeds.
        let tag = record.tag.expect("tag recorded");
        let out = StdCommand::new("git")
            .args(["tag", "--list"])
            .current_dir(&dir)
            .output()
            .unwrap();
        let tags = String::from_utf8_lossy(&out.stdout);
        assert!(tags.lines().any(|t| t == tag), "tags: {tags}");
        assert!(record.release_url.is_none());

        std::fs::remove_dir_all(&dir).ok();
    }
}
