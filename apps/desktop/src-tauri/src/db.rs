//! SQLite storage: connection, PRAGMAs, migrations and row mappers.

use crate::error::{AppError, AppResult};
use crate::types::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

pub struct Db {
    conn: Mutex<Connection>,
}

const SCHEMA_V1: &str = r#"
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE prompt_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, built_in INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE prompts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
  category_id TEXT REFERENCES prompt_categories(id) ON DELETE SET NULL,
  tags_json TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
  preferred_model_ids_json TEXT NOT NULL, parameters_json TEXT NOT NULL,
  variable_defaults_json TEXT NOT NULL, version INTEGER NOT NULL, built_in INTEGER NOT NULL DEFAULT 0,
  source_job_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE prompt_versions (
  id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, tags_json TEXT NOT NULL,
  preferred_model_ids_json TEXT NOT NULL, parameters_json TEXT NOT NULL,
  variable_defaults_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(prompt_id, version));
CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL, model_name TEXT NOT NULL,
  workflow TEXT NOT NULL, output TEXT NOT NULL, provider_request_id TEXT, status TEXT NOT NULL,
  prompt TEXT NOT NULL, negative_prompt TEXT, params_json TEXT NOT NULL,
  requested_duration_sec REAL, estimated_cost_usd REAL, estimate_source TEXT, confirmed_cost_usd REAL,
  error_code TEXT, error_message TEXT,
  prompt_id TEXT REFERENCES prompts(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE, poll_url TEXT, result_url TEXT, cancel_url TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
  UNIQUE(provider, provider_request_id));
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  output_index INTEGER NOT NULL, kind TEXT NOT NULL, original_url TEXT NOT NULL, local_path TEXT,
  filename TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER, sha256 TEXT, duration_sec REAL,
  width INTEGER, height INTEGER, thumbnail_path TEXT, download_status TEXT NOT NULL,
  duplicate_of_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, UNIQUE(job_id, output_index));
CREATE INDEX media_assets_sha256 ON media_assets(sha256);
CREATE TABLE archive_items (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, custom_title TEXT,
  favorite INTEGER NOT NULL DEFAULT 0, tags_json TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER);
CREATE TABLE download_tasks (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL, bytes_downloaded INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER,
  validator TEXT, accept_ranges INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER, last_error TEXT, last_error_code TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE providers (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
  verification TEXT NOT NULL DEFAULT 'unknown', last_verified_at INTEGER, last_error TEXT,
  region TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
"#;

/// Migration 2: last-known-good signed model registry, catalog metadata,
/// and retirement of providers removed from this build (fal.ai).
const SCHEMA_V2: &str = r#"
CREATE TABLE catalog (id INTEGER PRIMARY KEY CHECK (id = 1), version TEXT NOT NULL,
  body TEXT NOT NULL, sig TEXT NOT NULL, applied_at INTEGER NOT NULL);
INSERT OR IGNORE INTO settings (key, value_json) VALUES ('catalog:meta', '{}');
INSERT OR IGNORE INTO settings (key, value_json) VALUES ('catalog:upstream', '{}');
UPDATE generation_jobs SET status='failed', error_code='provider_removed',
  error_message='This provider is no longer supported by Vidra Studio.',
  completed_at=COALESCE(completed_at, updated_at)
  WHERE provider NOT IN ('higgsfield','replicate','kling') AND status IN ('submitting','queued','generating');
DELETE FROM providers WHERE id NOT IN ('higgsfield','replicate','kling');
"#;

pub const BUILTIN_CATEGORIES: &[(&str, &str)] = &[
    ("cinematic-advertising", "Cinematic Advertising"),
    ("product-commercials", "Product Commercials"),
    ("social-media-reels", "Social Media Reels"),
    ("character-animation", "Character Animation"),
    ("realistic-human-scenes", "Realistic Human Scenes"),
    ("educational-videos", "Educational Videos"),
    ("storytelling", "Storytelling"),
    ("nature-landscapes", "Nature & Landscapes"),
    ("sports", "Sports"),
    ("fashion", "Fashion"),
    ("music-videos", "Music Videos"),
    ("animation", "Animation"),
];

impl Db {
    pub fn open(path: &Path) -> AppResult<Db> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> AppResult<Db> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> AppResult<Db> {
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let db = Db {
            conn: Mutex::new(conn),
        };
        db.migrate()?;
        Ok(db)
    }

    pub fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn user_version(&self) -> AppResult<i64> {
        Ok(self
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))?)
    }

    fn migrate(&self) -> AppResult<()> {
        let mut conn = self.conn();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V1)?;
            seed(&tx)?;
            tx.pragma_update(None, "user_version", 1)?;
            tx.commit()?;
        }
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 2 {
            let tx = conn.transaction()?;
            tx.execute_batch(SCHEMA_V2)?;
            tx.pragma_update(None, "user_version", 2)?;
            tx.commit()?;
        }
        Ok(())
    }
}

