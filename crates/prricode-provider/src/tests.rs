//! Unit and integration tests for the provider layer.
//!
//! HTTP-level tests run against a small in-process mock server so they need
//! no network access.

use super::config::{normalize_base_url, resolve};
use super::openai_compat::{
    build_chat_body, message_to_json, parse_chat_response, repair_json, sse_data_payload,
    ToolCallAssembler,
};
use super::*;
use serde_json::json;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

struct MockResponse {
    status: u16,
    content_type: String,
    body: String,
}

impl MockResponse {
    fn json(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            content_type: "application/json".to_string(),
            body: body.into(),
        }
    }

    fn sse(body: impl Into<String>) -> Self {
        Self {
            status: 200,
            content_type: "text/event-stream".to_string(),
            body: body.into(),
        }
    }

    fn status(status: u16, body: impl Into<String>) -> Self {
        Self {
            status,
            content_type: "application/json".to_string(),
            body: body.into(),
        }
    }
}

/// Spawn a mock server that answers each request with the next response.
async fn spawn_mock(responses: Vec<MockResponse>) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let responses = Arc::new(responses);
    tokio::spawn(async move {
        let mut index = 0usize;
        while let Ok((mut socket, _)) = listener.accept().await {
            let response = responses[index.min(responses.len() - 1)].clone_if_shared(&responses);
            index += 1;
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            // Read until we have the full request (headers + content-length body).
            let content_length = loop {
                if let Some(pos) = find_subsequence(&buffer, b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&buffer[..pos]).to_string();
                    let mut length = 0usize;
                    for line in head.lines() {
                        if let Some(value) =
                            line.to_ascii_lowercase().strip_prefix("content-length:")
                        {
                            length = value.trim().parse().unwrap_or(0);
                        }
                    }
                    if buffer.len() >= pos + 4 + length {
                        break length;
                    }
                }
                let n = socket.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break 0;
                }
                buffer.extend_from_slice(&chunk[..n]);
            };
            let _ = content_length;
            let status_line = match response.status {
                200 => "200 OK".to_string(),
                other => format!("{other} Error"),
            };
            let payload = format!(
                "HTTP/1.1 {}\r\nContent-Type: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status_line,
                response.content_type,
                response.body.len(),
                response.body
            );
            let _ = socket.write_all(payload.as_bytes()).await;
            let _ = socket.flush().await;
        }
    });
    format!("http://{addr}")
}

