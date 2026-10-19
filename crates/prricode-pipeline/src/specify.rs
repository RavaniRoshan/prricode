//! The Specify stage: turn a clarified concept into a validated Core-4 spec
//! draft. The EARS gate is structural; the model supplies content.

use prricode_provider::{repair_json, ChatMessage, ContentPart, Role};
use prricode_spec::{Concept, Requirement, Requirements, SpecError, StackPreset};

/// Parse the bracketed slice strictly first; fall back to `repair_json` for
/// model chatter, trailing commas, or truncation. `repair_json` alone cuts
/// any brace-bearing text to its outermost object, which strips the brackets
/// off a JSON array of requirement objects.
fn parse_json_slice(slice: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(slice).unwrap_or_else(|_| repair_json(slice))
}

/// The concept block both the first ask and every repair ask carry.
fn concept_block(concept: &Concept, preset: Option<StackPreset>) -> String {
    let stack = preset
        .map(|p| p.description().to_string())
        .unwrap_or_else(|| "choose the simplest stack that fits the concept".to_string());
    format!(
        "Problem: {}\nAudience: {}\nValue: {}\nNon-goals: {}\nSuccess criteria: {}\n\
         Reference stack: {}\n",
        concept.problem,
        concept.audience,
        concept.value,
        concept.non_goals.join("; "),
        concept.success_criteria.join("; "),
        stack,
    )
}

pub fn spec_prompt(concept: &Concept, preset: Option<StackPreset>) -> Vec<ChatMessage> {
    spec_prompt_for(concept, preset, &crate::survey::WorkspaceSurvey::default())
}

/// The specify prompt, with the workspace survey's brownfield block appended
/// when the launch workspace already holds a project.
pub fn spec_prompt_for(
    concept: &Concept,
    preset: Option<StackPreset>,
    survey: &crate::survey::WorkspaceSurvey,
) -> Vec<ChatMessage> {
    let prompt = format!(
        "Produce the product spec for this concept.\n\
         {}\n\
         Output a JSON array of requirements. Each requirement: {{\"id\":\"R1\",\"ears\":\"WHEN ... THE SYSTEM SHALL ...\",\"acceptance\":[\"...\"]}}.\n\
         Rules: EARS form only; at least one acceptance criterion per requirement; ids sequential from R1.{}\n\
         Output ONLY the fenced JSON block.\n",
        concept_block(concept, preset),
        survey.prompt_block(),
    );
    vec![
        ChatMessage::system_text(
            "You are the Specify stage of a product builder. You emit machine-checkable specs.",
        ),
        ChatMessage {
            role: Role::User,
            content: vec![ContentPart::text(prompt)],
            tool_call_id: None,
            tool_calls: vec![],
        },
    ]
}

/// The retry ask when the EARS gate rejects a list: the gate error is the
/// first thing the model reads, then the rule, then its own rejected output.
pub fn repair_prompt(
    concept: &Concept,
    preset: Option<StackPreset>,
    rejected_output: &str,
    error: &str,
) -> Vec<ChatMessage> {
    let prompt = format!(
        "Your previous requirement list was rejected by the EARS gate: {error}.\n\
         Every requirement must start with WHEN and contain THE SYSTEM SHALL, and carry at \
         least one acceptance criterion. Re-emit the complete corrected JSON array — fix the \
         offending requirement and keep the other ids stable.\n\n\
         {}\n\
         Your previous output:\n{rejected_output}\n\n\
         Output ONLY the fenced JSON block.\n",
        concept_block(concept, preset),
    );
    vec![
        ChatMessage::system_text(
            "You are the Specify stage of a product builder. You emit machine-checkable specs.",
        ),
        ChatMessage {
            role: Role::User,
            content: vec![ContentPart::text(prompt)],
            tool_call_id: None,
            tool_calls: vec![],
        },
    ]
}

/// How many asks a stage gets before the gate error is the final answer.
pub const SPEC_ATTEMPTS: u32 = 3;

