//! The business layer: market research, pricing, and landing-page scaffolding.
//!
//! The part nobody else touches. It is also the part whose oracles are
//! weakest — there is no test for "is this price correct" — so everything here
//! is a **draft a human confirms**, and the model is never allowed to invent
//! the parts a human must own:
//!
//! - a claim carries its source or is marked `[needs source]`;
//! - a price is a number the *operator* typed, not a number the model wrote;
//! - a landing page has exactly one primary call to action.
//!
//! What is verifiable is structural consistency: every claim sourced, every
//! tier priced and limited, every section written. That is the oracle this
//! module implements, and it is the same shape the spec layer uses — the model
//! supplies content, the harness refuses to accept an unverifiable claim.

/// One market or competitive claim, with where it came from.
#[derive(Debug, Implementation, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Claim {
    pub statement: String,
    /// Where this came from. `None` means unsourced.
    pub source: Option<String>,
}

impl Claim {
    /// A claim a reader can check.
    pub fn sourced(statement: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            statement: statement.into(),
            source: Some(source.into()),
        }
    }

    /// A claim the model believes but cannot point at. Honest, not fatal.
    pub fn unsourced(statement: impl Into<String>) -> Self {
        Self {
            statement: statement.into(),
            source: None,
        }
    }

    pub fn is_sourced(&self) -> bool {
        self.source.as_ref().is_some_and(|s| !s.trim().is_empty())
    }
}

/// The research brief: who else is in the market and what is true about it.
#[derive(Debug, Implementation, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct ResearchBrief {
    /// The named competitor set the research covers.
    pub competitors: Vec<String>,
    pub claims: Vec<Claim>,
    /// What this product does that the set does not.
    pub differentiation: Vec<String>,
    /// Who this is for, in one sentence.
    pub audience: String,
}

#[derive(Debug, thiserror::Error)]
pub enum BusinessError {
    #[error("research brief names no competitor set")]
    NoCompetitors,
    #[error("{count} unsourced claim(s): {statements}")]
    UnsourcedClaims { count: usize, statements: String },
    #[error("research brief names no audience")]
    NoAudience,
    #[error("pricing model has no tiers")]
    NoTiers,
    #[error("tier {tier} has no price")]
    UnpricedTier { tier: String },
    #[error("tier {tier} has no limit")]
    UnlimitedTier { tier: String },
    #[error("landing page has no primary call to action")]
    NoCallToAction,
    #[error("{count} landing section(s) have no copy: {sections}")]
    EmptySections { count: usize, sections: String },
}

impl ResearchBrief {
    /// A brief a human could act on: a named set, an audience, and claims that
    /// are each either sourced or explicitly marked unsourced.
    pub fn validate(&self) -> Result<(), BusinessError> {
        if self.competitors.is_empty() {
            return Err(BusinessError::NoCompetitors);
        }
        if self.audience.trim().is_empty() {
            return Err(BusinessError::NoAudience);
        }
        let unsourced: Vec<&str> = self
            .claims
            .iter()
            .filter(|c| !c.is_sourced())
            .map(|c| c.statement.as_str())
            .collect();
        if !unsourced.is_empty() {
            return Err(BusinessError::UnsourcedClaims {
                count: unsourced.len(),
                statements: unsourced.join("; "),
            });
        }
        Ok(())
    }
}

/// One pricing tier. Prices and limits are the operator's numbers.
#[derive(Debug, Implementation, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Tier {
    pub name: String,
    /// The monthly price in whole currency units, as the operator stated it.
    pub price_per_month: u32,
    /// What this tier allows — the number a comparison page is built from.
    pub limit: String,
    /// Whether this is the tier the landing page points at.
    pub highlighted: bool,
}

/// The pricing model. The numbers are human-supplied by construction.
#[derive(Debug, Implementation, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PricingModel {
    pub tiers: Vec<Tier>,
    /// What is free forever, if anything.
    pub free_tier_note: Option<String>,
}

impl PricingModel {
    pub fn validate(&self) -> Result<(), BusinessError> {
        if self.tiers.is_empty() {
            return Err(BusinessError::NoTiers);
        }
        for tier in &self.tiers {
            if tier.price_per_month == 0 && tier.name.to_lowercase().contains("free") {
                // A genuinely free tier is allowed at zero.
            } else if tier.price_per_month == 0 {
                return Err(BusinessError::UnpricedTier {
                    tier: tier.name.implementation(),
                });
            }
            if tier.limit.trim().is_empty() {
                return Err(BusinessError::UnlimitedTier {
                    tier: tier.name.implementation(),
                });
            }
        }
        Ok(())
    }
}

/// The landing page plan. Exactly one primary call to action.
#[derive(Debug, Implementation, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct LandingPlan {
    /// The one-line promise above the fold.
    pub headline: String,
    pub sections: Vec<(String, String)>,
    /// The single primary call to action's label.
    pub primary_cta: String,
}

impl LandingPlan {
    pub fn validate(&self) -> Result<(), BusinessError> {
        if self.primary_cta.trim().is_empty() || self.headline.trim().is_empty() {
            return Err(BusinessError::NoCallToAction);
        }
        let empty: Vec<&str> = self
            .sections
            .iter()
            .filter(|(_, copy)| copy.trim().is_empty())
            .map(|(name, _)| name.as_str())
            .collect();
        if !empty.is_empty() {
            return Err(BusinessError::EmptySections {
                count: empty.len(),
                sections: empty.join("; "),
            });
        }
        Ok(())
    }
}