fn seed(tx: &rusqlite::Transaction) -> AppResult<()> {
    let now = now_ms();
    for (slug, name) in BUILTIN_CATEGORIES {
        tx.execute(
            "INSERT OR IGNORE INTO prompt_categories (id, name, built_in, created_at) VALUES (?1, ?2, 1, ?3)",
            params![format!("builtin-{slug}"), name, now],
        )?;
    }
    for p in ProviderId::ALL {
        tx.execute(
            "INSERT OR IGNORE INTO providers (id) VALUES (?1)",
            params![p.as_str()],
        )?;
    }
    let seed: Value = match serde_json::from_str(crate::bundled::SEED_PROMPTS) {
        Ok(v) => v,
        Err(e) => {
            log::error!("seed prompts invalid: {e}");
            return Ok(());
        }
    };
    let Some(prompts) = seed.get("prompts").and_then(Value::as_array) else {
        return Ok(());
    };
    for p in prompts {
        let title = p
            .get("title")
            .and_then(|t| t.get("en").or(Some(t)))
            .and_then(Value::as_str)
            .unwrap_or("Untitled");
        let Some(body) = p.get("body").and_then(Value::as_str) else {
            continue;
        };
        let category = p
            .get("category")
            .and_then(Value::as_str)
            .map(|c| format!("builtin-{c}"))
            .filter(|c| {
                BUILTIN_CATEGORIES
                    .iter()
                    .any(|(s, _)| format!("builtin-{s}") == *c)
            });
        let j = |k: &str, d: &str| p.get(k).map(|v| v.to_string()).unwrap_or_else(|| d.into());
        tx.execute(
            "INSERT INTO prompts (id, title, body, category_id, tags_json, favorite, preferred_model_ids_json,
               parameters_json, variable_defaults_json, version, built_in, source_job_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?8, 1, 1, NULL, ?9, ?9)",
            params![
                new_id(),
                title,
                body,
                category,
                j("tags", "[]"),
                j("preferredModelIds", "[]"),
                j("parameters", "{}"),
                j("variableDefaults", "{}"),
                now
            ],
        )?;
    }
    Ok(())
}

/* ── Row mappers ───────────────────────────────────────────────────────── */

fn json_col<T: serde::de::DeserializeOwned + Default>(s: String) -> T {
    serde_json::from_str(&s).unwrap_or_default()
}

pub const JOB_COLS: &str = "id, provider, model_id, model_name, workflow, output, provider_request_id, status,
  prompt, negative_prompt, params_json, requested_duration_sec, estimated_cost_usd, estimate_source,
  confirmed_cost_usd, error_code, error_message, prompt_id, project_id, created_at, updated_at, completed_at";

pub fn job_from_row(r: &Row, o: usize) -> rusqlite::Result<GenerationJob> {
    let provider: String = r.get(o + 1)?;
    Ok(GenerationJob {
        id: r.get(o)?,
        provider: ProviderId::parse(&provider).unwrap_or(ProviderId::Replicate),
        model_id: r.get(o + 2)?,
        model_name: r.get(o + 3)?,
        workflow: r.get(o + 4)?,
        output: r.get(o + 5)?,
        provider_request_id: r.get(o + 6)?,
        status: JobStatus::parse(&r.get::<_, String>(o + 7)?),
        prompt: r.get(o + 8)?,
        negative_prompt: r.get(o + 9)?,
        params: json_col(r.get(o + 10)?),
        requested_duration_sec: r.get(o + 11)?,
        estimated_cost_usd: r.get(o + 12)?,
        estimate_source: r.get(o + 13)?,
        confirmed_cost_usd: r.get(o + 14)?,
        error_code: r.get(o + 15)?,
        error_message: r.get(o + 16)?,
        prompt_id: r.get(o + 17)?,
        project_id: r.get(o + 18)?,
        created_at: r.get(o + 19)?,
        updated_at: r.get(o + 20)?,
        completed_at: r.get(o + 21)?,
    })
}
pub const JOB_NCOLS: usize = 22;

