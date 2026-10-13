//! Web fetch tool: GET a URL and return readable text.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};

pub struct WebFetchTool {
    client: reqwest::Client,
}

impl Default for WebFetchTool {
    fn default() -> Self {
        Self {
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .user_agent("prricode/0.1.0")
                .build()
                .unwrap_or_default(),
        }
    }
}

#[async_trait]
impl Tool for WebFetchTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "web_fetch".to_string(),
            description:
                "Fetch a public URL and return its content as readable text (HTML is stripped)."
                    .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "max_chars": { "type": "integer", "default": 20000 }
                },
                "required": ["url"]
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, _ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let url = input
            .get("url")
            .and_then(|v| v.as_str())
            .ok_or_else(|| super::ToolError::InvalidInput("missing 'url'".into()))?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(super::ToolError::InvalidInput("url must be http(s)".into()));
        }
        let max_chars = input
            .get("max_chars")
            .and_then(|v| v.as_u64())
            .unwrap_or(20_000) as usize;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| super::ToolError::Execution(format!("fetch failed: {e}")))?;
        let status = response.status();
        if !status.is_success() {
            return Ok(ToolOutput::error(format!("http {status} for {url}")));
        }
        let body = response
            .text()
            .await
            .map_err(|e| super::ToolError::Execution(format!("read body failed: {e}")))?;
        let text = html_to_text(&body);
        let truncated: String = text.chars().take(max_chars).collect();
        Ok(ToolOutput::text(truncated))
    }
}

/// Crude HTML-to-text: drop scripts/styles/tags, collapse whitespace.
pub fn html_to_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        out.push_str(&rest[..start]);
        let after = &rest[start..];
        let lower = after.to_ascii_lowercase();
        let skip = if lower.starts_with("<script") || lower.starts_with("<style") {
            match lower.find("</script>").or_else(|| lower.find("</style>")) {
                Some(pos) => lower[pos..]
                    .find('>')
                    .map(|p| pos + p + 1)
                    .unwrap_or(after.len()),
                None => after.len(),
            }
        } else {
            after.find('>').map(|p| p + 1).unwrap_or(after.len())
        };
        rest = &after[skip.min(after.len())..];
        if skip == 0 {
            break;
        }
    }
    out.push_str(rest);
    let mut text = String::with_capacity(out.len());
    for line in out.lines() {
        let trimmed = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if !trimmed.is_empty() {
            text.push_str(&trimmed);
            text.push('\n');
        }
    }
    text
}
