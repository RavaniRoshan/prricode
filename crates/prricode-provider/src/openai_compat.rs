//! OpenAI-compatible chat-completions client.
//!
//! Backs the OpenRouter, Kilo AI Gateway, Ollama Cloud, OpenAI, and custom
//! presets. Handles non-streaming and SSE-streaming chat, function calling,
//! multimodal content, usage/cost extraction, and lenient parsing of the
//! malformed tool-call payloads small local models tend to emit.

use super::{
    ChatMessage, ChatRequest, ChatResponse, ContentPart, ModelInfo, ModelProvider, ProviderConfig,
    ProviderError, ProviderKind, ProviderResult, Role, StreamEvent, ToolCall, ToolChoice, Usage,
};
use async_trait::async_trait;
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;

const MAX_TOOL_ARGUMENTS_LEN: usize = 1 << 20;

pub struct OpenAiCompatProvider {
    kind: ProviderKind,
    base_url: String,
    api_key: Option<String>,
    headers: std::collections::HashMap<String, String>,
    default_model: Option<String>,
    client: reqwest::Client,
}

impl OpenAiCompatProvider {
    pub fn new(config: ProviderConfig) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(600))
            .connect_timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self {
            kind: config.kind,
            base_url: config.base_url,
            api_key: config.api_key,
            headers: config.headers,
            default_model: config.default_model,
            client,
        }
    }

    fn provider_name(&self) -> String {
        self.kind.id().to_string()
    }

    async fn error_from_status(&self, resp: reqwest::Response) -> ProviderError {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        let trimmed: String = body.chars().take(2048).collect();
        ProviderError::Http {
            provider: self.provider_name(),
            status,
            body: trimmed,
        }
    }

    fn apply_common_headers(&self, req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        let mut req = req;
        if let Some(key) = &self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        for (k, v) in &self.headers {
            req = req.header(k.as_str(), v.as_str());
        }
        req
    }

    fn model_of(&self, request: &ChatRequest) -> String {
        if !request.model.is_empty() {
            request.model.clone()
        } else {
            self.default_model.clone().unwrap_or_default()
        }
    }
}

#[async_trait]
impl ModelProvider for OpenAiCompatProvider {
    fn kind(&self) -> ProviderKind {
        self.kind
    }

    async fn list_models(&self) -> ProviderResult<Vec<ModelInfo>> {
        let url = format!("{}/models", self.base_url);
        let resp = self
            .apply_common_headers(self.client.get(&url))
            .send()
            .await
            .map_err(|source| ProviderError::Request {
                provider: self.provider_name(),
                source,
            })?;
        if !resp.status().is_success() {
            return Err(self.error_from_status(resp).await);
        }
        let body: Value = resp.json().await.map_err(|source| ProviderError::Request {
            provider: self.provider_name(),
            source,
        })?;
        let data =
            body.get("data")
                .and_then(|d| d.as_array())
                .ok_or_else(|| ProviderError::Parse {
                    provider: self.provider_name(),
                    details: "response has no 'data' array".to_string(),
                })?;
        let mut models: Vec<ModelInfo> = data
            .iter()
            .filter_map(|m| {
                let id = m.get("id").or_else(|| m.get("name"))?.as_str()?.to_string();
                let context_limit = m
                    .get("context_length")
                    .or_else(|| m.get("context_window"))
                    .and_then(|v| v.as_u64())
                    .map(|v| v as u32)
                    .unwrap_or(128_000);
                Some(ModelInfo {
                    model_id: id.clone(),
                    display_label: id,
                    context_limit,
                    is_active: true,
                })
            })
            .collect();
        models.sort_by(|a, b| a.model_id.cmp(&b.model_id));
        Ok(models)
    }

    async fn chat(&self, request: &ChatRequest) -> ProviderResult<ChatResponse> {
        let url = format!("{}/chat/completions", self.base_url);
        let body = build_chat_body(request, &self.model_of(request), false);
        let resp = self
            .apply_common_headers(self.client.post(&url).json(&body))
            .send()
            .await
            .map_err(|source| ProviderError::Request {
                provider: self.provider_name(),
                source,
            })?;
        if !resp.status().is_success() {
            return Err(self.error_from_status(resp).await);
        }
        let body: Value = resp.json().await.map_err(|source| ProviderError::Request {
            provider: self.provider_name(),
            source,
        })?;
        parse_chat_response(&self.provider_name(), &body)
    }

