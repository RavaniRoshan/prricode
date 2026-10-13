use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug)]
pub struct RpcError(pub JsonRpcError);

impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (code={})", self.0.message, self.0.code)
    }
}

impl std::error::Error for RpcError {}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub method: String,
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Option<serde_json::Value>,
    pub result: Option<serde_json::Value>,
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    pub params: Option<serde_json::Value>,
}

impl fmt::Display for JsonRpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} (code={})", self.message, self.code)
    }
}

impl std::error::Error for JsonRpcError {}

impl JsonRpcError {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: None,
        }
    }
    pub fn parse_error(msg: impl Into<String>) -> Self {
        Self::new(-32700, msg)
    }
    pub fn invalid_request(msg: impl Into<String>) -> Self {
        Self::new(-32600, msg)
    }
    pub fn method_not_found(msg: impl Into<String>) -> Self {
        Self::new(-32601, msg)
    }
    pub fn invalid_params(msg: impl Into<String>) -> Self {
        Self::new(-32602, msg)
    }
    pub fn internal_error(msg: impl Into<String>) -> Self {
        Self::new(-32603, msg)
    }
    pub fn capability_required(cap: &str) -> Self {
        let mut err = Self::new(-32010, format!("capability required: {cap}"));
        err.data = Some(serde_json::json!({ "capability": cap }));
        err
    }
    pub fn session_not_found() -> Self {
        Self::new(-32020, "session not found")
    }
    pub fn workflow_not_found() -> Self {
        Self::new(-32030, "workflow not found")
    }
    pub fn approval_not_found() -> Self {
        Self::new(-32040, "approval not found")
    }
    pub fn subagent_not_found() -> Self {
        Self::new(-32050, "subagent not found")
    }
    pub fn computer_use_unavailable() -> Self {
        Self::new(-32060, "computer use unavailable")
    }
    pub fn user_input_invalid() -> Self {
        Self::new(-32070, "user input invalid")
    }
    pub fn workspace_not_trusted() -> Self {
        Self::new(-32100, "workspace not trusted")
    }
    pub fn workspace_unknown() -> Self {
        Self::new(-32101, "workspace unknown")
    }
    pub fn workspace_mismatch() -> Self {
        Self::new(-32102, "workspace mismatch")
    }
    pub fn session_log_unavailable() -> Self {
        Self::new(-32103, "session log unavailable")
    }
    pub fn invalid_session_id() -> Self {
        Self::new(-32104, "invalid session id")
    }
    pub fn invalid_payload() -> Self {
        Self::new(-32105, "invalid payload")
    }
    pub fn command_id_conflict() -> Self {
        Self::new(-32106, "command id conflict")
    }
    pub fn unknown_method() -> Self {
        Self::new(-32107, "unknown method")
    }
    pub fn wrong_target() -> Self {
        Self::new(-32108, "wrong target")
    }
    pub fn role_denied() -> Self {
        Self::new(-32109, "role denied")
    }
    pub fn process_generation_retired() -> Self {
        Self::new(-32110, "process generation retired")
    }
    pub fn policy_denied() -> Self {
        Self::new(-32111, "policy denied")
    }
    pub fn root_capacity_exhausted() -> Self {
        Self::new(-32112, "root capacity exhausted")
    }
    pub fn invalid_model() -> Self {
        Self::new(-32113, "invalid model")
    }
    pub fn unsupported_provider() -> Self {
        Self::new(-32114, "unsupported provider")
    }
    pub fn validator_unavailable() -> Self {
        Self::new(-32115, "validator unavailable")
    }
    pub fn stale_attempt() -> Self {
        Self::new(-32116, "stale attempt")
    }
    pub fn already_processed() -> Self {
        Self::new(-32117, "already processed")
    }
    pub fn invalid_target() -> Self {
        Self::new(-32118, "invalid target")
    }
    pub fn run_active() -> Self {
        Self::new(-32119, "run active")
    }
    pub fn current_session_required() -> Self {
        Self::new(-32120, "current session required")
    }
    pub fn schema_invalid() -> Self {
        Self::new(-32121, "schema invalid")
    }
    pub fn skill_not_found() -> Self {
        Self::new(-32122, "skill not found")
    }
    pub fn media_not_found() -> Self {
        Self::new(-32123, "media not found")
    }
    pub fn approval_expired() -> Self {
        Self::new(-32124, "approval expired")
    }
}
