use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use tracing::info;

const GOALS_DB_SCHEMA: &str = r#"
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
"#;

#[derive(Debug)]
pub struct Persistence {
    db_path: String,
}

impl Persistence {
    pub fn new(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let db_path = data_dir.join("prricode.db");
        let db = Self { db_path: db_path.to_string_lossy().to_string() };
        db.init()?;
        Ok(db)
    }

    fn init(&self) -> Result<()> {
        let conn = rusqlite::Connection::open(&self.db_path)?;
        conn.execute_batch(GOALS_DB_SCHEMA)?;
        info!("Persistence initialized at {}", self.db_path);
        Ok(())
    }

    pub fn conn(&self) -> Result<rusqlite::Connection> {
        Ok(rusqlite::Connection::open(&self.db_path)?)
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
        let goal = stmt.query_row([session_id, goal_id], |row| {
            Ok(GoalRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                objective: row.get(2)?,
                status: row.get(3)?,
                percent_complete: row.get(4)?,
                current_work: row.get(5)?,
                next_work: row.get(6)?,
            })
        }).ok();
        Ok(goal)
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