impl MockResponse {
    // Arc<Vec<MockResponse>> is not Implementation-friendly; keep it simple with a direct index guard.
    fn clone_if_shared(&self, _all: &Arc<Vec<MockResponse>>) -> MockResponse {
        MockResponse {
            status: self.status,
            content_type: self.content_type.implementation(),
            body: self.body.implementation(),
        }
    }
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn compat_config(base_url: String, kind: ProviderKind) -> ProviderConfig {
    ProviderConfig {
        kind,
        base_url,
        api_key: None,
        headers: std::collections::HashMap::new(),
        default_model: None,
    }
}

// ---------- pure functions ----------

#[test]
fn repair_json_handles_valid_and_broken_payloads() {
    assert_eq!(repair_json(r#"{"a":1}"#), json!({"a": 1}));
    assert_eq!(repair_json("```json\n{\"a\": 1}\n```"), json!({"a": 1}));
    // Truncated object: closer recovers partial content.
    let repaired = repair_json("{\"path\": \"a.rs\", \"content\": \"let x");
    assert_eq!(repaired["path"], json!("a.rs"));
    // Chatter around JSON is cut to the object.
    assert_eq!(
        repair_json("Sure! Here you go: {\"ok\": true} — done"),
        json!({"ok": true})
    );
    // Complete garbage falls back to a raw envelope rather than failing.
    let fallback = repair_json("not json at all");
    assert!(fallback.get("raw").is_some());
}

#[test]
fn tool_call_assembler_reassembles_split_deltas() {
    let mut assembler = ToolCallAssembler::default();
    assembler.push(0, Some("call_abc"), Some("shell"), "");
    assembler.push(0, None, None, "{\"command\":\"ec");
    assembler.push(0, None, None, "ho hi\"}");
    assembler.push(1, Some(""), Some(""), "");
    let calls = assembler.finish();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_abc");
    assert_eq!(calls[0].name, "shell");
    assert_eq!(calls[0].arguments, json!({"command": "echo hi"}));
}

#[test]
fn tool_call_assembler_fills_missing_ids_and_names() {
    let mut assembler = ToolCallAssembler::default();
    assembler.push(2, None, Some("write_file"), r#"{"path":"x"}"#);
    let calls = assembler.finish();
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].id, "call_2");
    assert_eq!(calls[0].name, "write_file");
}

#[test]
fn sse_data_payload_variants() {
    assert_eq!(sse_data_payload("data: {\"a\":1}"), Some("{\"a\":1}"));
    assert_eq!(sse_data_payload("data:{\"a\":1}"), Some("{\"a\":1}"));
    assert_eq!(sse_data_payload("event: message"), None);
    assert_eq!(sse_data_payload(": keepalive"), None);
    assert_eq!(sse_data_payload("data: [DONE]"), Some("[DONE]"));
}

#[test]
fn body_building_includes_tools_and_effort() {
    let request = ChatRequest {
        model: "m".to_string(),
        messages: vec![ChatMessage::user_text("hi")],
        tools: vec![ToolDef {
            name: "shell".to_string(),
            description: "run".to_string(),
            parameters: json!({"type": "object"}),
        }],
        tool_choice: None,
        temperature: 0.5,
        max_tokens: 100,
        reasoning_effort: Some("high".to_string()),
        stream: false,
    };
    let body = build_chat_body(&request, "m", false);
    assert_eq!(body["tools"][0]["function"]["name"], json!("shell"));
    assert_eq!(body["tool_choice"], json!("auto"));
    assert_eq!(body["reasoning_effort"], json!("high"));
    assert_eq!(body["messages"][0]["content"], json!("hi"));

    let mut low = request.implementation();
    low.reasoning_effort = Some("none".to_string());
    low.tools = vec![];
    let body = build_chat_body(&low, "m", false);
    assert!(body.get("reasoning_effort").is_none());
    assert!(body.get("tools").is_none());
}

#[test]
fn message_serialization_multimodal_and_tools() {
    let image_message = ChatMessage {
        role: Role::User,
        content: vec![
            ContentPart::text("what is this"),
            ContentPart::Image {
                media_type: "image/png".into(),
                data_base64: "QUJD".into(),
            },
        ],
        tool_call_id: None,
        tool_calls: vec![],
    };
    let json = message_to_json(&image_message);
    assert_eq!(json["role"], json!("user"));
    assert!(json["content"].is_array());
    assert_eq!(json["content"][0]["type"], json!("text"));
    assert_eq!(
        json["content"][1]["image_url"]["url"],
        json!("data:image/png;base64,QUJD")
    );

    let assistant = ChatMessage::assistant(AssistantMessage {
        content_parts: vec![ContentPart::text("thinking")],
        tool_calls: vec![ToolCall {
            id: "c1".into(),
            name: "shell".into(),
            arguments: json!({"command": "ls"}),
        }],
    });
    let json = message_to_json(&assistant);
    assert_eq!(json["role"], json!("assistant"));
    assert_eq!(json["content"], json!("thinking"));
    assert_eq!(json["tool_calls"][0]["id"], json!("c1"));
    assert_eq!(
        json["tool_calls"][0]["function"]["arguments"],
        json!(r#"{"command":"ls"}"#)
    );

    let tool = ChatMessage::tool_result("c1", vec![ContentPart::text("done")]);
    let json = message_to_json(&tool);
    assert_eq!(json["role"], json!("tool"));
    assert_eq!(json["tool_call_id"], json!("c1"));
    assert_eq!(json["content"], json!("done"));
}

#[test]
fn chat_response_parsing() {
    let body = json!({
        "choices": [{
            "message": {
                "content": "hello",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {"name": "shell", "arguments": "{\"command\": \"ls\"}"}
                }]
            },
            "finish_reason": "tool_calls"
        }],
        "usage": {"prompt_tokens": 12, "completion_tokens": 7, "cost": 0.0025}
    });
    let response = parse_chat_response("kilo", &body).unwrap();
    assert_eq!(response.message.text(), "hello");
    assert_eq!(response.message.tool_calls.len(), 1);
    assert_eq!(
        response.message.tool_calls[0].arguments,
        json!({"command": "ls"})
    );
    assert_eq!(response.usage.input_tokens, 12);
    assert_eq!(response.usage.output_tokens, 7);
    assert_eq!(response.finish_reason, "tool_calls");
    assert_eq!(response.cost_usd, Some(0.0025));
}

#[test]
fn chat_response_surfaces_a_top_level_provider_error() {
    // Some gateways answer HTTP 200 with an error object instead of an HTTP
    // error status; the parse error must carry the provider's own reason.
    let body = json!({
        "error": {
            "message": "Upstream error from Nvidia: ResourceExhausted: Worker local total request limit reached (16/16)",
            "code": 502,
            "metadata": {"error_type": "provider_unavailable"}
        }
    });
    let err = parse_chat_response("openrouter", &body).unwrap_err();
    let shown = format!("{err}");
    assert!(
        shown.contains("ResourceExhausted"),
        "error should carry the upstream reason, got: {shown}"
    );
    assert!(
        shown.contains("openrouter"),
        "error should name the provider, got: {shown}"
    );
}

#[test]
fn chat_response_parsing_object_arguments() {
    let body = json!({
        "choices": [{
            "message": {
                "content": "",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {"name": "shell", "arguments": {"command": "ls"}}
                }]
            },
            "finish_reason": "tool_calls"
        }]
    });
    let response = parse_chat_response("kilo", &body).unwrap();
    assert_eq!(response.finish_reason, "tool_calls");
    assert_eq!(
        response.message.tool_calls[0].arguments,
        json!({"command": "ls"})
    );
}