    async fn chat_stream(
        &self,
        request: &ChatRequest,
        events: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
    ) -> ProviderResult<ChatResponse> {
        let url = format!("{}/chat/completions", self.base_url);
        let body = build_chat_body(request, &self.model_of(request), true);
        let resp = self
            .apply_common_headers(self.client.post(&url).json(&body))
            .send()
            .await
            .map_err(|source| ProviderError::Request {
                provider: self.provider_name(),
                source,
            })?;
        if !resp.status().is_success() {
            return Err(self.error_from_status(resp).await);
        }

        let mut assembler = ToolCallAssembler::default();
        let mut text = String::new();
        let mut finish_reason = String::from("stop");
        let mut usage = Usage::default();
        let mut cost = None;
        let mut buffer = String::new();
        let mut stream = resp.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|source| ProviderError::Request {
                provider: self.provider_name(),
                source,
            })?;
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            // Process complete lines only.
            while let Some(pos) = buffer.find('\n') {
                let line = buffer[..pos].trim_end_matches('\r').to_string();
                buffer.drain(..=pos);
                let Some(data) = sse_data_payload(&line) else {
                    continue;
                };
                if data == "[DONE]" {
                    let _ = events.send(StreamEvent::Done);
                    continue;
                }
                let value: Value = match serde_json::from_str(data) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if let Some(u) = parse_usage(&value) {
                    usage = u;
                    let _ = events.send(StreamEvent::Usage(u));
                }
                if let Some(c) = parse_cost(&value) {
                    cost = Some(c);
                }
                if let Some(choice) = value
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|c| c.first())
                {
                    if let Some(fr) = choice.get("finish_reason").and_then(|v| v.as_str()) {
                        finish_reason = fr.to_string();
                    }
                    if let Some(delta) = choice.get("delta") {
                        if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                            if !content.is_empty() {
                                text.push_str(content);
                                let _ = events.send(StreamEvent::TextDelta(content.to_string()));
                            }
                        }
                        if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array())
                        {
                            for tc in tool_calls {
                                let index =
                                    tc.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                                let id = tc.get("id").and_then(|v| v.as_str());
                                let function = tc.get("function");
                                let name = function
                                    .and_then(|f| f.get("name"))
                                    .and_then(|v| v.as_str());
                                let args = function
                                    .and_then(|f| f.get("arguments"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("");
                                if let Some(name) = name {
                                    if !name.is_empty() {
                                        let _ = events.send(StreamEvent::ToolCallStart {
                                            index,
                                            id: id.unwrap_or("").to_string(),
                                            name: name.to_string(),
                                        });
                                    }
                                }
                                if !args.is_empty() {
                                    let _ = events.send(StreamEvent::ToolCallArgsDelta {
                                        index,
                                        arguments: args.to_string(),
                                    });
                                }
                                assembler.push(index, id, name, args);
                            }
                        }
                    }
                }
            }
        }

        // Some providers omit a final newline before closing; drain leftovers.
        if !buffer.trim().is_empty() {
            if let Some(data) = sse_data_payload(buffer.trim()) {
                if data != "[DONE]" {
                    if let Ok(value) = serde_json::from_str::<Value>(data) {
                        if let Some(u) = parse_usage(&value) {
                            usage = u;
                        }
                        if let Some(c) = parse_cost(&value) {
                            cost = Some(c);
                        }
                    }
                }
            }
        }

        let _ = events.send(StreamEvent::Done);
        Ok(ChatResponse {
            message: super::AssistantMessage {
                content_parts: vec![ContentPart::text(text)],
                tool_calls: assembler.finish(),
            },
            usage,
            finish_reason,
            cost_usd: cost,
        })
    }
}

pub fn build_chat_body(request: &ChatRequest, model: &str, stream: bool) -> Value {
    let messages: Vec<Value> = request.messages.iter().map(message_to_json).collect();
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": request.temperature,
        "max_tokens": request.max_tokens,
        "stream": stream,
    });
    if !request.tools.is_empty() {
        let tools: Vec<Value> = request
            .tools
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
            .collect();
        body["tools"] = Value::Array(tools);
        body["tool_choice"] = match &request.tool_choice {
            Some(ToolChoice::Auto) | None => json!("auto"),
            Some(ToolChoice::None) => json!("none"),
            Some(ToolChoice::Required) => json!("required"),
            Some(ToolChoice::Named(name)) => json!({
                "type": "function",
                "function": { "name": name }
            }),
        };
    }
    if let Some(effort) = &request.reasoning_effort {
        if effort != "none" {
            body["reasoning_effort"] = json!(effort);
        }
    }
    body
}

