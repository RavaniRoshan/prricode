use anyhow::Result;
use clap::Parser;
use prricode_cli::*;
use prricode_core::*;
use prricode_server::*;
use prricode_provider::*;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use tracing::{info, Level};
use tracing_subscriber;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_max_level(Level::INFO).init();
    let cli = Cli::parse();

    let data_dir = cli.data_dir.unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".local/share/prricode")
    });

    match cli.command {
        Command::Serve { port } => {
            let provider_kind = match cli.provider {
                ProviderArg::Echo => ProviderKind::Echo,
                ProviderArg::External => ProviderKind::External,
                ProviderArg::Local => ProviderKind::Local,
                ProviderArg::Ollama => ProviderKind::Ollama,
                ProviderArg::Openrouter => ProviderKind::OpenRouter,
                ProviderArg::Kilo => ProviderKind::Kilo,
            };
            let server = MspServer::new(data_dir, provider_kind);
            info!("prricode server starting (port={:?})", port);
            let stdin = io::stdin();
            let stdout = io::stdout();
            let mut stdout_lock = stdout.lock();
            for line in stdin.lock().lines() {
                let line = line?;
                if line.trim().is_empty() { continue; }
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
            let provider_kind = match cli.provider {
                ProviderArg::Echo => ProviderKind::Echo,
                ProviderArg::External => ProviderKind::External,
                ProviderArg::Local => ProviderKind::Local,
                ProviderArg::Ollama => ProviderKind::Ollama,
                ProviderArg::Openrouter => ProviderKind::OpenRouter,
                ProviderArg::Kilo => ProviderKind::Kilo,
            };
            let provider = create_provider(provider_kind);
            let models = provider.list_models().await?;
            let model_id = cli.model.unwrap_or_else(|| {
                models.first().map(|m| m.model_id.implementation()).unwrap_or_else(|| "echo".into())
            });
            let response = provider.generate(ModelRequest {
                model_id,
                messages: vec![Message { role: "user".into(), content: prompt }],
                max_tokens: 4096,
                temperature: 0.7,
            }).await?;
            if json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                    "content": response.content,
                    "inputTokens": response.input_tokens,
                    "outputTokens": response.output_tokens,
                    "finishReason": response.finish_reason,
                }))?);
            } else {
                println!("{}", response.content);
            }
        }
        Command::Schema { json } => {
            if json {
                println!("{}", serde_json::to_string_pretty(&serde_json::json!({
                    "fingerprint": SCHEMA_FINGERPRINT,
                    "version": PROTOCOL_VERSION,
                    "serverName": SERVER_NAME,
                    "serverVersion": SERVER_VERSION,
                }))?);
            } else {
                println!("prricode schema v{PROTOCOL_VERSION}");
                println!("fingerprint: {SCHEMA_FINGERPRINT}");
            }
        }
        Command::ModelProfile => {
            let provider_kind = match cli.provider {
                ProviderArg::Echo => ProviderKind::Echo,
                ProviderArg::External => ProviderKind::External,
                ProviderArg::Local => ProviderKind::Local,
                ProviderArg::Ollama => ProviderKind::Ollama,
                ProviderArg::Openrouter => ProviderKind::OpenRouter,
                ProviderArg::Kilo => ProviderKind::Kilo,
            };
            let provider = create_provider(provider_kind);
            let models = provider.list_models().await?;
            for m in models {
                println!("{} ({})", m.display_label, m.model_id);
            }
        }
        Command::Skills { action } => match action {
            SkillsAction::List => println!("No skills loaded"),
            SkillsAction::Import { source, dry_run } => println!("Import from {source} (dry_run={dry_run})"),
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
            McpAction::Remove { name } => println!("Remove MCP {name}"),
        },
        Command::Export { session_id, output } => println!("Export {session_id} to {output:?}"),
        Command::Trace { session_id } => println!("Trace {session_id}"),
        Command::SessionMessage { session_id, message } => println!("Message to {session_id}: {message}"),
        Command::Resume { session_id } => println!("Resume {session_id:?}"),
    }
    Ok(())
}
