use anyhow::Result;
use clap::Parser;
use prricode_cli::*;
use prricode_core::*;
use prricode_persistence::Persistence;
use prricode_provider::*;
use prricode_server::*;
use std::collections::HashMap;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
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

// ---------- paths ----------

/// Directory holding prricode's config files (`~/.config/prricode`, or the
/// parent of `$PRRICODE_CONFIG`).
fn config_dir() -> PathBuf {
    prricode_provider::config_path()
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn db_path(data_dir: &Path) -> PathBuf {
    data_dir.join("prricode.db")
}

// ---------- toml file helpers ----------

fn read_toml_table(path: &Path) -> Result<toml::Table> {
    match std::fs::read_to_string(path) {
        Ok(text) if text.trim().is_empty() => Ok(toml::Table::new()),
        Ok(text) => Ok(text
            .parse::<toml::Table>()
            .map_err(|e| anyhow::anyhow!("{} is not valid TOML: {e}", path.display()))?),
        Err(_) => Ok(toml::Table::new()),
    }
}

fn write_toml_file(path: &Path, table: &toml::Table) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, toml::to_string_pretty(table)?)?;
    Ok(())
}

fn ensure_section(table: &mut toml::Table, name: &str) {
    if !table.get(name).is_some_and(toml::Value::is_table) {
        table.insert(name.to_string(), toml::Value::Table(toml::Table::new()));
    }
}

/// Set a dotted key (`providers.kilo.api_key`) inside a TOML table, creating
/// intermediate tables as needed.
fn set_dotted(root: &mut toml::Value, dotted: &str, value: toml::Value) {
    let parts: Vec<&str> = dotted.split('.').collect();
    let (last, parents) = parts.split_last().expect("key has at least one segment");
    let mut current = root;
    for parent in parents {
        if !current.is_table() {
            *current = toml::Value::Table(toml::Table::new());
        }
        let table = current.as_table_mut().expect("checked above");
        current = table
            .entry(parent.to_string())
            .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    }
    if !current.is_table() {
        *current = toml::Value::Table(toml::Table::new());
    }
    current
        .as_table_mut()
        .expect("checked above")
        .insert(last.to_string(), value);
}

fn lookup_dotted<'a>(root: &'a serde_json::Value, dotted: &str) -> Option<&'a serde_json::Value> {
    let mut current = root;
    for part in dotted.split('.') {
        current = current.get(part)?;
    }
    Some(current)
}

fn flatten_value(
    prefix: &str,
    value: &serde_json::Value,
    out: &mut Vec<(String, serde_json::Value)>,
) {
    match value {
        serde_json::Value::Object(map) if !map.is_empty() => {
            for (key, value) in map {
                let key = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                flatten_value(&key, value, out);
            }
        }
        serde_json::Value::Object(_) => {}
        other => out.push((prefix.to_string(), other.clone())),
    }
}

fn print_config_value(key: &str, value: &serde_json::Value) {
    match value {
        serde_json::Value::String(s) => println!("{key} = {s}"),
        serde_json::Value::Null => println!("{key} = null"),
        other => println!("{key} = {other}"),
    }
}

// ---------- skills ----------

struct SkillEntry {
    name: String,
    description: String,
    location: PathBuf,
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

/// Read name/description from a skill directory's `SKILL.md` frontmatter,
/// falling back to the directory name and first body line.
fn skill_meta(dir: &Path) -> Option<(String, String)> {
    let text = std::fs::read_to_string(dir.join("SKILL.md")).ok()?;
    let mut name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut description = String::new();
    let mut lines = text.lines().peekable();
    if lines.peek().is_some_and(|line| line.trim() == "---") {
        lines.next();
        for line in lines.by_ref() {
            let trimmed = line.trim();
            if trimmed == "---" {
                break;
            }
            if let Some(rest) = trimmed.strip_prefix("name:") {
                name = unquote(rest);
            } else if let Some(rest) = trimmed.strip_prefix("description:") {
                description = unquote(rest);
            }
        }
    } else {
        for line in text.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('#') {
                description = trimmed.to_string();
                break;
            }
        }
    }
    Some((name, description))
}

