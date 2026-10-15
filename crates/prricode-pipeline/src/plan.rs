//! The Plan stage: requirements become a dependency-ordered, wave-scheduled
//! task graph. The traceability gate blocks plans that leave a requirement
//! uncovered.

use prricode_provider::{repair_json, ChatMessage, ContentPart, Role};
use prricode_spec::{Requirements, SpecError, TaskGraph, TaskNode};

pub fn plan_prompt(requirements: &Requirements) -> Vec<ChatMessage> {
    let list: Vec<String> = requirements
        .items
        .iter()
        .map(|r| {
            format!(
                "{}: {} (acceptance: {})",
                r.id,
                r.ears,
                r.acceptance.join("; ")
            )
        })
        .collect();
    let prompt = format!(
        "Turn these requirements into a task graph.\n{}\n\n\
         Output a fenced JSON array of tasks. Each task: {{\"id\":\"scaffold\",\"label\":\"Scaffold\",\"prompt\":\"...\",\"depends_on\":[],\"requirement_id\":\"R1\"}}.\n\
         Rules: at least one task per requirement (requirement_id traces it); ids are short slugs; \
         depends_on references earlier task ids only; the first task scaffolds the project.\n\
         Output ONLY the fenced JSON block.",
        list.join("\n"),
    );
    vec![
        ChatMessage::system_text(
            "You are the Plan stage of a product builder. You emit dependency-ordered task graphs.",
        ),
        ChatMessage {
            role: Role::User,
            content: vec![ContentPart::text(prompt)],
            tool_call_id: None,
            tool_calls: vec![],
        },
    ]
}

/// The retry ask when the traceability gate rejects a graph: the gap is the
/// first thing the model reads, then the rule, then its own rejected output.
pub fn repair_prompt(
    requirements: &Requirements,
    rejected_output: &str,
    error: &str,
) -> Vec<ChatMessage> {
    let list: Vec<String> = requirements
        .items
        .iter()
        .map(|r| {
            format!(
                "{}: {} (acceptance: {})",
                r.id,
                r.ears,
                r.acceptance.join("; ")
            )
        })
        .collect();
    let prompt = format!(
        "Your previous task graph was rejected by the traceability gate: {error}.\n\
         Every requirement needs at least one task whose requirement_id points at it. \
         Re-emit the complete corrected JSON array, keeping task ids and depends_on stable \
         and adding the tasks that cover the gap.\n\n\
         Requirements:\n{}\n\n\
         Your previous output:\n{rejected_output}\n\n\
         Output ONLY the fenced JSON block.\n",
        list.join("\n"),
    );
    vec![
        ChatMessage::system_text(
            "You are the Plan stage of a product builder. You emit dependency-ordered task graphs.",
        ),
        ChatMessage {
            role: Role::User,
            content: vec![ContentPart::text(prompt)],
            tool_call_id: None,
            tool_calls: vec![],
        },
    ]
}

/// How many asks the plan stage gets before the gate error is final.
pub const PLAN_ATTEMPTS: u32 = 3;

/// Produce a traceability-valid task graph: ask, and when the traceability
/// gate (or the JSON parse) rejects it, send the gate error back as a repair
/// ask — bounded. `on_retry` hears about each repair attempt.
pub async fn produce_task_graph(
    runner: &prricode_agent::AgentRunner,
    requirements: &Requirements,
    model: &str,
    approval_mode: prricode_core::ApprovalMode,
    mut on_retry: impl FnMut(&str),
) -> anyhow::Result<TaskGraph> {
    let mut messages = plan_prompt(requirements);
    for attempt in 1..=PLAN_ATTEMPTS {
        let user_content: Vec<ContentPart> =
            messages.iter().flat_map(|m| m.content.clone()).collect();
        let outcome = runner
            .run_subagent(prricode_agent::TurnInput {
                session_id: format!("plan-{}", uuid::Uuid::now_v7()),
                model: model.to_string(),
                approval_mode,
                workspace_root: std::env::temp_dir(),
                data_dir: std::env::temp_dir(),
                history: Vec::new(),
                user_content,
                goal: None,
                skills_prompt: None,
                max_iterations: 1,
                turn_id: uuid::Uuid::now_v7().to_string(),
            })
            .await?;
        let graph = match parse_task_graph(&outcome.content) {
            Ok(graph) => graph,
            Err(e) => {
                if attempt == PLAN_ATTEMPTS {
                    anyhow::bail!("{e} (after {attempt} attempts)");
                }
                on_retry(&format!(
                    "did not parse: {e}; retrying ({attempt} of {})",
                    PLAN_ATTEMPTS - 1
                ));
                messages = repair_prompt(requirements, &outcome.content, &e.to_string());
                continue;
            }
        };
        match validate_traceability(&graph, requirements) {
            Ok(()) => return Ok(graph),
            Err(e) => {
                if attempt == PLAN_ATTEMPTS {
                    anyhow::bail!("{e} (after {attempt} attempts)");
                }
                on_retry(&format!(
                    "{e}; retrying ({attempt} of {})",
                    PLAN_ATTEMPTS - 1
                ));
                messages = repair_prompt(requirements, &outcome.content, &e.to_string());
            }
        }
    }
    unreachable!("the loop returns or bails on the last attempt")
}

