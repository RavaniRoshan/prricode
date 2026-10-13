//! Grep tool: regex search over workspace files.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::path::PathBuf;

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "grep".to_string(),
            description:
                "Search file contents with a regex. Returns matching lines with file:line."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Rust regex syntax" },
                    "path": { "type": "string", "default": "." },
                    "glob": { "type": "string", "description": "restrict to files matching this glob, e.g. *.rs" },
                    "max_results": { "type": "integer", "default": 100 }
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
        let file_glob = input.get("glob").and_then(|v| v.as_str());
        let max_results = input
            .get("max_results")
            .and_then(|v| v.as_u64())
            .unwrap_or(100) as usize;

        let regex = regex::Regex::new(pattern)
            .map_err(|e| super::ToolError::InvalidInput(format!("bad regex: {e}")))?;
        let file_regex = match file_glob {
            Some(glob) => Some(
                regex::Regex::new(&format!(
                    "^{}$",
                    regex::escape(glob)
                        .replace("\\*", "[^/]*")
                        .replace("\\?", ".")
                ))
                .map_err(|e| super::ToolError::InvalidInput(format!("bad glob: {e}")))?,
            ),
            None => None,
        };

        let root = if PathBuf::from(base).is_absolute() {
            PathBuf::from(base)
        } else {
            ctx.workspace_root.join(base)
        };

        let mut results = Vec::new();
        let mut stack = vec![root];
        'outer: while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name == "target" || name == "node_modules" {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if let Some(file_regex) = &file_regex {
                    if !file_regex.is_match(&name) {
                        continue;
                    }
                }
                let Ok(content) = std::fs::read_to_string(&path) else {
                    continue;
                };
                for (i, line) in content.lines().enumerate() {
                    if regex.is_match(line) {
                        results.push(format!("{}:{}: {line}", path.display(), i + 1));
                        if results.len() >= max_results {
                            break 'outer;
                        }
                    }
                }
            }
        }
        results.sort();
        if results.is_empty() {
            return Ok(ToolOutput::text("(no matches)"));
        }
        Ok(ToolOutput::text(results.join("\n")))
    }
}