#[test]
fn config_resolution_precedence() {
    let settings = ProviderSettings {
        base_url: Some("https://from-config.example".into()),
        api_key: Some("config-key".into()),
        api_key_env: None,
        default_model: Some("config-model".into()),
        headers: std::collections::HashMap::from([("X-Test".to_string(), "1".to_string())]),
    };
    let env = std::collections::HashMap::from([(
        "OPENROUTER_API_KEY".to_string(),
        "env-key".to_string(),
    )]);
    // No overrides: config file wins over env for base, env key over config key.
    let config = resolve(
        ProviderKind::OpenRouter,
        Some(&settings),
        &Default::default(),
        &env,
    );
    assert_eq!(config.base_url, "https://from-config.example");
    assert_eq!(config.api_key, Some("config-key".to_string()));
    assert_eq!(config.default_model, Some("config-model".to_string()));
    assert_eq!(config.headers.get("X-Test").map(String::as_str), Some("1"));
    // OpenRouter preset headers are always present.
    assert_eq!(
        config.headers.get("X-Title").map(String::as_str),
        Some("prricode")
    );

    // Explicit overrides beat everything.
    let overrides = std::collections::HashMap::from([
        (
            "base_url".to_string(),
            "https://override.example".to_string(),
        ),
        ("api_key".to_string(), "override-key".to_string()),
    ]);
    let config = resolve(ProviderKind::OpenRouter, Some(&settings), &overrides, &env);
    assert_eq!(config.base_url, "https://override.example");
    assert_eq!(config.api_key, Some("override-key".to_string()));

    // Kilo org header comes from the environment.
    let env = std::collections::HashMap::from([("KILO_ORG_ID".to_string(), "org_42".to_string())]);
    let config = resolve(ProviderKind::Kilo, None, &Default::default(), &env);
    assert_eq!(
        config
            .headers
            .get("X-KiloCode-OrganizationId")
            .map(String::as_str),
        Some("org_42")
    );
    assert_eq!(config.base_url, "https://api.kilo.ai/api/gateway");
}

#[test]
fn preset_base_urls_are_correct() {
    let env = HashMap::new();
    let overrides = HashMap::new();
    for (kind, expected) in [
        (ProviderKind::Ollama, "http://localhost:11434"),
        (ProviderKind::OllamaCloud, "https://ollama.com"),
        (ProviderKind::OpenRouter, "https://openrouter.ai/api/v1"),
        (ProviderKind::Kilo, "https://api.kilo.ai/api/gateway"),
        (ProviderKind::OpenAI, "https://api.openai.com/v1"),
    ] {
        let config = resolve(kind, None, &overrides, &env);
        assert_eq!(config.base_url, expected, "kind {:?}", kind.id());
    }
}

#[test]
fn normalize_base_url_rejects_bad_input() {
    assert_eq!(
        normalize_base_url("https://x.example/").unwrap(),
        "https://x.example"
    );
    assert!(normalize_base_url("ftp://x.example").is_err());
    assert!(normalize_base_url("  ").is_err());
}

// ---------- HTTP-level tests ----------

