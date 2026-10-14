//! The Clarify stage: a one-question-at-a-time interview that empties the
//! concept's ambiguity markers.

use prricode_spec::Concept;

pub struct Clarifier {
    pub concept: Concept,
}

const QUESTIONS: &[(&str, &str)] = &[
    ("Who is the primary user of this product?", "audience"),
    ("What is the core value they get?", "value"),
    ("What single success criterion says it works?", "success"),
    ("What is explicitly NOT part of this product?", "non_goal"),
];

impl Clarifier {
    pub fn new(concept: Concept) -> Self {
        Self { concept }
    }

    pub fn next_question(&self) -> Option<String> {
        if self.concept.audience.is_empty() {
            return Some(QUESTIONS[0].0.to_string());
        }
        if self.concept.value.is_empty() {
            return Some(QUESTIONS[1].0.to_string());
        }
        if self.concept.success_criteria.is_empty() {
            return Some(QUESTIONS[2].0.to_string());
        }
        if self.concept.non_goals.is_empty() {
            return Some(QUESTIONS[3].0.to_string());
        }
        None
    }

    pub fn apply(&mut self, answer: &str) {
        let answer = answer.trim().to_string();
        if answer.is_empty() {
            return;
        }
        if self.concept.audience.is_empty() {
            self.concept.audience = answer;
            self.concept.ambiguities.retain(|a| a != "audience");
        } else if self.concept.value.is_empty() {
            self.concept.value = answer;
            self.concept.ambiguities.retain(|a| a != "value");
        } else if self.concept.success_criteria.is_empty() {
            self.concept.success_criteria.push(answer);
        } else if self.concept.non_goals.is_empty() {
            self.concept.non_goals.push(answer);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use prricode_spec::Concept;

    #[test]
    fn interview_asks_one_question_at_a_time_until_ready() {
        // Fixture: an idea still open on audience, value, and success
        // criteria, with non-goals already settled. `Concept::from_idea`
        // always fills `audience` (falling back to the whole idea text),
        // so the open-field shape is built directly to exercise the
        // priority-ordered interview.
        let concept = Concept {
            problem: "vague thing".into(),
            audience: String::new(),
            value: String::new(),
            non_goals: vec!["no social features".into()],
            success_criteria: Vec::new(),
            ambiguities: vec!["audience".into(), "value".into()],
            stack: None,
        };
        let mut clarifier = Clarifier::new(concept);
        assert_eq!(
            clarifier.next_question().as_deref(),
            Some("Who is the primary user of this product?")
        );
        clarifier.apply("commuters");
        assert_eq!(
            clarifier.next_question().as_deref(),
            Some("What is the core value they get?")
        );
        clarifier.apply("daily audio briefings");
        assert_eq!(
            clarifier.next_question().as_deref(),
            Some("What single success criterion says it works?")
        );
        clarifier.apply("a user receives a briefing every morning");
        assert!(clarifier.next_question().is_none());
        assert!(clarifier.concept.is_ready());
        assert_eq!(clarifier.concept.audience, "commuters");
    }
}
