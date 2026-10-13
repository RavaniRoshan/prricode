use serde::{Serialize, Deserialize};

pub mod types;
pub mod protocol;

pub const SCHEMA_FINGERPRINT: &str = "sha256:6de32db08bbbe0deb478d2bfcaba001e9fb490986bc80db3aceb4d996abf7df9";
pub const PROTOCOL_VERSION: u32 = 1;
pub const SERVER_NAME: &str = "prricode";
pub const SERVER_VERSION: &str = "0.1.0";

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Echo,
    External,
    Local,
    Ollama,
    OpenRouter,
    Kilo,
}

impl ProviderId {
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

#[derive(Debug, Implementation, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ApprovalMode {
    Closed,
    Open,
    Auto,
    Suggestive,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ReasoningEffort {
    None,
    Minimal,
    Low,
    Medium,
    High,
    XHigh,
    Max,
    Ultra,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Capability {
    UserShell,
    SessionMcp,
    SessionListStream,
    Feedback,
    ComputerUseSetup,
    ComputerUseHostSetup,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkflowChildAction {
    Skip,
    Retry,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComputerUseChoice {
    Ask,
    AlwaysAllow,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComputerUsePermission {
    Granted,
    Missing,
    Unknown,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComputerUseSetupPhase {
    Dormant,
    InProgress,
    RestartRequired,
    ReadyForTarget,
    Stopped,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SkillSource {
    Bundled,
    Imported,
    Project,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelCatalogSource {
    ProviderCatalog,
    FakeCatalog,
    UnresolvedCatalog,
    BundledCatalog,
    ConfigCatalog,
}
