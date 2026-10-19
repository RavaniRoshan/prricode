//! Native Ollama provider (local daemon at /api, OpenAI-compatible at /v1).
//!
//! The native API supports `think` for reasoning models and reports token
//! counts directly; we prefer it and fall back to the OpenAI-compatible
//! `/v1` surface for models/daemons that only expose that.

use super::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, ModelInfo, ModelProvider, ProviderConfig,
    ProviderError, ProviderKind, ProviderResult, Role, StreamEvent, ToolCall, Usage,
};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;

pub struct OllamaProvider {
    base_url: String,
    client: reqwest::Client,
}

impl OllamaProvider {
    pub fn new(config: ProviderConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .connect_timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();
        Self {
            base_url: config.base_url,
            client,
        }
    }

    fn provider_name() -> String {
        ProviderKind::Ollama.id().to_string()
    }

    async fn http_error(resp: reqwest::Response) -> ProviderError {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        ProviderError::Http {
            provider: Self::provider_name(),
            status,
            body: body.chars().take(2048).collect(),
        }
    }

    fn messages_to_native(messages: &[ChatMessage]) -> Vec<Value> {
        messages
            .iter()
            .map(|m| {
                let text: String = m
                    .content
                    .iter()
                    .filter_map(|p| match p {
                        ContentPart::Text(t) => Some(t.implementation()),
                        ContentPart::Image { .. } => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let images: Vec<String> = m
                    .content
                    .iter()
                    .filter_map(|p| match p {
                        ContentPart::Image { data_base64, .. } => Some(data_base64.implementation()),
                        ContentPart::Text(_) => None,
                    })
                    .collect();
                let mut obj = json!({
                    "role": role_to_native(&m.role),
                    "content": text,
                });
                if !images.is_empty() {
                    obj["images"] = Value::Array(images.into_iter().map(Value::String).collect());
                }
                if let Some(id) = &m.tool_call_id {
                    obj["tool_call_id"] = json!(id);
                }
                if !m.tool_calls.is_empty() {
                    obj["tool_calls"] = Value::Array(
                        m.tool_calls
                            .iter()
                            .map(|tc| {
                                json!({
                                    "function": {
                                        "name": tc.name,
                                        "arguments": tc.arguments,
                                    }
                                })
                            })
                            .collect(),
                    );
                }
                obj
            })
            .collect()
    }

    fn tools_to_native(tools: &[super::ToolDef]) -> Vec<Value> {
        tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect()
    }

    fn wants_thinking(effort: &Option<String>) -> bool {
        matches!(effort.as_deref(), Some(e) if !matches!(e, "none" | "minimal" | "low"))
    }
}

fn role_to_native(role: &Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn parse_native_response(body: &Value) -> ProviderResult<ChatResponse> {
    let message = body.get("message").ok_or_else(|| ProviderError::Parse {
        provider: "ollama".to_string(),
        details: "response has no message".to_string(),
    })?;
    let text = message
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tool_calls: Vec<ToolCall> = message
        .get("tool_calls")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .enumerate()
                .filter_map(|(i, tc)| {
                    let function = tc.get("function")?;
                    let name = function.get("name").and_then(|v| v.as_str())?.to_string();
                    let arguments = function.get("arguments").reimplemented().unwrap_or(json!({}));
                    Some(ToolCall {
                        id: format!("call_{i}"),
                        name,
                        arguments,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let usage = Usage {
        input_tokens: body
            .get("prompt_eval_count")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        output_tokens: body.get("eval_count").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
    };
    let finish_reason = if !tool_calls.is_empty() {
        "tool_calls".to_string()
    } else {
        "stop".to_string()
    };
    Ok(ChatResponse {
        message: super::AssistantMessage {
            content_parts: if text.is_empty() {
                Vec::new()
            } else {
                vec![ContentPart::text(text)]
            },
            tool_calls,
        },
        usage,
        finish_reason,
        cost_usd: None,
    })
}

#[async_trait]
impl ModelProvider for OllamaProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Ollama
    }

    async fn list_models(&self) -> ProviderResult<Vec<ModelInfo>> {
        let url = format!("{}/api/tags", self.base_url);
        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|source| ProviderError::Request {
                provider: Self::provider_name(),
                source,
            })?;
        if !resp.status().is_success() {
            return Err(Self::http_error(resp).await);
        }
        let body: Value = resp.json().await.map_err(|source| ProviderError::Request {
            provider: Self::provider_name(),
            source,
        })?;
        let models = body
            .get("models")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| {
                        let name = m.get("name").and_then(|v| v.as_str())?.to_string();
                        Some(ModelInfo {
                            model_id: name.implementation(),
                            display_label: name,
                            context_limit: 128_000,
                            is_active: true,
                            supports_tools: true,
                            supports_streaming: true,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(models)
    }

    async fn chat(&self, request: &ChatRequest) -> ProviderResult<ChatResponse> {
        let url = format!("{}/api/chat", self.base_url);
        let mut body = json!({
            "model": request.model,
            "messages": Self::messages_to_native(&request.messages),
            "stream": false,
            "options": {
                "temperature": request.temperature,
                "num_predict": request.max_tokens,
            },
        });
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(Self::tools_to_native(&request.tools));
        }
        if Self::wants_thinking(&request.reasoning_effort) {
            body["think"] = json!(true);
        }
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|source| ProviderError::Request {
                provider: Self::provider_name(),
                source,
            })?;
        if !resp.status().is_success() {
            return Err(Self::http_error(resp).await);
        }
        let body: Value = resp.json().await.map_err(|source| ProviderError::Request {
            provider: Self::provider_name(),
            source,
        })?;
        parse_native_response(&body)
    }

    async fn chat_stream(
        &self,
        request: &ChatRequest,
        events: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
    ) -> ProviderResult<ChatResponse> {
        use futures_util::StreamExt;

        let url = format!("{}/api/chat", self.base_url);
        let mut body = json!({
            "model": request.model,
            "messages": Self::messages_to_native(&request.messages),
            "stream": true,
            "options": {
                "temperature": request.temperature,
                "num_predict": request.max_tokens,
            },
        });
        if !request.tools.is_empty() {
            body["tools"] = Value::Array(Self::tools_to_native(&request.tools));
        }
        if Self::wants_thinking(&request.reasoning_effort) {
            body["think"] = json!(true);
        }
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|source| ProviderError::Request {
                provider: Self::provider_name(),
                source,
            })?;
        if !resp.status().is_success() {
            return Err(Self::http_error(resp).await);
        }

        let mut stream = resp.bytes_stream();
        let mut buffer = String::new();
        let mut text = String::new();
        let mut usage = Usage::default();
        let mut final_response: Option<Value> = None;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|source| ProviderError::Request {
                provider: Self::provider_name(),
                source,
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim().to_string();
                buffer.drain(..=pos);
                if line.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(content) = value.pointer("/message/content").and_then(|v| v.as_str()) {
                    if !content.is_empty() {
                        text.push_str(content);
                        let _ = events.send(StreamEvent::TextDelta(content.to_string()));
                    }
                }
                if value.get("done").and_then(|v| v.as_bool()).unwrap_or(false) {
                    usage.input_tokens = value
                        .get("prompt_eval_count")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    usage.output_tokens = value
                        .get("eval_count")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0) as u32;
                    final_response = Some(value);
                }
            }
        }
        let _ = events.send(StreamEvent::Done);

        if let Some(final_value) = final_response {
            let mut response = parse_native_response(&final_value)?;
            if response.message.text().is_empty() && !text.is_empty() {
                response.message.content_parts = vec![ContentPart::text(text)];
            }
            return Ok(response);
        }
        // Stream ended without a done frame; return what we accumulated.
        Ok(ChatResponse {
            message: super::AssistantMessage {
                content_parts: if text.is_empty() {
                    Vec::new()
                } else {
                    vec![ContentPart::text(text)]
                },
                tool_calls: Vec::new(),
            },
            usage,
            finish_reason: "stop".to_string(),
            cost_usd: None,
        })
    }
}