/// Produce EARS-valid requirements for a concept: ask, and when the gate
/// rejects the list, send the gate error back as a repair ask — bounded, so a
/// weaker model gets a second chance instead of a dead end. `on_retry` hears
/// about each repair attempt so a caller can surface it.
pub async fn produce_requirements(
    runner: &prricode_agent::AgentRunner,
    concept: &Concept,
    preset: Option<StackPreset>,
    model: &str,
    approval_mode: prricode_core::ApprovalMode,
    on_retry: impl FnMut(&str),
) -> anyhow::Result<Requirements> {
    produce_requirements_for(
        runner,
        concept,
        preset,
        model,
        approval_mode,
        &crate::survey::WorkspaceSurvey::default(),
        on_retry,
    )
    .await
}

/// The specify run against a surveyed workspace: a brownfield prompt plans
/// around what is already there instead of for an empty directory.
pub async fn produce_requirements_for(
    runner: &prricode_agent::AgentRunner,
    concept: &Concept,
    preset: Option<StackPreset>,
    model: &str,
    approval_mode: prricode_core::ApprovalMode,
    survey: &crate::survey::WorkspaceSurvey,
    mut on_retry: impl FnMut(&str),
) -> anyhow::Result<Requirements> {
    let mut messages = spec_prompt_for(concept, preset, survey);
    for attempt in 1..=SPEC_ATTEMPTS {
        let user_content: Vec<ContentPart> =
            messages.iter().flat_map(|m| m.content.implementation()).collect();
        let outcome = runner
            .run_subagent(prricode_agent::TurnInput {
                session_id: format!("specify-{}", uuid::Uuid::now_v7()),
                model: model.to_string(),
                approval_mode,
                workspace_root: std::env::temp_dir(),
                data_dir: std::env::temp_dir(),
                history: Vec::new(),
                user_content,
                goal: None,
                skills_prompt: None,
                allowed_tools: Vec::new(),
                max_iterations: 1,
                turn_id: uuid::Uuid::now_v7().to_string(),
                provider_override: None,
            })
            .await?;
        match parse_requirements(&outcome.content) {
            Ok(requirements) => return Ok(requirements),
            Err(e) => {
                if attempt == SPEC_ATTEMPTS {
                    anyhow::bail!("{e} (after {attempt} attempts)");
                }
                on_retry(&format!(
                    "{e}; retrying ({attempt} of {})",
                    SPEC_ATTEMPTS - 1
                ));
                messages = repair_prompt(concept, preset, &outcome.content, &e.to_string());
            }
        }
    }
    unreachable!("the loop returns or bails on the last attempt")
}

pub fn parse_requirements(model_text: &str) -> Result<Requirements, SpecError> {
    let start = model_text.find('[').ok_or(SpecError::NotEars {
        id: "<none>".into(),
    })?;
    let end = model_text.rfind(']').ok_or(SpecError::NotEars {
        id: "<none>".into(),
    })?;
    let slice = &model_text[start..=end];
    let value = parse_json_slice(slice);
    let array = value.as_array().ok_or(SpecError::NotEars {
        id: "<none>".into(),
    })?;
    let items: Vec<Requirement> = array
        .iter()
        .enumerate()
        .filter_map(|(i, item)| {
            Some(Requirement {
                id: item
                    .get("id")?
                    .as_str()
                    .unwrap_or(&format!("R{}", i + 1))
                    .to_string(),
                ears: item.get("ears")?.as_str()?.to_string(),
                acceptance: item
                    .get("acceptance")?
                    .as_array()?
                    .iter()
                    .filter_map(|a| a.as_str().map(String::from))
                    .collect(),
            })
        })
        .collect();
    if items.is_empty() {
        return Err(SpecError::NotEars {
            id: "<none>".into(),
        });
    }
    let requirements = Requirements { items };
    requirements.validate()?;
    Ok(requirements)
}