pub fn message_to_json(message: &ChatMessage) -> Value {
    match message.role {
        Role::System | Role::User => {
            let content = content_to_json(&message.content);
            json!({ "role": message.role.as_str(), "content": content })
        }
        Role::Assistant => {
            let text: String = message
                .content
                .iter()
                .filter_map(|p| match p {
                    ContentPart::Text(t) => Some(t.clone()),
                    _ => None,
                })
                .collect();
            let mut obj = json!({ "role": "assistant" });
            if !text.is_empty() {
                obj["content"] = json!(text);
            } else {
                obj["content"] = Value::Null;
            }
            if !message.tool_calls.is_empty() {
                obj["tool_calls"] = Value::Array(
                    message
                        .tool_calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": tc.arguments.to_string(),
                                }
                            })
                        })
                        .collect(),
                );
            }
            obj
        }
        Role::Tool => {
            let content = content_to_json(&message.content);
            json!({
                "role": "tool",
                "tool_call_id": message.tool_call_id.clone().unwrap_or_default(),
                "content": content,
            })
        }
    }
}

fn content_to_json(parts: &[ContentPart]) -> Value {
    if parts.len() == 1 {
        if let ContentPart::Text(t) = &parts[0] {
            return json!(t);
        }
    }
    let array: Vec<Value> = parts
        .iter()
        .map(|p| match p {
            ContentPart::Text(t) => json!({ "type": "text", "text": t }),
            ContentPart::Image {
                media_type,
                data_base64,
            } => json!({
                "type": "image_url",
                "image_url": { "url": format!("data:{media_type};base64,{data_base64}") }
            }),
        })
        .collect();
    Value::Array(array)
}

pub fn parse_chat_response(provider: &str, body: &Value) -> ProviderResult<ChatResponse> {
    let choice = body
        .get("choices")
        .and_then(|c| c.as_array())
        .and_then(|c| c.first())
        .ok_or_else(|| {
            // Some gateways answer HTTP 200 with an error object instead of an
            // error status; carry the provider's own reason when it did.
            if let Some(err) = body.get("error") {
                let message = err
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown error");
                let code = err.get("code").map(|c| c.to_string()).unwrap_or_default();
                return ProviderError::Parse {
                    provider: provider.to_string(),
                    details: format!("provider error (code {code}): {message}"),
                };
            }
            ProviderError::Parse {
                provider: provider.to_string(),
                details: "response has no choices".to_string(),
            }
        })?;
    let message = choice.get("message").ok_or_else(|| ProviderError::Parse {
        provider: provider.to_string(),
        details: "choice has no message".to_string(),
    })?;

    let mut text = message
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // Some providers stream reasoning into a separate field; prefer content.
    if text.is_empty() {
        if let Some(alt) = message.get("reasoning").and_then(|v| v.as_str()) {
            if !alt.is_empty() {
                text = alt.to_string();
            }
        }
    }

    let tool_calls = parse_tool_calls(message.get("tool_calls"));
    let finish_reason = choice
        .get("finish_reason")
        .and_then(|v| v.as_str())
        .unwrap_or(if tool_calls.is_empty() {
            "stop"
        } else {
            "tool_calls"
        })
        .to_string();

    let usage = parse_usage(body).unwrap_or_default();
    let cost = parse_cost(body);

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
        cost_usd: cost,
    })
}

fn parse_tool_calls(value: Option<&Value>) -> Vec<ToolCall> {
    let Some(array) = value.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    array
        .iter()
        .enumerate()
        .filter_map(|(i, tc)| {
            let function = tc.get("function")?;
            let name = function.get("name").and_then(|v| v.as_str())?.to_string();
            if name.is_empty() {
                return None;
            }
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from)
                .unwrap_or_else(|| format!("call_{i}"));
            let arguments = match function.get("arguments") {
                Some(Value::String(s)) => repair_json(s),
                Some(Value::Object(_)) => function.get("arguments").cloned().unwrap_or(json!({})),
                _ => json!({}),
            };
            Some(ToolCall {
                id,
                name,
                arguments,
            })
        })
        .collect()
}

