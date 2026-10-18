//! System prompt construction.

use prricode_core::ApprovalMode;

pub struct SystemPromptContext<'a> {
    pub workspace_root: &'a str,
    pub approval_mode: ApprovalMode,
    pub goal: Option<&'a str>,
    pub skills_prompt: Option<&'a str>,
    pub project_instructions: Option<&'a str>,
}

pub fn build_system_prompt(ctx: SystemPromptContext<'_>) -> String {
    let mut prompt = String::from(
        "You are prricode, an autonomous AI coding agent running in the user's terminal.\n\n\
         # How you work\n\
         - You have tools: read and edit files, run shell commands, search code, fetch the web, \
         delegate sub-tasks, and (when available) control the computer.\n\
         - Act, don't ask: when a request is clear, use tools to do the work and report the result. \
         Prefer the smallest change that solves the problem.\n\
         - Never fabricate command output or file contents; run the tool and read the result.\n\
         - When you edit files, keep existing style. After making changes, verify with the \
         relevant build/test command when one exists.\n\
         - Paths in tool calls are relative to the workspace root unless absolute.\n\n\
         # Environment\n",
    );
    prompt.push_str(&format!("- Workspace: {}\n", ctx.workspace_root));
    prompt.push_str(&format!(
        "- OS: {} ({})\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    let now = chrono_lite_now();
    prompt.push_str(&format!("- Date: {now}\n"));

    match ctx.approval_mode {
        ApprovalMode::Closed | ApprovalMode::Auto => {
            prompt.push_str(
                "- Sensitive actions (shell, file writes) require user approval and may be denied; \
                 if denied, adapt your approach rather than retrying the same call.\n",
            );
        }
        ApprovalMode::Open => {
            prompt.push_str("- Approval mode is open: act autonomously without pausing.\n");
        }
        ApprovalMode::Suggestive => {
            prompt.push_str(
                "- Approval mode is suggestive: do not execute sensitive actions; \
                 propose them and let the user run them.\n",
            );
        }
    }

    if let Some(goal) = ctx.goal {
        prompt.push_str(&format!(
            "\n# Current goal\n{goal}\n\nWork toward this goal across turns. When it is fully \
             achieved, call the goal_complete tool with a summary.\n"
        ));
    }
    if let Some(skills) = ctx.skills_prompt {
        prompt.push_str("\n# Active skills\n");
        prompt.push_str(skills);
        prompt.push('\n');
    }
    if let Some(pi) = ctx.project_instructions {
        prompt.push_str("\n# Project instructions\n");
        prompt.push_str(pi);
        prompt.push('\n');
    }
    prompt
}

/// Small date helper without pulling in chrono.
fn chrono_lite_now() -> String {
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
