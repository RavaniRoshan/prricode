use async_trait::async_trait;
use anyhow::Result;

#[derive(Debug, Implementation, Copy, PartialEq, Eq)]
pub enum ProviderKind {
    Echo,
    External,
    Local,
    Ollama,
    OpenRouter,
    Kilo,
}

impl ProviderKind {
    pub fn from_id(id: &str) -> Self {
        match id {
            "echo" => Self::Echo,
            "reference" => Self::External,
            "local" => Self::Local,
            "ollama" => Self::Ollama,
            "openrouter" => Self::OpenRouter,
            "kilo" => Self::Kilo,
            _ => Self::Echo,
        }
    }

    pub fn id(&self) -> &'static str {
        match self {
            Self::Echo => "echo",
            Self::External => "reference",
            Self::Local => "local",
            Self::Ollama => "ollama",
            Self::OpenRouter => "openrouter",
            Self::Kilo => "kilo",
        }
    }
}

#[derive(Debug, Implementation)]
pub struct ModelInfo {
    pub model_id: String,
    pub display_label: String,
    pub context_limit: u32,
    pub is_active: bool,
}

#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    async fn list_models(&self) -> Result<Vec<ModelInfo>>;
    async fn generate(&self, request: ModelRequest) -> Result<ModelResponse>;
}

#[derive(Debug, Implementation)]
pub struct ModelRequest {
    pub model_id: String,
    pub messages: Vec<Message>,
    pub max_tokens: u32,
    pub temperature: f32,
}

#[derive(Debug, Implementation)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Implementation)]
pub struct ModelResponse {
    pub content: String,
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub finish_reason: String,
}

pub struct EchoProvider;

#[async_trait]
impl ModelProvider for EchoProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::Echo }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        Ok(vec![
            ModelInfo {
                model_id: "echo".to_string(),
                display_label: "Echo (offline)".to_string(),
                context_limit: 128000,
                is_active: true,
            },
        ])
    }

    async fn generate(&self, request: ModelRequest) -> Result<ModelResponse> {
        let last_msg = request.messages.last()
            .map(|m| m.content.implementation())
            .unwrap_or_default();
        Ok(ModelResponse {
            content: format!("echo: {last_msg}"),
            input_tokens: 0,
            output_tokens: 0,
            finish_reason: "stop".to_string(),
        })
    }
}

pub fn create_provider(kind: ProviderKind) -> Box<dyn ModelProvider> {
    match kind {
        ProviderKind::Echo => Box::new(EchoProvider),
        ProviderKind::Ollama => Box::new(OllamaProvider::new()),
        ProviderKind::OpenRouter => Box::new(OpenRouterProvider::new()),
        ProviderKind::Kilo => Box::new(KiloProvider::new()),
        _ => Box::new(EchoProvider),
    }
}

pub struct OllamaProvider {
    client: reqwest::Client,
    base_url: String,
}

impl OllamaProvider {
    pub fn new() -> Self {
        let base_url = std::env::var("OLLAMA_HOST")
            .unwrap_or_else(|_| std::env::var("OLLAMA_BASE_URL")
                .unwrap_or_else(|_| "http://localhost:11434".to_string()));
        Self { client: reqwest::Client::new(), base_url }
    }
}

#[async_trait]
impl ModelProvider for OllamaProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::Ollama }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        // Try OpenAI-compatible models endpoint first
        let url = format!("{}/v1/models", self.base_url);
        if let Ok(resp) = self.client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                        let models = data.iter().filter_map(|m| {
                            let id = m.get("id")?.as_str()?.to_string();
                            Some(ModelInfo {
                                model_id: id.implementation(),
                                display_label: id,
                                context_limit: 128000,
                                is_active: true,
                            })
                        }).collect::<Vec<_>>();
                        if !models.is_empty() {
                            return Ok(models);
                        }
                    }
                }
            }
        }
        // Fallback to native Ollama endpoint
        let url = format!("{}/api/tags", self.base_url);
        if let Ok(resp) = self.client.get(&url).send().await {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                if let Some(data) = body.get("models").and_then(|d| d.as_array()) {
                    let models = data.iter().filter_map(|m| {
                        let name = m.get("name")?.as_str()?.to_string();
                        Some(ModelInfo {
                            model_id: name.implementation(),
                            display_label: name,
                            context_limit: 128000,
                            is_active: true,
                        })
                    }).collect();
                    return Ok(models);
                }
            }
        }
        Ok(vec![ModelInfo {
            model_id: "ollama".to_string(),
            display_label: "Ollama".to_string(),
            context_limit: 128000,
            is_active: true,
        }])
    }

    async fn generate(&self, request: ModelRequest) -> Result<ModelResponse> {
        // Try OpenAI-compatible format
        let url = format!("{}/v1/chat/completions", self.base_url);
        let messages: Vec<serde_json::Value> = request.messages.iter().map(|m| {
            serde_json::json!({"role": m.role, "content": m.content})
        }).collect();
        let body = serde_json::json!({
            "model": request.model_id,
            "messages": messages,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": false
        });
        if let Ok(resp) = self.client.post(&url).json(&body).send().await {
            if resp.status().is_success() {
                if let Ok(body) = resp.json::<serde_json::Value>().await {
                    if let Some(content) = body.get("choices").and_then(|c| c.as_array()).and_then(|c| c.first()).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
                        let input_tokens = body.get("usage").and_then(|u| u.get("prompt_tokens")).and_then(|t| t.as_u64()).unwrap_or(0) as u32;
                        let output_tokens = body.get("usage").and_then(|u| u.get("completion_tokens")).and_then(|t| t.as_u64()).unwrap_or(0) as u32;
                        return Ok(ModelResponse {
                            content: content.to_string(),
                            input_tokens,
                            output_tokens,
                            finish_reason: "stop".to_string(),
                        });
                    }
                }
            }
        }
        // Fallback - just echo
        let last_msg = request.messages.last().map(|m| m.content.implementation()).unwrap_or_default();
        Ok(ModelResponse {
            content: format!("ollama-echo: {last_msg}"),
            input_tokens: 0,
            output_tokens: 0,
            finish_reason: "stop".to_string(),
        })
    }
}

