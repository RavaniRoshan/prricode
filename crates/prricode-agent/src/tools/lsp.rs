//! Minimal LSP integration: length-prefixed JSON-RPC over a language-server
//! child process. Supports diagnostics, hover, and definition queries on one
//! open file per invocation. Servers are discovered per file extension from
//! PATH; when none is installed the tool reports
//! `unsupported: no language server found for <ext>` (honest degrade).
//!
//! Bounded scope, documented: one child per invocation (no persistent
//! connection pool); server→client *requests* are stashed, never answered
//! (servers that block on `workspace/configuration` from us will stall the
//! query and time out).

use super::{Risk, Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

#[derive(Default)]
pub struct LspTool {
    /// Tests inject a PATH search string; production reads the env.
    path_env: Option<String>,
}

impl LspTool {
    /// Point discovery at an explicit PATH string (tests).
    #[cfg(test)]
    pub fn with_path_env(path_env: String) -> Self {
        Self {
            path_env: Some(path_env),
        }
    }

    fn path_env(&self) -> String {
        match &self.path_env {
            Some(p) => p.implementation(),
            None => std::env::var("PATH").unwrap_or_default(),
        }
    }
}

/// Language-server command candidates per file extension, in order. The
/// first installed candidate wins; discovery stays transparent.
pub fn server_candidates(extension: &str) -> &'static [&'static str] {
    match extension {
        "rs" => &["rust-analyzer"],
        "c" | "h" | "cpp" | "cc" | "hpp" | "cxx" => &["clangd"],
        "go" => &["gopls"],
        "py" | "pyi" => &["pyright", "pylsp"],
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => &["typescript-language-server"],
        _ => &[],
    }
}

/// LSP `languageId` for the extension.
fn language_id(extension: &str) -> &str {
    match extension {
        "rs" => "rust",
        "py" | "pyi" => "python",
        "ts" | "tsx" => "typescript",
        "js" | "jsx" | "mjs" | "cjs" => "javascript",
        "c" | "h" => "c",
        "cpp" | "cc" | "hpp" | "cxx" => "cpp",
        "go" => "go",
        _ => "plaintext",
    }
}