pub const ASSET_COLS: &str = "id, job_id, output_index, kind, original_url, local_path, filename, mime_type,
  size_bytes, sha256, duration_sec, width, height, thumbnail_path, download_status, duplicate_of_asset_id, created_at";
pub const ASSET_NCOLS: usize = 17;

pub fn asset_from_row(r: &Row, o: usize) -> rusqlite::Result<MediaAsset> {
    Ok(MediaAsset {
        id: r.get(o)?,
        job_id: r.get(o + 1)?,
        output_index: r.get(o + 2)?,
        kind: r.get(o + 3)?,
        original_url: r.get(o + 4)?,
        local_path: r.get(o + 5)?,
        filename: r.get(o + 6)?,
        mime_type: r.get(o + 7)?,
        size_bytes: r.get(o + 8)?,
        sha256: r.get(o + 9)?,
        duration_sec: r.get(o + 10)?,
        width: r.get(o + 11)?,
        height: r.get(o + 12)?,
        thumbnail_path: r.get(o + 13)?,
        download_status: r.get(o + 14)?,
        duplicate_of_asset_id: r.get(o + 15)?,
        created_at: r.get(o + 16)?,
    })
}

pub const ITEM_COLS: &str =
    "id, asset_id, project_id, custom_title, favorite, tags_json, deleted_at";
pub const ITEM_NCOLS: usize = 7;

pub fn item_from_row(r: &Row, o: usize) -> rusqlite::Result<ArchiveItem> {
    Ok(ArchiveItem {
        id: r.get(o)?,
        asset_id: r.get(o + 1)?,
        project_id: r.get(o + 2)?,
        custom_title: r.get(o + 3)?,
        favorite: r.get::<_, i64>(o + 4)? != 0,
        tags: json_col(r.get(o + 5)?),
        deleted_at: r.get(o + 6)?,
    })
}

pub const TASK_COLS: &str =
    "id, asset_id, status, bytes_downloaded, total_bytes, retry_count, next_attempt_at,
  last_error, last_error_code, updated_at";
pub const TASK_NCOLS: usize = 10;

pub fn task_from_row(r: &Row, o: usize) -> rusqlite::Result<DownloadTask> {
    Ok(DownloadTask {
        id: r.get(o)?,
        asset_id: r.get(o + 1)?,
        status: r.get(o + 2)?,
        bytes_downloaded: r.get(o + 3)?,
        total_bytes: r.get(o + 4)?,
        retry_count: r.get(o + 5)?,
        next_attempt_at: r.get(o + 6)?,
        last_error: r.get(o + 7)?,
        last_error_code: r.get(o + 8)?,
        updated_at: r.get(o + 9)?,
    })
}

pub const PROMPT_COLS: &str = "id, title, body, category_id, tags_json, favorite, preferred_model_ids_json,
  parameters_json, variable_defaults_json, version, built_in, source_job_id, created_at, updated_at";

pub fn prompt_from_row(r: &Row) -> rusqlite::Result<Prompt> {
    Ok(Prompt {
        id: r.get(0)?,
        title: r.get(1)?,
        body: r.get(2)?,
        category_id: r.get(3)?,
        tags: json_col(r.get(4)?),
        favorite: r.get::<_, i64>(5)? != 0,
        preferred_model_ids: json_col(r.get(6)?),
        parameters: json_col(r.get(7)?),
        variable_defaults: json_col(r.get(8)?),
        version: r.get(9)?,
        built_in: r.get::<_, i64>(10)? != 0,
        source_job_id: r.get(11)?,
        created_at: r.get(12)?,
        updated_at: r.get(13)?,
    })
}

pub const VERSION_COLS: &str =
    "id, prompt_id, version, title, body, tags_json, preferred_model_ids_json,
  parameters_json, variable_defaults_json, created_at";

pub fn version_from_row(r: &Row) -> rusqlite::Result<PromptVersion> {
    Ok(PromptVersion {
        id: r.get(0)?,
        prompt_id: r.get(1)?,
        version: r.get(2)?,
        title: r.get(3)?,
        body: r.get(4)?,
        tags: json_col(r.get(5)?),
        preferred_model_ids: json_col(r.get(6)?),
        parameters: json_col(r.get(7)?),
        variable_defaults: json_col(r.get(8)?),
        created_at: r.get(9)?,
    })
}

