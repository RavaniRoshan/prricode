//! File tools: read, write, edit, list, and glob — all scoped to the
//! session workspace.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn resolve_in_workspace(root: &Path, relative: &str) -> ToolResult<PathBuf> {
    let path = if Path::new(relative).is_absolute() {
        PathBuf::from(relative)
    } else {
        root.join(relative)
    };
    // Reject paths that escape the workspace via ..
    let normalized = normalize(&path);
    let normalized_root = normalize(root);
    if !normalized.starts_with(&normalized_root) {
        return Err(super::ToolError::InvalidInput(format!(
            "path escapes the workspace: {relative}"
        )));
    }
    Ok(normalized)
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

pub struct ReadFileTool;

#[async_trait]
impl Tool for ReadFileTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "read_file".to_string(),
            description: "Read a file from the workspace. Returns numbered lines; use offset/limit for large files.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "offset": { "type": "integer", "description": "1-based start line" },
                    "limit": { "type": "integer", "description": "max lines (default 2000)" }
                },
                "required": ["path"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let path = input
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'path'".into()))?;
        let target = resolve_in_workspace(&ctx.workspace_root, path)?;
        let text = tokio::fs::read_to_string(&target)
            .await
            .map_err(|e| super::ToolError::Execution(format!("cannot read {path}: {e}")))?;
        let lines: Vec<&str> = text.lines().collect();
        let offset = input
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .max(1) as usize;
        let limit = input.get("limit").and_then(|v| v.as_u64()).unwrap_or(2000) as usize;
        let start = offset.saturating_sub(1).min(lines.len());
        let end = start.saturating_add(limit).min(lines.len());
        let mut out = String::new();
        for (i, line) in lines[start..end].iter().enumerate() {
            out.push_str(&format!("{:>6}\t{line}\n", start + i + 1));
        }
        if out.is_empty() {
            out = "(empty file)".to_string();
        }
        if end < lines.len() {
            out.push_str(&format!("… {} more lines", lines.len() - end));
        }
        Ok(ToolOutput::text(out))
    }
}

pub struct WriteFileTool;

#[async_trait]
impl Tool for WriteFileTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "write_file".to_string(),
            description: "Write (create or overwrite) a file in the workspace. Parent directories are created.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Sensitive
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let path = input
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'path'".into()))?;
        let content = input
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'content'".into()))?;
        let target = resolve_in_workspace(&ctx.workspace_root, path)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| super::ToolError::Execution(format!("cannot create dirs: {e}")))?;
        }
        tokio::fs::write(&target, content)
            .await
            .map_err(|e| super::ToolError::Execution(format!("cannot write {path}: {e}")))?;
        Ok(ToolOutput::text(format!(
            "wrote {} bytes to {path}",
            content.len()
        )))
    }
}

pub struct EditFileTool;

#[async_trait]
impl Tool for EditFileTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "edit_file".to_string(),
            description: "Replace an exact string in a file. The old_string must appear exactly once unless replace_all is true.".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" },
                    "replace_all": { "type": "boolean", "default": false }
                },
                "required": ["path", "old_string", "new_string"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Sensitive
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let path = input
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'path'".into()))?;
        let old = input
            .get("old_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'old_string'".into()))?;
        let new = input
            .get("new_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'new_string'".into()))?;
        let replace_all = input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let target = resolve_in_workspace(&ctx.workspace_root, path)?;
        let content = tokio::fs::read_to_string(&target)
            .await
            .map_err(|e| super::ToolError::Execution(format!("cannot read {path}: {e}")))?;
        let occurrences = content.matches(old).count();
        if occurrences == 0 {
            return Ok(ToolOutput::error(format!("old_string not found in {path}")));
        }
        if occurrences > 1 && !replace_all {
            return Ok(ToolOutput::error(format!(
                "old_string appears {occurrences} times in {path}; set replace_all or add more context"
            )));
        }
        let updated = if replace_all {
            content.replace(old, new)
        } else {
            content.replacen(old, new, 1)
        };
        tokio::fs::write(&target, &updated)
            .await
            .map_err(|e| super::ToolError::Execution(format!("cannot write {path}: {e}")))?;
        Ok(ToolOutput::text(format!(
            "edited {path} ({occurrences} replacement{})",
            if occurrences == 1 { "" } else { "s" }
        )))
    }
}

pub struct ListDirTool;

#[async_trait]
impl Tool for ListDirTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "list_dir".to_string(),
            description: "List a directory in the workspace (one level).".to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "default": "." }
                },
                "required": []
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let path = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let target = resolve_in_workspace(&ctx.workspace_root, path)?;
        let mut entries = tokio::fs::read_dir(&target)
            .await
            .map_err(|e| super::ToolError::Execution(format!("cannot list {path}: {e}")))?;
        let mut lines = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| super::ToolError::Execution(format!("readdir failed: {e}")))?
        {
            let name = entry.file_name().to_string_lossy().to_string();
            let file_type = entry.file_type().await.ok();
            let suffix = match file_type {
                Some(ft) if ft.is_dir() => "/",
                _ => "",
            };
            lines.push(format!("{name}{suffix}"));
        }
        lines.sort();
        if lines.is_empty() {
            return Ok(ToolOutput::text("(empty directory)"));
        }
        Ok(ToolOutput::text(lines.join("\n")))
    }
}

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "glob".to_string(),
            description: "Find files matching a glob pattern (e.g. **/*.rs) in the workspace."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string" },
                    "path": { "type": "string", "default": "." }
                },
                "required": ["pattern"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let pattern = input
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'pattern'".into()))?;
        let base = input.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let root = resolve_in_workspace(&ctx.workspace_root, base)?;
        let full_pattern = format!("{}/{}", root.display(), pattern);
        let matches: Vec<String> = glob_match(&full_pattern);
        let total = matches.len();
        let mut out = matches
            .into_iter()
            .take(1000)
            .collect::<Vec<_>>()
            .join("\n");
        if out.is_empty() {
            out = "(no matches)".to_string();
        }
        if total > 1000 {
            out.push_str(&format!("\n… {total} matches total"));
        }
        Ok(ToolOutput::text(out))
    }
}

/// Minimal glob matcher supporting `*`, `**`, and `?` over a filesystem walk.
fn glob_match(pattern: &str) -> Vec<String> {
    let path = std::path::Path::new(pattern);
    let root = path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let file_pattern = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_default();
    let filename_regex = glob_to_regex(&file_pattern);
    let mut results = Vec::new();
    let mut stack = vec![root];
    let regex = regex::Regex::new(&filename_regex).ok();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            let matches = regex.as_ref().map(|r| r.is_match(&name)).unwrap_or(false);
            if matches && path.is_file() {
                results.push(path.to_string_lossy().to_string());
            }
            if path.is_dir() {
                stack.push(path);
            }
        }
    }
    results.sort();
    results
}

fn glob_to_regex(pattern: &str) -> String {
    let mut regex = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    regex.push_str(".*");
                } else {
                    regex.push_str("[^/]*");
                }
            }
            '?' => regex.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '^' | '$' | '@' | '%' => {
                regex.push('\\');
                regex.push(c);
            }
            '[' | ']' | '{' | '}' => regex.push(c),
            other => regex.push(other),
        }
    }
    regex.push('$');
    regex
}