fn discover_skills() -> Vec<SkillEntry> {
    let mut skills = Vec::new();
    for dir in [PathBuf::from("skills"), config_dir().join("skills")] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        paths.sort();
        for path in paths {
            if let Some((name, description)) = skill_meta(&path) {
                skills.push(SkillEntry {
                    name,
                    description,
                    location: path,
                });
            }
        }
    }
    skills
}

fn write_mcp_server(
    path: &Path,
    table: &mut toml::Table,
    name: String,
    entry: toml::Table,
) -> Result<()> {
    let servers = table
        .entry("servers".to_string())
        .or_insert_with(|| toml::Value::Array(Vec::new()));
    if !servers.is_array() {
        *servers = toml::Value::Array(Vec::new());
    }
    let array = servers.as_array_mut().expect("just ensured");
    if array
        .iter()
        .any(|s| s.get("name").and_then(|n| n.as_str()) == Some(name.as_str()))
    {
        anyhow::bail!("MCP server '{name}' already exists in {}", path.display());
    }
    array.push(toml::Value::Table(entry));
    write_toml_file(path, table)?;
    Ok(())
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<()> {
    std::fs::create_dir_all(dest)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dest.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

// ---------- sandbox ----------

/// Version of bubblewrap, if it is installed and runnable.
fn probe_bwrap() -> Option<String> {
    let output = std::process::Command::new("bwrap")
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// ---------- auth ----------

/// Environment variables consulted for provider credentials.
const AUTH_ENV_VARS: &[(&str, &str)] = &[
    ("kilo", "KILO_API_KEY"),
    ("openrouter", "OPENROUTER_API_KEY"),
    ("openai", "OPENAI_API_KEY"),
    ("ollama-cloud", "OLLAMA_API_KEY"),
    ("ollama (host)", "OLLAMA_HOST"),
];

fn auth_env_var(provider: &str) -> Option<&'static str> {
    match provider.to_ascii_lowercase().as_str() {
        "kilo" => Some("KILO_API_KEY"),
        "openrouter" => Some("OPENROUTER_API_KEY"),
        "openai" => Some("OPENAI_API_KEY"),
        "ollama-cloud" | "ollamacloud" => Some("OLLAMA_API_KEY"),
        "ollama" => Some("OLLAMA_HOST"),
        _ => None,
    }
}

// ---------- items ----------

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push_str("...");
    out
}

/// One-line preview of a stored item's JSON content.
fn item_preview(content: &str, max: usize) -> String {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(content) else {
        return truncate_chars(content, max);
    };
    if let Some(parts) = value.get("content").and_then(|c| c.as_array()) {
        let mut rendered = Vec::new();
        for part in parts {
            match part.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                        rendered.push(text.to_string());
                    }
                }
                Some("toolUse") => rendered.push(format!(
                    "[tool {}]",
                    part.get("name").and_then(|n| n.as_str()).unwrap_or("?")
                )),
                Some("toolResult") => rendered.push("[tool result]".to_string()),
                _ => {}
            }
        }
        if !rendered.is_empty() {
            return truncate_chars(&rendered.join(" "), max);
        }
    }
    truncate_chars(&serde_json::to_string(&value).unwrap_or_default(), max)
}

fn rpc_line(id: u64, method: &str, params: serde_json::Value) -> String {
    serde_json::to_string(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    }))
    .unwrap_or_default()
}

const STARTER_CONFIG: &str = "\
# prricode project configuration
# Docs: docs/CONFIGURATION.md

[defaults]
# provider = \"ollama\"
# model = \"qwen2.5-coder:3b\"

# [providers.kilo]
# api_key_env = \"KILO_API_KEY\"
# default_model = \"liquid/lfm-2.5-2.6b:free\"

