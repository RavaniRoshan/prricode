//! Pure spec domain: concept, requirements, layered specs, stack presets,
//! and the task graph. No IO, no network, no tokio.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Concept {
    pub problem: String,
    pub audience: String,
    pub value: String,
    pub non_goals: Vec<String>,
    pub success_criteria: Vec<String>,
    pub ambiguities: Vec<String>,
    pub stack: Option<StackChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackChoice {
    pub preset: Option<StackPreset>,
    pub custom: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Requirement {
    pub id: String,
    pub ears: String,
    pub acceptance: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Requirements {
    pub items: Vec<Requirement>,
}

impl Requirements {
    pub fn validate(&self) -> Result<(), SpecError> {
        for item in &self.items {
            let ears = item.ears.trim().to_uppercase();
            if !ears.starts_with("WHEN") || !ears.contains("THE SYSTEM SHALL") {
                return Err(SpecError::NotEars {
                    id: item.id.clone(),
                });
            }
            if item.acceptance.is_empty() {
                return Err(SpecError::NoAcceptance {
                    id: item.id.clone(),
                });
            }
        }
        Ok(())
    }

    pub fn traceability(&self) -> Vec<(String, usize)> {
        self.items
            .iter()
            .map(|item| (item.id.clone(), item.acceptance.len()))
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spec {
    pub concept: Concept,
    pub requirements: Requirements,
    pub design: String,
    pub tasks: String,
    pub version: u32,
}

const STALE_MARKER: &str = "\n\n[stale: requirements changed — regenerate]";

impl Spec {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concept_from_idea_extracts_shape() {
        let concept = Concept::from_idea(
            "a service that turns RSS feeds into podcast briefings for commuters",
        );
        assert!(!concept.problem.is_empty());
        assert!(!concept.audience.is_empty());
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
}
