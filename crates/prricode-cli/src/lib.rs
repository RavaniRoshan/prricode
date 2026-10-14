use clap::{Parser, Subcommand, ValueEnum};
use prricode_core::*;
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "prricode",
    version = "0.1.0",
    about = "Autonomous AI coding agent"
)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Command>,

    #[arg(long, value_enum, default_value = "echo", global = true)]
    pub provider: ProviderArg,

    #[arg(long, global = true)]
    pub model: Option<String>,

    #[arg(long, global = true)]
    pub base_url: Option<String>,

    #[arg(long, global = true)]
    pub api_key: Option<String>,

    #[arg(long, global = true)]
    pub api_key_env: Option<String>,

    #[arg(long, global = true)]
    pub reasoning_effort: Option<ReasoningEffortArg>,

    #[arg(long, global = true)]
    pub worktree: Option<String>,

    #[arg(long, global = true)]
    pub approval_mode: Option<ApprovalModeArg>,

    #[arg(long, global = true)]
    pub permission_profile: Option<String>,

    #[arg(long, global = true)]
    pub context_compaction_strategy: Option<String>,

    #[arg(long, global = true)]
    pub data_dir: Option<PathBuf>,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, ValueEnum)]
pub enum ProviderArg {
    Echo,
    Ollama,
    OllamaCloud,
    Openrouter,
    Kilo,
    Openai,
    Custom,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, ValueEnum)]
pub enum ReasoningEffortArg {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
    Ultra,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq, ValueEnum)]
pub enum ApprovalModeArg {
    Closed,
    Open,
    Auto,
    Suggestive,
}

#[derive(Subcommand)]
pub enum Command {
    /// List sessions, or show one session's detail
    Resume { session_id: Option<String> },
    /// Execute one-off command
    Exec {
        prompt: String,
        #[arg(long)]
        json: bool,
    },
    /// Manage configuration
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Export session data
    Export {
        session_id: String,
        #[arg(long)]
        output: Option<String>,
    },
    /// View execution trace
    Trace { session_id: String },
    /// Show model profiles
    ModelProfile,
    /// Manage skills
    Skills {
        #[command(subcommand)]
        action: SkillsAction,
    },
    /// Voice input (transcribe a file when a speech model is configured)
    Voice {
        #[arg(
            long,
            action = clap::ArgAction::Set,
            num_args = 0..=1,
            default_value = "false",
            default_missing_value = "true"
        )]
        toggle: bool,
        /// Transcribe this audio file (requires voice.stt_model in config)
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// Manage plugins
    Plugins {
        #[command(subcommand)]
        action: PluginsAction,
    },
    /// Sandbox management
    Sandbox {
        #[command(subcommand)]
        action: SandboxAction,
    },
    /// Export schema
    Schema {
        #[arg(long)]
        json: bool,
    },
    /// Start JSON-RPC server
    Serve {
        #[arg(long)]
        port: Option<u16>,
    },
    /// Send session message
    SessionMessage { session_id: String, message: String },
    /// MCP server management
    Mcp {
        #[command(subcommand)]
        action: McpAction,
    },
    /// Authentication
    Auth {
        #[command(subcommand)]
        action: AuthAction,
    },
    /// Login to provider
    Login {
        #[arg(id = "login-provider")]
        provider: Option<String>,
    },
    /// Logout
    Logout {
        /// Drop this provider's stored credential; with no provider, all of them.
        #[arg(id = "logout-provider")]
        provider: Option<String>,
    },
    /// Initialize project
    Init {
        #[arg(long)]
        force: bool,
    },
}

#[derive(Subcommand)]
pub enum ConfigAction {
    Get { key: Option<String> },
    Set { key: String, value: String },
    List,
}

#[derive(Subcommand)]
pub enum SkillsAction {
    List,
    Import {
        source: String,
        #[arg(long)]
        dry_run: bool,
    },
    Activate {
        name: String,
    },
}

#[derive(Subcommand)]
pub enum PluginsAction {
    List,
    Install {
        target: String,
    },
    Marketplace {
        #[command(subcommand)]
        action: MarketplaceAction,
    },
}

#[derive(Subcommand)]
pub enum MarketplaceAction {
    Add { name: String, source: String },
    Remove { name: String },
    Update { name: String },
}

#[derive(Subcommand)]
pub enum SandboxAction {
    Check,
    Setup,
    Status,
}

#[derive(Subcommand)]
pub enum McpAction {
    List,
    Add {
        name: String,
        #[arg(long)]
        url: Option<String>,
        #[arg(long)]
        command: Option<String>,
        #[arg(long)]
        args: Option<String>,
    },
    Remove {
        name: String,
    },
}

