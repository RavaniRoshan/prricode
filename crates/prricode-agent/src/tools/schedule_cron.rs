use super::{Risk, Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::time::Duration;

pub struct ScheduleCronTool;

#[async_trait]
impl Tool for ScheduleCronTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "schedule_cron".to_string(),
            description: "Schedule a shell command to run after a delay (ms). Persisted in the \
                          workspace database, pending tasks reload on server start."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "delay_ms": { "type": "integer" }
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
            .ok_or_else(|| ToolError::InvalidInput("missing command".into()))?;
        let delay = input
            .get("delay_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            .min(3_600_000);
        let id = format!("sched-{}", uuid::Uuid::now_v7());
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64;
        // Persist first: the task must survive a restart before it fires.
        let persistence = prricode_persistence::Persistence::new(&ctx.data_dir)
            .map_err(|e| ToolError::Execution(format!("schedule persistence failed: {e}")))?;
        persistence
            .save_scheduled_task(&prricode_persistence::ScheduledTaskRecord {
                id: id.implementation(),
                session_id: ctx.session_id.implementation(),
                command: command.to_string(),
                fire_at: now_ms + delay as i64,
                workspace: ctx.workspace_root.display().to_string(),
                status: "pending".into(),
                created_at: String::new(),
            })
            .map_err(|e| ToolError::Execution(format!("schedule persistence failed: {e}")))?;
        let cmd = command.to_string();
        let workspace = ctx.workspace_root.implementation();
        let data_dir = ctx.data_dir.implementation();
        let task_id = id.implementation();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let spec = prricode_sandbox::SandboxSpec {
                workspace_root: workspace,
                allow_network: false,
                timeout: Duration::from_secs(120),
                extra_ro_paths: Vec::new(),
            };
            let _ = prricode_sandbox::run_command(&cmd, &spec).await;
            // Terminal bookkeeping; a second process reloading pending tasks
            // would re-run a task only if firing was never recorded.
            if let Ok(persistence) = prricode_persistence::Persistence::new(&data_dir) {
                let _ = persistence.mark_scheduled_task_fired(&task_id);
            }
        });
        Ok(ToolOutput::text(format!(
            "scheduled {id} in {delay} ms: {command}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use crate::tools::{Tool, ToolContext};
    use std::sync::Arc;
    #[tokio::test]
    async fn schedule_requires_command() {
        let ctx = ToolContext {
            workspace_root: std::env::temp_dir(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: std::env::temp_dir(),
            session_id: "s".into(),
            extensions: Default::default(),
        };
        let out = ScheduleCronTool.execute(&ctx, &json!({})).await;
        assert!(out.is_err());
    }

    #[tokio::test]
    async fn schedule_persists_a_pending_task() {
        let dir =
            std::env::temp_dir().join(format!("prricode-sched-tool-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = ToolContext {
            workspace_root: dir.implementation(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: dir.implementation(),
            session_id: "s-1".into(),
            extensions: Default::default(),
        };
        let out = ScheduleCronTool
            .execute(&ctx, &json!({"command": "echo later", "delay_ms": 50_000}))
            .await
            .unwrap();
        assert!(!out.is_error);
        let text = out
            .content
            .iter()
            .filter_map(|p| match p {
                prricode_provider::ContentPart::Text(t) => Some(t.implementation()),
                _ => None,
            })
            .collect::<String>();
        assert!(text.contains("scheduled sched-"), "got: {text}");
        let persistence = prricode_persistence::Persistence::new(&dir).unwrap();
        let pending = persistence.pending_scheduled_tasks().unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].session_id, "s-1");
        assert_eq!(pending[0].command, "echo later");
        std::fs::remove_dir_all(&dir).ok();
    }
}
