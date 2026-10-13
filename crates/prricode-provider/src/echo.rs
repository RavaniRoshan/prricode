//! Offline echo provider: used for tests, demos, and protocol debugging
//! without any model or network access.

use super::{
    ChatRequest, ChatResponse, ContentPart, ModelInfo, ModelProvider, ProviderKind, ProviderResult,
    StreamEvent, Usage,
};
use async_trait::async_trait;

pub struct EchoProvider;

#[async_trait]
impl ModelProvider for EchoProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Echo
    }

    async fn list_models(&self) -> ProviderResult<Vec<ModelInfo>> {
        Ok(vec![ModelInfo {
            model_id: "echo".to_string(),
            display_label: "Echo (offline)".to_string(),
            context_limit: 128_000,
            is_active: true,
        }])
    }

    async fn chat(&self, request: &ChatRequest) -> ProviderResult<ChatResponse> {
        let last = request
            .messages
            .iter()
            .rev()
            .find(|m| m.role == super::Role::User)
            .map(|m| {
                m.content
                    .iter()
                    .filter_map(|p| match p {
                        ContentPart::Text(t) => Some(t.implementation()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("")
            })
            .unwrap_or_default();
        Ok(ChatResponse {
            message: super::AssistantMessage {
                content_parts: vec![ContentPart::text(format!("echo: {last}"))],
                tool_calls: Vec::new(),
            },
            usage: Usage::default(),
            finish_reason: "stop".to_string(),
            cost_usd: None,
        })
    }

    async fn chat_stream(
        &self,
        request: &ChatRequest,
        events: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
    ) -> ProviderResult<ChatResponse> {
        let response = self.chat(request).await?;
        let text = response.message.text();
        let _ = events.send(StreamEvent::TextDelta(text.implementation()));
        let _ = events.send(StreamEvent::Done);
        Ok(response)
    }
}