pub fn parse_usage(body: &Value) -> Option<Usage> {
    let usage = body.get("usage")?;
    let input = usage
        .get("prompt_tokens")
        .or_else(|| usage.get("input_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let output = usage
        .get("completion_tokens")
        .or_else(|| usage.get("output_tokens"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    if input == 0 && output == 0 {
        return None;
    }
    Some(Usage {
        input_tokens: input,
        output_tokens: output,
    })
}

/// Extract a per-request cost in USD when the provider reports one
/// (Kilo AI Gateway and some OpenRouter models return cost fields).
pub fn parse_cost(body: &Value) -> Option<f64> {
    let candidates = [
        body.pointer("/usage/cost"),
        body.pointer("/usage/cost_usd"),
        body.pointer("/usage/total_cost"),
        body.pointer("/cost"),
        body.pointer("/x-cost"),
    ];
    candidates
        .into_iter()
        .flatten()
        .find_map(|v| v.as_f64())
        .filter(|c| c.is_finite() && *c >= 0.0)
}

/// Extract the `data:` payload from an SSE line, if present.
pub fn sse_data_payload(line: &str) -> Option<&str> {
    let line = line.trim();
    let rest = line.strip_prefix("data:")?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

/// Incremental assembler for streamed tool-call deltas.
#[derive(Default)]
pub struct ToolCallAssembler {
    calls: Vec<(String, String, String)>,
}

impl ToolCallAssembler {
    pub fn push(
        &mut self,
        index: usize,
        id: Option<&str>,
        name: Option<&str>,
        args_fragment: &str,
    ) {
        while self.calls.len() <= index {
            self.calls
                .push((String::new(), String::new(), String::new()));
        }
        let call = &mut self.calls[index];
        if let Some(id) = id {
            if !id.is_empty() && call.0.is_empty() {
                call.0 = id.to_string();
            }
        }
        if let Some(name) = name {
            if !name.is_empty() && call.1.is_empty() {
                call.1 = name.to_string();
            }
        }
        if call.2.len() < MAX_TOOL_ARGUMENTS_LEN {
            call.2.push_str(args_fragment);
        }
    }

    pub fn finish(self) -> Vec<ToolCall> {
        self.calls
            .into_iter()
            .enumerate()
            .filter(|(_, (_, name, _))| !name.is_empty())
            .map(|(i, (id, name, args))| ToolCall {
                id: if id.is_empty() {
                    format!("call_{i}")
                } else {
                    id
                },
                name,
                arguments: repair_json(&args),
            })
            .collect()
    }
}

/// Lenient JSON parse for model-emitted tool arguments: strips code fences,
/// recovers from truncation, and tolerates surrounding chatter.
pub fn repair_json(raw: &str) -> Value {
    let cleaned = clean_json_text(raw);
    if let Ok(v) = serde_json::from_str::<Value>(&cleaned) {
        return v;
    }
    if let Some(v) = attempt_close(&cleaned) {
        return v;
    }
    if let Ok(v) = serde_json::from_str::<Value>(raw) {
        return v;
    }
    json!({ "raw": raw })
}

fn clean_json_text(raw: &str) -> String {
    let mut text = raw.trim();
    if let Some(stripped) = text
        .strip_prefix("```")
        .and_then(|s| s.strip_prefix("json"))
    {
        text = stripped.trim_start();
        if let Some(end) = text.rfind("```") {
            text = text[..end].trim_end();
        }
    }
    // If there is chatter around the JSON object, cut to the object.
    if let Some(start) = text.find('{') {
        if let Some(end) = text.rfind('}') {
            if end > start {
                text = &text[start..=end];
            }
        }
    }
    text.trim().to_string()
}

fn attempt_close(text: &str) -> Option<Value> {
    let mut in_string = false;
    let mut escaped = false;
    let mut stack: Vec<char> = Vec::new();
    for ch in text.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_string => escaped = true,
            '"' => in_string = !in_string,
            '{' if !in_string => stack.push('}'),
            '[' if !in_string => stack.push(']'),
            '}' | ']' if !in_string => {
                stack.pop();
            }
            _ => {}
        }
    }
    let mut candidate = text.to_string();
    if in_string {
        candidate.push('"');
    }
    while let Some(closer) = stack.pop() {
        candidate.push(closer);
    }
    serde_json::from_str::<Value>(&candidate).ok()
}
