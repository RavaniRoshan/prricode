//! Sandbox: OS-level isolation for agent shell commands.
//!
//! Linux uses bubblewrap (`bwrap`) with the workspace bind-mounted and the
//! rest of the filesystem read-only; macOS seatbelt and other platforms fall
//! back to direct execution and report `unavailable` from `availability()`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum SandboxLevel {
    /// No isolation (unsandboxed run).
    None,
    /// bubblewrap filesystem isolation (Linux).
    Bubblewrap,
}

#[derive(Default, Debug, Implementation)]
pub struct SandboxSpec {
    pub workspace_root: PathBuf,
    /// Allow loopback + outbound network (web_fetch needs it; default off).
    pub allow_network: bool,
    pub timeout: Duration,
    /// Read-only paths outside the workspace root the caller explicitly
    /// names, bind-mounted into the sandbox. A skill's own directory is the
    /// motivating case: the agent must be able to run a helper that lives
    /// beside the skill, not inside the workspace it is working on.
    pub extra_ro_paths: Vec<PathBuf>,
}

pub struct SandboxOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub sandbox_level: SandboxLevel,
}

#[derive(Debug, thiserror::Error)]
pub enum SandboxError {
    #[error("failed to spawn sandboxed command: {0}")]
    Spawn(String),
}

pub type SandboxResult<T> = Result<T, SandboxError>;

/// What isolation this host can provide right now.
pub fn availability() -> &'static str {
    if cfg!(target_os = "linux") && bwrap_version().is_some() {
        "available"
    } else {
        "unavailable"
    }
}

pub fn bwrap_version() -> Option<String> {
    let output = std::process::Command::new("bwrap")
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Run a bash command inside the sandbox (or directly when unavailable).
pub async fn run_command(command: &str, spec: &SandboxSpec) -> SandboxResult<SandboxOutput> {
    let level = if cfg!(target_os = "linux") && bwrap_version().is_some() {
        SandboxLevel::Bubblewrap
    } else {
        SandboxLevel::None
    };

    let mut cmd = match level {
        SandboxLevel::Bubblewrap => {
            let mut c = std::process::Command::new("bwrap");
            c.arg("--ro-bind").arg("/").arg("/");
            c.arg("--dev").arg("/dev");
            c.arg("--proc").arg("/proc");
            c.arg("--tmpfs").arg("/tmp");
            for path in &spec.extra_ro_paths {
                if path.exists() {
                    c.arg("--ro-bind").arg(path).arg(path);
                }
            }
            c.arg("--bind")
                .arg(&spec.workspace_root)
                .arg(&spec.workspace_root);
            c.arg("--chdir").arg(&spec.workspace_root);
            if spec.allow_network {
                c.arg("--share-net");
            } else {
                c.arg("--unshare-net");
            }
            c.arg("--die-with-parent");
            c.arg("--").arg("bash").arg("-c").arg(command);
            c
        }
        SandboxLevel::None => {
            let mut c = std::process::Command::new("bash");
            c.arg("-c").arg(command);
            c.current_dir(&spec.workspace_root);
            c
        }
    };
    // Mask credentials: drop sensitive environment variables from the child.
    for (k, _) in std::env::vars() {
        let ku = k.to_uppercase();
        if ku.contains("KEY")
            || ku.contains("TOKEN")
            || ku.contains("SECRET")
            || ku.contains("PASSWORD")
            || ku.contains("CREDENTIAL")
        {
            cmd.env_remove(&k);
        }
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let child = tokio::process::Command::from(cmd)
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| SandboxError::Spawn(e.to_string()))?;

    let run = async move {
        child
            .wait_with_output()
            .await
            .map_err(|e| SandboxError::Spawn(e.to_string()))
    };
    let timed = tokio::time::timeout(spec.timeout, run).await;
    match timed {
        Ok(Ok(output)) => Ok(SandboxOutput {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            timed_out: false,
            sandbox_level: level,
        }),
        Ok(Err(e)) => Err(e),
        Err(_) => Ok(SandboxOutput {
            exit_code: -1,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: true,
            sandbox_level: level,
        }),
    }
}

/// Resolve a workspace-relative path, rejecting escapes, for callers that
/// build sandbox specs. Kept here so tools and the sandbox agree on scoping.
pub fn normalize(root: &Path, relative: &str) -> Option<PathBuf> {
    let path = if Path::new(relative).is_absolute() {
        PathBuf::from(relative)
    } else {
        root.join(relative)
    };
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    if result.starts_with(root) {
        Some(result)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn availability_is_a_known_string() {
        assert!(matches!(availability(), "available" | "unavailable"));
    }

    #[test]
    fn normalize_scopes_to_workspace() {
        let root = Path::new("/tmp/ws");
        assert_eq!(normalize(root, "a/b.txt"), Some(root.join("a/b.txt")));
        assert_eq!(normalize(root, "/tmp/ws/x"), Some(root.join("x")));
        // Escapes are rejected, not silently resolved.
        assert_eq!(normalize(root, "../escape"), None);
        assert_eq!(normalize(root, "../../../../../../.."), None);
    }

    #[tokio::test]
    async fn runs_basic_command() {
        if bwrap_version().is_none() && cfg!(target_os = "linux") {
            // bwrap missing: direct execution still works.
        }
        let spec = SandboxSpec {
            workspace_root: std::env::temp_dir(),
            allow_network: false,
            timeout: Duration::from_secs(10),
            extra_ro_paths: Vec::new(),
        };
        let output = run_command("echo sandbox-ok", &spec).await.unwrap();
        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.contains("sandbox-ok"));
    }

    #[tokio::test]
    async fn an_extra_ro_path_is_visible_inside_the_sandbox() {
        // A path outside the workspace root the caller explicitly named must
        // be readable: skills execute helpers that live in the skill's own
        // directory, and that directory is not the workspace.
        let workspace = std::env::temp_dir().join(format!("sbx-ws-{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!("sbx-out-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&workspace);
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("helper.py"), "print('outside')\n").unwrap();

        let spec = SandboxSpec {
            workspace_root: workspace.implementation(),
            allow_network: false,
            timeout: Duration::from_secs(30),
            extra_ro_paths: vec![outside.implementation()],
        };
        let output = run_command(
            &format!("cat {}", outside.join("helper.py").display()),
            &spec,
        )
        .await
        .unwrap();
        assert_eq!(output.exit_code, 0, "stderr: {}", output.stderr);
        assert_eq!(output.stdout.trim(), "print('outside')");

        // Without the extra path the sandbox is honest about hiding it — but
        // only when there is a sandbox: with no bubblewrap the level degrades
        // to None and nothing is hidden by design.
        let bare = SandboxSpec {
            extra_ro_paths: Vec::new(),
            ..spec.implementation()
        };
        let hidden = run_command(
            &format!("cat {}", outside.join("helper.py").display()),
            &bare,
        )
        .await
        .unwrap();
        if hidden.sandbox_level == SandboxLevel::Bubblewrap {
            assert_ne!(
                hidden.exit_code, 0,
                "a path the caller did not name must stay hidden: {}",
                hidden.stderr
            );
        }
        std::fs::remove_dir_all(&workspace).ok();
        std::fs::remove_dir_all(&outside).ok();
    }
}
