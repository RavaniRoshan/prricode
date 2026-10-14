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
        } else if self.concept.value.is_empty() {
            self.concept.value = answer;
        } else if self.concept.success_criteria.is_empty() {
            self.concept.success_criteria.push(answer);
        } else if self.concept.non_goals.is_empty() {
            self.concept.non_goals.push(answer);
        }
        self.clear_settled_markers();
    }

    /// The interview question that clears an ambiguity marker. The exit path
    /// uses it to re-ask a marker the field-driven interview skipped past.
    pub fn question_for_marker(marker: &str) -> Option<&'static str> {
        QUESTIONS
            .iter()
            .find(|(_, m)| *m == marker)
            .map(|(question, _)| *question)
    }

    /// Markers track field state, not interview history: drop each marker
    /// once its field is settled. `Concept::from_idea` seeds an "audience"
    /// marker over an already-filled audience, so clearing markers only in
    /// their own apply branch would leave that marker stale forever.
    fn clear_settled_markers(&mut self) {
        if !self.concept.audience.is_empty() {
            self.concept.ambiguities.retain(|a| a != "audience");
        }
        if !self.concept.value.is_empty() {
            self.concept.ambiguities.retain(|a| a != "value");
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

    #[test]
    fn a_fully_interviewed_from_idea_concept_is_ready() {
        // `from_idea` fills audience up front and seeds both the "audience"
        // and "value" markers; the markers must not outlive their fields or
        // `is_ready` never flips for a fully-interviewed concept.
        let mut clarifier = Clarifier::new(Concept::from_idea(
            "a service that turns RSS feeds into podcast briefings for commuters",
        ));
        assert_eq!(
            clarifier.next_question().as_deref(),
            Some("What is the core value they get?")
        );
        let mut answers = 0;
        while let Some(_question) = clarifier.next_question() {
            clarifier.apply("daily audio briefings for commuters");
            answers += 1;
            assert!(answers <= 3, "interview must terminate");
        }
        assert_eq!(answers, 3);
        assert!(clarifier.concept.ambiguities.is_empty());
        assert!(clarifier.concept.is_ready());
    }
}