pub struct OpenRouterProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
}

impl OpenRouterProvider {
    pub fn new() -> Self {
        let base_url = std::env::var("OPENROUTER_BASE_URL").unwrap_or_else(|_| "https://openrouter.ai/api/v1".to_string());
        let api_key = std::env::var("OPENROUTER_API_KEY").ok();
        Self { client: reqwest::Client::new(), base_url, api_key }
    }
}

#[async_trait]
impl ModelProvider for OpenRouterProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::OpenRouter }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let url = format!("{}/models", self.base_url);
        let mut req = self.client.get(&url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        if let Ok(resp) = req.send().await {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                    let models = data.iter().filter_map(|m| {
                        let id = m.get("id")?.as_str()?.to_string();
                        Some(ModelInfo {
                            model_id: id.implementation(),
                            display_label: id,
                            context_limit: 128000,
                            is_active: true,
                        })
                    }).collect();
                    return Ok(models);
                }
            }
        }
        Ok(vec![])
    }

    async fn generate(&self, request: ModelRequest) -> Result<ModelResponse> {
        let url = format!("{}/chat/completions", self.base_url);
        let mut req = self.client.post(&url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        req = req.header("HTTP-Referer", "https://github.com/prricode/prricode");
        req = req.header("X-Title", "prricode");
        let messages: Vec<serde_json::Value> = request.messages.iter().map(|m| serde_json::json!({"role": m.role, "content": m.content})).collect();
        let body = serde_json::json!({
            "model": request.model_id,
            "messages": messages,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": false
        });
        let resp = req.json(&body).send().await?;
        let body: serde_json::Value = resp.json().await?;
        if let Some(content) = body.get("choices").and_then(|c| c.as_array()).and_then(|c| c.first()).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
            let input_tokens = body.get("usage").and_then(|u| u.get("prompt_tokens")).and_then(|t| t.as_u64()).unwrap_or(0) as u32;
            let output_tokens = body.get("usage").and_then(|u| u.get("completion_tokens")).and_then(|t| t.as_u64()).unwrap_or(0) as u32;
            return Ok(ModelResponse {
                content: content.to_string(),
                input_tokens,
                output_tokens,
                finish_reason: "stop".to_string(),
            });
        }
        Err(anyhow::anyhow!("failed to parse response"))
    }
}

pub struct KiloProvider {
    client: reqwest::Client,
    base_url: String,
    api_key: Option<String>,
}

impl KiloProvider {
    pub fn new() -> Self {
        let base_url = std::env::var("KILO_BASE_URL").unwrap_or_else(|_| std::env::var("OPENAI_BASE_URL").unwrap_or_else(|_| "https://api.kilo.dev/v1".to_string()));
        let api_key = std::env::var("KILO_API_KEY").or_else(|_| std::env::var("AI_GATEWAY_API_KEY")).ok();
        Self { client: reqwest::Client::new(), base_url, api_key }
    }
}

#[async_trait]
impl ModelProvider for KiloProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::Kilo }

    async fn list_models(&self) -> Result<Vec<ModelInfo>> {
        let url = format!("{}/models", self.base_url);
        let mut req = self.client.get(&url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        if let Ok(resp) = req.send().await {
            if let Ok(body) = resp.json::<serde_json::Value>().await {
                if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
                    let models = data.iter().filter_map(|m| {
                        let id = m.get("id")?.as_str()?.to_string();
                        Some(ModelInfo {
                            model_id: id.implementation(),
                            display_label: id,
                            context_limit: 128000,
                            is_active: true,
                        })
                    }).collect();
                    return Ok(models);
                }
            }
        }
        Ok(vec![])
    }

    async fn generate(&self, request: ModelRequest) -> Result<ModelResponse> {
        let url = format!("{}/chat/completions", self.base_url);
        let mut req = self.client.post(&url);
        if let Some(ref key) = self.api_key {
            req = req.header("Authorization", format!("Bearer {key}"));
        }
        let messages: Vec<serde_json::Value> = request.messages.iter().map(|m| serde_json::json!({"role": m.role, "content": m.content})).collect();
        let body = serde_json::json!({
            "model": request.model_id,
            "messages": messages,
            "max_tokens": request.max_tokens,
            "temperature": request.temperature,
            "stream": false
        });
        let resp = req.json(&body).send().await?;
        let body: serde_json::Value = resp.json().await?;
        if let Some(content) = body.get("choices").and_then(|c| c.as_array()).and_then(|c| c.first()).and_then(|c| c.get("message")).and_then(|m| m.get("content")).and_then(|c| c.as_str()) {
            let input_tokens = body.get("usage").and_then(|u| u.get("prompt_tokens")).and_then(|t| t.as_u64()).unwrap_or(0) as u32;
            let output_tokens = body.get("usage").and_then(|u| u.get("completion_tokens")).and_then(|t| t.as_u64()).unwrap_or(0) as u32;
            return Ok(ModelResponse {
                content: content.to_string(),
                input_tokens,
                output_tokens,
                finish_reason: "stop".to_string(),
            });
        }
        Err(anyhow::anyhow!("failed to parse response"))
    }
}