# [providers.ollama]
# base_url = \"http://localhost:11434\"
";

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_max_level(Level::INFO)
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();

    let data_dir = cli.data_dir.clone().unwrap_or_else(|| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        PathBuf::from(home).join(".local/share/prricode")
    });

    // Bare `prricode` (no subcommand) runs the interactive TUI — the
    // Reference-compatible default entry point.
    if cli.command.is_none() {
        let launch = prricode_tui::LaunchConfig {
            provider: provider_kind(cli.provider),
            model: default_model(&cli),
            base_url: cli.base_url.clone(),
            approval_mode: cli
                .approval_mode
                .map(|m| m.to_mode())
                .unwrap_or(prricode_core::ApprovalMode::Closed),
            workspace_root: None,
            data_dir: Some(data_dir),
            resume_session: None,
        };
        return prricode_tui::run(launch);
    }

    match cli.command.as_ref().expect("command present") {
        Command::Serve { port } => {
            let provider = build_provider(&cli);
            let default_model = default_model(&cli);
            info!("prricode server starting (port={:?})", port);
            let (server, mut events_rx) = PrricodeServer::new(data_dir, provider, default_model);
            let server = Arc::new(server);
            let out = Arc::new(tokio::sync::Mutex::new(io::stdout()));
            let out_writer = Arc::clone(&out);
            tokio::spawn(async move {
                while let Some(event) = events_rx.recv().await {
                    if let Some((method, params)) = notification_for(&event) {
                        let notification = serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": method,
                            "params": params,
                        });
                        let mut stdout = out_writer.lock().await;
                        let line = serde_json::to_string(&notification).unwrap_or_default();
                        let _ = writeln!(stdout, "{line}");
                        let _ = stdout.flush();
                    }
                }
            });
            let stdin = io::stdin();
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
                        let mut stdout = out.lock().await;
                        writeln!(stdout, "{}", serde_json::to_string(&resp)?)?;
                        stdout.flush()?;
                        continue;
                    }
                };
                let response = server.handle_request_from_value(req).await;
                let mut stdout = out.lock().await;
                writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
                stdout.flush()?;
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
        Command::Skills { action } => {
            match action {
                SkillsAction::List => {
                    let skills = discover_skills();
                    if skills.is_empty() {
                        println!(
                            "No skills found (looked in ./skills and {})",
                            config_dir().join("skills").display()
                        );
                    }
                    for skill in skills {
                        if skill.description.is_empty() {
                            println!("{} [{}]", skill.name, skill.location.display());
                        } else {
                            println!(
                                "{}: {} [{}]",
                                skill.name,
                                skill.description,
                                skill.location.display()
                            );
                        }
                    }
                }
                SkillsAction::Import { source, dry_run } => {
                    let source = PathBuf::from(source);
                    if !source.join("SKILL.md").is_file() {
                        anyhow::bail!("no SKILL.md under {}", source.display());
                    }
                    let name = source
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .ok_or_else(|| {
                            anyhow::anyhow!("cannot determine skill name from {}", source.display())
                        })?;
                    let dest = config_dir().join("skills").join(&name);
                    if *dry_run {
                        println!(
                            "dry run: would import '{name}' from {} to {}",
                            source.display(),
                            dest.display()
                        );
                        return Ok(());
                    }
                    if dest.exists() {
                        anyhow::bail!(
                            "skill '{name}' already installed at {} (remove it to re-import)",
                            dest.display()
                        );
                    }
                    copy_dir_recursive(&source, &dest)?;
                    println!("Imported skill '{name}' into {}", dest.display());
                }
                SkillsAction::Activate { name } => {
                    println!("Skill '{name}' is not activated from the CLI: activation is session-scoped.");
                    println!(
                        "Skills under ./skills and {} load when a session starts.",
                        config_dir().join("skills").display()
                    );
                    println!("Run 'prricode serve' and call skill/list on the session to inspect active skills.");
                }
            }
        }
        Command::Config { action } => match action {
            ConfigAction::Get { key } => {
                let config = prricode_provider::load_config();
                let value = serde_json::to_value(&config)?;
                match key {
                    None => {
                        let mut flat = Vec::new();
                        flatten_value("", &value, &mut flat);
                        if flat.is_empty() {
                            println!(
                                "No values set (config: {})",
                                prricode_provider::config_path().display()
                            );
                        }
                        for (key, value) in flat {
                            print_config_value(&key, &value);
                        }
                    }
                    Some(key) => match lookup_dotted(&value, key) {
                        Some(value) => print_config_value(key, value),
                        None => println!("{key}: not set"),
                    },
                }
            }
            ConfigAction::Set { key, value } => {
                if key.split('.').any(|part| part.is_empty()) {
                    anyhow::bail!("invalid config key: {key}");
                }
                let path = prricode_provider::config_path();
                let mut root = match std::fs::read_to_string(&path) {
                    Ok(text) if text.trim().is_empty() => toml::Value::Table(toml::Table::new()),
                    Ok(text) => text.parse::<toml::Value>().map_err(|e| {
                        anyhow::anyhow!("{} is not valid TOML: {e}", path.display())
                    })?,
                    Err(_) => toml::Value::Table(toml::Table::new()),
                };
                // Every config key is string-typed (provider ids, models, env var
                // names), so values are stored as TOML strings.
                set_dotted(&mut root, key, toml::Value::String(value.clone()));
                if let Some(parent) = path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                std::fs::write(&path, toml::to_string_pretty(&root)?)?;
                println!("Set {key} = {value} in {}", path.display());
            }
            ConfigAction::List => {
                let path = prricode_provider::config_path();
                match std::fs::read_to_string(&path) {
                    Ok(text) => print!("{text}"),
                    Err(_) => println!("No config file at {}", path.display()),
                }
            }
        },
        Command::Sandbox { action } => match action {
            SandboxAction::Check | SandboxAction::Status => {
                if !cfg!(target_os = "linux") {
                    println!(
                        "Sandbox: unavailable on {} (bubblewrap is Linux-only)",
                        std::env::consts::OS
                    );
                } else {
                    match probe_bwrap() {
                        Some(version) => println!("Sandbox: available ({version})"),
                        None => println!(
                            "Sandbox: unavailable (bwrap not found; install the 'bubblewrap' package)"
                        ),
                    }
                }
            }
            SandboxAction::Setup => {
                if !cfg!(target_os = "linux") {
                    println!(
                        "Sandbox: nothing to set up on {} (this build probes bubblewrap on Linux only)",
                        std::env::consts::OS
                    );
                } else {
                    match probe_bwrap() {
                        Some(version) => {
                            println!("Sandbox: {version} installed; nothing to set up")
                        }
                        None => {
                            println!(
                                "Sandbox: bwrap not found; install bubblewrap to isolate commands"
                            );
                            println!("  apt: sudo apt install bubblewrap");
                            println!("  dnf: sudo dnf install bubblewrap");
                            println!("then re-run 'prricode sandbox check'");
                        }
                    }
                }
            }
        },
        Command::Auth { action } => match action {
            AuthAction::Status => {
                println!("credentials (stored, owner-only):");
                let stored = prricode_provider::credential_providers();
                if stored.is_empty() {
                    println!("  none");
                }
                for provider in stored {
                    println!("  {provider}: stored");
                }
                println!("environment:");
                for (label, var) in AUTH_ENV_VARS {
                    let state = if std::env::var(var).is_ok() {
                        "set"
                    } else {
                        "not set"
                    };
                    println!("  {label}: {state} ({var})");
                }
            }
            AuthAction::Token { provider, key_env } => {
                // Store a credential: read the key from the environment variable
                // named on the command line, or from stdin when piped.
                let key = match key_env.as_ref().and_then(|var| std::env::var(var).ok()) {
                    Some(key) => key,
                    None => {
                        let mut line = String::new();
                        if std::io::stdin().read_line(&mut line).unwrap_or(0) == 0 {
                            anyhow::bail!("no key on stdin; pass --key-env <VAR>");
                        }
                        line.trim().to_string()
                    }
                };
                if key.is_empty() {
                    anyhow::bail!("empty key");
                }
                prricode_provider::credential_set(provider, &key)?;
                println!("stored credential for {provider}");
            }
            AuthAction::Refresh => {
                println!(
                    "Nothing to refresh: prricode resolves credentials per request (env > config > store)."
                );
                println!("Run 'prricode auth status' to see what is configured.");
            }
        },
        Command::Login { provider } => match provider {
            Some(provider) => {
                let normalized = provider.to_ascii_lowercase();
                if normalized == "echo" {
                    println!("The echo provider needs no authentication.");
                } else if normalized == "custom" {
                    println!("Custom providers authenticate with an environment variable of your choice:");
                    println!("  prricode exec \"...\" --provider custom --base-url https://... --api-key-env MY_KEY");
                } else if let Some(var) = auth_env_var(provider) {
                    println!("To authenticate with {provider}, set:");
                    if normalized == "ollama" {
                        println!(
                            "  export {var}=http://your-host:11434   # only if not the default"
                        );
                    } else {
                        println!("  export {var}=\"your-api-key\"");
                    }
                    println!("Add it to your shell profile (~/.bashrc or ~/.zshrc) to persist it.");
                } else {
                    println!("Unknown provider '{provider}'.");
                    println!("Known providers: echo, ollama, ollama-cloud, openrouter, kilo, openai, custom");
                }
            }
            None => {
                println!("Login is per provider; pick one and set its environment variable:");
                println!("  prricode login kilo         # KILO_API_KEY");
                println!("  prricode login openrouter   # OPENROUTER_API_KEY");
                println!("  prricode login openai       # OPENAI_API_KEY");
                println!("  prricode login ollama-cloud # OLLAMA_API_KEY");
                println!("  prricode login ollama       # OLLAMA_HOST (local; no key needed)");
            }
        },
        Command::Logout => {
            println!("prricode keeps no credentials of its own; unset the environment variables:");
            println!(
                "  unset KILO_API_KEY OPENROUTER_API_KEY OPENAI_API_KEY OLLAMA_API_KEY OLLAMA_HOST"
            );
            println!(
                "Also remove inline 'api_key' entries from {} ('prricode config list').",
                prricode_provider::config_path().display()
            );
        }
        Command::Init { force } => {
            let path = PathBuf::from("prricode.toml");
            if path.exists() && !*force {
                anyhow::bail!(
                    "{} already exists (use --force to overwrite)",
                    path.display()
                );
            }
            std::fs::write(&path, STARTER_CONFIG)?;
            println!("Wrote {}", path.display());
        }
        Command::Voice { toggle: _, file } => {
            use prricode_voice::{OpenAiAudio, SpeechToText};
            let config = prricode_provider::load_config();
            let Some(stt_model) = config.voice.stt_model.clone() else {
                println!(
                    "Voice needs a speech-to-text model in {}:",
                    prricode_provider::config_path().display()
                );
                println!("  [voice]");
                println!("  stt_model = \"your-stt-model\"");
                println!("See docs/VOICE.md.");
                return Ok(());
            };
            let Some(file) = file else {
                println!("Voice ready (stt_model: {stt_model}). Transcribe a file with:");
                println!("  prricode voice --file meeting.wav");
                return Ok(());
            };
            // Resolve the provider's base URL + key for /audio/transcriptions.
            let kind = provider_kind(cli.provider);
            let settings = config.providers.get(kind.id()).cloned();
            let mut overrides = HashMap::new();
            if let Some(base_url) = &cli.base_url {
                overrides.insert("base_url".to_string(), base_url.clone());
            }
            let env: HashMap<String, String> = std::env::vars().collect();
            let provider_config = resolve_settings(kind, settings.as_ref(), &overrides, &env);
            let audio = OpenAiAudio::new(provider_config.base_url, provider_config.api_key)
                .with_stt(stt_model.clone());
            let bytes = std::fs::read(file)
                .map_err(|e| anyhow::anyhow!("cannot read {}: {e}", file.display()))?;
            let media_type = match file.extension().and_then(|e| e.to_str()) {
                Some("mp3") => "audio/mpeg",
                Some("wav") => "audio/wav",
                Some("webm") => "audio/webm",
                Some("ogg") => "audio/ogg",
                Some("m4a") => "audio/mp4",
                _ => "application/octet-stream",
            };
            let text = audio
                .transcribe(&bytes, media_type)
                .await
                .map_err(|e| anyhow::anyhow!("transcription failed: {e}"))?;
            if text.trim().is_empty() {
                println!("(no speech recognized)");
            } else {
                println!("{text}");
            }
        }
        Command::Plugins { action } => match action {
            PluginsAction::List => {
                let dir = config_dir().join("plugins");
                let mut names: Vec<String> = std::fs::read_dir(&dir)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .filter(|entry| entry.path().is_dir())
                    .filter_map(|entry| entry.file_name().into_string().ok())
                    .collect();
                names.sort();
                if names.is_empty() {
                    println!("No plugins installed in {}", dir.display());
                }
                for name in names {
                    println!("{name}");
                }
            }
            PluginsAction::Install { target } => {
                let dir = config_dir().join("plugins");
                std::fs::create_dir_all(&dir)?;
                let name = target
                    .rsplit('/')
                    .next()
                    .unwrap_or(target)
                    .trim_end_matches(".git")
                    .to_string();
                if name.is_empty() {
                    anyhow::bail!("cannot determine a plugin name from {target}");
                }
                let dest = dir.join(&name);
                if dest.exists() {
                    anyhow::bail!("plugin '{name}' already installed at {}", dest.display());
                }
                let status = std::process::Command::new("git")
                    .arg("clone")
                    .arg(target)
                    .arg(&dest)
                    .status()?;
                if !status.success() {
                    anyhow::bail!("git clone failed for {target}");
                }
                println!("Installed plugin '{name}' into {}", dest.display());
            }
            PluginsAction::Marketplace { action } => match action {
                MarketplaceAction::Add { name, source } => {
                    let path = config_dir().join("marketplaces.toml");
                    let mut table = read_toml_table(&path)?;
                    ensure_section(&mut table, "marketplaces");
                    let marketplaces = table["marketplaces"].as_table_mut().expect("just ensured");
                    if marketplaces.contains_key(name) {
                        anyhow::bail!("marketplace '{name}' already exists in {}", path.display());
                    }
                    marketplaces.insert(name.clone(), toml::Value::String(source.clone()));
                    write_toml_file(&path, &table)?;
                    println!(
                        "Added marketplace '{name}' ({source}) to {}",
                        path.display()
                    );
                }
                MarketplaceAction::Remove { name } => {
                    let path = config_dir().join("marketplaces.toml");
                    let mut table = read_toml_table(&path)?;
                    let removed = table
                        .get_mut("marketplaces")
                        .and_then(toml::Value::as_table_mut)
                        .is_some_and(|m| m.remove(name).is_some());
                    if !removed {
                        anyhow::bail!("marketplace '{name}' not found in {}", path.display());
                    }
                    write_toml_file(&path, &table)?;
                    println!("Removed marketplace '{name}'");
                }
                MarketplaceAction::Update { name } => {
                    let path = config_dir().join("marketplaces.toml");
                    let table = read_toml_table(&path)?;
                    let source = table
                        .get("marketplaces")
                        .and_then(toml::Value::as_table)
                        .and_then(|m| m.get(name))
                        .and_then(toml::Value::as_str)
                        .ok_or_else(|| {
                            anyhow::anyhow!("marketplace '{name}' not found in {}", path.display())
                        })?
                        .to_string();
                    let is_git = ["http://", "https://", "git@"]
                        .iter()
                        .any(|prefix| source.starts_with(prefix))
                        || source.ends_with(".git");
                    if !is_git {
                        anyhow::bail!(
                            "marketplace '{name}' source '{source}' is not a git repository; nothing to update"
                        );
                    }
                    let clone_dir = config_dir().join("marketplaces").join(name);
                    let pulled = if clone_dir.join(".git").exists() {
                        std::process::Command::new("git")
                            .arg("-C")
                            .arg(&clone_dir)
                            .arg("pull")
                            .status()?
                            .success()
                    } else {
                        if let Some(parent) = clone_dir.parent() {
                            std::fs::create_dir_all(parent)?;
                        }
                        std::process::Command::new("git")
                            .arg("clone")
                            .arg(&source)
                            .arg(&clone_dir)
                            .status()?
                            .success()
                    };
                    if !pulled {
                        anyhow::bail!("git sync failed for marketplace '{name}' ({source})");
                    }
                    write_toml_file(&path, &table)?;
                    println!("Updated marketplace '{name}' from {source}");
                }
            },
        },
        Command::Mcp { action } => match action {
            McpAction::List => {
                let path = config_dir().join("mcp.toml");
                let table = read_toml_table(&path)?;
                match table.get("servers").and_then(toml::Value::as_array) {
                    Some(servers) if !servers.is_empty() => {
                        for server in servers {
                            let name = server.get("name").and_then(|n| n.as_str()).unwrap_or("?");
                            if let Some(command) = server.get("command").and_then(|c| c.as_str()) {
                                println!("{name}: {command} (stdio)");
                            } else if let Some(url) = server.get("url").and_then(|u| u.as_str()) {
                                println!("{name}: {url} (http; not auto-started)");
                            } else {
                                println!("{name}: <invalid entry>");
                            }
                        }
                    }
                    _ => println!("No MCP servers configured in {}", path.display()),
                }
            }
            McpAction::Add {
                name,
                url,
                command,
                args,
            } => {
                let path = config_dir().join("mcp.toml");
                let mut table = read_toml_table(&path)?;
                let mut entry = toml::Table::new();
                entry.insert("name".to_string(), toml::Value::String(name.clone()));
                if let Some(command) = command {
                    entry.insert("command".to_string(), toml::Value::String(command.clone()));
                    if let Some(args) = args {
                        let parts: Vec<toml::Value> = args
                            .split_whitespace()
                            .map(|a| toml::Value::String(a.to_string()))
                            .collect();
                        entry.insert("args".to_string(), toml::Value::Array(parts));
                    }
                    write_mcp_server(&path, &mut table, name.clone(), entry)?;
                    println!(
                        "Added MCP server '{name}' (command: {command}) to {}",
                        path.display()
                    );
                } else if let Some(url) = url {
                    // Remote/HTTP servers are recorded but not auto-started by
                    // this build (stdio MCP only).
                    entry.insert("url".to_string(), toml::Value::String(url.clone()));
                    write_mcp_server(&path, &mut table, name.clone(), entry)?;
                    println!("Added MCP server '{name}' ({url}) to {}", path.display());
                    println!("note: HTTP transports connect from the TUI/server; stdio servers start automatically");
                } else {
                    anyhow::bail!("mcp add needs --url or --command");
                }
            }
            McpAction::Remove { name } => {
                let path = config_dir().join("mcp.toml");
                let mut table = read_toml_table(&path)?;
                let removed = table
                    .get_mut("servers")
                    .and_then(toml::Value::as_array_mut)
                    .is_some_and(|servers| {
                        let before = servers.len();
                        servers.retain(|s| s.get("name").and_then(|n| n.as_str()) != Some(name));
                        servers.len() != before
                    });
                if !removed {
                    anyhow::bail!("MCP server '{name}' not found in {}", path.display());
                }
                write_toml_file(&path, &table)?;
                println!("Removed MCP server '{name}'");
            }
        },
        Command::Export { session_id, output } => {
            let persistence = Persistence::new(&data_dir)?;
            let items = persistence.list_items(session_id, None)?;
            let mut transcript = String::new();
            for item in &items {
                transcript.push_str(&serde_json::to_string(item)?);
                transcript.push('\n');
            }
            match output {
                Some(path) => {
                    std::fs::write(path, &transcript)?;
                    println!(
                        "Exported {} items from session {session_id} to {path}",
                        items.len()
                    );
                }
                None => print!("{transcript}"),
            }
        }
        Command::Trace { session_id } => {
            let persistence = Persistence::new(&data_dir)?;
            let items = persistence.list_items(session_id, None)?;
            if items.is_empty() {
                println!(
                    "No items for session {session_id} in {}",
                    db_path(&data_dir).display()
                );
                return Ok(());
            }
            for item in &items {
                let role = item.role.as_deref().unwrap_or("-");
                println!(
                    "{}  {}/{}  {}",
                    item.created_at,
                    item.kind,
                    role,
                    item_preview(&item.content, 100)
                );
            }
        }
        Command::SessionMessage {
            session_id,
            message,
        } => {
            println!(
                "Cross-session messaging runs through the prricode server (JSON-RPC over stdio)."
            );
            println!("Start it in one terminal:  prricode serve");
            println!("Then send these lines to its stdin:");
            println!();
            println!(
                "{}",
                rpc_line(
                    1,
                    "initialize",
                    serde_json::json!({"clientInfo": {"name": "prricode-cli", "version": "0.1.0"}})
                )
            );
            println!(
                "{}",
                rpc_line(
                    2,
                    "session/resume",
                    serde_json::json!({"commandId": uuid::Uuid::now_v7().to_string(), "sessionId": session_id})
                )
            );
            println!(
                "{}",
                rpc_line(
                    3,
                    "turn/start",
                    serde_json::json!({
                        "commandId": uuid::Uuid::now_v7().to_string(),
                        "sessionId": session_id,
                        "input": [{"type": "text", "text": message}]
                    })
                )
            );
            println!();
            println!(
                "Replies stream back as turn/item and turn/completed notifications on stdout."
            );
            if uuid::Uuid::parse_str(session_id).is_err() {
                println!("(note: session ids are UUIDs; run 'prricode resume' to list them)");
            }
        }
        Command::Resume { session_id: None } => {
            // Interactive resume goes through the TUI picker.
            let launch = prricode_tui::LaunchConfig {
                provider: provider_kind(cli.provider),
                model: default_model(&cli),
                base_url: cli.base_url.clone(),
                approval_mode: cli
                    .approval_mode
                    .map(|m| m.to_mode())
                    .unwrap_or(prricode_core::ApprovalMode::Closed),
                workspace_root: None,
                data_dir: Some(data_dir),
                resume_session: None,
            };
            return prricode_tui::run(launch);
        }
        Command::Resume { session_id } => {
            let persistence = Persistence::new(&data_dir)?;
            let sessions = persistence.list_sessions()?;
            match session_id {
                None => {
                    if sessions.is_empty() {
                        println!("No sessions in {}", db_path(&data_dir).display());
                    }
                    for session in &sessions {
                        println!(
                            "{}\t{}\t{}",
                            session.id,
                            session.workspace_root.as_deref().unwrap_or("-"),
                            session.model_id.as_deref().unwrap_or("-")
                        );
                    }
                }
                Some(session_id) => match sessions.iter().find(|s| &s.id == session_id) {
                    None => println!(
                        "Session {session_id} not found in {}",
                        db_path(&data_dir).display()
                    ),
                    Some(session) => {
                        println!("session:  {}", session.id);
                        println!(
                            "workspace: {}",
                            session.workspace_root.as_deref().unwrap_or("-")
                        );
                        println!("model:    {}", session.model_id.as_deref().unwrap_or("-"));
                        println!(
                            "provider: {}",
                            session.provider_id.as_deref().unwrap_or("-")
                        );
                        println!(
                            "approval: {}",
                            session.approval_mode.as_deref().unwrap_or("-")
                        );
                        let items = persistence.list_items(&session.id, None)?;
                        println!("items:    {}", items.len());
                        if let Some(last) = items.last() {
                            println!(
                                "last:     {} {}/{} {}",
                                last.created_at,
                                last.kind,
                                last.role.as_deref().unwrap_or("-"),
                                item_preview(&last.content, 100)
                            );
                        }
                    }
                },
            }
        }
    }
    Ok(())
}
