//! The Plan stage: requirements become a dependency-ordered, wave-scheduled
//! task graph. The traceability gate blocks plans that leave a requirement
//! uncovered.

use prricode_provider::{repair_json, ChatMessage, ContentPart, Role};
use prricode_spec::{Requirements, SpecError, TaskGraph, TaskNode};

pub fn plan_prompt(requirements: &Requirements) -> Vec<ChatMessage> {
    plan_prompt_for(requirements, &crate::survey::WorkspaceSurvey::default())
}

/// The plan prompt, with the workspace survey's brownfield block appended when
/// the launch workspace already holds a project.
pub fn plan_prompt_for(
    requirements: &Requirements,
    survey: &crate::survey::WorkspaceSurvey,
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
    // A brownfield workspace must not be scaffolded over: its first task
    // reads and preserves what is there.
    let first_task_rule = if survey.is_brownfield() {
        "the first task reads the existing project and preserves it — never scaffold a second one"
    } else {
        "the first task scaffolds the project"
    };
    let prompt = format!(
        "Turn these requirements into a task graph.\n{}\n\n\
         Output a fenced JSON array of tasks. Each task: {{\"id\":\"scaffold\",\"label\":\"Scaffold\",\"prompt\":\"...\",\"depends_on\":[],\"requirement_id\":\"R1\",\"files\":[\"…\"]}}.
\
         Rules: at least one task per requirement (requirement_id traces it); ids are short slugs; \
         depends_on references earlier task ids only; {first_task_rule}; \
         every task names the files it edits in \"files\" — workspace-relative, and they must already exist.
\
         Output ONLY the fenced JSON block.",
        list.join("\n"),
    );
    let prompt = format!("{prompt}{}", survey.prompt_block());
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

/// In an existing project, every task must edit a file that is really there.
/// A task that names nothing builds its own world beside the real one, which
/// is the classic brownfield failure. Greenfield is unconstrained.
pub fn validate_reuse(
    graph: &TaskGraph,
    survey: &crate::survey::WorkspaceSurvey,
) -> Result<(), SpecError> {
    if !survey.is_brownfield() {
        return Ok(());
    }
    for node in &graph.nodes {
        if node.files.is_empty() {
            return Err(SpecError::Uncovered {
                id: format!("{} (names no files)", node.id),
            });
        }
        for file in &node.files {
            if !survey.workspace.join(file).exists() {
                return Err(SpecError::Uncovered {
                    id: format!("{} ({file} does not exist)", node.id),
                });
            }
        }
    }
    Ok(())
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
    on_retry: impl FnMut(&str),
) -> anyhow::Result<TaskGraph> {
    produce_task_graph_for(
        runner,
        requirements,
        model,
        approval_mode,
        &crate::survey::WorkspaceSurvey::default(),
        on_retry,
    )
    .await
}

/// The plan run against a surveyed workspace: its first task reads and
/// preserves the existing project instead of scaffolding a second one.
pub async fn produce_task_graph_for(
    runner: &prricode_agent::AgentRunner,
    requirements: &Requirements,
    model: &str,
    approval_mode: prricode_core::ApprovalMode,
    survey: &crate::survey::WorkspaceSurvey,
    mut on_retry: impl FnMut(&str),
) -> anyhow::Result<TaskGraph> {
    let mut messages = plan_prompt_for(requirements, survey);
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
                files: item
                    .get("files")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|f| f.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default(),
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

    #[test]
    fn a_brownfield_prompt_plans_around_what_is_there() {
        let reqs = reqs();
        let green = message_text(&plan_prompt(&reqs));
        let mut survey = crate::survey::WorkspaceSurvey::default();
        assert!(!survey.is_brownfield());

        // A workspace that already holds a project.
        let dir = std::env::temp_dir().join(format!("brown-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pyproject.toml"), "[project]\n").unwrap();
        std::fs::create_dir_all(dir.join("tests")).unwrap();
        std::fs::write(dir.join("tests/test_a.py"), "def test_x():\n    pass\n").unwrap();
        survey = crate::survey::survey(&dir);
        let brown = message_text(&plan_prompt_for(&reqs, &survey));

        assert!(green.contains("the first task scaffolds the project"));
        assert!(
            brown.contains("never scaffold a second one"),
            "a brownfield prompt must forbid scaffolding: {brown}"
        );
        assert!(brown.contains("Existing tests: 1"), "{brown}");
        assert_ne!(green, brown, "the prompts must differ");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// In an existing project a task that creates its own file is the classic
    /// brownfield failure: a second skeleton next to the first. Every task
    /// must name the files it edits, and those files must exist.
    #[test]
    fn a_brownfield_task_must_name_files_that_exist() {
        let dir = std::env::temp_dir().join(format!("reuse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("pyproject.toml"), "[project]\n").unwrap();
        std::fs::write(dir.join("src/app.py"), "def main():\n    pass\n").unwrap();
        let survey = crate::survey::survey(&dir);

        let mut graph = parse_task_graph(
            "```json\n[{\"id\":\"a\",\"label\":\"A\",\"prompt\":\"x\",\"depends_on\":[],\"requirement_id\":\"R1\",\"files\":[\"src/app.py\"]}]\n```",
        )
        .unwrap();
        assert!(
            validate_reuse(&graph, &survey).is_ok(),
            "an existing file is fine"
        );

        // A file that is not there is a planning error, not a runtime surprise.
        graph.nodes[0].files = vec!["src/does_not_exist.py".into()];
        let err = validate_reuse(&graph, &survey).unwrap_err();
        assert!(
            err.to_string().contains("src/does_not_exist.py"),
            "the missing file is named: {err}"
        );

        // A task that names nothing creates its own world.
        graph.nodes[0].files = Vec::new();
        let err = validate_reuse(&graph, &survey).unwrap_err();
        assert!(
            err.to_string().contains("names no files"),
            "the task is told to edit what is there: {err}"
        );

        // Greenfield has no such constraint.
        let green = crate::survey::WorkspaceSurvey::default();
        graph.nodes[0].files = Vec::new();
        assert!(validate_reuse(&graph, &green).is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_brownfield_prompt_names_the_files_the_task_should_edit() {
        let reqs = reqs();
        let mut survey = crate::survey::WorkspaceSurvey::default();
        assert!(!survey.is_brownfield());
        let dir = std::env::temp_dir().join(format!("reuse2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\n").unwrap();
        survey = crate::survey::survey(&dir);
        let text = message_text(&plan_prompt_for(&reqs, &survey));
        assert!(
            text.contains("Cargo.toml"),
            "the plan sees the project's real files: {text}"
        );
        assert!(
            text.contains("files") && text.contains("edit"),
            "each task is asked to name the files it edits: {text}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    fn message_text(messages: &[prricode_provider::ChatMessage]) -> String {
        messages
            .iter()
            .flat_map(|m| m.content.iter())
            .filter_map(|p| match p {
                prricode_provider::ContentPart::Text(t) => Some(t.clone()),
                _ => None,
            })
            .collect()
    }
}
