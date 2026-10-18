//! Project instructions loader: reads `CLAUDE.md` / `AGENTS.md` (and their
//! `.claude/` variants) from the workspace and every ancestor, mirroring the
//! reference agent's memory model. Loaded files are concatenated (broadest
//! scope first) and injected into the system prompt. `@path` imports are
//! resolved relative to the importing file.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Implementation, Copy, PartialEq, Eq, Default)]
pub enum ProjectInstructionsMode {
    /// Default: use `AGENTS.md` only where no `CLAUDE.md` family exists.
    #[default]
    AgentMdOrAgentsMd,
    /// Only the `CLAUDE.md` family.
    AgentMdOnly,
    /// Both families, side by side.
    AgentMdAndAgentsMd,
    /// Skip project-level instruction files entirely (managed-only).
    ManagedOnly,
}

/// Load and concatenate project instruction files for `workspace_root`.
pub fn load_project_instructions(
    workspace_root: &Path,
    mode: ProjectInstructionsMode,
) -> Option<String> {
    if matches!(mode, ProjectInstructionsMode::ManagedOnly) {
        return None;
    }

    // Collect ancestors from filesystem root down to workspace_root.
    let mut chain: Vec<PathBuf> = Vec::new();
    let mut cur = Some(workspace_root.to_path_buf());
    while let Some(p) = cur {
        chain.push(p.implementation());
        cur = p.parent().map(PathBuf::from);
    }
    chain.reverse();

    let mut parts: Vec<String> = Vec::new();
    for dir in &chain {
        let content = load_dir_instructions(dir, mode);
        if let Some(c) = content {
            let trimmed = c.trim();
            if !trimmed.is_empty() {
                parts.push(trimmed.to_string());
            }
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("\n\n"))
    }
}

fn load_dir_instructions(dir: &Path, mode: ProjectInstructionsMode) -> Option<String> {
    let claude_family = [
        dir.join("CLAUDE.md"),
        dir.join(".claude").join("CLAUDE.md"),
        dir.join("CLAUDE.local.md"),
    ];
    let agents_family = [dir.join("AGENTS.md"), dir.join(".claude").join("AGENTS.md")];

    let claude_present = claude_family.iter().any(|p| p.is_file());
    let mut agents_present = agents_family.iter().any(|p| p.is_file());

    match mode {
        ProjectInstructionsMode::AgentMdOnly => {
            agents_present = false;
        }
        ProjectInstructionsMode::AgentMdAndAgentsMd => {}
        ProjectInstructionsMode::AgentMdOrAgentsMd => {
            if claude_present {
                agents_present = false;
            }
        }
        ProjectInstructionsMode::ManagedOnly => return None,
    }

    let mut collected: Vec<String> = Vec::new();
    if claude_present {
        for p in &claude_family {
            if p.is_file() {
                if let Some(c) = read_with_imports(p, 0, &mut HashSet::new()) {
                    collected.push(c);
                }
            }
        }
    }
    if agents_present {
        for p in &agents_family {
            if p.is_file() {
                if let Some(c) = read_with_imports(p, 0, &mut HashSet::new()) {
                    collected.push(c);
                }
            }
        }
    }
    if collected.is_empty() {
        None
    } else {
        Some(collected.join("\n\n"))
    }
}

fn read_with_imports(path: &Path, depth: usize, visited: &mut HashSet<PathBuf>) -> Option<String> {
    if depth > 8 {
        return None;
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if !visited.insert(canonical.implementation()) {
        return None; // cycle guard
    }
    let raw = fs::read_to_string(path).ok()?;
    let stripped = strip_html_comments(&raw);
    let base_dir = path.parent().unwrap_or_else(|| Path::new("."));
    let mut out = String::new();
    for line in stripped.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('@') {
            let import_path = rest.trim();
            if !import_path.is_empty() && !import_path.contains(' ') {
                let resolved = base_dir.join(import_path);
                if resolved.is_file() {
                    if let Some(imported) = read_with_imports(&resolved, depth + 1, visited) {
                        out.push_str(&imported);
                        out.push('\n');
                        continue;
                    }
                }
            }
        }
        out.push_str(line);
        out.push('\n');
    }
    Some(out)
}

