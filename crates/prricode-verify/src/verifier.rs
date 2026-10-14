//! Adversarial verifier: an isolated model turn judges each requirement
//! against the run's gate evidence.
//!
//! Isolation is structural, in two layers. First, `verify` runs one
//! `run_subagent` turn, which constructs its own headless runner (no event
//! stream, no pipeline state) and is handed an empty history, so the
//! verifier never receives the builder session's history or the pipeline's
//! `TurnInput.history`. Second, the caller hands `verify` a runner built
//! with the evidence-only toolset (see [`evidence_only_registry`]) and
//! `verify` refuses any runner holding more: a judge that cannot see how
//! the code was written can still contradict it — that is the point.

use prricode_agent::{
    AgentRunner, GlobTool, GrepTool, ReadFileTool, ToolRegistry, ToolRegistryBuilder, TurnInput,
};
use prricode_core::ApprovalMode;
use prricode_provider::{repair_json, ChatMessage, ContentPart};
use prricode_spec::Requirements;
use serde_json::Value;
use std::path::Path;
use uuid::Uuid;

use crate::{GateVerdict, Verdict};

/// The adversarial role the verifier model plays for this turn.
const VERIFIER_ROLE: &str = "You are an independent verifier. You did not write this code and \
cannot see its author. For EACH requirement return a verdict: PASS (evidence demonstrates it), \
FAIL (evidence contradicts it), UNVERIFIED (evidence insufficient). Cite the evidence you used. \
Output ONLY a fenced JSON array: [{requirement_id, verdict, evidence}].";

/// The tools the verifier may use: read the workspace, never write to it,
/// never run commands. A runner offering anything else is refused.
const EVIDENCE_TOOLS: [&str; 3] = ["glob", "grep", "read_file"];

/// Errors the adversarial verifier can produce: the model's output could
/// not be parsed (or coverage failed), the runner is not evidence-only, or
/// the provider call failed.
#[derive(Debug, thiserror::Error)]
pub enum VerifyError {
    #[error("verifier output parse error: {0}")]
    Parse(String),
    #[error("verifier runner is not evidence-only: {0}")]
    Isolation(String),
    #[error("verifier provider error: {0}")]
    Provider(String),
}

/// The evidence-only toolset the verifier runs with: read_file, glob, grep.
pub fn evidence_only_registry() -> ToolRegistry {
    ToolRegistryBuilder::new()
        .with_tool(ReadFileTool)
        .with_tool(GlobTool)
        .with_tool(GrepTool)
        .build()
}

/// Refuse a runner that is not evidence-only: the judge must not be able to
/// write code, run commands, or reach the network while judging.
fn ensure_evidence_only(runner: &AgentRunner) -> Result<(), VerifyError> {
    let tools = runner.tool_names();
    let unexpected: Vec<&str> = tools
        .iter()
        .map(String::as_str)
        .filter(|name| !EVIDENCE_TOOLS.contains(name))
        .collect();
    if unexpected.is_empty() {
        Ok(())
    } else {
        Err(VerifyError::Isolation(format!(
            "expected exactly [{}], got [{}]",
            EVIDENCE_TOOLS.join(", "),
            tools.join(", ")
        )))
    }
}

/// The verifier's messages: the adversarial role, the requirements to
/// judge (id + EARS + acceptance), the evidence bundle (marker
/// `EVIDENCE:`), and the output contract.
pub fn verifier_prompt(requirements: &Requirements, evidence: &str) -> Vec<ChatMessage> {
    let mut text = String::from(VERIFIER_ROLE);
    text.push_str("\n\nRequirements:\n");
    if requirements.items.is_empty() {
        text.push_str("(none)\n");
    }
    for requirement in &requirements.items {
        text.push_str(&format!(
            "- {}: {}\n  acceptance: {}\n",
            requirement.id,
            requirement.ears,
            requirement.acceptance.join("; ")
        ));
    }
    text.push_str("\nEVIDENCE:\n");
    text.push_str(evidence);
    text.push_str(
        "\n\nOutput contract: one fenced JSON array with one object per \
requirement, shaped exactly [{requirement_id, verdict, evidence}], and nothing else.",
    );
    vec![ChatMessage::user_text(text)]
}