#[derive(Subcommand)]
pub enum AuthAction {
    Status,
    Refresh,
    /// Store a credential for a provider (key via --key-env or stdin)
    Token {
        #[arg(id = "auth-provider")]
        provider: String,
        #[arg(long)]
        key_env: Option<String>,
    },
}

impl ProviderArg {
    pub fn to_provider_id(&self) -> ProviderId {
        match self {
            Self::Echo => ProviderId::Echo,
            Self::Ollama => ProviderId::Ollama,
            Self::OllamaCloud => ProviderId::OllamaCloud,
            Self::Openrouter => ProviderId::OpenRouter,
            Self::Kilo => ProviderId::Kilo,
            Self::Openai => ProviderId::OpenAI,
            Self::Custom => ProviderId::Custom,
        }
    }
}

impl ReasoningEffortArg {
    pub fn to_effort(&self) -> ReasoningEffort {
        match self {
            Self::None => ReasoningEffort::None,
            Self::Minimal => ReasoningEffort::Minimal,
            Self::Low => ReasoningEffort::Low,
            Self::Medium => ReasoningEffort::Medium,
            Self::High => ReasoningEffort::High,
            Self::XHigh => ReasoningEffort::XHigh,
            Self::Max => ReasoningEffort::Max,
            Self::Ultra => ReasoningEffort::Ultra,
        }
    }
}

impl ApprovalModeArg {
    pub fn to_mode(&self) -> ApprovalMode {
        match self {
            Self::Closed => ApprovalMode::Closed,
            Self::Open => ApprovalMode::Open,
            Self::Auto => ApprovalMode::Auto,
            Self::Suggestive => ApprovalMode::Suggestive,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn cli_debug_assert_passes() {
        Cli::command().debug_assert();
    }

    #[test]
    fn auth_token_takes_a_provider_positional() {
        let cli = Cli::parse_from([
            "prricode",
            "auth",
            "token",
            "openrouter",
            "--key-env",
            "OPENROUTER_API_KEY",
        ]);
        match cli.command {
            Some(Command::Auth {
                action: AuthAction::Token { provider, key_env },
            }) => {
                assert_eq!(provider, "openrouter");
                assert_eq!(key_env.as_deref(), Some("OPENROUTER_API_KEY"));
            }
            other => {
                let _ = other;
                panic!("expected `auth token`, got another command")
            }
        }
    }

    #[test]
    fn auth_status_parses() {
        let cli = Cli::parse_from(["prricode", "auth", "status"]);
        assert!(matches!(
            cli.command,
            Some(Command::Auth {
                action: AuthAction::Status
            })
        ));
    }

    #[test]
    fn login_provider_positional_parses() {
        let cli = Cli::parse_from(["prricode", "login", "kilo"]);
        match cli.command {
            Some(Command::Login { provider }) => assert_eq!(provider.as_deref(), Some("kilo")),
            other => {
                let _ = other;
                panic!("expected `login`, got another command")
            }
        }
    }

    #[test]
    fn logout_takes_an_optional_provider_positional() {
        let cli = Cli::parse_from(["prricode", "logout", "openrouter"]);
        match cli.command {
            Some(Command::Logout { provider }) => {
                assert_eq!(provider.as_deref(), Some("openrouter"))
            }
            other => {
                let _ = other;
                panic!("expected `logout`, got another command")
            }
        }
        // With no provider it still parses (removes every stored credential).
        let cli = Cli::parse_from(["prricode", "logout"]);
        match cli.command {
            Some(Command::Logout { provider }) => assert_eq!(provider, None),
            other => {
                let _ = other;
                panic!("expected `logout`, got another command")
            }
        }
    }

    #[test]
    fn global_provider_flag_still_works_next_to_subcommands() {
        let cli = Cli::parse_from(["prricode", "--provider", "openrouter", "exec", "hi"]);
        assert_eq!(cli.provider, ProviderArg::Openrouter);
        match cli.command {
            Some(Command::Exec { prompt, .. }) => assert_eq!(prompt, "hi"),
            other => {
                let _ = other;
                panic!("expected `exec`, got another command")
            }
        }
    }

    #[test]
    fn exec_accepts_model_and_approval_globals() {
        let cli = Cli::parse_from([
            "prricode",
            "--provider",
            "ollama",
            "--model",
            "qwen2.5-coder:3b",
            "--approval-mode",
            "open",
            "exec",
            "go",
        ]);
        assert_eq!(cli.provider, ProviderArg::Ollama);
        assert_eq!(cli.model.as_deref(), Some("qwen2.5-coder:3b"));
        assert_eq!(cli.approval_mode, Some(ApprovalModeArg::Open));
    }
}