pub fn category_from_row(r: &Row) -> rusqlite::Result<PromptCategory> {
    Ok(PromptCategory {
        id: r.get(0)?,
        name: r.get(1)?,
        built_in: r.get::<_, i64>(2)? != 0,
        created_at: r.get(3)?,
    })
}

/* ── Small shared repositories ─────────────────────────────────────────── */

pub fn get_job(conn: &Connection, id: &str) -> AppResult<Option<GenerationJob>> {
    Ok(conn
        .query_row(
            &format!("SELECT {JOB_COLS} FROM generation_jobs WHERE id = ?1"),
            [id],
            |r| job_from_row(r, 0),
        )
        .optional()?)
}

pub fn get_asset(conn: &Connection, id: &str) -> AppResult<Option<MediaAsset>> {
    Ok(conn
        .query_row(
            &format!("SELECT {ASSET_COLS} FROM media_assets WHERE id = ?1"),
            [id],
            |r| asset_from_row(r, 0),
        )
        .optional()?)
}

pub fn get_task(conn: &Connection, asset_id: &str) -> AppResult<Option<DownloadTask>> {
    Ok(conn
        .query_row(
            &format!("SELECT {TASK_COLS} FROM download_tasks WHERE asset_id = ?1"),
            [asset_id],
            |r| task_from_row(r, 0),
        )
        .optional()?)
}

pub fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value_json FROM settings WHERE key = ?1",
            [key],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        params![key, value],
    )?;
    Ok(())
}

/* ── Projects ──────────────────────────────────────────────────────────── */

pub fn validate_name(name: &str, max: usize) -> AppResult<String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > max || n.chars().any(char::is_control) {
        return Err(AppError::invalid(format!(
            "Names must be 1–{max} characters."
        )));
    }
    Ok(n.to_string())
}

fn unique_violation(e: &rusqlite::Error) -> bool {
    matches!(e, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation)
}

