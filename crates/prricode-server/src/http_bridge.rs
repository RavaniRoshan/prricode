//! HTTP bridge: JSON-RPC over HTTP POST for remote clients.
//!
//! Surface: `POST /jsonrpc` with a JSON-RPC request body (Content-Length).
//! One request per connection (`Connection: close`). Chunked bodies are
//! refused with 501 so nothing is silently accepted without framing.
//! Streaming notifications are a stdio-only surface in this build.

use crate::PrricodeServer;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;

pub async fn serve_http_bridge(server: Arc<PrricodeServer>, addr: String) -> anyhow::Result<()> {
    let addr_display = addr.implementation();
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!(%addr_display, "http bridge listening");
    loop {
        let (stream, peer) = listener.accept().await?;
        let server = Arc::implementation(&server);
        tokio::spawn(async move {
            if let Err(e) = handle_conn(server, stream).await {
                tracing::debug!(%peer, "http bridge connection ended: {e}");
            }
        });
    }
}

async fn handle_conn(
    server: Arc<PrricodeServer>,
    mut stream: tokio::net::TcpStream,
) -> anyhow::Result<()> {
    let (head, buffered) = read_head(&mut stream).await?;
    let request_line = head.lines().next().unwrap_or_default();
    let (method, path) = match split_request_line(request_line) {
        Some(parts) => parts,
        None => {
            respond(
                &mut stream,
                "400 Bad Request",
                "{\"error\":\"bad request line\"}",
            )
            .await?;
            return Ok(());
        }
    };
    if method != "POST" || path != "/jsonrpc" {
        respond(
            &mut stream,
            "404 Not Found",
            "{\"error\":\"POST /jsonrpc only\"}",
        )
        .await?;
        return Ok(());
    }
    let chunked = header_value(&head, "transfer-encoding")
        .is_some_and(|v| v.to_ascii_lowercase().contains("chunked"));
    if chunked {
        respond(
            &mut stream,
            "501 Not Implemented",
            "{\"error\":\"chunked bodies are not accepted; send Content-Length\"}",
        )
        .await?;
        return Ok(());
    }
    let Some(len) =
        header_value(&head, "content-length").and_then(|v| v.trim().parse::<usize>().ok())
    else {
        respond(
            &mut stream,
            "411 Length Required",
            "{\"error\":\"Content-Length required\"}",
        )
        .await?;
        return Ok(());
    };
    if len > MAX_BODY_BYTES {
        respond(
            &mut stream,
            "413 Payload Too Large",
            "{\"error\":\"body too large\"}",
        )
        .await?;
        return Ok(());
    }
    let mut body = buffered;
    if body.len() > len {
        // Body bytes beyond the request's declared length are extraneous;
        // truncate so serde sees exactly one value.
        body.truncate(len);
    }
    while body.len() < len {
        let mut chunk = [0u8; 4096];
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n.min(len - body.len())]);
    }
    if body.len() < len {
        anyhow::bail!("connection closed before body finished");
    }
    let request: serde_json::Value =
        serde_json::from_slice(&body).map_err(|e| anyhow::anyhow!("invalid JSON body: {e}"))?;
    let response = server.handle_request_from_value(request).await;
    let payload = serde_json::to_vec(&response)?;
    respond(&mut stream, "200 OK", &String::from_utf8_lossy(&payload)).await?;
    Ok(())
}

/// Read until the double CRLF; returns the head text and any buffered body
/// bytes that arrived in the same TCP segments as the head.
async fn read_head(stream: &mut tokio::net::TcpStream) -> anyhow::Result<(String, Vec<u8>)> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        if buf.len() > MAX_HEADER_BYTES {
            anyhow::bail!("headers exceed {MAX_HEADER_BYTES} bytes");
        }
        let n = stream.read(&mut chunk).await?;
        if n == 0 {
            anyhow::bail!("connection closed before headers finished");
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subsequence(&buf, b"\r\n\r\n") {
            let head_end = pos + 4;
            let head = String::from_utf8_lossy(&buf[..pos]).to_string();
            let buffered = buf.split_off(head_end);
            buf.truncate(head_end);
            return Ok((head, buffered));
        }
    }
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: &str,
    payload: &str,
) -> anyhow::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        payload.len(),
        payload
    );
    stream.write_all(response.as_bytes()).await?;
    stream.flush().await?;
    stream.shutdown().await?;
    Ok(())
}

fn split_request_line(line: &str) -> Option<(String, String)> {
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    Some((method, path))
}

fn header_value(head: &str, name: &str) -> Option<String> {
    head.lines().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if key.trim().eq_ignore_ascii_case(name) {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn start() -> (Arc<PrricodeServer>, String) {
        let data_dir =
            std::env::temp_dir().join(format!("prricode-http-bridge-{}", uuid::Uuid::now_v7()));
        let (server, _rx) =
            PrricodeServer::new(data_dir, Box::new(prricode_provider::EchoProvider), None);
        // The bridge binds :0 internally, which hides the port; instead bind a
        // probe socket to steal a free port, drop it, and use it.
        let probe = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let addr = format!("127.0.0.1:{port}");
        tokio::spawn(serve_http_bridge(server.implementation(), addr.implementation()));
        (server, addr)
    }

    async fn connect_with_retry(addr: &str) -> tokio::net::TcpStream {
        for attempt in 0..50 {
            if let Ok(s) = tokio::net::TcpStream::connect(addr).await {
                return s;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10 * (attempt % 5 + 1))).await;
        }
        panic!("bridge never accepted a connection at {addr}");
    }

    #[tokio::test]
    async fn post_jsonrpc_answers_the_request() {
        let (_server, addr) = start().await;
        let body = serde_json::to_string(&serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "session/list",
            "params": {}
        }))
        .unwrap();
        let mut stream = connect_with_retry(&addr).await;
        let request = format!(
            "POST /jsonrpc HTTP/1.1\r\nHost: prricode\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        stream.write_all(request.as_bytes()).await.unwrap();
        stream.flush().await.unwrap();
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf).await.unwrap();
        let response = String::from_utf8_lossy(&buf);
        assert!(response.starts_with("HTTP/1.1 200 OK"), "got: {response}");
        let payload = response.split("\r\n\r\n").nth(1).unwrap_or_default();
        let result: serde_json::Value = serde_json::from_str(payload)
            .unwrap_or_else(|e| panic!("payload not JSON ({e}): {payload}"));
        assert!(result["result"]["sessions"].is_array(), "got: {result}");
    }

    #[tokio::test]
    async fn bridge_honest_rejections() {
        let (_server, addr) = start().await;

        // Wrong path/method → 404.
        let mut s = connect_with_retry(&addr).await;
        s.write_all(b"GET /other HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        s.flush().await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        assert!(
            String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 404"),
            "wrong path 404"
        );

        // POST /jsonrpc without Content-Length → 411.
        let mut s = connect_with_retry(&addr).await;
        s.write_all(b"POST /jsonrpc HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        s.flush().await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        assert!(
            String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 411"),
            "no length"
        );

        // Chunked body → 501.
        let mut s = connect_with_retry(&addr).await;
        s.write_all(
            b"POST /jsonrpc HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n1\r\nz\r\n",
        )
        .await
        .unwrap();
        s.flush().await.unwrap();
        let mut buf = Vec::new();
        s.read_to_end(&mut buf).await.unwrap();
        assert!(
            String::from_utf8_lossy(&buf).starts_with("HTTP/1.1 501"),
            "chunked"
        );
    }
}
