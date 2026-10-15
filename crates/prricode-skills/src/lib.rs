//! Skills: `SKILL.md` capability bundles loaded from the project and the
//! user's home directory, with import from other formats.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    /// The markdown body after the frontmatter.
    pub instructions: String,
    pub location: PathBuf,
    pub source: SkillSource,
    /// Runnable helpers under the skill's `scripts/` directory.
    pub scripts: Vec<PathBuf>,
}

impl Skill {
    /// The interpreter command prefix for a script, from its shebang.
    /// `#!/usr/bin/env python3` -> `["/usr/bin/env", "python3"]`; `#!/bin/bash` -> bash;
    /// no shebang -> the file is executed directly (it must be executable).
    pub fn interpreter_for(script: &Path) -> Vec<String> {
        let text = std::fs::read_to_string(script).unwrap_or_default();
        if let Some(first) = text.lines().next() {
            if let Some(shebang) = first.strip_prefix("#!") {
                let parts: Vec<String> = shebang.split_whitespace().map(String::from).collect();
                if !parts.is_empty() {
                    // `#!/usr/bin/env python3` keeps env-as-interpreter.
                    return parts;
                }
            }
        }
        vec![script.to_string_lossy().to_string()]
    }

    /// The documented argv contract: `<interpreter> <script> <args...>`,
    /// the skill-script invocation contract:
    pub fn script_command(&self, script_name: &str, args: &[String]) -> Option<Vec<String>> {
        let script = self
            .scripts
            .iter()
            .find(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy() == script_name)
                    .unwrap_or(false)
            })
            .cloned()?;
        let mut command = Self::interpreter_for(&script);
        command.push(script.to_string_lossy().to_string());
        command.extend(args.iter().cloned());
        Some(command)
    }

    pub fn script_names(&self) -> Vec<String> {
        self.scripts
            .iter()
            .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .collect()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Bundled,
    Project,
    Imported,
}

#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error("io error: {0}")]
    Io(String),
    #[error("{0} has no SKILL.md")]
    NoSkillMd(PathBuf),
    #[error("skill '{0}' already installed at {1}")]
    AlreadyInstalled(String, PathBuf),
}

pub type SkillResult<T> = Result<T, SkillError>;

/// Directories scanned for skills, in precedence order (project first).
pub fn skill_dirs(home_dir: &Path, cwd: &Path) -> Vec<(PathBuf, SkillSource)> {
    vec![
        (cwd.join("skills"), SkillSource::Project),
        (
            home_dir.join(".config/prricode/skills"),
            SkillSource::Imported,
        ),
    ]
}

/// Parse a `SKILL.md` file into name/description/instructions.
pub fn parse_skill_md(text: &str, location: &Path, source: SkillSource) -> Skill {
    let mut name = location
        .parent()
        .and_then(|p| p.file_name())
        .or_else(|| location.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unnamed".to_string());
    let mut description = String::new();
    let mut lines = text.lines().peekable();
    if lines.peek().is_some_and(|l| l.trim() == "---") {
        lines.next();
        let mut body = Vec::new();
        let mut in_body = false;
        for line in lines.by_ref() {
            if line.trim() == "---" {
                in_body = true;
                continue;
            }
            if in_body {
                body.push(line);
                continue;
            }
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("name:") {
                name = unquote(rest);
            } else if let Some(rest) = trimmed.strip_prefix("description:") {
                description = unquote(rest);
            }
        }
        let instructions = body.join("\n");
        return Skill {
            name,
            description,
            instructions,
            location: location.to_path_buf(),
            source,
            scripts: Vec::new(),
        };
    }
    let instructions = text.to_string();
    for line in text.lines() {
        let trimmed = line.trim();
        if description.is_empty() && !trimmed.is_empty() && !trimmed.starts_with('#') {
            description = trimmed.to_string();
        }
    }
    Skill {
        name,
        description,
        instructions,
        location: location.to_path_buf(),
        source,
        scripts: Vec::new(),
    }
}

fn unquote(value: &str) -> String {
    let value = value.trim();
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].to_string();
        }
    }
    value.to_string()
}

