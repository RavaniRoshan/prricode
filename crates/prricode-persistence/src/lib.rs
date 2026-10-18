use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tracing::info;

mod jsonl;
pub use jsonl::*;

const GOALS_DB_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    percent_complete INTEGER NOT NULL DEFAULT 0,
    current_work TEXT,
    next_work TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    workspace_root TEXT,
    model_id TEXT,
    provider_id TEXT,
    approval_mode TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    role TEXT,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    requirement_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    token_budget INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_attempts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_uploads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    media_type TEXT NOT NULL,
    total_bytes INTEGER NOT NULL,
    chunks_received INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    description TEXT,
    version TEXT,
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS hooks (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    event_type TEXT NOT NULL,
    handler TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost REAL NOT NULL DEFAULT 0,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gate_records (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    gate TEXT NOT NULL,
    command TEXT NOT NULL,
    exit_code INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    evidence_tail TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_session_created ON items (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_records (session_id);
CREATE INDEX IF NOT EXISTS idx_gate_records_run ON gate_records (run_id);
"#;

#[derive(Debug)]
pub struct Persistence {
    db_path: String,
}

impl Persistence {
    pub fn new(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let db_path = data_dir.join("prricode.db");
        let db = Self {
            db_path: db_path.to_string_lossy().to_string(),
        };
        db.init()?;
        Ok(db)
    }

    fn init(&self) -> Result<()> {
        let conn = self.conn()?;
        conn.execute_batch(GOALS_DB_SCHEMA)?;
        info!("Persistence initialized at {}", self.db_path);
        Ok(())
    }

    pub fn conn(&self) -> Result<rusqlite::Connection> {
        let conn = rusqlite::Connection::open(&self.db_path)?;
        conn.busy_timeout(std::time::Duration::from_millis(5000))?;
        Ok(conn)
    }

    pub fn data_dir(&self) -> &Path {
        Path::new(&self.db_path).parent().unwrap_or(Path::new("."))
    }

    pub fn save_session(&self, session: &SessionRecord) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO sessions (id, workspace_root, model_id, provider_id, approval_mode, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            (&session.id, &session.workspace_root, &session.model_id, &session.provider_id, &session.approval_mode),
        )?;
        Ok(())
    }

    pub fn save_goal(&self, goal: &GoalRecord) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO goals (id, session_id, objective, status, percent_complete, current_work, next_work, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now'))",
            (&goal.id, &goal.session_id, &goal.objective, &goal.status, &goal.percent_complete, &goal.current_work, &goal.next_work),
        )?;
        Ok(())
    }

    pub fn get_goal(&self, session_id: &str, goal_id: &str) -> Result<Option<GoalRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, objective, status, percent_complete, current_work, next_work FROM goals WHERE session_id=?1 AND id=?2"
        )?;
        let goal = stmt
            .query_row([session_id, goal_id], |row| {
                Ok(GoalRecord {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    objective: row.get(2)?,
                    status: row.get(3)?,
                    percent_complete: row.get(4)?,
                    current_work: row.get(5)?,
                    next_work: row.get(6)?,
                })
            })
            .ok();
        Ok(goal)
    }

    pub fn list_goals(&self, session_id: &str) -> Result<Vec<GoalRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, objective, status, percent_complete, current_work, next_work FROM goals WHERE session_id=?1 ORDER BY created_at DESC"
        )?;
        let rows = stmt.query_map([session_id], |row| {
            Ok(GoalRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                objective: row.get(2)?,
                status: row.get(3)?,
                percent_complete: row.get(4)?,
                current_work: row.get(5)?,
                next_work: row.get(6)?,
            })
        })?;
        Ok(rows.flatten().collect())
    }

    pub fn delete_goals(&self, session_id: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute("DELETE FROM goals WHERE session_id=?1", [session_id])?;
        Ok(())
    }

    pub fn list_sessions(&self) -> Result<Vec<SessionRecord>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace_root, model_id, provider_id, approval_mode FROM sessions ORDER BY updated_at DESC"
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(SessionRecord {
                id: row.get(0)?,
                workspace_root: row.get(1)?,
                model_id: row.get(2)?,
                provider_id: row.get(3)?,
                approval_mode: row.get(4)?,
            })
        })?;
        Ok(rows.flatten().collect())
    }

    // ---- items ----

    pub fn save_item(&self, item: &ItemRecord) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO items (id, session_id, kind, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))",
            (
                &item.id,
                &item.session_id,
                &item.kind,
                &item.role,
                &item.content,
            ),
        )?;
        Ok(())
    }

    pub fn list_items(&self, session_id: &str, limit: Option<u32>) -> Result<Vec<ItemRecord>> {
        let conn = self.conn()?;
        let limit = limit.unwrap_or(1000).min(10_000) as i64;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, kind, role, content, created_at FROM items
             WHERE session_id=?1 ORDER BY created_at ASC, rowid ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(rusqlite::params![session_id, limit], |row| {
            Ok(ItemRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                kind: row.get(2)?,
                role: row.get(3)?,
                content: row.get(4)?,
                created_at: row.get(5)?,
            })
        })?;
        Ok(rows.flatten().collect())
    }

    pub fn save_summary_item(&self, session_id: &str, summary: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO items (id, session_id, kind, role, content, created_at)
             VALUES (?1, ?2, 'summary', 'system', ?3, datetime('now'))",
            rusqlite::params![uuid::Uuid::now_v7().to_string(), session_id, summary],
        )?;
        Ok(())
    }

    // ---- usage ----

    pub fn save_usage(
        &self,
        session_id: &str,
        input_tokens: u32,
        output_tokens: u32,
        cost: f64,
    ) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO usage_records (session_id, input_tokens, output_tokens, cost)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![session_id, input_tokens, output_tokens, cost],
        )?;
        Ok(())
    }

    pub fn usage_summary(&self, session_id: &str) -> Result<(u64, u64, f64)> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cost),0)
             FROM usage_records WHERE session_id=?1"
        )?;
        let row = stmt.query_row([session_id], |row| {
            Ok((
                row.get::<_, i64>(0)? as u64,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, f64>(2)?,
            ))
        })?;
        Ok(row)
    }

    // ---- settings ----

    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, datetime('now'))",
            [key, value],
        )?;
        Ok(())
    }

    pub fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.conn()?;
        let value = conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .ok();
        Ok(value)
    }

    pub fn list_settings(&self) -> Result<Vec<(String, String)>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.flatten().collect())
    }

    // ---- gate records ----

    pub fn save_gate_record(&self, record: &GateRecordRow) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO gate_records (id, run_id, gate, command, exit_code, passed, evidence_tail, duration_ms, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))",
            (
                &record.id,
                &record.run_id,
                &record.gate,
                &record.command,
                &record.exit_code,
                &record.passed,
                &record.evidence_tail,
                &record.duration_ms,
            ),
        )?;
        Ok(())
    }

    pub fn list_gate_records(&self, run_id: &str) -> Result<Vec<GateRecordRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT id, run_id, gate, command, exit_code, passed, evidence_tail, duration_ms, created_at
             FROM gate_records WHERE run_id=?1 ORDER BY created_at ASC, rowid ASC"
        )?;
        let rows = stmt.query_map([run_id], |row| {
            Ok(GateRecordRow {
                id: row.get(0)?,
                run_id: row.get(1)?,
                gate: row.get(2)?,
                command: row.get(3)?,
                exit_code: row.get(4)?,
                passed: row.get(5)?,
                evidence_tail: row.get(6)?,
                duration_ms: row.get(7)?,
                created_at: row.get(8)?,
            })
        })?;
        Ok(rows.flatten().collect())
    }
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct SessionRecord {
    pub id: String,
    pub workspace_root: Option<String>,
    pub model_id: Option<String>,
    pub provider_id: Option<String>,
    pub approval_mode: Option<String>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct GoalRecord {
    pub id: String,
    pub session_id: String,
    pub objective: String,
    pub status: String,
    pub percent_complete: i32,
    pub current_work: Option<String>,
    pub next_work: Option<String>,
}

#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct ItemRecord {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub role: Option<String>,
    pub content: String,
    #[serde(default)]
    pub created_at: String,
}

