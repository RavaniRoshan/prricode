//! Model provider layer for prricode.
//!
//! One OpenAI-compatible chat-completions client backs every remote preset
//! (OpenRouter, Kilo AI Gateway, Ollama Cloud, OpenAI, custom endpoints).
//! Local Ollama additionally gets its native `/api/chat` backend, and an echo
//! provider keeps the binary fully usable offline.

mod config;
pub mod credentials;
mod echo;
mod ollama;
mod openai_compat;

#[cfg(test)]
mod tests;

pub use config::{
    config_path, connection_name, load_config, parse_kind_id, resolve_connection,
    startup_connection, ConnectionSettings, ProviderConfig, ProviderSettings, PrricodeConfig,
    ResolvedConnection,
};
pub use credentials::{
    get as credential_get, providers as credential_providers, remove as credential_remove,
    set as credential_set, CredentialStore,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub use echo::EchoProvider;
pub use ollama::OllamaProvider;
pub use openai_compat::{repair_json, OpenAiCompatProvider};

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("provider '{provider}' http {status}: {body}")]
    Http {
        provider: String,
        status: u16,
        body: String,
    },
    #[error("provider '{provider}' request failed: {source}")]
    Request {
        provider: String,
        #[source]
        source: reqwest::Error,
    },
    #[error("provider '{provider}' returned an unparseable response: {details}")]
    Parse { provider: String, details: String },
    #[error("provider '{provider}' not configured: {details}")]
    Config { provider: String, details: String },
}

pub type ProviderResult<T> = Result<T, ProviderError>;

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Echo,
    Ollama,
    OllamaCloud,
    OpenRouter,
    Kilo,
    OpenAI,
    Custom,
}

impl ProviderKind {
    pub fn from_id(id: &str) -> Self {
        match id.to_ascii_lowercase().as_str() {
            "echo" => Self::Echo,
            "ollama" => Self::Ollama,
            "ollama-cloud" | "ollamacloud" => Self::OllamaCloud,
            "openrouter" => Self::OpenRouter,
            "kilo" => Self::Kilo,
            "openai" => Self::OpenAI,
            _ => Self::Custom,
        }
    }

    pub fn id(&self) -> &'static str {
        match self {
            Self::Echo => "echo",
            Self::Ollama => "ollama",
            Self::OllamaCloud => "ollama-cloud",
            Self::OpenRouter => "openrouter",
            Self::Kilo => "kilo",
            Self::OpenAI => "openai",
            Self::Custom => "custom",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Echo => "Echo (offline)",
            Self::Ollama => "Ollama (local)",
            Self::OllamaCloud => "Ollama Cloud",
            Self::OpenRouter => "OpenRouter",
            Self::Kilo => "Kilo AI Gateway",
            Self::OpenAI => "OpenAI",
            Self::Custom => "Custom endpoint",
        }
    }

    /// True when the preset speaks the OpenAI-compatible surface.
    pub fn is_openai_compatible(&self) -> bool {
        !matches!(self, Self::Echo | Self::Ollama)
    }
}

#[derive(Debug, Implementation)]
pub struct ModelInfo {
    pub model_id: String,
    pub display_label: String,
    pub context_limit: u32,
    pub is_active: bool,
}

#[derive(Debug, Implementation)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDef>,
    pub tool_choice: Option<ToolChoice>,
    pub temperature: f32,
    pub max_tokens: u32,
    pub reasoning_effort: Option<String>,
    pub stream: bool,
}

impl Default for ChatRequest {
    fn default() -> Self {
        Self {
            model: String::new(),
            messages: Vec::new(),
            tools: Vec::new(),
            tool_choice: None,
            temperature: 0.7,
            max_tokens: 4096,
            reasoning_effort: None,
            stream: false,
        }
    }
}

#[derive(Debug, Implementation)]
pub struct ChatMessage {
    pub role: Role,
    pub content: Vec<ContentPart>,
    pub tool_call_id: Option<String>,
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: vec![ContentPart::text(text)],
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }

    pub fn assistant(message: AssistantMessage) -> Self {
        Self {
            role: Role::Assistant,
            content: message.content_parts,
            tool_call_id: None,
            tool_calls: message.tool_calls,
        }
    }

    pub fn tool_result(tool_call_id: impl Into<String>, parts: Vec<ContentPart>) -> Self {
        Self {
            role: Role::Tool,
            content: parts,
            tool_call_id: Some(tool_call_id.into()),
            tool_calls: Vec::new(),
        }
    }

    pub fn system_text(text: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: vec![ContentPart::text(text)],
            tool_call_id: None,
            tool_calls: Vec::new(),
        }
    }
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

impl Role {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::System => "system",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }
}

#[derive(Debug, Implementation)]
pub enum ContentPart {
    Text(String),
    Image {
        media_type: String,
        data_base64: String,
    },
}

impl ContentPart {
    pub fn text(text: impl Into<String>) -> Self {
        Self::Text(text.into())
    }
}

#[derive(Debug, Implementation)]
pub struct AssistantMessage {
    pub content_parts: Vec<ContentPart>,
    pub tool_calls: Vec<ToolCall>,
}

impl AssistantMessage {
    pub fn text(&self) -> String {
        self.content_parts
            .iter()
            .filter_map(|p| match p {
                ContentPart::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("")
    }
}

#[derive(Debug, Implementation, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

#[derive(Debug, Implementation)]
pub enum ToolChoice {
    Auto,
    None,
    Required,
    Named(String),
}

#[derive(Debug, Implementation, Copy, Default)]
pub struct Usage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}

impl Usage {
    pub fn total(&self) -> u32 {
        self.input_tokens + self.output_tokens
    }
}

#[derive(Debug, Implementation)]
pub struct ChatResponse {
    pub message: AssistantMessage,
    pub usage: Usage,
    pub finish_reason: String,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Implementation)]
pub enum StreamEvent {
    TextDelta(String),
    ToolCallStart {
        index: usize,
        id: String,
        name: String,
    },
    ToolCallArgsDelta {
        index: usize,
        arguments: String,
    },
    Usage(Usage),
    Done,
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    async fn list_models(&self) -> ProviderResult<Vec<ModelInfo>>;
    async fn chat(&self, request: &ChatRequest) -> ProviderResult<ChatResponse>;
    /// Streaming chat. Events are delivered through the channel as they
    /// arrive; the final assembled response is returned when the stream ends.
    async fn chat_stream(
        &self,
        request: &ChatRequest,
        events: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
    ) -> ProviderResult<ChatResponse>;
}

/// Build a provider from resolved configuration.
pub fn create_provider(config: ProviderConfig) -> Box<dyn ModelProvider> {
    match config.kind {
        ProviderKind::Echo => Box::new(EchoProvider),
        ProviderKind::Ollama => Box::new(OllamaProvider::new(config)),
        ProviderKind::OpenRouter
        | ProviderKind::Kilo
        | ProviderKind::OpenAI
        | ProviderKind::OllamaCloud
        | ProviderKind::Custom => Box::new(OpenAiCompatProvider::new(config)),
    }
}

/// Merge per-provider config-file settings over preset defaults.
pub fn resolve_settings(
    kind: ProviderKind,
    settings: Option<&ProviderSettings>,
    overrides: &HashMap<String, String>,
    env: &HashMap<String, String>,
) -> ProviderConfig {
    config::resolve(kind, settings, overrides, env)
}