pub fn parse_task_graph(model_text: &str) -> Result<TaskGraph, SpecError> {
    let start = model_text.find('[').ok_or(SpecError::NotEars {
        id: "<none>".into(),
    })?;
    let end = model_text.rfind(']').ok_or(SpecError::NotEars {
        id: "<none>".into(),
    })?;
    let slice = &model_text[start..=end];
    let value =
        serde_json::from_str::<serde_json::Value>(slice).unwrap_or_else(|_| repair_json(slice));
    let array = value.as_array().ok_or(SpecError::NotEars {
        id: "<none>".into(),
    })?;
    let nodes: Vec<TaskNode> = array
        .iter()
        .filter_map(|item| {
            Some(TaskNode {
                id: item.get("id")?.as_str()?.to_string(),
                label: item
                    .get("label")
                    .and_then(|v| v.as_str())
                    .unwrap_or("task")
                    .to_string(),
                prompt: item.get("prompt")?.as_str()?.to_string(),
                depends_on: item
                    .get("depends_on")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|d| d.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
                requirement_id: item
                    .get("requirement_id")
                    .and_then(|v| v.as_str())
                    .map(String::from),
            })
        })
        .collect();
    if nodes.is_empty() {
        return Err(SpecError::NotEars {
            id: "<none>".into(),
        });
    }
    let graph = TaskGraph { nodes };
    graph.waves()?;
    Ok(graph)
}

pub fn validate_traceability(
    graph: &TaskGraph,
    requirements: &Requirements,
) -> Result<(), SpecError> {
    let covered = graph.traceability();
    for requirement in &requirements.items {
        if !covered.contains(&requirement.id) {
            return Err(SpecError::Uncovered {
                id: requirement.id.clone(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use prricode_spec::{Requirement, Requirements};

    fn reqs() -> Requirements {
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

    #[test]
    fn parse_task_graph_and_validate_traceability() {
        let text = "```json\n[{\"id\":\"scaffold\",\"label\":\"Scaffold\",\"prompt\":\"create the app\",\"depends_on\":[],\"requirement_id\":null},{\"id\":\"feature\",\"label\":\"Feature\",\"prompt\":\"build b\",\"depends_on\":[\"scaffold\"],\"requirement_id\":\"R1\"},{\"id\":\"feature2\",\"label\":\"Feature 2\",\"prompt\":\"build d\",\"depends_on\":[\"scaffold\"],\"requirement_id\":\"R2\"}]\n```";
        let graph = parse_task_graph(text).unwrap();
        assert_eq!(graph.waves().unwrap().len(), 2);
        assert!(validate_traceability(&graph, &reqs()).is_ok());

        let partial = "```json\n[{\"id\":\"only\",\"label\":\"Only\",\"prompt\":\"x\",\"depends_on\":[],\"requirement_id\":\"R1\"}]\n```";
        let graph = parse_task_graph(partial).unwrap();
        assert!(
            matches!(validate_traceability(&graph, &reqs()), Err(SpecError::Uncovered { id }) if id == "R2")
        );
    }

    #[test]
    fn repair_prompt_names_the_traceability_gap() {
        let messages = repair_prompt(
            &reqs(),
            "[{\"id\":\"only\",\"label\":\"Only\",\"prompt\":\"x\",\"depends_on\":[],\"requirement_id\":\"R1\"}]",
            "requirement R2 is not covered by any task",
        );
        let joined: String = messages
            .last()
            .expect("a user turn")
            .content
            .iter()
            .filter_map(|p| match p {
                prricode_provider::ContentPart::Text(t) => Some(t.clone()),
                _ => None,
            })
            .collect();
        assert!(
            joined.starts_with("Your previous task graph was rejected"),
            "the repair prompt must lead with the rejection, got: {joined:.80}"
        );
        assert!(
            joined.contains("requirement R2 is not covered"),
            "names the gap"
        );
        assert!(joined.contains("R2"), "quotes the rejected output");
        assert!(
            joined.contains("requirement_id"),
            "names the field that fixes coverage"
        );
    }
}
