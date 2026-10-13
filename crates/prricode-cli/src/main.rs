use anyhow::Result;
use clap::Parser;
use prricode_cli::*;
use prricode_core::*;
use prricode_provider::*;
use prricode_server::*;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use tracing::{info, Level};

fn provider_kind(arg: ProviderArg) -> ProviderKind {
    match arg {
        ProviderArg::Echo => ProviderKind::Echo,
        ProviderArg::Ollama => ProviderKind::Ollama,
        ProviderArg::OllamaCloud => ProviderKind::OllamaCloud,
        ProviderArg::Openrouter => ProviderKind::OpenRouter,
        ProviderArg::Kilo => ProviderKind::Kilo,
        ProviderArg::Openai => ProviderKind::OpenAI,
        ProviderArg::Custom => ProviderKind::Custom,
    }
}

/// Build a provider from CLI overrides, environment, and the config file.
fn build_provider(cli: &Cli) -> Box<dyn ModelProvider> {
    let kind = provider_kind(cli.provider);
    let config = prricode_provider::load_config();
    let settings = config.providers.get(kind.id());
    let mut overrides = HashMap::new();
    if let Some(base_url) = &cli.base_url {
        overrides.insert("base_url".to_string(), base_url.clone());
    }
    if let Some(api_key) = &cli.api_key {
        overrides.insert("api_key".to_string(), api_key.clone());
    }
    if let Some(env_var) = &cli.api_key_env {
        if let Ok(value) = std::env::var(env_var) {
            overrides.insert("api_key".to_string(), value);
        }
    }
    let env: HashMap<String, String> = std::env::vars().collect();
    let provider_config = resolve_settings(kind, settings, &overrides, &env);
    create_provider(provider_config)
}

fn default_model(cli: &Cli) -> Option<String> {
    if let Some(model) = &cli.model {
        return Some(model.clone());
    }
    let config = prricode_provider::load_config();
    if let Some(model) = config.defaults.model {
        return Some(model);
    }
    None
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_max_level(Level::INFO).init();
    let cli = Cli::parse();

    let data_dir = cli.data_dir.clone().unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".local/share/prricode")
    });

    match &cli.command {
        Command::Serve { port } => {
            let provider = build_provider(&cli);
            info!("prricode server starting (port={:?})", port);
            let server = PrricodeServer::new(data_dir, provider);
            let stdin = io::stdin();
            let stdout = io::stdout();
            let mut stdout_lock = stdout.lock();
            for line in stdin.lock().lines() {
                let line = line?;
                if line.trim().is_empty() {
                    continue;
                }
                let req: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        let resp = serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": null,
                            "error": { "code": -32700, "message": format!("parse error: {e}") }
                        });
                        writeln!(stdout_lock, "{}", serde_json::to_string(&resp)?)?;
                        stdout_lock.flush()?;
                        continue;
                    }
                };
                let response = server.handle_request_from_value(req).await;
                writeln!(stdout_lock, "{}", serde_json::to_string(&response)?)?;
                stdout_lock.flush()?;
            }
        }
        Command::Exec { prompt, json } => {
            let prompt = prompt.clone();
            let json = *json;
            let provider = build_provider(&cli);
            let mut model = default_model(&cli);
            if model.is_none() {
                if let Ok(models) = provider.list_models().await {
                    model = models.first().map(|m| m.model_id.clone());
                }
            }
            let model = model.unwrap_or_else(|| "echo".into());
            let response = provider
                .chat(&ChatRequest {
                    model,
                    messages: vec![ChatMessage::user_text(prompt)],
                    ..Default::default()
                })
                .await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "content": response.message.text(),
                        "inputTokens": response.usage.input_tokens,
                        "outputTokens": response.usage.output_tokens,
                        "finishReason": response.finish_reason,
                    }))?
                );
            } else {
                println!("{}", response.message.text());
            }
        }
        Command::Schema { json } => {
            if *json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&serde_json::json!({
                        "fingerprint": SCHEMA_FINGERPRINT,
                        "version": PROTOCOL_VERSION,
                        "serverName": SERVER_NAME,
                        "serverVersion": SERVER_VERSION,
                    }))?
                );
            } else {
                println!("prricode schema v{PROTOCOL_VERSION}");
                println!("fingerprint: {SCHEMA_FINGERPRINT}");
            }
        }
        Command::ModelProfile => {
            let provider = build_provider(&cli);
            let models = provider.list_models().await?;
            if models.is_empty() {
                println!("No models available. Is the provider reachable?");
            }
            for m in models {
                println!("{} ({})", m.display_label, m.model_id);
            }
        }
        Command::Skills { action } => match action {
            SkillsAction::List => println!("No skills loaded"),
            SkillsAction::Import { source, dry_run } => {
                println!("Import from {source} (dry_run={dry_run})")
            }
            SkillsAction::Activate { name } => println!("Activated: {name}"),
        },
        Command::Config { action } => match action {
            ConfigAction::List => println!("No config"),
            ConfigAction::Get { key } => println!("Config: {key:?}"),
            ConfigAction::Set { key, value } => println!("Set {key} = {value}"),
        },
        Command::Sandbox { action } => match action {
            SandboxAction::Check => println!("Sandbox: available"),
            SandboxAction::Setup => println!("Sandbox: setup complete"),
            SandboxAction::Status => println!("Sandbox: active"),
        },
        Command::Auth { action } => match action {
            AuthAction::Status => println!("Not authenticated"),
            AuthAction::Refresh => println!("Token refreshed"),
            AuthAction::Token => println!("No token"),
        },
        Command::Login { provider } => println!("Login via {:?}", provider),
        Command::Logout => println!("Logged out"),
        Command::Init { force } => println!("Init (force={force})"),
        Command::Voice { toggle } => println!("Voice (toggle={toggle})"),
        Command::Plugins { action } => match action {
            PluginsAction::List => println!("No plugins"),
            PluginsAction::Install { target } => println!("Install: {target}"),
            PluginsAction::Marketplace { action } => match action {
                MarketplaceAction::Add { name, source } => println!("Add {name} from {source}"),
                MarketplaceAction::Remove { name } => println!("Remove {name}"),
                MarketplaceAction::Update { name } => println!("Update {name}"),
            },
        },
        Command::Mcp { action } => match action {
            McpAction::List => println!("No MCP servers"),
            McpAction::Add { name, url } => println!("Add MCP {name} at {url}"),
            McpAction::Remove { name } => println!("Remove {name}"),
        },
        Command::Export { session_id, output } => println!("Export {session_id} to {output:?}"),
        Command::Trace { session_id } => println!("Trace {session_id}"),
        Command::SessionMessage {
            session_id,
            message,
        } => println!("Message to {session_id}: {message}"),
        Command::Resume { session_id } => println!("Resume {session_id:?}"),
    }
    Ok(())
}