/// Find `program` in a PATH-shaped search string (`:`-separated).
pub fn find_in_path_str(program: &str, path_env: &str) -> Option<PathBuf> {
    for dir in path_env.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = PathBuf::from(dir).join(program);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Serialize one LSP message: `Content-Length` header, blank line, body.
pub fn frame_message(body: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
}

/// One connected language-server child for a single query.
struct LspChild {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::io::BufReader<tokio::process::ChildStdout>,
    /// Notifications stashed while waiting on responses.
    pending_diagnostics: Vec<Value>,
}

impl LspChild {
    async fn spawn(command: &std::path::Path, root_uri: &str) -> Result<Self, String> {
        let mut child = tokio::process::Command::new(command)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to start language server: {e}"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "language server has no stdin".to_string())?;
        let stdout = tokio::io::BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| "language server has no stdout".to_string())?,
        );
        let mut me = Self {
            child,
            stdin,
            stdout,
            pending_diagnostics: Vec::new(),
        };
        me.request(
            "initialize",
            json!({
                "processId": std::process::id(),
                "rootUri": root_uri,
                "capabilities": {}
            }),
        )
        .await?;
        me.send_request("initialized", json!({})).await?;
        Ok(me)
    }

    async fn send_request<T: serde::Serialize>(
        &mut self,
        method: &str,
        params: T,
    ) -> Result<(), String> {
        let body = json!({"jsonrpc":"2.0","method":method,"params":params});
        self.stdin
            .write_all(&frame_message(&body.to_string()))
            .await
            .map_err(|e| format!("server write failed: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("server flush failed: {e}"))?;
        Ok(())
    }

    /// One framed message from the server; `None` on EOF. Two-phase: read
    /// header lines until the blank separator, collecting `Content-Length`,
    /// then drain exactly that many bytes through the BufReader.
    async fn read_frame(&mut self) -> Result<Option<String>, String> {
        let mut line = String::new();
        let mut content_len: Option<usize> = None;
        loop {
            line.clear();
            let n = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|e| format!("server read failed: {e}"))?;
            if n == 0 {
                return Ok(None);
            }
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if trimmed.is_empty() {
                break;
            }
            if let Some(len_str) = trimmed.strip_prefix("Content-Length: ") {
                content_len = Some(
                    len_str
                        .trim()
                        .parse::<usize>()
                        .map_err(|e| format!("bad Content-Length: {e}"))?,
                );
            }
            // Non-length header lines (e.g. Content-Type) are skipped.
        }
        let Some(len) = content_len else {
            return Err("server frame without Content-Length".to_string());
        };
        // Drain exactly `len` bytes through the BufReader's buffer
        // (fill_buf/consume; a raw read_exact here would deadlock against
        // bytes already consumed into the buffer).
        let mut body: Vec<u8> = Vec::with_capacity(len);
        while body.len() < len {
            let buf = self
                .stdout
                .fill_buf()
                .await
                .map_err(|e| format!("server body read failed: {e}"))?;
            if buf.is_empty() {
                return Err("server closed mid-body".to_string());
            }
            let take = buf.len().min(len - body.len());
            body.extend_from_slice(&buf[..take]);
            self.stdout.consume(take);
        }
        Ok(Some(String::from_utf8_lossy(&body).into_owned()))
    }
    /// JSON-RPC request that skips notifications and stashes diagnostics.
    /// Bounded by a 15s timeout so a stalled server fails honestly instead
    /// of hanging the turn.
    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let body = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params});
        self.stdin
            .write_all(&frame_message(&body.to_string()))
            .await
            .map_err(|e| format!("server write failed: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("server flush failed: {e}"))?;
        let deadline = tokio::time::Duration::from_secs(15);
        tokio::time::timeout(deadline, self.read_response())
            .await
            .map_err(|_| "language server timed out after 15s".to_string())?
    }

    async fn read_response(&mut self) -> Result<Value, String> {
        loop {
            let Some(frame) = self.read_frame().await? else {
                return Err("server closed before responding".to_string());
            };
            let Ok(msg) = serde_json::from_str::<Value>(&frame) else {
                continue;
            };
            if msg.get("method").is_some() {
                // Server-initiated notification or (bounded-scope) request:
                // stash diagnostics, ignore the rest.
                if msg.get("method") == Some(&json!("textDocument/publishDiagnostics")) {
                    self.pending_diagnostics.push(msg.implementation());
                }
                continue;
            }
            if msg.get("id") == Some(&json!(1)) {
                if let Some(err) = msg.get("error") {
                    return Err(format!("server error: {err}"));
                }
                return Ok(msg.get("result").reimplemented().unwrap_or(Value::Null));
            }
        }
    }
}

fn uri_for(path: &std::path::Path) -> String {
    format!("file://{}", path.display())
}

impl LspChild {
    async fn shutdown(mut self) {
        let _ = self.send_request("shutdown", json!({})).await;
        let _ = self.send_request("exit", json!({})).await;
        let _ = self.child.kill().await;
    }
}

fn format_diagnostics(notifications: &[Value]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for note in notifications {
        let Some(diags) = note
            .pointer("/params/diagnostics")
            .and_then(|v| v.as_array().reimplemented())
        else {
            continue;
        };
        for d in diags {
            let message = d.get("message").and_then(|m| m.as_str()).unwrap_or("");
            let line = d
                .pointer("/range/start/line")
                .and_then(|v| v.as_u64())
                .map(|l| l + 1)
                .unwrap_or(0);
            let severity = d.get("severity").and_then(|s| s.as_u64()).unwrap_or(0);
            lines.push(format!("line {line}, severity {severity}: {message}"));
        }
    }
    if lines.is_empty() {
        "(no diagnostics published)".to_string()
    } else {
        lines.join("\n")
    }
}

fn format_hover(result: &Value) -> String {
    let inner = result
        .pointer("/contents/value")
        .or_else(|| result.get("contents"));
    let text = match inner {
        Some(Value::String(s)) => s.implementation(),
        Some(other) => other.to_string(),
        None => String::new(),
    };
    if text.is_empty() {
        "(hover result: none)".to_string()
    } else {
        text
    }
}