/// Load every skill from the standard directories.
pub fn load_skills(home_dir: &Path, cwd: &Path) -> Vec<Skill> {
    let mut skills = Vec::new();
    for (dir, source) in skill_dirs(home_dir, cwd) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_dir())
            .collect();
        paths.sort();
        for path in paths {
            let file = path.join("SKILL.md");
            if let Ok(text) = std::fs::read_to_string(&file) {
                let mut skill = parse_skill_md(&text, &file, source);
                skill.scripts = discover_scripts(&path);
                skills.push(skill);
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// Import a skill directory from `source` into the user's skills directory.
/// Supports both prricode `SKILL.md` directories and Claude-style skill dirs
/// (same layout). Codex `AGENTS.md`-style single files are wrapped as one skill.
pub fn import_skill(
    home_dir: &Path,
    source: &Path,
    dry_run: bool,
    force: bool,
) -> SkillResult<ImportedSkill> {
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| SkillError::NoSkillMd(source.to_path_buf()))?;
    let dest_dir = home_dir.join(".config/prricode/skills").join(&name);

    if source.is_file() {
        // Single-file skill (e.g. Codex AGENTS.md or a bare markdown file).
        let text = std::fs::read_to_string(source)
            .map_err(|e| SkillError::Io(format!("cannot read {}: {e}", source.display())))?;
        let description = text
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty() && !l.starts_with('#'))
            .unwrap_or("imported skill")
            .to_string();
        let body = format!("---\nname: {name}\ndescription: {description}\n---\n\n{text}\n");
        if dry_run {
            return Ok(ImportedSkill {
                name,
                source: source.to_path_buf(),
                dest: dest_dir.join("SKILL.md"),
                imported: false,
            });
        }
        if dest_dir.join("SKILL.md").exists() && !force {
            return Err(SkillError::AlreadyInstalled(name, dest_dir));
        }
        std::fs::create_dir_all(&dest_dir).map_err(|e| SkillError::Io(e.to_string()))?;
        std::fs::write(dest_dir.join("SKILL.md"), body)
            .map_err(|e| SkillError::Io(e.to_string()))?;
        return Ok(ImportedSkill {
            name,
            source: source.to_path_buf(),
            dest: dest_dir.join("SKILL.md"),
            imported: true,
        });
    }

    if !source.join("SKILL.md").is_file() {
        return Err(SkillError::NoSkillMd(source.to_path_buf()));
    }
    if dry_run {
        return Ok(ImportedSkill {
            name: name.clone(),
            source: source.to_path_buf(),
            dest: dest_dir,
            imported: false,
        });
    }
    if dest_dir.exists() && !force {
        return Err(SkillError::AlreadyInstalled(name, dest_dir));
    }
    copy_dir_recursive(source, &dest_dir)?;
    Ok(ImportedSkill {
        name,
        source: source.to_path_buf(),
        dest: dest_dir,
        imported: true,
    })
}

#[derive(Debug, Clone)]
pub struct ImportedSkill {
    pub name: String,
    pub source: PathBuf,
    pub dest: PathBuf,
    pub imported: bool,
}

fn copy_dir_recursive(src: &Path, dest: &Path) -> SkillResult<()> {
    std::fs::create_dir_all(dest).map_err(|e| SkillError::Io(e.to_string()))?;
    let entries = std::fs::read_dir(src).map_err(|e| SkillError::Io(e.to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|e| SkillError::Io(e.to_string()))?;
        let target = dest.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|e| SkillError::Io(e.to_string()))?
            .is_dir()
        {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| SkillError::Io(e.to_string()))?;
        }
    }
    Ok(())
}

/// Runnable helpers directly under `<skill>/scripts/`, sorted.
pub fn discover_scripts(skill_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(skill_dir.join("scripts")) else {
        return Vec::new();
    };
    let mut scripts: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .collect();
    scripts.sort();
    scripts
}

/// Output of a skill-script execution.
#[derive(Debug, Clone)]
pub struct ScriptOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// Execute a skill script through the sandbox with the documented contract:
/// the interpreter comes from the script's shebang, the skill directory is the
/// workspace root so relative data paths resolve, and there is no network.
pub async fn run_skill_script(
    skill: &Skill,
    script_name: &str,
    args: &[String],
    workspace_root: &Path,
) -> anyhow::Result<ScriptOutput> {
    let command = skill.script_command(script_name, args).ok_or_else(|| {
        anyhow::anyhow!("skill '{}' has no script named {script_name}", skill.name)
    })?;
    let spec = prricode_sandbox::SandboxSpec {
        workspace_root: workspace_root.to_path_buf(),
        allow_network: false,
        timeout: std::time::Duration::from_secs(120),
        // The script lives beside the skill, which is not the workspace the
        // agent is working in. Without this bind the sandbox (rightly) hides
        // it and the helper cannot be opened — visible when the skill ships
        // under a path the sandbox covers with a tmpfs. `location` is the
        // SKILL.md file, so the directory is its parent.
        extra_ro_paths: skill
            .location
            .parent()
            .map(|dir| vec![dir.to_path_buf()])
            .unwrap_or_default(),
    };
    let full = command.join(" ");
    let output = prricode_sandbox::run_command(&full, &spec).await?;
    Ok(ScriptOutput {
        exit_code: output.exit_code,
        stdout: output.stdout,
        stderr: output.stderr,
        timed_out: output.timed_out,
    })
}

