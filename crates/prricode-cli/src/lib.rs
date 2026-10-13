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

#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
pub enum ProviderArg {
    Echo,
    Ollama,
    OllamaCloud,
    Openrouter,
    Kilo,
    Openai,
    Custom,
}

#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
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

#[derive(Copy, Clone, PartialEq, Eq, ValueEnum)]
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
    /// Voice input
    Voice {
        #[arg(long, action = clap::ArgAction::Set, num_args = 0..=1, default_missing_value = "true")]
        toggle: bool,
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
    Logout,
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
    Add { name: String, url: String },
    Remove { name: String },
}

#[derive(Subcommand)]
pub enum AuthAction {
    Status,
    Refresh,
    Token,
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