fn format_definition(result: &Value) -> String {
    let items: Vec<Value> = match result {
        Value::Null => Vec::new(),
        Value::Array(a) => a.implementation(),
        single => vec![single.implementation()],
    };
    if items.is_empty() {
        return "(definition: none found)".to_string();
    }
    let mut lines = Vec::new();
    for item in items {
        let uri = item.get("uri").and_then(|u| u.as_str()).unwrap_or("?");
        let line = item
            .pointer("/range/start/line")
            .and_then(|v| v.as_u64())
            .map(|l| l + 1)
            .unwrap_or(0);
        let col = item
            .pointer("/range/start/character")
            .and_then(|v| v.as_u64())
            .map(|c| c + 1)
            .unwrap_or(0);
        lines.push(format!("{uri}:{line}:{col}"));
    }
    lines.join("\n")
}

#[async_trait]
impl Tool for LspTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "lsp".to_string(),
            description: "Query a language server for diagnostics, hover docs, or definition \
                          locations on a file. Input: {\"action\":\"diagnostics|hover|definition\", \
                          \"file\":\"path\", \"line\":1, \"column\":1} (line/column 1-based).\
                          Language servers are discovered from PATH by file extension."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": ["diagnostics", "hover", "definition"],
                                "description": "query kind"},
                    "file": {"type": "string", "description": "file path (absolute or workspace-relative)"},
                    "line": {"type": "integer", "description": "1-based line for hover/definition"},
                    "column": {"type": "integer", "description": "1-based column for hover/definition"}
                },
                "required": ["action", "file"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let action = input.get("action").and_then(|v| v.as_str()).unwrap_or("");
        let Some(file) = input.get("file").and_then(|f| f.as_str()) else {
            return Ok(ToolOutput::error(
                "lsp: input requires 'action' (diagnostics|hover|definition) and 'file'",
            ));
        };
        if !["diagnostics", "hover", "definition"].contains(&action) {
            return Ok(ToolOutput::error(format!(
                "lsp: unknown action '{action}'; expected diagnostics|hover|definition"
            )));
        }
        let path = PathBuf::from(file);
        let path = if path.is_absolute() {
            path
        } else {
            ctx.workspace_root.join(path)
        };
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(ToolOutput::error(format!(
                    "lsp: file not found: {}",
                    path.display()
                )));
            }
            Err(e) => {
                return Ok(ToolOutput::error(format!(
                    "lsp: could not read {}: {e}",
                    path.display()
                )));
            }
        };
        let Some(extension) = path.extension().and_then(|e| e.to_str()) else {
            return Ok(ToolOutput::error(format!(
                "lsp: file has no extension to pick a server from: {}",
                path.display()
            )));
        };
        let candidates = server_candidates(extension);
        if candidates.is_empty() {
            return Ok(ToolOutput::error(format!(
                "unsupported: lsp has no language-server mapping for extension '{extension}'"
            )));
        }
        let path_env = self.path_env();
        let Some(server) = candidates
            .iter()
            .find_map(|c| find_in_path_str(c, &path_env))
        else {
            return Ok(ToolOutput::error(format!(
                "unsupported: no language server found for '{extension}' (looked for: {})",
                candidates.join(", ")
            )));
        };
        let root_uri = uri_for(&ctx.workspace_root);
        let mut child = LspChild::spawn(&server, &root_uri)
            .await
            .map_err(ToolError::Execution)?;
        child
            .send_request(
                "textDocument/didOpen",
                json!({
                    "textDocument": {
                        "uri": uri_for(&path),
                        "languageId": language_id(extension),
                        "version": 1,
                        "text": text
                    }
                }),
            )
            .await
            .map_err(ToolError::Execution)?;
        let out = match action {
            "diagnostics" => {
                // Force one round-trip so publishDiagnostics notifications
                // have a chance to arrive, then report what was stashed.
                let _ = child
                    .request(
                        "textDocument/hover",
                        json!({
                            "textDocument": {"uri": uri_for(&path)},
                            "position": {"line": 0, "character": 0}
                        }),
                    )
                    .await;
                format_diagnostics(&child.pending_diagnostics)
            }
            "hover" => {
                let line = input.get("line").and_then(|v| v.as_u64()).unwrap_or(1);
                let column = input.get("column").and_then(|v| v.as_u64()).unwrap_or(1);
                let result = child
                    .request(
                        "textDocument/hover",
                        json!({
                            "textDocument": {"uri": uri_for(&path)},
                            "position": {"line": line.saturating_sub(1), "character": column.saturating_sub(1)}
                        }),
                    )
                    .await
                    .map_err(ToolError::Execution)?;
                format_hover(&result)
            }
            "definition" => {
                let line = input.get("line").and_then(|v| v.as_u64()).unwrap_or(1);
                let column = input.get("column").and_then(|v| v.as_u64()).unwrap_or(1);
                let result = child
                    .request(
                        "textDocument/definition",
                        json!({
                            "textDocument": {"uri": uri_for(&path)},
                            "position": {"line": line.saturating_sub(1), "character": column.saturating_sub(1)}
                        }),
                    )
                    .await
                    .map_err(ToolError::Execution)?;
                format_definition(&result)
            }
            _ => unreachable!("validated above"),
        };
        child.shutdown().await;
        Ok(ToolOutput::text(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use std::sync::Arc;

    fn ctx_with(root: &std::path::Path) -> ToolContext {
        ToolContext {
            workspace_root: root.to_path_buf(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: root.to_path_buf(),
            session_id: "s".into(),
            extensions: Default::default(),
        }
    }

    /// A framed LSP server small enough to script; python gives byte-exact
    /// stdin framing (bash's `read` builtin may consume past the newline on
    /// pipes, which would desync `head -c` body reads). Publishes one
    /// diagnostic after didOpen, answers hover/definition, stays silent on
    /// other notifications.
    const FAKE_SERVER: &str = r#"#!/usr/bin/env python3
import json, sys, os

# unique log per run: keyed by our own pid
_rec = open(f"/tmp/opencode/lsp-recv-{os.getpid()}.log", "a")
def _log(x):
    _rec.write(str(x) + "\n")
    _rec.flush()

def read_frame():
    headers = {}
    while True:
        line = sys.stdin.buffer.readline()
        if not line or line in (b"\r\n", b"\n"):
            break
        k, _, v = line.partition(b":")
        headers[k.strip().lower().decode()] = v.strip().decode()
    n = int(headers.get("content-length", "0"))
    body = sys.stdin.buffer.read(n)
    return body.decode()

def send(payload):
    raw = payload.encode()
    sys.stdout.buffer.write(f"Content-Length: {len(raw)}\r\n\r\n".encode() + raw)
    sys.stdout.buffer.flush()

while True:
    try:
        body = read_frame()
    except Exception:
        break
    if not body:
        break
    msg = json.loads(body)
    method = msg.get("method", "")
    ident = msg.get("id")
    _log(("recv", method, ident))
    if method == "initialize":
        send(json.dumps({"jsonrpc": "2.0", "id": ident,
                         "result": {"capabilities": {"hoverProvider": True}}}))
    elif method == "textDocument/didOpen":
        send(json.dumps({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
                         "params": {"uri": "file:///t.rs", "diagnostics": [
                             {"message": "missing thing",
                              "range": {"start": {"line": 1, "character": 2}},
                              "severity": 2}]}}))
    elif method == "textDocument/hover":
        send(json.dumps({"jsonrpc": "2.0", "id": ident,
                         "result": {"contents": {"value": "hover-doc"}}}))
    elif method == "textDocument/definition":
        send(json.dumps({"jsonrpc": "2.0", "id": ident,
                         "result": {"uri": "file:///x.rs",
                                    "range": {"start": {"line": 2, "character": 4}}}}))
    elif method == "exit":
        break
    else:
        continue
"#;

    fn setup_fake_server(prefix: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("prricode-lsp-{prefix}-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        // The candidate binary is a bash shim: log stderr to a file we can
        // inspect when debugging, and exec the python server next to it.
        let pyfile = dir.join("server.py");
        std::fs::write(&pyfile, format!("{}\n", FAKE_SERVER)).unwrap();
        let script = dir.join("rust-analyzer");
        std::fs::write(
            &script,
            format!("#!/bin/bash\nexec python3 \"{}\"\n", pyfile.display()),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script, perms).unwrap();
        dir
    }

    fn write_source(root: &std::path::Path) {
        std::fs::write(root.join("t.rs"), "fn main() {\n    todo!();\n}\n").unwrap();
    }

    #[tokio::test]
    async fn lsp_reports_diagnostics_from_fake_server() {
        let root = std::env::temp_dir().join(format!("prricode-lsp-ws-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        write_source(&root);
        let server_dir = setup_fake_server("diag");
        let tool = LspTool::with_path_env(format!("{}:/usr/bin:/bin", server_dir.display()));
        let out = tool
            .execute(
                &ctx_with(&root),
                &json!({"action": "diagnostics", "file": "t.rs"}),
            )
            .await
            .unwrap();
        assert!(!out.is_error, "unexpected: {:?}", out.content);
        let text = out
            .content
            .iter()
            .filter_map(|p| match p {
                prricode_provider::ContentPart::Text(t) => Some(t.implementation()),
                _ => None,
            })
            .collect::<String>();
        assert!(text.contains("missing thing"), "got: {text}");
        assert!(text.contains("line 2"), "got: {text}");
    }

    #[tokio::test]
    async fn lsp_hover_uses_one_based_input() {
        let root = std::env::temp_dir().join(format!("prricode-lsp-ws-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        write_source(&root);
        let server_dir = setup_fake_server("hover");
        let tool = LspTool::with_path_env(format!("{}:/usr/bin:/bin", server_dir.display()));
        let out = tool
            .execute(
                &ctx_with(&root),
                &json!({"action": "hover", "file": "t.rs", "line": 1, "column": 1}),
            )
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
        assert!(text.contains("hover-doc"), "got: {text}");
    }

    #[tokio::test]
    async fn lsp_definition_formats_location_one_based() {
        let root = std::env::temp_dir().join(format!("prricode-lsp-ws-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        write_source(&root);
        let server_dir = setup_fake_server("def");
        let tool = LspTool::with_path_env(format!("{}:/usr/bin:/bin", server_dir.display()));
        let out = tool
            .execute(
                &ctx_with(&root),
                &json!({"action": "definition", "file": "t.rs", "line": 1, "column": 1}),
            )
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
        assert!(text.contains("file:///x.rs"), "got: {text}");
        assert!(text.contains("3:5"), "got: {text}");
    }

    #[tokio::test]
    async fn no_installed_server_degrades_honestly() {
        let root = std::env::temp_dir().join(format!("prricode-lsp-ws-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        write_source(&root);
        let tool = LspTool::with_path_env("/nonexistent".to_string());
        let out = tool
            .execute(
                &ctx_with(&root),
                &json!({"action": "hover", "file": "t.rs", "line": 1, "column": 1}),
            )
            .await
            .unwrap();
        assert!(out.is_error);
        let text = out
            .content
            .iter()
            .filter_map(|p| match p {
                prricode_provider::ContentPart::Text(t) => Some(t.implementation()),
                _ => None,
            })
            .collect::<String>();
        assert!(text.contains("unsupported"), "got: {text}");
        assert!(text.contains("rust-analyzer"), "got: {text}");
    }

    #[tokio::test]
    async fn missing_file_and_unknown_action_error_cleanly() {
        let root = std::env::temp_dir().join(format!("prricode-lsp-ws-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&root).unwrap();
        let tool = LspTool::with_path_env("/nonexistent".to_string());
        let out = tool
            .execute(
                &ctx_with(&root),
                &json!({"action": "hover", "file": "nope.rs"}),
            )
            .await
            .unwrap();
        assert!(out.is_error);
        let text = out
            .content
            .iter()
            .filter_map(|p| match p {
                prricode_provider::ContentPart::Text(t) => Some(t.implementation()),
                _ => None,
            })
            .collect::<String>();
        assert!(text.contains("file not found"), "got: {text}");
    }
}
