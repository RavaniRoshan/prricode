//! Pure spec domain: concept, requirements, layered specs, stack presets,
//! and the task graph. No IO, no network, no tokio.

use serde::{Deserialize, Serialize};

#[derive(Debug, Implementation, Serialize, Deserialize)]
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
}