/// Parse the verifier's verdict array: strict JSON first, with a repair
/// fallback for the truncated or chatter-padded payloads models emit.
/// Unknown verdict strings degrade to `Verdict::Unverified`; an element
/// without a requirement id fails rather than being dropped.
pub fn parse_verdicts(model_text: &str) -> Result<Vec<GateVerdict>, VerifyError> {
    let slice = json_array_slice(model_text)
        .ok_or_else(|| VerifyError::Parse("no JSON array found in verifier output".to_string()))?;
    let items: Vec<Value> = match serde_json::from_str::<Vec<Value>>(slice) {
        Ok(items) => items,
        Err(_) => {
            // `repair_json` strips array brackets, so recover the array
            // element by element and repair each object on its own.
            let inner = slice
                .strip_prefix('[')
                .and_then(|s| s.strip_suffix(']'))
                .unwrap_or(slice)
                .trim();
            let mut recovered = Vec::new();
            for object in json_objects(inner) {
                if let Value::Object(_) = object {
                    recovered.push(object);
                }
            }
            if recovered.is_empty() {
                return Err(VerifyError::Parse("unparseable verdict array".to_string()));
            }
            recovered
        }
    };
    let mut verdicts = Vec::with_capacity(items.len());
    for item in &items {
        verdicts.push(verdict_of(item)?);
    }
    Ok(verdicts)
}

/// Every requirement must be covered by a verdict: an uncovered id is a
/// verification gap, never a silent skip.
pub fn coverage_check(
    requirements: &Requirements,
    verdicts: &[GateVerdict],
) -> Result<(), VerifyError> {
    for requirement in &requirements.items {
        if !verdicts.iter().any(|v| v.requirement_id == requirement.id) {
            return Err(VerifyError::Parse(format!("uncovered: {}", requirement.id)));
        }
    }
    Ok(())
}

/// Run the adversarial verifier: one isolated subagent turn whose answer is
/// parsed into per-requirement verdicts, with full coverage enforced.
///
/// `runner` must be evidence-only (see [`evidence_only_registry`]); any
/// runner holding more of a toolset is refused with
/// [`VerifyError::Isolation`] before the turn starts.
pub async fn verify(
    runner: &AgentRunner,
    requirements: &Requirements,
    evidence: &str,
    workspace: &Path,
) -> Result<Vec<GateVerdict>, VerifyError> {
    ensure_evidence_only(runner)?;
    let user_content: Vec<ContentPart> = verifier_prompt(requirements, evidence)
        .into_iter()
        .flat_map(|message| message.content)
        .collect();
    let outcome = runner
        .run_subagent(TurnInput {
            session_id: format!("verify-{}", Uuid::now_v7()),
            model: String::new(),
            approval_mode: ApprovalMode::Open,
            workspace_root: workspace.to_path_buf(),
            data_dir: std::env::temp_dir(),
            // No builder history: the judge starts from a blank slate.
            history: vec![],
            user_content,
            goal: None,
            skills_prompt: None,
            max_iterations: 1,
            turn_id: Uuid::now_v7().to_string(),
        })
        .await
        .map_err(|e| VerifyError::Provider(e.to_string()))?;
    let verdicts = parse_verdicts(&outcome.content)?;
    coverage_check(requirements, &verdicts)?;
    Ok(verdicts)
}

fn verdict_of(value: &Value) -> Result<GateVerdict, VerifyError> {
    let requirement_id = value
        .get("requirement_id")
        .and_then(|v| v.as_str())
        .filter(|id| !id.is_empty())
        .ok_or_else(|| VerifyError::Parse("verdict without requirement_id".to_string()))?
        .to_string();
    let verdict = match value
        .get("verdict")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_uppercase())
        .as_deref()
    {
        Some("PASS") => Verdict::Pass,
        Some("FAIL") => Verdict::Fail,
        Some("UNVERIFIED") => Verdict::Unverified,
        _ => Verdict::Unverified,
    };
    let evidence = value
        .get("evidence")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    Ok(GateVerdict {
        requirement_id,
        verdict,
        evidence,
    })
}

