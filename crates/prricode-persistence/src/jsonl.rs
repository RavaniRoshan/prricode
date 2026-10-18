//! Append-only JSONL session store (alongside SQLite).
//!
//! Each session is a file `<data_dir>/sessions/<id>.jsonl` with one JSON
//! object per line. Records are never mutated; new state is appended.

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct JsonlRecord {
    pub kind: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub content: Value,
    #[serde(default)]
    pub uuid: Option<String>,
    #[serde(default)]
    pub parent_uuid: Option<String>,
}

pub fn session_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sessions")
}

pub fn session_path(data_dir: &Path, session_id: &str) -> PathBuf {
    session_dir(data_dir).join(format!("{session_id}.jsonl"))
}

pub fn append_record(data_dir: &Path, session_id: &str, record: &JsonlRecord) -> Result<()> {
    let dir = session_dir(data_dir);
    fs::create_dir_all(&dir)?;
    let path = session_path(data_dir, session_id);
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    let line = serde_json::to_string(record)?;
    writeln!(file, "{line}")?;
    Ok(())
}

pub fn read_records(data_dir: &Path, session_id: &str) -> Result<Vec<JsonlRecord>> {
    let path = session_path(data_dir, session_id);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(&path)?;
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(rec) = serde_json::from_str::<JsonlRecord>(&line) {
            out.push(rec);
        }
    }
    Ok(out)
}

pub fn fork_session(data_dir: &Path, from: &str, to: &str) -> Result<()> {
    let src = session_path(data_dir, from);
    let dst = session_path(data_dir, to);
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    if src.exists() {
        fs::copy(&src, &dst)?;
    } else {
        fs::write(&dst, "")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn append_and_read_roundtrip() {
        let dir = env::temp_dir().join(format!("prricode-jsonl-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let rec = JsonlRecord {
            kind: "user".into(),
            role: Some("user".into()),
            content: serde_json::json!({"text":"hi"}),
            uuid: Some("u1".into()),
            parent_uuid: None,
        };
        append_record(&dir, "s1", &rec).unwrap();
        let records = read_records(&dir, "s1").unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, "user");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fork_copies_records() {
        let dir = env::temp_dir().join(format!("prricode-jsonl-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        let rec = JsonlRecord {
            kind: "assistant".into(),
            role: Some("assistant".into()),
            content: serde_json::json!({"text":"hello"}),
            uuid: Some("a1".into()),
            parent_uuid: None,
        };
        append_record(&dir, "s1", &rec).unwrap();
        fork_session(&dir, "s1", "s2").unwrap();
        let records = read_records(&dir, "s2").unwrap();
        assert_eq!(records.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
