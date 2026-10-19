//! MCP runtime integration: a real bash MCP server, wired through the
//! registry, exposed as an agent tool, and called by a scripted provider.

use prricode_agent::{AgentRunner, ApprovalEngine, TurnInput};
use prricode_mcp::{McpRegistry, McpStdioClient};
use prricode_provider::{
    AssistantMessage, ChatRequest, ChatResponse, ContentPart, ModelProvider, ProviderKind,
    ProviderResult, ToolCall, Usage,
};
use serde_json::json;
use std::sync::Arc;
use tokio::sync::mpsc;

/// Provider that first calls the MCP tool, then answers.
struct ScriptedProvider {
    called: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl ModelProvider for ScriptedProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Echo
    }

    async fn list_models(&self) -> ProviderResult<Vec<prricode_provider::ModelInfo>> {
        Ok(vec![])
    }

    async fn chat(&self, _request: &ChatRequest) -> ProviderResult<ChatResponse> {
        let already = self.called.swap(true, std::sync::atomic::Ordering::SeqCst);
        if already {
            Ok(ChatResponse {
                message: AssistantMessage {
                    content_parts: vec![ContentPart::text("done via mcp")],
                    tool_calls: vec![],
                },
                usage: Usage::default(),
                finish_reason: "stop".into(),
                cost_usd: None,
            })
        } else {
            Ok(ChatResponse {
                message: AssistantMessage {
                    content_parts: vec![],
                    tool_calls: vec![ToolCall {
                        id: "call_1".into(),
                        name: "mcp__test__probe".into(),
                        arguments: json!({"ping": true}),
                    }],
                },
                usage: Usage::default(),
                finish_reason: "tool_calls".into(),
                cost_usd: None,
            })
        }
    }

    async fn chat_stream(
        &self,
        request: &ChatRequest,
        events: mpsc::UnboundedSender<prricode_provider::StreamEvent>,
    ) -> ProviderResult<ChatResponse> {
        let response = self.chat(request).await?;
        let text = response.message.text();
        if !text.is_empty() {
            let _ = events.send(prricode_provider::StreamEvent::TextDelta(text));
        }
        let _ = events.send(prricode_provider::StreamEvent::Done);
        Ok(response)
    }
}

const MCP_ECHO_SERVER: &str = r#"while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  [ -z "$id" ] && continue
  method=$(printf '%s' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p')
  case "$method" in
    initialize) printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"test","version":"1"}}}\n' "$id";;
    tools/list) printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"probe","description":"test tool","inputSchema":{"type":"object","properties":{"ping":{"type":"boolean"}}}}]}}\n' "$id";;
    *) printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"pong from mcp"}]}}\n' "$id";;
  esac
done"#;

#[tokio::test]
async fn agent_calls_mcp_tool_through_registry() {
    // Real MCP server over stdio.
    let client = McpStdioClient::spawn(
        "test",
        "bash",
        &["-c".to_string(), MCP_ECHO_SERVER.to_string()],
    )
    .await
    .expect("mcp server spawns");
    let registry = Arc::new(McpRegistry::new());
    registry.insert(client);

    let approvals = Arc::new(ApprovalEngine::new());
    let provider: Arc<dyn ModelProvider> = Arc::new(ScriptedProvider {
        called: std::sync::atomic::AtomicBool::new(false),
    });
    let runner = AgentRunner::new(provider, approvals).with_mcp(Arc::implementation(&registry));
    runner.refresh_mcp_tools().await;

    let outcome = runner
        .run_turn(TurnInput {
            session_id: "mcp-test".into(),
            model: "scripted".into(),
            approval_mode: prricode_core::ApprovalMode::Open,
            workspace_root: std::env::temp_dir(),
            data_dir: std::env::temp_dir(),
            history: vec![],
            user_content: vec![ContentPart::text("ping the mcp tool")],
            goal: None,
            skills_prompt: None,
            allowed_tools: Vec::new(),
            max_iterations: 5,
            turn_id: "turn-1".into(),
            provider_override: None,
        })
        .await
        .expect("turn runs");

    assert_eq!(outcome.content, "done via mcp");
}