/// One persisted verification gate execution.
#[derive(Debug, Implementation, Serialize, Deserialize)]
pub struct GateRecordRow {
    pub id: String,
    pub run_id: String,
    pub gate: String,
    pub command: String,
    pub exit_code: i32,
    pub passed: bool,
    pub evidence_tail: String,
    pub duration_ms: u64,
    #[serde(default)]
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_persistence_lifecycle_and_indices() {
        let temp_path =
            std::env::temp_dir().join(format!("prricode-test-{}", uuid::Uuid::now_v7()));
        let p = Persistence::new(&temp_path).unwrap();

        // Verify tables and indices exist in sqlite_master
        let conn = p.conn().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='index'")
            .unwrap();
        let indices: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .flatten()
            .collect();
        assert!(indices.contains(&"idx_items_session_created".to_string()));
        assert!(indices.contains(&"idx_usage_session".to_string()));
        assert!(indices.contains(&"idx_gate_records_run".to_string()));

        // Test settings
        p.set_setting("theme", "dracula").unwrap();
        p.set_setting("approvalAmendment:/tmp/ws:shell:cargo", "{}")
            .unwrap();
        let settings = p.list_settings().unwrap();
        assert_eq!(settings.len(), 2);
        assert_eq!(p.get_setting("theme").unwrap().as_deref(), Some("dracula"));

        // Test items
        let item = ItemRecord {
            id: "i1".into(),
            session_id: "s1".into(),
            kind: "user".into(),
            role: Some("user".into()),
            content: r#"{"content":[{"type":"text","text":"hello"}]}"#.into(),
            created_at: String::new(),
        };
        p.save_item(&item).unwrap();
        let items = p.list_items("s1", None).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "i1");

        // Test gate records
        let gate = GateRecordRow {
            id: "g1".into(),
            run_id: "r1".into(),
            gate: "test".into(),
            command: "cargo test".into(),
            exit_code: 0,
            passed: true,
            evidence_tail: "ok".into(),
            duration_ms: 100,
            created_at: String::new(),
        };
        p.save_gate_record(&gate).unwrap();
        let gates = p.list_gate_records("r1").unwrap();
        assert_eq!(gates.len(), 1);
        assert_eq!(gates[0].id, "g1");

        let _ = std::fs::remove_dir_all(&temp_path);
    }
}
