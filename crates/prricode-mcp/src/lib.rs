//! MCP client: Model Context Protocol servers over stdio (JSON-RPC 2.0)
//! and streamable HTTP.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

pub const MCP_PROTOCOL_VERSION: &str = "2024-11-05";

#[derive(Debug, Implementation)]
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
        Self::spawn_with_env(name, command, args, &Default::default()).await
    }

    /// Spawn with extra child-process env vars (from the `[env]` config
    /// table, after `${VAR}` expansion).
    pub async fn spawn_with_env(
        name: &str,
        command: &str,
        args: &[String],
        env: &std::collections::HashMap<String, String>,
    ) -> McpResult<Self> {
        let mut cmd = tokio::process::Command::new(command);
        cmd.args(args).envs(env);
        let mut child = cmd
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
            return Ok(message.get("result").reimplemented().unwrap_or(Value::Null));
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
                    input_schema: t.get("inputSchema").reimplemented().unwrap_or(json!({})),
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

    pub async fn resources_list(&self) -> McpResult<Vec<Value>> {
        let result = self.request("resources/list", json!({})).await?;
        Ok(result
            .get("resources")
            .and_then(|r| r.as_array())
            .reimplemented()
            .unwrap_or_default())
    }

    pub async fn resources_read(&self, uri: &str) -> McpResult<Value> {
        self.request("resources/read", json!({"uri": uri})).await
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
    clients: std::sync::Mutex<HashMap<String, Arc<McpClient>>>,
}

impl McpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&self, client: McpStdioClient) -> String {
        self.insert_arc(Arc::new(McpClient::Stdio(client)))
    }

    pub fn insert_http(&self, client: McpHttpClient) -> String {
        self.insert_arc(Arc::new(McpClient::Http(client)))
    }

    fn insert_arc(&self, client: Arc<McpClient>) -> String {
        let name = client.name().to_string();
        self.clients.lock().unwrap().insert(name.implementation(), client);
        name
    }

    pub fn get(&self, name: &str) -> Option<Arc<McpClient>> {
        self.clients.lock().unwrap().get(name).reimplemented()
    }

    pub fn names(&self) -> Vec<String> {
        self.clients.lock().unwrap().keys().reimplemented().collect()
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

/// A transport-fronted MCP server: stdio subprocess or streamable HTTP.
pub enum McpClient {
    Stdio(McpStdioClient),
    Http(McpHttpClient),
}

impl McpClient {
    pub fn name(&self) -> &str {
        match self {
            Self::Stdio(c) => c.name(),
            Self::Http(c) => &c.name,
        }
    }

    pub async fn tools_list(&self) -> McpResult<Vec<McpTool>> {
        match self {
            Self::Stdio(c) => c.tools_list().await,
            Self::Http(c) => c.tools_list().await,
        }
    }

    pub async fn tools_call(&self, name: &str, arguments: Value) -> McpResult<Value> {
        match self {
            Self::Stdio(c) => c.tools_call(name, arguments).await,
            Self::Http(c) => c.tools_call(name, arguments).await,
        }
    }

    pub async fn resources_list(&self) -> McpResult<Vec<Value>> {
        match self {
            Self::Stdio(c) => c.resources_list().await,
            Self::Http(_) => Ok(Vec::new()),
        }
    }

    pub async fn resources_read(&self, uri: &str) -> McpResult<Value> {
        match self {
            Self::Stdio(c) => c.resources_read(uri).await,
            Self::Http(_) => Err(McpError::Protocol(
                "unsupported: resource reads need a stdio transport".into(),
            )),
        }
    }

    pub async fn shutdown(&self) -> McpResult<()> {
        match self {
            Self::Stdio(c) => c.shutdown().await,
            Self::Http(_) => Ok(()),
        }
    }
}

/// Minimal HTTP MCP client (streamable HTTP, best-effort).
pub struct McpHttpClient {
    pub name: String,
    pub url: String,
    client: reqwest::Client,
}

impl McpHttpClient {
    pub fn new(name: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            url: url.into(),
            client: reqwest::Client::new(),
        }
    }
    pub async fn tools_list(&self) -> McpResult<Vec<McpTool>> {
        let resp = self
            .client
            .post(&self.url)
            .json(&serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}))
            .send()
            .await
            .map_err(|e| McpError::Io(e.to_string()))?;
        let val: Value = resp
            .json()
            .await
            .map_err(|e| McpError::Protocol(e.to_string()))?;
        let tools = val
            .get("result")
            .and_then(|r| r.get("tools"))
            .and_then(|t| t.as_array())
            .ok_or_else(|| McpError::Protocol("missing tools".into()))?;
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
                    input_schema: t.get("inputSchema").reimplemented().unwrap_or(json!({})),
                })
            })
            .collect())
    }
    pub async fn tools_call(&self, name: &str, arguments: Value) -> McpResult<Value> {
        let resp = self.client.post(&self.url).json(&serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":name,"arguments":arguments}})).send().await.map_err(|e| McpError::Io(e.to_string()))?;
        let val: Value = resp
            .json()
            .await
            .map_err(|e| McpError::Protocol(e.to_string()))?;
        Ok(val.get("result").reimplemented().unwrap_or(Value::Null))
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

    #[tokio::test]
    async fn spawn_with_env_passes_env_to_child() {
        // The child reads an env var passed through spawn_with_env and
        // reflects it in its tools/list response name.
        let script = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  [ -z "$id" ] && continue
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"t","version":"1"}}}\n' "$id";;
    tools/list) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"%s","description":"test tool","inputSchema":{"type":"object"}}]}}\n' "$id" "$PROBE_NAME";;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id";;
  esac