pub fn list_projects(conn: &Connection) -> AppResult<Vec<Project>> {
    let mut st =
        conn.prepare("SELECT id, name, created_at FROM projects ORDER BY name COLLATE NOCASE")?;
    let rows = st.query_map([], |r| {
        Ok(Project {
            id: r.get(0)?,
            name: r.get(1)?,
            created_at: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create_project(conn: &Connection, name: &str) -> AppResult<Project> {
    let name = validate_name(name, 80)?;
    let p = Project {
        id: new_id(),
        name,
        created_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO projects (id, name, created_at) VALUES (?1, ?2, ?3)",
        params![p.id, p.name, p.created_at],
    )
    .map_err(|e| {
        if unique_violation(&e) {
            AppError::invalid("A project with this name already exists.")
        } else {
            e.into()
        }
    })?;
    Ok(p)
}

pub fn rename_project(conn: &Connection, id: &str, name: &str) -> AppResult<()> {
    validate_id(id)?;
    let name = validate_name(name, 80)?;
    let n = conn
        .execute(
            "UPDATE projects SET name = ?2 WHERE id = ?1",
            params![id, name],
        )
        .map_err(|e| {
            if unique_violation(&e) {
                AppError::invalid("A project with this name already exists.")
            } else {
                e.into()
            }
        })?;
    if n == 0 {
        return Err(AppError::not_found("Project not found."));
    }
    Ok(())
}

pub fn delete_project(conn: &Connection, id: &str) -> AppResult<()> {
    validate_id(id)?;
    conn.execute("DELETE FROM projects WHERE id = ?1", [id])?;
    Ok(())
}

pub(crate) fn map_unique(e: rusqlite::Error, msg: &str) -> AppError {
    if unique_violation(&e) {
        AppError::invalid(msg)
    } else {
        e.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v1_database_upgrades_to_v2_and_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v1.sqlite3");
        {
            // Build a pure v1 database exactly as the previous release did.
            let mut conn = Connection::open(&path).unwrap();
            let tx = conn.transaction().unwrap();
            tx.execute_batch(SCHEMA_V1).unwrap();
            tx.execute(
                "INSERT INTO providers (id) VALUES ('fal'),('higgsfield'),('replicate'),('kling')",
                [],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO projects (id,name,created_at) VALUES ('p1','Keep me',1)",
                [],
            )
            .unwrap();
            for (id, prov, status) in [
                ("j1", "higgsfield", "completed"),
                ("j2", "fal", "queued"),
                ("j3", "replicate", "queued"),
            ] {
                tx.execute("INSERT INTO generation_jobs (id,provider,model_id,model_name,workflow,output,status,prompt,params_json,idempotency_key,created_at,updated_at) VALUES (?1,?2,'m','m','text-to-video','video',?3,'x','{}',?1,5,5)", params![id, prov, status]).unwrap();
            }
            tx.execute(
                "INSERT INTO settings (key,value_json) VALUES ('app','{\"x\":1}')",
                [],
            )
            .unwrap();
            tx.pragma_update(None, "user_version", 1).unwrap();
            tx.commit().unwrap();
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(db.user_version().unwrap(), 2);
        let c = db.conn();
        let name: String = c
            .query_row("SELECT name FROM projects WHERE id='p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(name, "Keep me");
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM generation_jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3, "no job is deleted");
        let st: (String, String) = c
            .query_row(
                "SELECT status, error_code FROM generation_jobs WHERE id='j2'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(st, ("failed".into(), "provider_removed".into()));
        let st: String = c
            .query_row(
                "SELECT status FROM generation_jobs WHERE id='j3'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(st, "queued");
        let app: String = c
            .query_row("SELECT value_json FROM settings WHERE key='app'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(app, "{\"x\":1}");
        let p: i64 = c
            .query_row("SELECT COUNT(*) FROM providers", [], |r| r.get(0))
            .unwrap();
        assert_eq!(p, 3);
        let cat: i64 = c
            .query_row("SELECT COUNT(*) FROM catalog", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cat, 0);
    }

    #[test]
    fn migrates_from_empty_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v.sqlite3");
        {
            let db = Db::open(&path).unwrap();
            assert_eq!(db.user_version().unwrap(), 2);
            let n: i64 = db
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM prompt_categories WHERE built_in=1",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 12);
            let p: i64 = db
                .conn()
                .query_row("SELECT COUNT(*) FROM prompts WHERE built_in=1", [], |r| {
                    r.get(0)
                })
                .unwrap();
            assert!(p > 0);
        }
        let db = Db::open(&path).unwrap();
        assert_eq!(db.user_version().unwrap(), 2);
        let n: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM prompt_categories", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 12, "re-run does not re-seed");
        let fk: i64 = db
            .conn()
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1);
        let mode: String = db
            .conn()
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }

    #[test]
    fn fk_cascade_rules() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let proj = create_project(&c, "P").unwrap();
        c.execute("INSERT INTO prompts (id,title,body,tags_json,preferred_model_ids_json,parameters_json,variable_defaults_json,version,created_at,updated_at) VALUES ('p1','t','b','[]','[]','{}','{}',1,0,0)", []).unwrap();
        c.execute("INSERT INTO prompt_versions (id,prompt_id,version,title,body,tags_json,preferred_model_ids_json,parameters_json,variable_defaults_json,created_at) VALUES ('v1','p1',1,'t','b','[]','[]','{}','{}',0)", []).unwrap();
        c.execute("INSERT INTO generation_jobs (id,provider,model_id,model_name,workflow,output,status,prompt,params_json,prompt_id,project_id,idempotency_key,created_at,updated_at) VALUES ('j1','replicate','m','m','text-to-video','video','completed','x','{}','p1',?1,'k1',0,0)", [&proj.id]).unwrap();
        c.execute("INSERT INTO media_assets (id,job_id,output_index,kind,original_url,filename,download_status,created_at) VALUES ('a1','j1',0,'video','https://x','f','pending',0)", []).unwrap();
        c.execute(
            "INSERT INTO archive_items (id,asset_id,project_id) VALUES ('i1','a1',?1)",
            [&proj.id],
        )
        .unwrap();
        c.execute("INSERT INTO download_tasks (id,asset_id,status,updated_at) VALUES ('t1','a1','pending',0)", []).unwrap();
        // project delete → SET NULL
        delete_project(&c, &proj.id).unwrap();
        let pj: Option<String> = c
            .query_row(
                "SELECT project_id FROM generation_jobs WHERE id='j1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(pj.is_none());
        let pi: Option<String> = c
            .query_row(
                "SELECT project_id FROM archive_items WHERE id='i1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(pi.is_none());
        // job delete cascades assets/items/tasks but keeps the prompt
        c.execute("DELETE FROM generation_jobs WHERE id='j1'", [])
            .unwrap();
        for t in ["media_assets", "archive_items", "download_tasks"] {
            let n: i64 = c
                .query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{t}");
        }
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM prompts WHERE id='p1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1);
        // prompt delete cascades versions
        c.execute("DELETE FROM prompts WHERE id='p1'", []).unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM prompt_versions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