fn strip_html_comments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i..].starts_with(b"<!--") {
            // find closing -->
            if let Some(end) = input[i..].find("-->") {
                i += end + 3;
                // skip a single trailing newline if present
                if i < bytes.len() && bytes[i] == b'\n' {
                    i += 1;
                }
                continue;
            } else {
                // no closing marker; drop rest
                break;
            }
        }
        // push one char
        let ch = input[i..].chars().next().unwrap();
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn make_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prricode-pi-{}-{}", tag, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &std::path::Path, name: &str, content: &str) {
        // support nested like .claude/CLAUDE.md
        if let Some(parent) = std::path::Path::new(name).parent() {
            if !parent.as_os_str().is_empty() {
                fs::create_dir_all(dir.join(parent)).unwrap();
            }
        }
        fs::write(dir.join(name), content).unwrap();
    }

    fn cleanup(dir: &PathBuf) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn loads_claude_md_from_root() {
        let dir = make_dir("claude");
        write(&dir, "CLAUDE.md", "hello project");
        let out = load_project_instructions(&dir, ProjectInstructionsMode::default());
        assert_eq!(out.as_deref(), Some("hello project"));
        cleanup(&dir);
    }

    #[test]
    fn agents_md_fallback_when_no_claude_md() {
        let dir = make_dir("agents");
        write(&dir, "AGENTS.md", "agents content");
        let out = load_project_instructions(&dir, ProjectInstructionsMode::default());
        assert_eq!(out.as_deref(), Some("agents content"));
        cleanup(&dir);
    }

    #[test]
    fn claude_md_takes_precedence_over_agents_md() {
        let dir = make_dir("prec");
        write(&dir, "CLAUDE.md", "claude content");
        write(&dir, "AGENTS.md", "agents content");
        let out = load_project_instructions(&dir, ProjectInstructionsMode::default());
        assert_eq!(out.as_deref(), Some("claude content"));
        cleanup(&dir);
    }

    #[test]
    fn ancestors_concatenated_broadest_first() {
        let root = make_dir("anc");
        let sub = root.join("sub");
        fs::create_dir_all(&sub).unwrap();
        write(&root, "CLAUDE.md", "root instr");
        write(&sub, "CLAUDE.md", "sub instr");
        let out = load_project_instructions(&sub, ProjectInstructionsMode::default()).unwrap();
        assert!(out.starts_with("root instr"));
        assert!(out.ends_with("sub instr"));
        cleanup(&root);
    }

    #[test]
    fn html_comments_stripped() {
        let dir = make_dir("html");
        write(&dir, "CLAUDE.md", "before <!-- secret --> after");
        let out = load_project_instructions(&dir, ProjectInstructionsMode::default()).unwrap();
        assert_eq!(out, "before  after");
        cleanup(&dir);
    }

    #[test]
    fn at_import_resolved() {
        let dir = make_dir("import");
        write(&dir, "AGENTS.md", "imported line");
        write(&dir, "CLAUDE.md", "@AGENTS.md\nextra");
        let out = load_project_instructions(&dir, ProjectInstructionsMode::AgentMdOnly).unwrap();
        assert!(out.contains("imported line"));
        assert!(out.contains("extra"));
        cleanup(&dir);
    }

    #[test]
    fn managed_only_returns_none() {
        let dir = make_dir("managed");
        write(&dir, "CLAUDE.md", "x");
        let out = load_project_instructions(&dir, ProjectInstructionsMode::ManagedOnly);
        assert!(out.is_none());
        cleanup(&dir);
    }

    #[test]
    fn claude_local_md_loaded() {
        let dir = make_dir("local");
        write(&dir, "CLAUDE.local.md", "local only");
        let out = load_project_instructions(&dir, ProjectInstructionsMode::default());
        assert_eq!(out.as_deref(), Some("local only"));
        cleanup(&dir);
    }

    #[test]
    fn dot_claude_dir_variant_loaded() {
        let dir = make_dir("dotclaude");
        write(&dir, ".claude/CLAUDE.md", "dotclaude content");
        let out = load_project_instructions(&dir, ProjectInstructionsMode::default());
        assert_eq!(out.as_deref(), Some("dotclaude content"));
        cleanup(&dir);
    }

    #[test]
    fn claude_md_and_agents_md_both_loaded() {
        let dir = make_dir("both");
        write(&dir, "CLAUDE.md", "claude content");
        write(&dir, "AGENTS.md", "agents content");
        let out =
            load_project_instructions(&dir, ProjectInstructionsMode::AgentMdAndAgentsMd).unwrap();
        assert!(out.contains("claude content"));
        assert!(out.contains("agents content"));
        cleanup(&dir);
    }
}