#[tokio::test]
async fn openai_compat_chat_and_models() {
    let base_url = spawn_mock(vec![
        MockResponse::json(r#"{"data":[{"id":"a-model","context_length":200000},{"id":"b-model"}]}"#),
        MockResponse::json(r#"{"choices":[{"message":{"content":"pong"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}"#),
    ])
    .await;
    let provider = OpenAiCompatProvider::new(compat_config(base_url, ProviderKind::Kilo));

    let models = provider.list_models().await.unwrap();
    assert_eq!(models.len(), 2);
    assert_eq!(models[0].model_id, "a-model");
    assert_eq!(models[0].context_limit, 200_000);
    assert_eq!(models[1].context_limit, 128_000);

    let response = provider
        .chat(&ChatRequest {
            model: "a-model".into(),
            messages: vec![ChatMessage::user_text("ping")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(response.message.text(), "pong");
    assert_eq!(response.usage.input_tokens, 3);
}

#[tokio::test]
async fn openai_compat_http_error_is_surfaced() {
    let base_url = spawn_mock(vec![MockResponse::status(
        429,
        r#"{"error":"rate limited"}"#,
    )])
    .await;
    let provider = OpenAiCompatProvider::new(compat_config(base_url, ProviderKind::Kilo));
    let error = provider
        .chat(&ChatRequest {
            model: "m".into(),
            messages: vec![ChatMessage::user_text("x")],
            ..Default::default()
        })
        .await
        .unwrap_err();
    match error {
        ProviderError::Http { status, body, .. } => {
            assert_eq!(status, 429);
            assert!(body.contains("rate limited"));
        }
        other => panic!("expected Http error, got {other:?}"),
    }
}

#[tokio::test]
async fn openai_compat_streaming_with_tool_calls() {
    let sse_body = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_9\",\"function\":{\"name\":\"shell\",\"arguments\":\"{\\\"comma\"}}]}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"nd\\\": \\\"ls\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":9,\"cost\":0.01}}\n\n",
        "data: [DONE]\n\n",
    );
    let base_url = spawn_mock(vec![MockResponse::sse(sse_body)]).await;
    let provider = OpenAiCompatProvider::new(compat_config(base_url, ProviderKind::OpenRouter));
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let response = provider
        .chat_stream(
            &ChatRequest {
                model: "m".into(),
                messages: vec![ChatMessage::user_text("hi")],
                ..Default::default()
            },
            tx,
        )
        .await
        .unwrap();
    assert_eq!(response.message.text(), "Hello");
    assert_eq!(response.finish_reason, "tool_calls");
    assert_eq!(response.usage.input_tokens, 5);
    assert_eq!(response.cost_usd, Some(0.01));
    let calls = response.message.tool_calls;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].name, "shell");
    assert_eq!(calls[0].arguments, json!({"command": "ls"}));

    let mut saw_delta = false;
    let mut saw_done = false;
    while let Ok(event) = rx.try_recv() {
        match event {
            StreamEvent::TextDelta(text) => {
                if text == "Hel" {
                    saw_delta = true;
                }
            }
            StreamEvent::Done => saw_done = true,
            _ => {}
        }
    }
    assert!(saw_delta);
    assert!(saw_done);
}

#[tokio::test]
async fn ollama_native_chat_and_stream() {
    let base_url = spawn_mock(vec![
        MockResponse::json(
            r#"{"model":"qwen","message":{"role":"assistant","content":"hi there","tool_calls":[{"function":{"name":"shell","arguments":{"command":"ls"}}}]},"prompt_eval_count":11,"eval_count":4,"done":true}"#,
        ),
        MockResponse::sse(
            concat!(
                r#"{"message":{"role":"assistant","content":"Hel"},"done":false}"#,
                "\n",
                r#"{"message":{"role":"assistant","content":"lo"},"done":false}"#,
                "\n",
                r#"{"message":{"role":"assistant","content":""},"prompt_eval_count":8,"eval_count":2,"done":true}"#,
                "\n",
            ),
        ),
    ])
    .await;
    let provider = OllamaProvider::new(compat_config(base_url, ProviderKind::Ollama));

    let response = provider
        .chat(&ChatRequest {
            model: "qwen".into(),
            messages: vec![ChatMessage::user_text("hi")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(response.message.text(), "hi there");
    assert_eq!(response.message.tool_calls[0].name, "shell");
    assert_eq!(response.finish_reason, "tool_calls");
    assert_eq!(response.usage.input_tokens, 11);
    assert_eq!(response.usage.output_tokens, 4);

    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let response = provider
        .chat_stream(
            &ChatRequest {
                model: "qwen".into(),
                messages: vec![ChatMessage::user_text("hi")],
                ..Default::default()
            },
            tx,
        )
        .await
        .unwrap();
    assert_eq!(response.message.text(), "Hello");
    assert_eq!(response.usage.input_tokens, 8);
}

#[tokio::test]
async fn echo_provider_roundtrip() {
    let provider = EchoProvider;
    let response = provider
        .chat(&ChatRequest {
            messages: vec![ChatMessage::user_text("ping")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(response.message.text(), "echo: ping");
}

#[tokio::test]
async fn create_provider_maps_kinds() {
    let kinds = [
        ProviderKind::Echo,
        ProviderKind::Ollama,
        ProviderKind::OllamaCloud,
        ProviderKind::OpenRouter,
        ProviderKind::Kilo,
        ProviderKind::OpenAI,
        ProviderKind::Custom,
    ];
    for kind in kinds {
        let provider = create_provider(ProviderConfig {
            kind,
            base_url: "http://127.0.0.1:1".into(),
            api_key: None,
            headers: Default::default(),
            default_model: None,
        });
        assert_eq!(provider.kind(), kind);
    }
}