/// Render active skills into a system-prompt fragment.
pub fn render_skills_prompt(skills: &[Skill], active: &[String]) -> String {
    let mut out = String::new();
    for skill in skills {
        if !active.is_empty() && !active.iter().any(|a| a == &skill.name) {
            continue;
        }
        out.push_str(&format!("## {}\n{}\n\n", skill.name, skill.instructions));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_skill() {
        let text = "---\nname: git\ndescription: Git helpers\n---\n\n# Git\nUse git commands.\n";
        let skill = parse_skill_md(text, Path::new("/x/git/SKILL.md"), SkillSource::Project);
        assert_eq!(skill.name, "git");
        assert_eq!(skill.description, "Git helpers");
        assert!(skill.instructions.contains("Use git commands."));
    }

    #[test]
    fn parses_plain_markdown_fallback() {
        let text = "# Title\nFirst body line\nMore\n";
        let skill = parse_skill_md(text, Path::new("/x/plain/SKILL.md"), SkillSource::Project);
        assert_eq!(skill.description, "First body line");
    }

    #[test]
    fn imports_and_loads_a_skill() {
        let home = std::env::temp_dir().join(format!("prricode-skill-test-{}", std::process::id()));
        let src = home.join("src/my-skill");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("SKILL.md"),
            "---\nname: my-skill\ndescription: A test skill\n---\n\nDo the thing.\n",
        )
        .unwrap();
        let imported = import_skill(&home, &src, false, false).unwrap();
        assert!(imported.imported);
        assert!(imported.dest.join("SKILL.md").is_file());
        let skills = load_skills(&home, &home.join("nope"));
        assert!(skills.iter().any(|s| s.name == "my-skill"));
        let prompt = render_skills_prompt(&skills, &["my-skill".to_string()]);
        assert!(prompt.contains("Do the thing."));
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn executes_a_bundled_skill_script_through_the_sandbox() {
        // The bundled wordcount skill ships scripts/wordcount.py with an
        // `#!/usr/bin/env python3` shebang; the documented contract
        // is `<interpreter> <script> <args>` executed in the skill directory.
        let cwd = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .ancestors()
            .nth(2)
            .unwrap()
            .to_path_buf();
        let skills = load_skills(Path::new("/nonexistent-home"), &cwd);
        let skill = skills
            .iter()
            .find(|s| s.name == "wordcount")
            .expect("bundled wordcount skill loads");
        assert_eq!(skill.script_names(), vec!["wordcount.py".to_string()]);
        // The shebang drives the interpreter.
        assert_eq!(
            Skill::interpreter_for(&skill.scripts[0]),
            vec!["/usr/bin/env".to_string(), "python3".to_string()]
        );
        let data_dir = std::env::temp_dir().join(format!("skill-script-{}", std::process::id()));
        std::fs::create_dir_all(&data_dir).unwrap();
        let data_file = data_dir.join("sample.txt");
        std::fs::write(&data_file, "one two three four five").unwrap();
        let output = run_skill_script(
            skill,
            "wordcount.py",
            &[data_file.to_string_lossy().to_string()],
            &data_dir,
        )
        .await
        .unwrap();
        assert_eq!(output.exit_code, 0, "stderr: {}", output.stderr);
        assert_eq!(output.stdout.trim(), "words 5");
        let output = run_skill_script(
            skill,
            "wordcount.py",
            &[
                "--lines".to_string(),
                data_file.to_string_lossy().to_string(),
            ],
            &data_dir,
        )
        .await
        .unwrap();
        assert_eq!(output.stdout.trim(), "lines 1");
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn import_rejects_dirs_without_skill_md() {
        let home = std::env::temp_dir().join("prricode-skill-missing");
        std::fs::create_dir_all(home.join("src/bad")).unwrap();
        let err = import_skill(&home, &home.join("src/bad"), false, false).unwrap_err();
        assert!(matches!(err, SkillError::NoSkillMd(_)));
        std::fs::remove_dir_all(&home).ok();
    }
}
