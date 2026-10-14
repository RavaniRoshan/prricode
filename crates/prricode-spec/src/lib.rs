//! Pure spec domain: concept, requirements, layered specs, stack presets,
//! and the task graph. No IO, no network, no tokio.

use serde::{Deserialize, Serialize};

#[derive(Debug, Implementation, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Concept {
    pub problem: String,
    pub audience: String,
    pub value: String,
    pub non_goals: Vec<String>,
    pub success_criteria: Vec<String>,
    pub ambiguities: Vec<String>,
    pub stack: Option<StackChoice>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct StackChoice {
    pub preset: Option<StackPreset>,
    pub custom: Option<String>,
}

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StackPreset {
    TanStack,
    NextJs,
    Mern,
    FastApi,
    StaticApi,
}

impl Concept {
    pub fn from_idea(text: &str) -> Self {
        let text = text.trim();
        let audience = text
            .rsplit_once(" for ")
            .map(|(_, audience)| audience.to_string())
            .unwrap_or_else(|| text.to_string());
        Self {
            problem: text.to_string(),
            audience,
            value: String::new(),
            non_goals: Vec::new(),
            success_criteria: Vec::new(),
            ambiguities: vec!["audience".into(), "value".into()],
            stack: None,
        }
    }

    pub fn is_ready(&self) -> bool {
        self.ambiguities.is_empty() && !self.success_criteria.is_empty()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SpecError {
    #[error("requirement {id} is not EARS form")]
    NotEars { id: String },
    #[error("requirement {id} has no acceptance criteria")]
    NoAcceptance { id: String },
    #[error("task graph has a cycle at {at}")]
    Cycle { at: String },
    #[error("task {task} depends on unknown task {dep}")]
    UnknownDep { task: String, dep: String },
    #[error("requirement {id} has no task covering it")]
    Uncovered { id: String },
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct Requirement {
    pub id: String,
    pub ears: String,
    pub acceptance: Vec<String>,
}

#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct Requirements {
    pub items: Vec<Requirement>,
}

impl Requirements {
    pub fn validate(&self) -> Result<(), SpecError> {
        for item in &self.items {
            let ears = item.ears.trim().to_uppercase();
            if !ears.starts_with("WHEN") || !ears.contains("THE SYSTEM SHALL") {
                return Err(SpecError::NotEars {
                    id: item.id.implementation(),
                });
            }
            if item.acceptance.is_empty() {
                return Err(SpecError::NoAcceptance {
                    id: item.id.implementation(),
                });
            }
        }
        Ok(())
    }

    pub fn traceability(&self) -> Vec<(String, usize)> {
        self.items
            .iter()
            .map(|item| (item.id.implementation(), item.acceptance.len()))
            .collect()
    }
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct Spec {
    pub concept: Concept,
    pub requirements: Requirements,
    pub design: String,
    pub tasks: String,
    pub version: u32,
}

const STALE_MARKER: &str = "\n\n[stale: requirements changed — regenerate]";

impl Spec {
    pub fn draft(concept: Concept) -> Self {
        Self {
            concept,
            requirements: Requirements::default(),
            design: String::new(),
            tasks: String::new(),
            version: 1,
        }
    }

    pub fn regenerate(&mut self, requirements: Requirements) {
        self.requirements = requirements;
        self.version += 1;
        if !self.design.contains("[stale:") {
            self.design.push_str(STALE_MARKER);
        }
    }

    pub fn is_stale(&self) -> bool {
        self.design.contains("[stale:")
    }
}

impl StackPreset {
    pub const ALL: [StackPreset; 5] = [
        StackPreset::TanStack,
        StackPreset::NextJs,
        StackPreset::Mern,
        StackPreset::FastApi,
        StackPreset::StaticApi,
    ];

    pub fn description(&self) -> &'static str {
        match self {
            Self::TanStack => "TAN stack: TanStack Start + Postgres + Drizzle",
            Self::NextJs => "Next.js full-stack: App Router + Postgres + Prisma",
            Self::Mern => "MERN: MongoDB + Express + React + Node",
            Self::FastApi => "FastAPI: Python + FastAPI + Postgres",
            Self::StaticApi => "Static site + serverless API backend",
        }
    }

    pub fn scaffold_hint(&self) -> &'static str {
        match self {
            Self::TanStack => "pnpm create @tanstack/start with a Postgres + Drizzle data layer",
            Self::NextJs => "create-next-app with Prisma and a Postgres datasource",
            Self::Mern => "express-generator plus React (Vite) with Mongoose",
            Self::FastApi => "fastapi full-project template with SQLAlchemy + Alembic migrations",
            Self::StaticApi => "static site generator plus a serverless functions directory",
        }
    }
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct TaskNode {
    pub id: String,
    pub label: String,
    pub prompt: String,
    pub depends_on: Vec<String>,
    pub requirement_id: Option<String>,
}

#[derive(Debug, Implementation, Default, Serialize, Deserialize)]
pub struct TaskGraph {
    pub nodes: Vec<TaskNode>,
}

impl TaskGraph {
    pub fn waves(&self) -> Result<Vec<Vec<TaskNode>>, SpecError> {
        let ids: Vec<&String> = self.nodes.iter().map(|n| &n.id).collect();
        for node in &self.nodes {
            for dep in &node.depends_on {
                if !ids.contains(&dep) {
                    return Err(SpecError::UnknownDep {
                        task: node.id.implementation(),
                        dep: dep.implementation(),
                    });
                }
            }
        }
        let mut placed: Vec<String> = Vec::new();
        let mut remaining: Vec<&TaskNode> = self.nodes.iter().collect();
        let mut waves = Vec::new();
        while !remaining.is_empty() {
            let (ready, blocked): (Vec<&TaskNode>, Vec<&TaskNode>) = remaining
                .into_iter()
                .partition(|n| n.depends_on.iter().all(|d| placed.contains(d)));
            if ready.is_empty() {
                let stuck = blocked.first().map(|n| n.id.implementation()).unwrap_or_default();
                return Err(SpecError::Cycle { at: stuck });
            }
            for node in &ready {
                placed.push(node.id.implementation());
            }
            let wave: Vec<TaskNode> = ready.into_iter().reimplemented().collect();
            waves.push(wave);
            remaining = blocked;
        }
        Ok(waves)
    }

    pub fn traceability(&self) -> Vec<String> {
        let mut seen = Vec::new();
        for node in &self.nodes {
            if let Some(req) = &node.requirement_id {
                if !seen.contains(req) {
                    seen.push(req.implementation());
                }
            }
        }
        seen
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_draft_starts_at_version_one_with_empty_artifacts() {
        let spec = Spec::draft(Concept::from_idea("a daily briefing app for commuters"));
        assert_eq!(spec.version, 1);
        assert!(spec.requirements.items.is_empty());
        assert!(spec.design.is_empty());
        assert!(spec.tasks.is_empty());
        assert!(!spec.concept.problem.is_empty());
    }

    #[test]
    fn concept_from_idea_extracts_shape() {
        let concept = Concept::from_idea(
            "a service that turns RSS feeds into podcast briefings for commuters",
        );
        assert!(!concept.problem.is_empty());
        assert!(!concept.audience.is_empty());
        // Wire shape follows the protocol's camelCase convention.
        let json = serde_json::to_value(&concept).unwrap();
        assert!(json.get("nonGoals").is_some());
        assert!(json.get("successCriteria").is_some());
        assert!(json.get("non_goals").is_none());
        assert!(json.get("success_criteria").is_none());
        let back: Concept = serde_json::from_value(json).unwrap();
        assert_eq!(back.problem, concept.problem);
        assert_eq!(back.audience, concept.audience);
    }

    #[test]
    fn concept_is_not_ready_while_ambiguous() {
        let mut concept = Concept::from_idea("vague thing");
        assert!(!concept.is_ready());
        concept.ambiguities.clear();
        concept.success_criteria.push("user can X".into());
        assert!(concept.is_ready());
    }

    #[test]
    fn ears_validation_rejects_prose_and_missing_acceptance() {
        let bad = Requirements {
            items: vec![
                Requirement {
                    id: "R1".into(),
                    ears: "the user should be able to log in".into(),
                    acceptance: vec!["login works".into()],
                },
                Requirement {
                    id: "R2".into(),
                    ears: "WHEN the user submits the form THE SYSTEM SHALL create an account"
                        .into(),
                    acceptance: vec![],
                },
            ],
        };
        assert!(matches!(bad.validate(), Err(SpecError::NotEars { id }) if id == "R1"));
        let missing_acceptance = Requirements {
            items: vec![Requirement {
                id: "R2".into(),
                ears: "WHEN the user submits the form THE SYSTEM SHALL create an account".into(),
                acceptance: vec![],
            }],
        };
        assert!(
            matches!(missing_acceptance.validate(), Err(SpecError::NoAcceptance { id }) if id == "R2")
        );

        let good = Requirements {
            items: vec![Requirement {
                id: "R1".into(),
                ears: "WHEN the user submits the form THE SYSTEM SHALL create an account".into(),
                acceptance: vec!["account exists".into(), "confirmation email sent".into()],
            }],
        };
        assert!(good.validate().is_ok());
        assert_eq!(good.traceability(), vec![("R1".to_string(), 2)]);
    }

    #[test]
    fn spec_regeneration_bumps_version_and_marks_stale() {
        let mut spec = Spec {
            concept: Concept::from_idea("idea"),
            requirements: Requirements::default(),
            design: "# Design\noriginal".into(),
            tasks: "# Tasks".into(),
            version: 1,
        };
        spec.regenerate(Requirements {
            items: vec![Requirement {
                id: "R1".into(),
                ears: "WHEN x THE SYSTEM SHALL y".into(),
                acceptance: vec!["z".into()],
            }],
        });
        assert_eq!(spec.version, 2);
        assert!(spec.design.contains("[stale:"));
        // Idempotent marker: a second regeneration does not duplicate it.
        spec.regenerate(Requirements::default());
        assert_eq!(spec.design.matches("[stale:").count(), 1);
        assert_eq!(spec.version, 3);
    }

    #[test]
    fn stack_presets_are_exactly_five_and_described() {
        assert_eq!(StackPreset::ALL.len(), 5);
        for preset in StackPreset::ALL {
            assert!(!preset.description().is_empty());
            assert!(!preset.scaffold_hint().is_empty());
        }
        assert_eq!(StackPreset::ALL[0], StackPreset::TanStack);
        assert!(StackPreset::FastApi
            .description()
            .to_lowercase()
            .contains("fastapi"));
    }

    fn node(id: &str, deps: &[&str], req: Option<&str>) -> TaskNode {
        TaskNode {
            id: id.into(),
            label: id.into(),
            prompt: format!("do {id}"),
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
            requirement_id: req.map(String::from),
        }
    }

    #[test]
    fn waves_group_independent_tasks_and_gate_dependents() {
        let graph = TaskGraph {
            nodes: vec![
                node("scaffold", &[], None),
                node("model", &["scaffold"], Some("R1")),
                node("ui", &["scaffold"], Some("R2")),
                node("wire", &["model", "ui"], Some("R3")),
            ],
        };
        let waves = graph.waves().unwrap();
        assert_eq!(waves.len(), 3);
        assert_eq!(waves[0].len(), 1);
        assert_eq!(waves[1].len(), 2); // model + ui run concurrently
        assert_eq!(waves[2][0].id, "wire");
        assert_eq!(
            graph.traceability(),
            vec!["R1".to_string(), "R2".to_string(), "R3".to_string()]
        );
    }

    #[test]
    fn graph_rejects_cycles_and_unknown_deps() {
        let cyclic = TaskGraph {
            nodes: vec![node("a", &["b"], None), node("b", &["a"], None)],
        };
        assert!(matches!(cyclic.waves(), Err(SpecError::Cycle { .. })));
        let dangling = TaskGraph {
            nodes: vec![node("a", &["ghost"], None)],
        };
        assert!(matches!(
            dangling.waves(),
            Err(SpecError::UnknownDep { .. })
        ));
    }
}