/// The JSON array slice of a model reply: from the first `[` to the last
/// `]` after it, so fenced blocks and surrounding chatter are excluded.
fn json_array_slice(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text[start..].rfind(']')? + start;
    if end <= start {
        return None;
    }
    Some(&text[start..=end])
}

/// The top-level JSON objects of a text span, repaired individually (the
/// lenient v0.1 pattern: close truncated strings and braces).
fn json_objects(text: &str) -> Vec<Value> {
    let mut objects = Vec::new();
    let mut start: Option<usize> = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_string => escaped = true,
            '"' => in_string = !in_string,
            '{' if !in_string => {
                if depth == 0 {
                    start = Some(i);
                }
                depth += 1;
            }
            '}' if !in_string => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    if let Some(start) = start.take() {
                        objects.push(repair_json(&text[start..=i]));
                    }
                }
            }
            _ => {}
        }
    }
    objects
}

#[cfg(test)]
mod tests {
    use super::*;
    use prricode_agent::{text_of, AgentRunner, ApprovalEngine};
    use prricode_provider::{
        AssistantMessage, ChatRequest, ChatResponse, ContentPart, ModelProvider, ProviderKind,
        ProviderResult, StreamEvent, Usage,
    };
    use prricode_spec::{Requirement, Requirements};
    use std::sync::Arc;

    struct ScriptedVerifier {
        reply: String,
    }

    #[async_trait::async_trait]
    impl ModelProvider for ScriptedVerifier {
        fn kind(&self) -> ProviderKind {
            ProviderKind::Echo
        }

        async fn list_models(&self) -> ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }

