//! Provider configuration: presets, environment resolution, config file.

use super::{ProviderError, ProviderKind, ProviderResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub base_url: String,
    pub api_key: Option<String>,
    pub headers: HashMap<String, String>,
    /// Default model for this provider (CLI/config), if any.
    pub default_model: Option<String>,
}

/// Per-provider settings as written in the config file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Name of an environment variable holding the API key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PrricodeConfig {
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub providers: HashMap<String, ProviderSettings>,
    #[serde(default)]
    pub voice: VoiceSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VoiceSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_voice: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Defaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("PRRICODE_CONFIG") {
        return PathBuf::from(p);
    }
    let base = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    base.join("prricode").join("config.toml")
}

pub fn load_config() -> PrricodeConfig {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).unwrap_or_default(),
        Err(_) => PrricodeConfig::default(),
    }
}

fn preset_base_url(kind: ProviderKind) -> &'static str {
    match kind {
        ProviderKind::Echo => "",
        ProviderKind::Ollama => "http://localhost:11434",
        ProviderKind::OllamaCloud => "https://ollama.com",
        ProviderKind::OpenRouter => "https://openrouter.ai/api/v1",
        ProviderKind::Kilo => "https://api.kilo.ai/api/gateway",
        ProviderKind::OpenAI => "https://api.openai.com/v1",
        ProviderKind::Custom => "",
    }
}

fn preset_api_key_env(kind: ProviderKind) -> Option<&'static str> {
    match kind {
        ProviderKind::Echo | ProviderKind::Ollama | ProviderKind::Custom => None,
        ProviderKind::OllamaCloud => Some("OLLAMA_API_KEY"),
        ProviderKind::OpenRouter => Some("OPENROUTER_API_KEY"),
        ProviderKind::Kilo => Some("KILO_API_KEY"),
        ProviderKind::OpenAI => Some("OPENAI_API_KEY"),
    }
}

fn preset_headers(kind: ProviderKind) -> HashMap<String, String> {
    let mut headers = HashMap::new();
    match kind {
        ProviderKind::OpenRouter => {
            headers.insert(
                "HTTP-Referer".to_string(),
                "https://github.com/RavaniRoshan/prricode".to_string(),
            );
            headers.insert("X-Title".to_string(), "prricode".to_string());
        }
        ProviderKind::Kilo => {
            // Optional organization scoping, read from the environment by the caller.
        }
        _ => {}
    }
    headers
}

/// Resolve a provider's effective configuration.
///
/// Precedence: explicit CLI overrides > environment variables > config file
/// > preset defaults.
pub fn resolve(
    kind: ProviderKind,
    settings: Option<&ProviderSettings>,
    overrides: &HashMap<String, String>,
    env: &HashMap<String, String>,
) -> super::ProviderConfig {
    let settings = settings.cloned().unwrap_or_default();

    let base_url = overrides
        .get("base_url")
        .cloned()
        .or_else(|| env_base_url(kind, env))
        .or(settings.base_url)
        .unwrap_or_else(|| preset_base_url(kind).to_string());
    let base_url = if kind == super::ProviderKind::Echo {
        base_url
    } else {
        normalize_base_url(&base_url).unwrap_or(base_url)
    };

    let api_key = overrides
        .get("api_key")
        .cloned()
        .or_else(|| settings.api_key.clone())
        .or_else(|| {
            let var = settings
                .api_key_env
                .clone()
                .or_else(|| preset_api_key_env(kind).map(String::from))?;
            env.get(&var).cloned()
        });

    let mut headers = preset_headers(kind);
    for (k, v) in settings.headers.iter() {
        headers.insert(k.clone(), v.clone());
    }
    if kind == ProviderKind::Kilo {
        if let Some(org) = env
            .get("KILO_ORG_ID")
            .or_else(|| env.get("KILO_ORGANIZATION_ID"))
        {
            headers.insert("X-KiloCode-OrganizationId".to_string(), org.clone());
        }
    }

    let default_model = settings.default_model;

    super::ProviderConfig {
        kind,
        base_url,
        api_key,
        headers,
        default_model,
    }
}

fn env_base_url(kind: ProviderKind, env: &HashMap<String, String>) -> Option<String> {
    let var = match kind {
        ProviderKind::Ollama => "OLLAMA_HOST",
        ProviderKind::OllamaCloud => "OLLAMA_CLOUD_BASE_URL",
        ProviderKind::OpenRouter => "OPENROUTER_BASE_URL",
        ProviderKind::Kilo => "KILO_BASE_URL",
        ProviderKind::OpenAI => "OPENAI_BASE_URL",
        ProviderKind::Custom => "CUSTOM_BASE_URL",
        ProviderKind::Echo => return None,
    };
    env.get(var).or_else(|| env.get("CUSTOM_BASE_URL")).cloned()
}

/// Normalize a base URL: strip trailing slashes, ensure a scheme.
pub fn normalize_base_url(url: &str) -> ProviderResult<String> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(ProviderError::Config {
            provider: "custom".to_string(),
            details: "base URL is empty".to_string(),
        });
    }
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err(ProviderError::Config {
            provider: "custom".to_string(),
            details: format!("base URL must start with http:// or https://, got '{trimmed}'"),
        });
    }
    Ok(trimmed.to_string())
}