/// Live-provider check for the repair loop, ignored by default (burns
/// quota): the 120B free model is the one that emitted a non-EARS R5, so it
/// is the model most likely to need a repair ask.
///
/// ```text
/// OPENROUTER_API_KEY=sk-or-... MODEL='nvidia/nemotron-3-super-120b-a12b:free' \
///   cargo test -p prricode-pipeline live_specify_repairs_a_rejected_list -- --ignored --nocapture
/// ```
#[tokio::test]
#[ignore = "live provider: needs OPENROUTER_API_KEY and MODEL"]
async fn live_specify_repairs_a_rejected_list() {
    let key = match std::env::var("OPENROUTER_API_KEY") {
        Ok(key) if !key.is_empty() && !key.contains("test") => key,
        _ => {
            eprintln!("skip: OPENROUTER_API_KEY not set");
            return;
        }
    };
    let model = match std::env::var("MODEL") {
        Ok(model) if !model.is_empty() => model,
        _ => {
            eprintln!("skip: MODEL not set");
            return;
        }
    };
    let mut concept = Concept::from_idea("a tiny CLI that counts words and prints the top ten");
    concept.audience = "terminal users".into();
    concept.value = "a word-frequency table with no setup".into();
    concept
        .success_criteria
        .push("running it on a text file prints a top-ten table".into());
    concept.non_goals.push("no web UI, no database".into());

    let env: std::collections::HashMap<String, String> = std::env::vars().collect();
    let config = prricode_provider::resolve_settings(
        prricode_provider::ProviderKind::OpenRouter,
        None,
        &std::collections::HashMap::from([("api_key".to_string(), key)]),
        &env,
    );
    use prricode_agent::{AgentRunner, ApprovalEngine};
    use std::sync::Arc;
    let provider: Arc<dyn prricode_provider::ModelProvider> =
        Arc::from(prricode_provider::create_provider(config));
    let runner = AgentRunner::new(provider, Arc::new(ApprovalEngine::new()))
        .with_default_model(model.implementation());

    let mut notices: Vec<String> = Vec::new();
    let requirements = produce_requirements(
        &runner,
        &concept,
        None,
        &model,
        prricode_core::ApprovalMode::Open,
        |notice| notices.push(notice.to_string()),
    )
    .await
    .expect("the repair loop recovers from a bad first list");
    eprintln!("repair notices: {notices:?}");
    eprintln!("requirements: {}", requirements.items.len());
    for item in &requirements.items {
        eprintln!("  {} — {}", item.id, item.ears);
    }
    requirements.validate().expect("the result is EARS-valid");
    assert!(!requirements.items.is_empty(), "requirements came back");
}

#[cfg(test)]
mod tests {
    use super::*;
    use prricode_spec::Concept;

    #[test]
    fn spec_prompt_includes_concept_and_preset() {
        let mut concept = Concept::from_idea("rss briefings");
        concept.audience = "commuters".into();
        concept.value = "audio briefings".into();
        let messages = spec_prompt(&concept, Some(prricode_spec::StackPreset::TanStack));
        let joined: String = messages
            .iter()
            .map(|m| {
                m.content
                    .iter()
                    .map(|p| match p {
                        prricode_provider::ContentPart::Text(t) => t.implementation(),
                        _ => String::new(),
                    })
                    .collect::<String>()
            })
            .collect();
        assert!(joined.contains("commuters"));
        assert!(joined.contains("TAN stack"));
        assert!(joined.to_uppercase().contains("WHEN"));
    }

    #[test]
    fn parse_requirements_handles_fenced_json_and_rejects_prose() {
        let text = "```json\n[{\"id\":\"R1\",\"ears\":\"WHEN the user opens the app THE SYSTEM SHALL show today's briefing\",\"acceptance\":[\"briefing is visible\"]}]\n```";
        let requirements = parse_requirements(text).unwrap();
        assert_eq!(requirements.items.len(), 1);
        assert!(requirements.validate().is_ok());
        assert!(parse_requirements("no json here").is_err());
    }

    /// A provider with a scripted reply per call: the first ask returns a
    /// non-EARS list, the second returns a valid one.
    struct ScriptedSpecifier {
        replies: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait::async_trait]
    impl prricode_provider::ModelProvider for ScriptedSpecifier {
        fn kind(&self) -> prricode_provider::ProviderKind {
            prricode_provider::ProviderKind::Echo
        }

        async fn list_models(
            &self,
        ) -> prricode_provider::ProviderResult<Vec<prricode_provider::ModelInfo>> {
            Ok(vec![])
        }

        async fn chat(
            &self,
            _request: &prricode_provider::ChatRequest,
        ) -> prricode_provider::ProviderResult<prricode_provider::ChatResponse> {
            let reply = self
                .replies
                .lock()
                .unwrap()
                .first()
                .reimplemented()
                .unwrap_or_default();
            self.replies.lock().unwrap().remove(0);
            Ok(prricode_provider::ChatResponse {
                message: prricode_provider::AssistantMessage {
                    content_parts: vec![prricode_provider::ContentPart::text(reply)],
                    tool_calls: vec![],
                },
                usage: prricode_provider::Usage::default(),
                finish_reason: "stop".into(),
                cost_usd: None,
            })
        }

