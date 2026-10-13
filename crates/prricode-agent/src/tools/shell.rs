//! Shell tool: runs a bash command in the session workspace.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::time::Duration;

pub struct ShellTool {
    default_timeout_secs: u64,
}

impl Default for ShellTool {
    fn default() -> Self {
        Self {
            default_timeout_secs: 120,
        }
    }
}

impl ShellTool {
    pub fn new(default_timeout_secs: u64) -> Self {
        Self {
            default_timeout_secs,
        }
    }
}

#[async_trait]
impl Tool for ShellTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "shell".to_string(),
            description: "Run a bash command in the session workspace. Output is captured; use for builds, tests, git, and scripts. Prefer dedicated tools for reading/editing single files.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The bash command to run" },
                    "timeout_secs": { "type": "integer", "description": "Kill the command after this many seconds (default 120)" }
                },
                "required": ["command"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Sensitive
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let command = input
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'command'".into()))?;
        let timeout = input
            .get("timeout_secs")
            .and_then(|v| v.as_u64())
            .unwrap_or(self.default_timeout_secs)
            .clamp(1, 600);

        let child = tokio::process::Command::new("bash")
            .arg("-c")
            .arg(command)
            .current_dir(&ctx.workspace_root)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| super::ToolError::Execution(format!("spawn failed: {e}")))?;

        let run = async move {
            child
                .wait_with_output()
                .await
                .map_err(|e| super::ToolError::Execution(format!("wait failed: {e}")))
        };
        let timed = tokio::time::timeout(Duration::from_secs(timeout), run).await;
        let output = match timed {
            Ok(result) => result?,
            Err(_) => {
                // kill_on_drop terminates the child when the future is dropped.
                return Ok(ToolOutput::error(format!(
                    "command timed out after {timeout}s"
                )));
            }
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let exit_code = output.status.code().unwrap_or(-1);
        let mut content = String::new();
        if !stdout.is_empty() {
            content.push_str(&stdout);
        }
        if !stderr.is_empty() {
            if !content.is_empty() {
                content.push('\n');
            }
            content.push_str("stderr:\n");
            content.push_str(&stderr);
        }
        if content.is_empty() {
            content.push_str("(no output)");
        }
        content.push_str(&format!("\nexit_code: {exit_code}"));
        let truncated = content.chars().count() > 30_000;
        if truncated {
            content = content.chars().take(30_000).collect();
            content.push_str("\n… [truncated]");
        }
        if exit_code == 0 {
            Ok(ToolOutput::text(content))
        } else {
            Ok(ToolOutput::error(content))
        }
    }
}
