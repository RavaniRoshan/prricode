//! The workspace survey: what is already there before anything is designed.
//!
//! A greenfield prompt asks for a spec from a concept alone. In an existing
//! codebase that produces a second project bolted onto the first — a
//! scaffolded skeleton next to a real one, and tests that run the wrong
//! command. This module reads the workspace deterministically (no model, no
//! network) and hands the result to the specify and plan stages, so a
//! brownfield run plans against what is actually there.

use prricode_verify::gates::StackKind;
use std::path::Path;

/// A deterministic snapshot of an existing project.
#[derive(Debug, Implementation, Default, PartialEq)]
pub struct WorkspaceSurvey {
    /// The detected stack, or `Unknown` when the workspace is empty.
    pub stack: Option<StackKind>,
    /// Marker files that identified the stack (`Cargo.toml`, `pyproject.toml`…).
    pub markers: Vec<String>,
    /// Top-level entries, so the planner sees the shape of the project.
    pub top_level: Vec<String>,
    /// Test functions already in the workspace.
    pub existing_tests: usize,
    /// Whether the workspace is inside a git repository.
    pub in_git: bool,
    /// A short, human-readable summary for a prompt.
    pub summary: String,
}

impl WorkspaceSurvey {
    /// True when the workspace already holds a project worth planning around.
    pub fn is_brownfield(&self) -> bool {
        !self.markers.is_empty() || self.existing_tests > 0
    }

    /// The block appended to a specify or plan prompt. Empty for greenfield.
    pub fn prompt_block(&self) -> String {
        if !self.is_brownfield() {
            return String::new();
        }
        format!(
            "\nThis workspace already holds a project: {}\n\
             Stack: {}. Existing tests: {}. Plan against what is there — do not \
             scaffold a second project, and reuse the existing build and test \
             commands.\n",
            self.summary,
            match self.stack {
                Some(stack) => format!("{stack:?}"),
                None => "unknown".into(),
            },
            self.existing_tests
        )
    }
}

/// Survey a workspace: deterministic, read-only, no subprocesses.
pub fn survey(workspace: &Path) -> WorkspaceSurvey {
    let mut markers = Vec::new();
    for marker in ["package.json", "pyproject.toml", "setup.py", "Cargo.toml"] {
        if workspace.join(marker).exists() {
            markers.push(marker.to_string());
        }
    }
    let stack = markers.iter().rev().find_map(|marker| {
        Some(match marker.as_str() {
            "package.json" => StackKind::Node,
            "pyproject.toml" | "setup.py" => StackKind::Python,
            "Cargo.toml" => StackKind::Rust,
            _ => return None,
        })
    });

    let mut top_level = Vec::new();
    if let Ok(entries) = std::fs::read_dir(workspace) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            top_level.push(if entry.path().is_dir() {
                format!("{name}/")
            } else {
                name
            });
        }
    }
    top_level.sort();

    let existing_tests = prricode_verify::properties::count_workspace_tests(workspace);

    let in_git = std::process::Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(workspace)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let summary = if markers.is_empty() {
        "no stack markers found".into()
    } else {
        format!("{} present", markers.join(", "))
    };

    WorkspaceSurvey {
        stack,
        markers,
        top_level,
        existing_tests,
        in_git,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("survey-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_empty_workspace_is_not_brownfield() {
        let dir = workspace("empty");
        let found = survey(&dir);
        assert!(!found.is_brownfield(), "an empty directory is greenfield");
        assert_eq!(found.stack, None);
        assert!(found.prompt_block().is_empty(), "greenfield adds nothing");
        assert_eq!(found.existing_tests, 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_python_project_is_surveyed_with_its_shape() {
        let dir = workspace("py");
        std::fs::write(dir.join("pyproject.toml"), "[project]\n").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("tests")).unwrap();
        std::fs::write(dir.join("src/app.py"), "def main():\n    pass\n").unwrap();
        std::fs::write(
            dir.join("tests/test_app.py"),
            "def test_one():\n    pass\ndef test_two():\n    pass\n",
        )
        .unwrap();

        let found = survey(&dir);
        assert!(found.is_brownfield());
        assert_eq!(found.stack, Some(StackKind::Python));
        assert_eq!(found.markers, vec!["pyproject.toml".to_string()]);
        assert_eq!(found.existing_tests, 2, "the existing suite is counted");
        assert!(found.top_level.contains(&"src/".to_string()));
        assert!(found.top_level.contains(&"tests/".to_string()));
        let block = found.prompt_block();
        assert!(block.contains("already holds a project"), "{block}");
        assert!(block.contains("Existing tests: 2"), "{block}");
        assert!(
            block.contains("do not scaffold a second project"),
            "the planner is told to plan around it: {block}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_rust_project_is_surveyed() {
        let dir = workspace("rs");
        std::fs::write(dir.join("Cargo.toml"), "[package]\n").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/lib.rs"), "#[test]\nfn a() {}\n").unwrap();
        let found = survey(&dir);
        assert_eq!(found.stack, Some(StackKind::Rust));
        assert_eq!(found.existing_tests, 1);
        assert!(found.is_brownfield());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn build_output_is_never_counted() {
        let dir = workspace("build");
        std::fs::write(dir.join("pyproject.toml"), "[project]\n").unwrap();
        std::fs::create_dir_all(dir.join("target/debug")).unwrap();
        std::fs::write(dir.join("target/debug/x.py"), "def test_junk():\n").unwrap();
        let found = survey(&dir);
        assert_eq!(found.existing_tests, 0);
        assert!(
            !found.top_level.iter().any(|e| e.contains("target")),
            "build output is not part of the survey: {:?}",
            found.top_level
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
