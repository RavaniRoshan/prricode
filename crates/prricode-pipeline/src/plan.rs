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
}
