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

pub fn spec_prompt(concept: &Concept, preset: Option<StackPreset>) -> Vec<ChatMessage> {
    let stack = preset
        .map(|p| p.description().to_string())
        .unwrap_or_else(|| "choose the simplest stack that fits the concept".to_string());
    let mut prompt = format!(
        "Produce the product spec for this concept.\n\
         Problem: {}\nAudience: {}\nValue: {}\nNon-goals: {}\nSuccess criteria: {}\n\
         Reference stack: {}\n\n\
         Output a JSON array of requirements. Each requirement: {{\"id\":\"R1\",\"ears\":\"WHEN ... THE SYSTEM SHALL ...\",\"acceptance\":[\"...\"]}}.\n\
         Rules: EARS form only; at least one acceptance criterion per requirement; ids sequential from R1.\n\
         Output ONLY the fenced JSON block.",
        concept.problem,
        concept.audience,
        concept.value,
        concept.non_goals.join("; "),
        concept.success_criteria.join("; "),
        stack,
    );
    prompt.push('\n');
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
}
