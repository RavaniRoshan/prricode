//! MCP client: Model Context Protocol servers over stdio (JSON-RPC 2.0)
//! and streamable HTTP.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

#[derive(Debug, Clone)]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("io: {0}")]
    Io(String),
    #[error("protocol: {0}")]
    Protocol(String),
    #[error("transport closed")]
    Closed,
}

pub type McpResult<T> = Result<T, McpError>;

/// A connected MCP server over stdio.
pub struct McpStdioClient {
    name: String,
    stdin: Arc<Mutex<BufWriter<ChildStdin>>>,
    stdout: Arc<Mutex<BufReader<ChildStdout>>>,
    child: Arc<Mutex<Child>>,
    next_id: std::sync::atomic::AtomicU64,
}

impl McpStdioClient {
    /// Spawn an MCP server process and complete the initialize handshake.
    pub async fn spawn(name: &str, command: &str, args: &[String]) -> McpResult<Self> {
        let mut child = tokio::process::Command::new(command)
            .args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| McpError::Io(e.to_string()))?;
        let stdin = child.stdin.take().ok_or(McpError::Io("no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or(McpError::Io("no stdout".into()))?;
        let client = Self {
            name: name.to_string(),
            stdin: Arc::new(Mutex::new(BufWriter::new(stdin))),
            stdout: Arc::new(Mutex::new(BufReader::new(stdout))),
            child: Arc::new(Mutex::new(child)),
            next_id: std::sync::atomic::AtomicU64::new(1),
        };
        client
            .request(
                "initialize",
                json!({
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": { "name": "prricode", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
            .await?;
        client
            .notify("notifications/initialized", json!({}))
            .await?;
        Ok(client)
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    async fn request(&self, method: &str, params: Value) -> McpResult<Value> {
        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        {
            let mut stdin = self.stdin.lock().await;
            stdin
                .write_all(format!("{frame}\n").as_bytes())
                .await
                .map_err(|e| McpError::Io(e.to_string()))?;
            stdin
                .flush()
                .await
                .map_err(|e| McpError::Io(e.to_string()))?;
        }
        loop {
            let mut line = String::new();
            let read = {
                let mut stdout = self.stdout.lock().await;
                stdout
                    .read_line(&mut line)
                    .await
                    .map_err(|e| McpError::Io(e.to_string()))?
            };
            if read == 0 {
                return Err(McpError::Closed);
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let message: Value = serde_json::from_str(trimmed)
                .map_err(|e| McpError::Protocol(format!("bad frame: {e}")))?;
            if message.get("id").and_then(|v| v.as_u64()) != Some(id) {
                // Notification or a reply to another request; skip.
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(McpError::Protocol(error.to_string()));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    async fn notify(&self, method: &str, params: Value) -> McpResult<()> {
        let frame = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .map_err(|e| McpError::Io(e.to_string()))?;
        stdin
            .flush()
            .await
            .map_err(|e| McpError::Io(e.to_string()))?;
        Ok(())
    }

    pub async fn tools_list(&self) -> McpResult<Vec<McpTool>> {
        let result = self.request("tools/list", json!({})).await?;
        let tools = result
            .get("tools")
            .and_then(|t| t.as_array())
            .ok_or_else(|| McpError::Protocol("tools/list response missing tools array".into()))?;
        Ok(tools
            .iter()
            .filter_map(|t| {
                Some(McpTool {
                    name: t.get("name")?.as_str()?.to_string(),
                    description: t
                        .get("description")
                        .and_then(|d| d.as_str())
                        .unwrap_or("")
                        .to_string(),
                    input_schema: t.get("inputSchema").cloned().unwrap_or(json!({})),
                })
            })
            .collect())
    }

    pub async fn tools_call(&self, name: &str, arguments: Value) -> McpResult<Value> {
        self.request(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
        )
        .await
    }

    pub async fn shutdown(&self) -> McpResult<()> {
        let mut child = self.child.lock().await;
        let _ = child.kill().await;
        Ok(())
    }
}

/// Connection registry for the server.
#[derive(Default)]
pub struct McpRegistry {
    clients: std::sync::Mutex<HashMap<String, Arc<McpStdioClient>>>,
}

impl McpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, client: McpStdioClient) -> String {
        let name = client.name().to_string();
        self.clients
            .lock()
            .unwrap()
            .insert(name.clone(), Arc::new(client));
        name
    }

    pub fn get(&self, name: &str) -> Option<Arc<McpStdioClient>> {
        self.clients.lock().unwrap().get(name).cloned()
    }

    pub fn names(&self) -> Vec<String> {
        self.clients.lock().unwrap().keys().cloned().collect()
    }

    pub async fn remove(&self, name: &str) -> bool {
        let client = self.clients.lock().unwrap().remove(name);
        match client {
            Some(client) => {
                client.shutdown().await.ok();
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawns_and_lists_tools_from_echo_server() {
        // A minimal MCP server implemented as a bash JSON-lines loop.
        let script = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  [ -z "$id" ] && continue
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"t","version":"1"}}}\n' "$id";;
    tools/list) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"probe","description":"test tool","inputSchema":{"type":"object"}}]}}\n' "$id";;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id";;
  esac
done"#;
        let client = McpStdioClient::spawn("test", "bash", &["-c".to_string(), script.to_string()])
            .await
            .unwrap();
        assert_eq!(client.name(), "test");
        let tools = client.tools_list().await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "probe");
        let result = client.tools_call("probe", json!({"x": 1})).await.unwrap();
        assert!(result.is_object());
        client.shutdown().await.unwrap();
    }
}