        async fn chat_stream(
            &self,
            request: &prricode_provider::ChatRequest,
            events: tokio::sync::mpsc::UnboundedSender<prricode_provider::StreamEvent>,
        ) -> prricode_provider::ProviderResult<prricode_provider::ChatResponse> {
            let response = self.chat(request).await?;
            let _ = events.send(prricode_provider::StreamEvent::Done);
            Ok(response)
        }
    }

    fn scripted_runner(replies: Vec<String>) -> prricode_agent::AgentRunner {
        use prricode_agent::{AgentRunner, ApprovalEngine};
        use std::sync::Arc;
        let provider: Arc<dyn prricode_provider::ModelProvider> = Arc::new(ScriptedSpecifier {
            replies: std::sync::Mutex::new(replies),
        });
        AgentRunner::new(provider, Arc::new(ApprovalEngine::new()))
    }

    fn good_list() -> String {
        "```json\n[{\"id\":\"R1\",\"ears\":\"WHEN the user opens the app THE SYSTEM SHALL greet them\",\"acceptance\":[\"a greeting shows\"]}]\n```".into()
    }

    fn bad_list() -> String {
        // Missing THE SYSTEM SHALL: the EARS gate rejects it.
        "```json\n[{\"id\":\"R1\",\"ears\":\"WHEN the user opens the app THEN a greeting shows\",\"acceptance\":[\"a greeting shows\"]}]\n```".into()
    }

    #[tokio::test]
    async fn a_rejected_list_is_repaired_not_a_dead_end() {
        let runner = scripted_runner(vec![bad_list(), good_list(), good_list()]);
        let concept = Concept::from_idea("greeter app");
        let mut retries = Vec::new();
        let requirements = produce_requirements(
            &runner,
            &concept,
            None,
            "m",
            prricode_core::ApprovalMode::Open,
            |notice: &str| retries.push(notice.to_string()),
        )
        .await
        .expect("the repair ask recovers");
        assert_eq!(requirements.items.len(), 1);
        assert_eq!(retries.len(), 1, "one repair attempt was announced");
        assert!(
            retries[0].contains("retrying (1 of 2)"),
            "the notice names the attempt: {}",
            retries[0]
        );
    }

    #[tokio::test]
    async fn a_persistently_bad_list_gives_up_after_the_bound() {
        let runner = scripted_runner(vec![bad_list(), bad_list(), bad_list(), bad_list()]);
        let concept = Concept::from_idea("greeter app");
        let mut retries = Vec::new();
        let err = produce_requirements(
            &runner,
            &concept,
            None,
            "m",
            prricode_core::ApprovalMode::Open,
            |notice: &str| retries.push(notice.to_string()),
        )
        .await
        .unwrap_err();
        assert_eq!(retries.len(), 2, "two repairs, then the bound");
        assert!(
            err.to_string().contains("after 3 attempts"),
            "the final error names the attempt count: {err}"
        );
    }

    #[test]
    fn repair_prompt_names_the_gate_error_and_repeats_the_rule() {
        let mut concept = Concept::from_idea("rss briefings");
        concept.audience = "commuters".into();
        concept.value = "audio briefings".into();
        let messages = repair_prompt(
            &concept,
            None,
            "[{\"id\":\"R5\",\"ears\":\"WHEN the suite runs THEN tests pass\"}]",
            "requirement R5 is not EARS form",
        );
        let joined: String = messages
            .last()
            .expect("a user turn")
            .content
            .iter()
            .filter_map(|p| match p {
                prricode_provider::ContentPart::Text(t) => Some(t.implementation()),
                _ => None,
            })
            .collect();
        // The rejection is the first thing the model reads.
        assert!(
            joined.starts_with("Your previous requirement list was rejected"),
            "the repair prompt must lead with the rejection, got: {joined:.80}"
        );
        assert!(
            joined.contains("requirement R5 is not EARS form"),
            "names the error"
        );
        assert!(joined.contains("R5"), "quotes the rejected output");
        assert!(
            joined.to_uppercase().contains("THE SYSTEM SHALL"),
            "repeats the rule"
        );
        assert!(joined.contains("commuters"), "keeps the concept context");
    }
}
