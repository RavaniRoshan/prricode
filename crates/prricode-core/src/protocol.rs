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
}
