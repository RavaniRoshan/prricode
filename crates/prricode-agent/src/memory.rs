//! Auto-memory: per-project memory directory with a MEMORY.md index.

use std::fs;
use std::path::{Path, PathBuf};

pub fn project_memory_dir(workspace: &Path) -> PathBuf {
    let slug = workspace
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>();
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("prricode")
        .join("projects")
        .join(slug)
        .join("memory")
}

pub fn load_index(workspace: &Path) -> Option<String> {
    let path = project_memory_dir(workspace).join("MEMORY.md");
    fs::read_to_string(path).ok()
}

pub fn save_memory(workspace: &Path, name: &str, content: &str) -> std::io::Result<PathBuf> {
    let dir = project_memory_dir(workspace);
    fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{name}.md"));
    fs::write(&file, content)?;
    // Append to index if not present.
    let index = dir.join("MEMORY.md");
    let mut idx = fs::read_to_string(&index).unwrap_or_default();
    if !idx.contains(name) {
        idx.push_str(&format!("- [{name}]({name}.md)\n"));
        fs::write(&index, idx)?;
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn save_and_load_index() {
        let ws = env::temp_dir().join(format!("prricode-mem-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&ws).unwrap();
        save_memory(&ws, "note", "hello").unwrap();
        let idx = load_index(&ws).unwrap();
        assert!(idx.contains("note"));
        let _ = std::fs::remove_dir_all(&ws);
        // cleanup memory dir too
        let _ = std::fs::remove_dir_all(project_memory_dir(&ws));
    }
}
