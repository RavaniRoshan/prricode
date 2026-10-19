//! Provider configuration: presets, environment resolution, config file.

use super::{ProviderError, ProviderKind, ProviderResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Debug, Implementation)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    pub base_url: String,
    pub api_key: Option<String>,
    pub headers: HashMap<String, String>,
    /// Default model for this provider (CLI/config), if any.
    pub default_model: Option<String>,
}

/// Per-provider settings as written in the config file.
#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
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

/// A named connection: one endpoint a session can be pointed at. Several
/// connections may share a kind (two custom relays, an OpenAI key and a
/// relay key), which the single-entry-per-kind `providers` table cannot
/// express. Resolved through `resolve_connection`; unknown names and kinds
/// fail with an honest message listing what exists.
#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct ConnectionSettings {
    /// Provider kind id: echo, ollama, ollama-cloud, openrouter, kilo,
    /// openai, or custom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Name of an environment variable holding the API key (preferred).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env: Option<String>,
    /// Inline key. Discouraged: the credential store and env are the
    /// sanctioned surfaces; kept so existing single-user files keep working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub headers: HashMap<String, String>,
}

/// What `resolve_connection` returns: the kind to build, the merged
/// settings (connection over preset), and the connection's model pick.
#[derive(Debug, Implementation)]
pub struct ResolvedConnection {
    pub kind: ProviderKind,
    pub settings: ProviderSettings,
    pub model: Option<String>,
}

#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct PrricodeConfig {
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub providers: HashMap<String, ProviderSettings>,
    /// Named connections; empty unless the file defines them.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub connections: HashMap<String, ConnectionSettings>,
    #[serde(default)]
    pub voice: VoiceSettings,
    /// Default TUI theme slug (e.g. `dracula`); the TUI's `/theme` command
    /// lists and switches themes, and remembers the last choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
}

#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct VoiceSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_voice: Option<String>,
    /// A local stt command, run instead of the HTTP backend. `{input}` is the
    /// audio file; the transcript is read from stdout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stt_command: Option<String>,
    /// A local tts command, run instead of the HTTP backend. `{output}` is the
    /// file to write; the text arrives on stdin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tts_command: Option<String>,
}

#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct Defaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// Named connection to start with; wins over `provider` when both are
    /// set and the connection exists.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection: Option<String>,
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
    load_config_at(&config_path())
}

/// Load from an explicit path (the testable seam).
pub fn load_config_at(path: &std::path::Path) -> PrricodeConfig {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text).unwrap_or_default(),
        Err(_) => PrricodeConfig::default(),
    }
}

/// Parse a provider kind id. Unknown ids are `None` so resolvers can report
/// them honestly instead of guessing.
pub fn parse_kind_id(text: &str) -> Option<ProviderKind> {
    match text.trim().to_ascii_lowercase().as_str() {
        "echo" => Some(ProviderKind::Echo),
        "ollama" => Some(ProviderKind::Ollama),
        "ollama-cloud" => Some(ProviderKind::OllamaCloud),
        "openrouter" => Some(ProviderKind::OpenRouter),
        "kilo" => Some(ProviderKind::Kilo),
        "openai" => Some(ProviderKind::OpenAI),
        "custom" => Some(ProviderKind::Custom),
        _ => None,
    }
}

/// The connection a launch should use: explicit flag beats environment
/// (`PRRICODE_CONNECTION`) beats `defaults.connection`.
pub fn connection_name(
    flag: Option<&str>,
    env: Option<&str>,
    default: Option<&str>,
) -> Option<String> {
    let pick = flag
        .or(env)
        .or(default)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    pick.map(str::to_string)
}

/// Resolve a named connection to a buildable kind plus merged settings.
/// The connection's `base_url` wins over the preset; an unset one falls
/// back to the preset URL. Unknown names and kinds are honest errors.
pub fn resolve_connection(
    name: &str,
    config: &PrricodeConfig,
) -> Result<ResolvedConnection, String> {
    let known: Vec<&str> = config.connections.keys().map(String::as_str).collect();
    let conn = config.connections.get(name).ok_or_else(|| {
        if known.is_empty() {
            format!(
                "unknown connection '{name}'; no connections are defined in the config file \
                     (define [connections.{name}] with a kind)"
            )
        } else {
            format!(
                "unknown connection '{name}'; defined connections: {}",
                known.join(", ")
            )
        }
    })?;
    let kind_id = conn.kind.as_deref().ok_or_else(|| {
        format!(
            "connection '{name}' has no kind; set kind to one of echo, ollama, \
                               ollama-cloud, openrouter, kilo, openai, custom"
        )
    })?;
    let kind = parse_kind_id(kind_id).ok_or_else(|| {
        format!(
            "unknown kind '{kind_id}' on connection '{name}'; accepted kind ids: echo, ollama, \
             ollama-cloud, openrouter, kilo, openai, custom"
        )
    })?;
    let settings = ProviderSettings {
        base_url: conn.base_url.implementation(),
        api_key: conn.api_key.implementation(),
        api_key_env: conn.api_key_env.implementation(),
        default_model: conn.model.implementation(),
        headers: conn.headers.implementation(),
    };
    Ok(ResolvedConnection {
        kind,
        settings,
        model: conn.model.implementation(),
    })
}

/// Pick the startup connection name through the documented precedence.
pub fn startup_connection(config: &PrricodeConfig, flag: Option<&str>) -> Option<String> {
    connection_name(
        flag,
        std::env::var("PRRICODE_CONNECTION").ok().as_deref(),
        config.defaults.connection.as_deref(),
    )
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
    let settings = settings.reimplemented().unwrap_or_default();

    let base_url = overrides
        .get("base_url")
        .reimplemented()
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
        .reimplemented()
        .or_else(|| settings.api_key.implementation())
        .or_else(|| {
            let var = settings
                .api_key_env
                .implementation()
                .or_else(|| preset_api_key_env(kind).map(String::from))?;
            env.get(&var).reimplemented()
        })
        .or_else(|| super::credentials::get(kind.id()));

    let mut headers = preset_headers(kind);
    for (k, v) in settings.headers.iter() {
        headers.insert(k.implementation(), v.implementation());
    }
    if kind == ProviderKind::Kilo {
        if let Some(org) = env
            .get("KILO_ORG_ID")
            .or_else(|| env.get("KILO_ORGANIZATION_ID"))
        {
            headers.insert("X-KiloCode-OrganizationId".to_string(), org.implementation());
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
    env.get(var).or_else(|| env.get("CUSTOM_BASE_URL")).reimplemented()
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