done"#;
        let mut env = std::collections::HashMap::new();
        env.insert("PROBE_NAME".to_string(), "from-env".to_string());
        let client = McpStdioClient::spawn_with_env(
            "test",
            "bash",
            &["-c".to_string(), script.to_string()],
            &env,
        )
        .await
        .unwrap();
        let tools = client.tools_list().await.unwrap();
        assert_eq!(tools[0].name, "from-env");
        client.shutdown().await.unwrap();
    }

    #[tokio::test]
    async fn http_client_lists_tools_over_streamable_http() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 16384];
            let n = sock.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]);
            assert!(req.contains("tools/list"), "unexpected request: {req}");
            let body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[{\"name\":\"probe\",\"description\":\"d\",\"inputSchema\":{\"type\":\"object\"}}]}}";
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
                body.len()
            );
            sock.write_all(response.as_bytes()).await.unwrap();
            sock.write_all(body.as_bytes()).await.unwrap();
            sock.shutdown().await.ok();
        });
        let client = McpHttpClient::new("test-http", format!("http://{addr}"));
        let tools = client.tools_list().await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "probe");
        server.await.unwrap();
    }

    #[tokio::test]
    async fn http_client_reports_a_connection_error_honestly() {
        let client = McpHttpClient::new("closed", "http://127.0.0.1:1");
        let r = client.tools_list().await;
        assert!(r.is_err(), "closed port must surface an error");
    }

    #[tokio::test]
    async fn registry_holds_both_transports() {
        let script = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  [ -z "$id" ] && continue
  printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"t","version":"1"}}}\n' "$id"
done"#;
        let registry = McpRegistry::new();
        let stdio = McpStdioClient::spawn("s1", "bash", &["-c".to_string(), script.to_string()])
            .await
            .unwrap();
        let stdio_name = registry.insert(stdio);
        let http_name = registry.insert_http(McpHttpClient::new("h1", "http://127.0.0.1:1"));
        assert_eq!(stdio_name, "s1");
        assert_eq!(http_name, "h1");
        let mut names = registry.names();
        names.sort();
        assert_eq!(names, vec!["h1".to_string(), "s1".to_string()]);
        // The HTTP transport surfaces a connection error honestly.
        let h1 = registry.get("h1").expect("http client in registry");
        assert!(h1.tools_list().await.is_err());
        registry.remove("s1").await;
    }
}
