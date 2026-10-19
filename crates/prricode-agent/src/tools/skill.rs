//! Skill tool: load a discovered skill's instructions into the turn.

use super::{Risk, Tool, ToolContext, ToolOutput, ToolResult};
use async_trait::async_trait;
use prricode_provider::ToolDef;
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Default)]
pub struct SkillTool {
    /// Tests inject this; production resolves `$HOME`.
    home: Option<PathBuf>,
}

impl SkillTool {
    /// Point the tool at a specific skills home (tests).
    #[cfg(test)]
    pub fn with_home(home: PathBuf) -> Self {
        Self { home: Some(home) }
    }

    fn resolve_home(&self) -> PathBuf {
        self.home.implementation().unwrap_or_else(default_home)
    }
}

fn default_home() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

#[async_trait]
impl Tool for SkillTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "skill".to_string(),
            description: "Load a skill's instructions by name. Call without a name to list the \
                          available skills."
                .to_string(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "skill name (as listed); omit to list skills"
                    }
                }
            }),
        }
    }

    fn risk(&self) -> Risk {
        Risk::Safe
    }

    async fn execute(&self, ctx: &ToolContext, input: &Value) -> ToolResult<ToolOutput> {
        let skills = prricode_skills::load_skills(&self.resolve_home(), &ctx.workspace_root);
        if skills.is_empty() {
            let home = self.resolve_home();
            return Ok(ToolOutput::text(format!(
                "no skills discovered (looked in {}/skills and {}/.config/prricode/skills)",
                ctx.workspace_root.display(),
                home.display()
            )));
        }
        let requested = input.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if requested.is_empty() {
            let mut lines: Vec<String> = skills
                .iter()
                .map(|s| {
                    format!(
                        "- {} — {} ({})",
                        s.name,
                        s.description,
                        source_name(&s.source)
                    )
                })
                .collect();
            lines.sort();
            return Ok(ToolOutput::text(lines.join("\n")));
        }
        let Some(skill) = skills
            .iter()
            .find(|s| s.name.eq_ignore_ascii_case(requested))
        else {
            let mut names: Vec<&str> = skills.iter().map(|s| s.name.as_str()).collect();
            names.sort_unstable();
            return Ok(ToolOutput::error(format!(
                "skill '{requested}' not found; available: {}",
                names.join(", ")
            )));
        };
        let mut header = format!(
            "skill: {}\ndescription: {}\nsource: {}\n\n",
            skill.name,
            skill.description,
            source_name(&skill.source)
        );
        header.push_str(&skill.instructions);
        let mut footer = String::new();
        if let Some(model) = &skill.model {
            footer.push_str(&format!("\nmodel preference: {model}"));
        }
        if !skill.allowed_tools.is_empty() {
            footer.push_str(&format!(
                "\nallowed-tools: {}",
                skill.allowed_tools.join(", ")
            ));
        }
        if !skill.scripts.is_empty() {
            footer.push_str(&format!("\nscripts count: {}", skill.scripts.len()));
        }
        if !footer.is_empty() {
            header.push_str(&footer);
        }
        Ok(ToolOutput::text(header))
    }
}

fn source_name(source: &prricode_skills::SkillSource) -> &'static str {
    match source {
        prricode_skills::SkillSource::Bundled => "bundled",
        prricode_skills::SkillSource::Project => "project",
        prricode_skills::SkillSource::Imported => "imported",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::ApprovalEngine;
    use std::sync::Arc;

    fn text_of(out: &ToolOutput) -> String {
        let mut s = String::new();
        for part in &out.content {
            if let prricode_provider::ContentPart::Text(t) = part {
                s.push_str(t);
            }
        }
        s
    }

    /// Fresh unique temp workspace; skills may be written under
    /// `<dir>/skills` (project source). Returns the dir.
    fn temp_root(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("prricode-skill-{tag}-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_skill(root: &std::path::Path, name: &str, body: &str) {
        let dir = root.join("skills").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), body).unwrap();
    }

    fn ctx_with(root: &std::path::Path) -> ToolContext {
        ToolContext {
            workspace_root: root.to_path_buf(),
            approvals: Arc::new(ApprovalEngine::new()),
            data_dir: root.to_path_buf(),
            session_id: "s".into(),
            extensions: Default::default(),
        }
    }

    #[tokio::test]
    async fn skill_loads_instructions_by_name() {
        let root = temp_root("load");
        write_skill(
            &root,
            "cooler",
            "---\nname: cooler\ndescription: chills drinks\nallowed-tools: shell, read\n---\nUse \
             the cooler.\n",
        );
        let tool = SkillTool::with_home(temp_root("home-load"));
        let out = tool
            .execute(&ctx_with(&root), &json!({"name": "COOLER"}))
            .await
            .unwrap();
        let text = text_of(&out);
        assert!(text.contains("Use the cooler."));
        assert!(text.contains("description: chills drinks"));
        assert!(text.contains("allowed-tools: shell, read"));
        assert!(!out.is_error);
    }

    #[tokio::test]
    async fn no_name_lists_available() {
        let root = temp_root("list");
        write_skill(
            &root,
            "alpha",
            "---\nname: alpha\ndescription: does alpha things\n---\nbody\n",
        );
        write_skill(
            &root,
            "beta",
            "---\nname: beta\ndescription: does beta things\n---\nbody\n",
        );
        let tool = SkillTool::with_home(temp_root("home-list"));
        let out = tool.execute(&ctx_with(&root), &json!({})).await.unwrap();
        let text = text_of(&out);
        assert!(text.contains("- alpha — does alpha things"));
        assert!(text.contains("- beta — does beta things"));
    }

    #[tokio::test]
    async fn not_found_is_honest() {
        let root = temp_root("nf");
        write_skill(
            &root,
            "alpha",
            "---\nname: alpha\ndescription: d\n---\nbody\n",
        );
        let tool = SkillTool::with_home(temp_root("home-nf"));
        let out = tool
            .execute(&ctx_with(&root), &json!({"name": "nope"}))
            .await
            .unwrap();
        assert!(out.is_error);
        assert!(text_of(&out).contains("not found; available: alpha"));
    }

    #[tokio::test]
    async fn empty_discovery_is_reported() {
        let root = temp_root("empty");
        let tool = SkillTool::with_home(temp_root("home-empty"));
        let out = tool.execute(&ctx_with(&root), &json!({})).await.unwrap();
        assert!(text_of(&out).contains("no skills discovered"));
        std::fs::remove_dir_all(&root).ok();
    }
}