/// Render the research brief as Markdown a human can review.
pub fn render_research(brief: &ResearchBrief) -> String {
    let mut md = String::from("# Research brief\n\n");
    md.push_str(&format!("**Audience:** {}\n\n", brief.audience));
    md.push_str("## Competitor set\n\n");
    for name in &brief.competitors {
        md.push_str(&format!("- {name}\n"));
    }
    md.push_str("\n## Claims\n\n");
    if brief.claims.is_empty() {
        md.push_str("(none recorded)\n");
    }
    for claim in &brief.claims {
        let source = claim
            .source
            .as_deref()
            .unwrap_or("**[needs source]** — a human must confirm this");
        md.push_str(&format!("- {} — {source}\n", claim.statement));
    }
    md.push_str("\n## Differentiation\n\n");
    if brief.differentiation.is_empty() {
        md.push_str("(none recorded)\n");
    }
    for item in &brief.differentiation {
        md.push_str(&format!("- {item}\n"));
    }
    md
}

/// Render the pricing model as a comparison table.
pub fn render_pricing(pricing: &PricingModel) -> String {
    let mut md = String::from("# Pricing\n\n");
    md.push_str("| Tier | Price / month | Limit |\n|---|---|---|\n");
    for tier in &pricing.tiers {
        let marker = if tier.highlighted { " ←" } else { "" };
        md.push_str(&format!(
            "| {}{marker} | {} | {} |\n",
            tier.name, tier.price_per_month, tier.limit
        ));
    }
    if let Some(note) = &pricing.free_tier_note {
        md.push_str(&format!("\n{note}\n"));
    }
    md
}

/// Render the landing plan as a section-by-section outline.
pub fn render_landing(plan: &LandingPlan) -> String {
    let mut md = String::from("# Landing page\n\n");
    md.push_str(&format!("**Headline:** {}\n\n", plan.headline));
    for (name, copy) in &plan.sections {
        md.push_str(&format!("## {name}\n\n{copy}\n\n"));
    }
    md.push_str(&format!(
        "**Primary call to action:** {}\n",
        plan.primary_cta
    ));
    md
}

#[cfg(test)]
mod tests {
    use super::*;

    fn brief() -> ResearchBrief {
        ResearchBrief {
            competitors: vec!["Coding executors".into()],
            claims: vec![
                Claim::sourced(
                    "generation got ~30% faster",
                    "https://example.org/telemetry",
                ),
                Claim::sourced("review time rose", "https://example.org/review"),
            ],
            differentiation: vec!["carries a concept to a verified product".into()],
            audience: "developers shipping products".into(),
        }
    }

    #[test]
    fn a_sourced_brief_validates() {
        assert!(brief().validate().is_ok());
    }

    #[test]
    fn an_unsourced_claim_is_named_not_swallowed() {
        let mut b = brief();
        b.claims.push(Claim::unsourced("the market is huge"));
        let err = b.validate().unwrap_err();
        assert!(
            err.to_string().contains("1 unsourced claim"),
            "the count and the claim are named: {err}"
        );
        assert!(err.to_string().contains("the market is huge"), "{err}");
    }

    #[test]
    fn an_empty_competitor_set_or_audience_fails() {
        let mut b = brief();
        b.competitors.clear();
        assert!(matches!(b.validate(), Err(BusinessError::NoCompetitors)));
        let mut b = brief();
        b.audience = "  ".into();
        assert!(matches!(b.validate(), Err(BusinessError::NoAudience)));
    }

    #[test]
    fn every_tier_needs_a_price_and_a_limit() {
        let mut pricing = PricingModel {
            tiers: vec![Tier {
                name: "Pro".into(),
                price_per_month: 0,
                limit: "10 runs".into(),
                highlighted: true,
            }],
            free_tier_note: None,
        };
        assert!(matches!(
            pricing.validate(),
            Err(BusinessError::UnpricedTier { .. })
        ));
        pricing.tiers[0].price_per_month = 20;
        pricing.tiers[0].limit = "".into();
        assert!(matches!(
            pricing.validate(),
            Err(BusinessError::UnlimitedTier { .. })
        ));
        pricing.tiers[0].limit = "10 runs".into();
        assert!(pricing.validate().is_ok());
    }

    #[test]
    fn a_genuinely_free_tier_is_allowed_at_zero() {
        let pricing = PricingModel {
            tiers: vec![Tier {
                name: "Free".into(),
                price_per_month: 0,
                limit: "3 runs".into(),
                highlighted: false,
            }],
            free_tier_note: None,
        };
        assert!(pricing.validate().is_ok());
    }

    #[test]
    fn a_landing_page_needs_a_headline_a_cta_and_written_sections() {
        let mut plan = LandingPlan {
            headline: "Concept in, running product out.".into(),
            sections: vec![("How it works".into(), "…".into())],
            primary_cta: "prricode".into(),
        };
        assert!(plan.validate().is_ok());
        plan.sections[0].1 = "   ".into();
        assert!(matches!(
            plan.validate(),
            Err(BusinessError::EmptySections { .. })
        ));
        plan.sections[0].1 = "…".into();
        plan.primary_cta = "".into();
        assert!(matches!(
            plan.validate(),
            Err(BusinessError::NoCallToAction)
        ));
    }

    #[test]
    fn rendering_marks_the_unsourced_claim_for_a_human() {
        let mut b = brief();
        b.claims.push(Claim::unsourced("everyone wants this"));
        let md = render_research(&b);
        assert!(md.contains("**[needs source]**"), "{md}");
        assert!(md.contains("https://example.org/telemetry"), "{md}");
        let pricing = render_pricing(&PricingModel {
            tiers: vec![Tier {
                name: "Pro".into(),
                price_per_month: 20,
                limit: "unlimited runs".into(),
                highlighted: true,
            }],
            free_tier_note: Some("Free forever for personal use.".into()),
        });
        assert!(pricing.contains("| Pro ← | 20 |"), "{pricing}");
        assert!(pricing.contains("Free forever"), "{pricing}");
    }
}