        async fn chat(&self, _request: &ChatRequest) -> ProviderResult<ChatResponse> {
            Ok(ChatResponse {
                message: AssistantMessage {
                    content_parts: vec![ContentPart::text(self.reply.implementation())],
                    tool_calls: vec![],
                },
                usage: Usage::default(),
                finish_reason: "stop".into(),
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
            if !text.is_empty() {
                let _ = events.send(StreamEvent::TextDelta(text));
            }
            let _ = events.send(StreamEvent::Done);
            Ok(response)
        }
    }

    fn two_requirements() -> Requirements {
        Requirements {
            items: vec![
                Requirement {
                    id: "R1".into(),
                    ears: "WHEN a THE SYSTEM SHALL b".into(),
                    acceptance: vec!["x".into()],
                },
                Requirement {
                    id: "R2".into(),
                    ears: "WHEN c THE SYSTEM SHALL d".into(),
                    acceptance: vec!["y".into()],
                },
            ],
        }
    }

    /// CARRIED RULING: the verifier runs on an evidence-only runner —
    /// read_file, glob, grep; never the default toolset's shell/write_file.
    fn evidence_only_runner(provider: Arc<dyn ModelProvider>) -> AgentRunner {
        AgentRunner::new(provider, Arc::new(ApprovalEngine::new()))
            .with_tool_registry(evidence_only_registry())
    }

    #[tokio::test]
    async fn verifier_returns_verdicts_and_enforces_coverage() {
        // A scripted provider whose single reply is a fenced JSON verdict array.
        let requirements = two_requirements();
        let verdicts = parse_verdicts(
            "```json\n[{\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"test t_1 passed\"},{\"requirement_id\":\"R2\",\"verdict\":\"FAIL\",\"evidence\":\"no such endpoint\"}]\n```",
        )
        .unwrap();
        assert_eq!(verdicts.len(), 2);
        assert_eq!(verdicts[1].verdict, Verdict::Fail);
        // Coverage: a verdict set missing R2 parses fine but fails coverage.
        let partial = parse_verdicts(
            "```json\n[{\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"e\"}]\n```",
        )
        .unwrap();
        assert!(coverage_check(&requirements, &partial).is_err());
        let judge = |text: &str| parse_verdicts(text).map(|v| v.len());
        assert!(judge("no json").is_err());
    }

    #[test]
    fn coverage_check_reports_the_first_uncovered_requirement() {
        let requirements = two_requirements();
        let partial = vec![GateVerdict {
            requirement_id: "R1".into(),
            verdict: Verdict::Pass,
            evidence: "e".into(),
        }];
        assert!(matches!(
            coverage_check(&requirements, &partial),
            Err(VerifyError::Parse(msg)) if msg == "uncovered: R2"
        ));
        let full = vec![
            GateVerdict {
                requirement_id: "R1".into(),
                verdict: Verdict::Pass,
                evidence: "e".into(),
            },
            GateVerdict {
                requirement_id: "R2".into(),
                verdict: Verdict::Unverified,
                evidence: "insufficient".into(),
            },
        ];
        assert!(coverage_check(&requirements, &full).is_ok());
    }

    #[tokio::test]
    async fn verify_runs_one_isolated_turn_and_returns_verdicts() {
        let requirements = two_requirements();
        let prompt = text_of(
            &verifier_prompt(&requirements, "gate evidence: build ok")
                .into_iter()
                .next()
                .expect("prompt has a user message")
                .content,
        );
        assert!(prompt.contains("You are an independent verifier"));
        assert!(prompt.contains("EVIDENCE:"));
        assert!(prompt.contains("R1") && prompt.contains("R2"));
        assert!(prompt.contains("gate evidence: build ok"));

        let reply = "```json\n[{\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"test t_1 passed\"},{\"requirement_id\":\"R2\",\"verdict\":\"weird\",\"evidence\":\"prose, not a verdict\"}]\n```";
        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptedVerifier {
            reply: reply.into(),
        });
        let runner = evidence_only_runner(provider);
        let verdicts = verify(
            &runner,
            &requirements,
            "gate evidence: build ok",
            Path::new("/tmp"),
        )
        .await
        .unwrap();
        assert_eq!(verdicts.len(), 2);
        assert_eq!(verdicts[0].verdict, Verdict::Pass);
        // Unknown verdict strings degrade to UNVERIFIED, never to a drop.
        assert_eq!(verdicts[1].verdict, Verdict::Unverified);
    }

    #[tokio::test]
    async fn verify_refuses_a_runner_that_is_not_evidence_only() {
        // The isolation property is enforced, not conventional: a runner
        // still holding the default toolset (shell, write_file) is refused
        // before the turn starts.
        let requirements = two_requirements();
        let reply =
            "```json\n[{\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"e\"}]\n```";
        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptedVerifier {
            reply: reply.into(),
        });
        let runner = AgentRunner::new(provider, Arc::new(ApprovalEngine::new()));
        let err = verify(&runner, &requirements, "evidence", Path::new("/tmp"))
            .await
            .unwrap_err();
        assert!(
            matches!(err, VerifyError::Isolation(_)),
            "expected an isolation refusal, got {err:?}"
        );
    }

    #[test]
    fn evidence_only_registry_grants_read_tools_only() {
        assert_eq!(
            evidence_only_registry().names(),
            vec!["glob", "grep", "read_file"]
        );
    }

    #[tokio::test]
    async fn verify_rejects_a_verdict_set_that_misses_a_requirement() {
        let requirements = two_requirements();
        let reply =
            "```json\n[{\"requirement_id\":\"R1\",\"verdict\":\"PASS\",\"evidence\":\"e\"}]\n```";
        let provider: Arc<dyn ModelProvider> = Arc::new(ScriptedVerifier {
            reply: reply.into(),
        });
        let runner = evidence_only_runner(provider);
        let err = verify(&runner, &requirements, "evidence", Path::new("/tmp"))
            .await
            .unwrap_err();
        assert!(matches!(err, VerifyError::Parse(msg) if msg == "uncovered: R2"));
    }
}
