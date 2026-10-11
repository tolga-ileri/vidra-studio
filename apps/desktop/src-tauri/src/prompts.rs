//! Prompt Library: CRUD with version history, categories, JSON import/export
//! (schema of `packages/core/src/prompt-io.ts`).

use crate::core::Core;
use crate::db::{self, PROMPT_COLS, VERSION_COLS};
use crate::error::{AppError, AppResult};
use crate::types::*;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::OnceLock;

fn key_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_]{0,47}$").expect("regex"))
}

fn valid_param_value(v: &Value) -> bool {
    match v {
        Value::String(s) => s.chars().count() <= 4096,
        Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
        Value::Bool(_) => true,
        Value::Array(a) => {
            a.len() <= 20
                && a.iter()
                    .all(|x| x.as_str().is_some_and(|s| s.chars().count() <= 4096))
        }
        _ => false,
    }
}

fn check_parameters(p: &ParamValues) -> AppResult<()> {
    if p.len() > 60
        || p.iter()
            .any(|(k, v)| !key_re().is_match(k) || !valid_param_value(v))
    {
        return Err(AppError::invalid("Invalid parameter preset."));
    }
    Ok(())
}

fn check_variables(v: &BTreeMap<String, String>) -> AppResult<()> {
    if v.len() > 60
        || v.iter()
            .any(|(k, val)| !key_re().is_match(k) || val.chars().count() > 1000)
    {
        return Err(AppError::invalid("Invalid variable defaults."));
    }
    Ok(())
}

fn check_models(ids: &[String]) -> AppResult<()> {
    if ids.len() > 20 || ids.iter().any(|m| m.is_empty() || m.chars().count() > 200) {
        return Err(AppError::invalid("Invalid preferred models."));
    }
    Ok(())
}

pub struct Clean {
    title: String,
    body: String,
    category_id: Option<String>,
    tags: Vec<String>,
    favorite: bool,
    models: Vec<String>,
    parameters: ParamValues,
    variables: BTreeMap<String, String>,
    source_job_id: Option<String>,
}

fn clean(conn: &Connection, input: PromptInput) -> AppResult<Clean> {
    let title = input.title.trim().to_string();
    if title.is_empty() || title.chars().count() > 120 {
        return Err(AppError::invalid("Titles must be 1–120 characters."));
    }
    if input.body.trim().is_empty() || input.body.chars().count() > 20000 {
        return Err(AppError::invalid("Prompt text must be 1–20000 characters."));
    }
    if let Some(c) = &input.category_id {
        validate_id(c)?;
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM prompt_categories WHERE id=?1",
            [c],
            |r| r.get(0),
        )?;
        if n == 0 {
            return Err(AppError::not_found("Category not found."));
        }
    }
    if let Some(j) = &input.source_job_id {
        validate_id(j)?;
    }
    check_models(&input.preferred_model_ids)?;
    check_parameters(&input.parameters)?;
    check_variables(&input.variable_defaults)?;
    Ok(Clean {
        title,
        body: input.body,
        category_id: input.category_id,
        tags: crate::archive::normalize_tags(&input.tags)?,
        favorite: input.favorite,
        models: input.preferred_model_ids,
        parameters: input.parameters,
        variables: input.variable_defaults,
        source_job_id: input.source_job_id,
    })
}

pub fn get(conn: &Connection, id: &str) -> AppResult<Option<Prompt>> {
    Ok(conn
        .query_row(
            &format!("SELECT {PROMPT_COLS} FROM prompts WHERE id=?1"),
            [id],
            db::prompt_from_row,
        )
        .optional()?)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromptQuery {
    pub search: Option<String>,
    pub category_id: Option<String>,
    pub favorite: Option<bool>,
    pub tag: Option<String>,
}

pub fn list(core: &Core, q: &PromptQuery) -> AppResult<Vec<Prompt>> {
    let c = core.db.conn();
    let mut st = c.prepare(&format!(
        "SELECT {PROMPT_COLS} FROM prompts ORDER BY favorite DESC, updated_at DESC"
    ))?;
    let rows = st.query_map([], db::prompt_from_row)?;
    let search = q
        .search
        .as_deref()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let mut out = Vec::new();
    for p in rows {
        let p = p?;
        if q.category_id
            .as_ref()
            .is_some_and(|c| p.category_id.as_ref() != Some(c))
        {
            continue;
        }
        if q.favorite.is_some_and(|f| p.favorite != f) {
            continue;
        }
        if q.tag
            .as_ref()
            .is_some_and(|t| !p.tags.iter().any(|x| x.eq_ignore_ascii_case(t)))
        {
            continue;
        }
        if let Some(s) = &search {
            let hit = p.title.to_lowercase().contains(s)
                || p.body.to_lowercase().contains(s)
                || p.tags.iter().any(|t| t.to_lowercase().contains(s));
            if !hit {
                continue;
            }
        }
        out.push(p);
    }
    Ok(out)
}

fn insert(conn: &Connection, c: &Clean, built_in: bool) -> AppResult<String> {
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO prompts (id, title, body, category_id, tags_json, favorite, preferred_model_ids_json, parameters_json,
           variable_defaults_json, version, built_in, source_job_id, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?10,?11,?12,?12)",
        params![
            id, c.title, c.body, c.category_id, serde_json::to_string(&c.tags)?, c.favorite as i64,
            serde_json::to_string(&c.models)?, serde_json::to_string(&c.parameters)?,
            serde_json::to_string(&c.variables)?, built_in as i64, c.source_job_id, now
        ],
    )?;
    Ok(id)
}

pub fn create(core: &Core, input: PromptInput) -> AppResult<Prompt> {
    let c = core.db.conn();
    let clean = clean(&c, input)?;
    let id = insert(&c, &clean, false)?;
    let p = get(&c, &id)?.ok_or_else(|| AppError::not_found("Prompt not found."))?;
    drop(c);
    core.emit(StoreEvent::PromptsChanged);
    Ok(p)
}

fn snapshot(conn: &Connection, p: &Prompt) -> AppResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO prompt_versions (id, prompt_id, version, title, body, tags_json, preferred_model_ids_json,
           parameters_json, variable_defaults_json, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            new_id(), p.id, p.version, p.title, p.body, serde_json::to_string(&p.tags)?,
            serde_json::to_string(&p.preferred_model_ids)?, serde_json::to_string(&p.parameters)?,
            serde_json::to_string(&p.variable_defaults)?, p.updated_at
        ],
    )?;
    Ok(())
}

pub fn update(core: &Core, id: &str, input: PromptInput) -> AppResult<Prompt> {
    validate_id(id)?;
    let mut conn = core.db.conn();
    let clean = clean(&conn, input)?;
    let tx = conn.transaction()?;
    let cur = get(&tx, id)?.ok_or_else(|| AppError::not_found("Prompt not found."))?;
    snapshot(&tx, &cur)?;
    tx.execute(
        "UPDATE prompts SET title=?2, body=?3, category_id=?4, tags_json=?5, favorite=?6, preferred_model_ids_json=?7,
           parameters_json=?8, variable_defaults_json=?9, version=version+1, updated_at=?10,
           source_job_id=COALESCE(?11, source_job_id) WHERE id=?1",
        params![
            id, clean.title, clean.body, clean.category_id, serde_json::to_string(&clean.tags)?, clean.favorite as i64,
            serde_json::to_string(&clean.models)?, serde_json::to_string(&clean.parameters)?,
            serde_json::to_string(&clean.variables)?, now_ms().max(cur.updated_at + 1), clean.source_job_id
        ],
    )?;
    let p = get(&tx, id)?.ok_or_else(|| AppError::not_found("Prompt not found."))?;
    tx.commit()?;
    drop(conn);
    core.emit(StoreEvent::PromptsChanged);
    Ok(p)
}

pub fn duplicate(core: &Core, id: &str) -> AppResult<Prompt> {
    validate_id(id)?;
    let c = core.db.conn();
    let p = get(&c, id)?.ok_or_else(|| AppError::not_found("Prompt not found."))?;
    let mut title: String = format!("{} (copy)", p.title).chars().take(120).collect();
    title = title.trim().to_string();
    let clean = Clean {
        title,
        body: p.body,
        category_id: p.category_id,
        tags: p.tags,
        favorite: false,
        models: p.preferred_model_ids,
        parameters: p.parameters,
        variables: p.variable_defaults,
        source_job_id: p.source_job_id,
    };
    let nid = insert(&c, &clean, false)?;
    let out = get(&c, &nid)?.ok_or_else(|| AppError::not_found("Prompt not found."))?;
    drop(c);
    core.emit(StoreEvent::PromptsChanged);
    Ok(out)
}

pub fn delete(core: &Core, id: &str) -> AppResult<()> {
    validate_id(id)?;
    core.db
        .conn()
        .execute("DELETE FROM prompts WHERE id=?1", [id])?;
    core.emit(StoreEvent::PromptsChanged);
    Ok(())
}

pub fn set_favorite(core: &Core, id: &str, fav: bool) -> AppResult<()> {
    validate_id(id)?;
    core.db.conn().execute(
        "UPDATE prompts SET favorite=?2 WHERE id=?1",
        params![id, fav as i64],
    )?;
    core.emit(StoreEvent::PromptsChanged);
    Ok(())
}

pub fn versions(core: &Core, id: &str) -> AppResult<Vec<PromptVersion>> {
    validate_id(id)?;
    let c = core.db.conn();
    let mut st = c.prepare(&format!(
        "SELECT {VERSION_COLS} FROM prompt_versions WHERE prompt_id=?1 ORDER BY version DESC"
    ))?;
    let rows = st.query_map([id], db::version_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Restoring creates a new version (the current one is snapshotted first).
pub fn restore_version(core: &Core, id: &str, version: i64) -> AppResult<Prompt> {
    validate_id(id)?;
    let v = {
        let c = core.db.conn();
        c.query_row(
            &format!(
                "SELECT {VERSION_COLS} FROM prompt_versions WHERE prompt_id=?1 AND version=?2"
            ),
            params![id, version],
            db::version_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Version not found."))?
    };
    let cur = get(&core.db.conn(), id)?.ok_or_else(|| AppError::not_found("Prompt not found."))?;
    update(
        core,
        id,
        PromptInput {
            title: v.title,
            body: v.body,
            category_id: cur.category_id,
            tags: v.tags,
            favorite: cur.favorite,
            preferred_model_ids: v.preferred_model_ids,
            parameters: v.parameters,
            variable_defaults: v.variable_defaults,
            source_job_id: None,
        },
    )
}

/* ── Categories ────────────────────────────────────────────────────────── */

pub fn categories(core: &Core) -> AppResult<Vec<PromptCategory>> {
    let c = core.db.conn();
    let mut st = c.prepare("SELECT id, name, built_in, created_at FROM prompt_categories ORDER BY built_in DESC, name COLLATE NOCASE")?;
    let rows = st.query_map([], db::category_from_row)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn create_category(core: &Core, name: &str) -> AppResult<PromptCategory> {
    let name = db::validate_name(name, 60)?;
    let cat = PromptCategory {
        id: new_id(),
        name,
        built_in: false,
        created_at: now_ms(),
    };
    core.db
        .conn()
        .execute(
            "INSERT INTO prompt_categories (id, name, built_in, created_at) VALUES (?1, ?2, 0, ?3)",
            params![cat.id, cat.name, cat.created_at],
        )
        .map_err(|e| db::map_unique(e, "A category with this name already exists."))?;
    core.emit(StoreEvent::PromptsChanged);
    Ok(cat)
}

pub fn rename_category(core: &Core, id: &str, name: &str) -> AppResult<()> {
    validate_id(id)?;
    let name = db::validate_name(name, 60)?;
    let n = core
        .db
        .conn()
        .execute(
            "UPDATE prompt_categories SET name=?2 WHERE id=?1 AND built_in=0",
            params![id, name],
        )
        .map_err(|e| db::map_unique(e, "A category with this name already exists."))?;
    if n == 0 {
        return Err(AppError::invalid("Built-in categories cannot be renamed."));
    }
    core.emit(StoreEvent::PromptsChanged);
    Ok(())
}

pub fn delete_category(core: &Core, id: &str) -> AppResult<()> {
    validate_id(id)?;
    let c = core.db.conn();
    let built_in: Option<i64> = c
        .query_row(
            "SELECT built_in FROM prompt_categories WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    match built_in {
        None => return Err(AppError::not_found("Category not found.")),
        Some(1) => return Err(AppError::invalid("Built-in categories cannot be deleted.")),
        _ => {}
    }
    c.execute("DELETE FROM prompt_categories WHERE id=?1", [id])?;
    drop(c);
    core.emit(StoreEvent::PromptsChanged);
    Ok(())
}

/* ── Import / export ───────────────────────────────────────────────────── */

pub const MAX_IMPORT_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportFile {
    pub format: String,
    pub format_version: u32,
    pub exported_at: String,
    pub categories: Vec<ExportCategory>,
    pub prompts: Vec<ExportPrompt>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExportCategory {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportPrompt {
    pub title: String,
    pub body: String,
    pub category: Option<String>,
    pub tags: Vec<String>,
    pub favorite: bool,
    pub preferred_model_ids: Vec<String>,
    pub parameters: ParamValues,
    pub variable_defaults: BTreeMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub versions: Option<Vec<ExportVersion>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportVersion {
    pub version: i64,
    pub title: String,
    pub body: String,
    pub created_at: String,
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_default()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
}

fn parse_iso(s: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
}

pub fn export(core: &Core, ids: Option<&[String]>) -> AppResult<String> {
    if let Some(ids) = ids {
        if ids.len() > 5000 {
            return Err(AppError::invalid("Too many prompts."));
        }
        ids.iter().try_for_each(|i| validate_id(i))?;
    }
    let cats = categories(core)?;
    let cat_name = |id: &Option<String>| {
        id.as_ref()
            .and_then(|i| cats.iter().find(|c| &c.id == i))
            .map(|c| c.name.clone())
    };
    let mut prompts = Vec::new();
    for p in list(core, &PromptQuery::default())? {
        if ids.is_some_and(|ids| !ids.contains(&p.id)) {
            continue;
        }
        let versions: Vec<ExportVersion> = versions(core, &p.id)?
            .into_iter()
            .take(200)
            .map(|v| ExportVersion {
                version: v.version,
                title: v.title,
                body: v.body,
                created_at: iso(v.created_at),
            })
            .collect();
        prompts.push(ExportPrompt {
            category: cat_name(&p.category_id),
            title: p.title,
            body: p.body,
            tags: p.tags,
            favorite: p.favorite,
            preferred_model_ids: p.preferred_model_ids,
            parameters: p.parameters,
            variable_defaults: p.variable_defaults,
            versions: if versions.is_empty() {
                None
            } else {
                Some(versions)
            },
        });
    }
    let used: Vec<String> = cats
        .iter()
        .filter(|c| {
            prompts
                .iter()
                .any(|p| p.category.as_deref() == Some(&c.name))
                || (ids.is_none() && !c.built_in)
        })
        .map(|c| c.name.clone())
        .collect();
    let file = ExportFile {
        format: "vidra.prompts".into(),
        format_version: 1,
        exported_at: iso(now_ms()),
        categories: used
            .into_iter()
            .map(|name| ExportCategory { name })
            .collect(),
        prompts,
    };
    Ok(serde_json::to_string_pretty(&file)?)
}

fn has_forbidden_key(v: &Value, depth: usize) -> bool {
    if depth > 10 {
        return true;
    }
    match v {
        Value::Object(m) => m.iter().any(|(k, v)| {
            matches!(k.as_str(), "__proto__" | "constructor" | "prototype")
                || has_forbidden_key(v, depth + 1)
        }),
        Value::Array(a) => a.iter().any(|x| has_forbidden_key(x, depth + 1)),
        _ => false,
    }
}

/// Strict parse mirroring `parsePromptExport`.
pub fn parse_export(text: &str) -> AppResult<ExportFile> {
    if text.len() > MAX_IMPORT_BYTES {
        return Err(AppError::invalid("The file is too large (max 5 MB)."));
    }
    let raw: Value =
        serde_json::from_str(text).map_err(|_| AppError::invalid("The file is not valid JSON."))?;
    if has_forbidden_key(&raw, 0) {
        return Err(AppError::invalid("The file contains forbidden keys."));
    }
    let f: ExportFile = serde_json::from_value(raw).map_err(|e| {
        AppError::invalid(format!(
            "Invalid prompt file: {}",
            crate::providers::sanitize(&e.to_string())
        ))
    })?;
    fn bad<T>(m: &str) -> AppResult<T> {
        Err(AppError::invalid(format!("Invalid prompt file: {m}")))
    }
    if f.format != "vidra.prompts" || f.format_version != 1 {
        return bad("unsupported format");
    }
    if parse_iso(&f.exported_at).is_none() {
        return bad("exportedAt");
    }
    if f.categories.len() > 500 || f.prompts.len() > 5000 {
        return bad("too many entries");
    }
    for c in &f.categories {
        let n = c.name.trim();
        if n.is_empty() || n.chars().count() > 60 {
            return bad("category name");
        }
    }
    for p in &f.prompts {
        let t = p.title.trim();
        if t.is_empty()
            || t.chars().count() > 120
            || p.body.is_empty()
            || p.body.chars().count() > 20000
        {
            return bad("prompt title/body");
        }
        if p.category
            .as_ref()
            .is_some_and(|c| c.trim().chars().count() > 60)
        {
            return bad("prompt category");
        }
        if p.tags.len() > 30
            || p.tags
                .iter()
                .any(|t| t.trim().is_empty() || t.trim().chars().count() > 40)
        {
            return bad("tags");
        }
        check_models(&p.preferred_model_ids).or_else(|_| bad("preferredModelIds"))?;
        check_parameters(&p.parameters).or_else(|_| bad("parameters"))?;
        check_variables(&p.variable_defaults).or_else(|_| bad("variableDefaults"))?;
        if let Some(vs) = &p.versions {
            if vs.len() > 200 {
                return bad("versions");
            }
            for v in vs {
                if v.version < 1
                    || v.title.chars().count() > 120
                    || v.body.chars().count() > 20000
                    || parse_iso(&v.created_at).is_none()
                {
                    return bad("versions");
                }
            }
        }
    }
    Ok(f)
}

pub fn import(core: &Core, text: &str) -> AppResult<(usize, usize)> {
    let f = parse_export(text)?;
    let mut conn = core.db.conn();
    let tx = conn.transaction()?;
    let mut cat_ids: BTreeMap<String, String> = BTreeMap::new();
    {
        let mut st = tx.prepare("SELECT id, name FROM prompt_categories")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for r in rows {
            let (id, name) = r?;
            cat_ids.insert(name.to_lowercase(), id);
        }
    }
    let mut ensure_cat = |tx: &rusqlite::Transaction, name: &str| -> AppResult<String> {
        let key = name.trim().to_lowercase();
        if let Some(id) = cat_ids.get(&key) {
            return Ok(id.clone());
        }
        let id = new_id();
        tx.execute(
            "INSERT INTO prompt_categories (id, name, built_in, created_at) VALUES (?1, ?2, 0, ?3)",
            params![id, name.trim(), now_ms()],
        )?;
        cat_ids.insert(key, id.clone());
        Ok(id)
    };
    for c in &f.categories {
        ensure_cat(&tx, &c.name)?;
    }
    let (mut imported, mut skipped) = (0, 0);
    for p in f.prompts {
        let dup: i64 = tx.query_row(
            "SELECT COUNT(*) FROM prompts WHERE title=?1 AND body=?2",
            params![p.title.trim(), p.body],
            |r| r.get(0),
        )?;
        if dup > 0 {
            skipped += 1;
            continue;
        }
        let category_id = match p
            .category
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(n) => Some(ensure_cat(&tx, n)?),
            None => None,
        };
        let clean = Clean {
            title: p.title.trim().to_string(),
            body: p.body,
            category_id,
            tags: crate::archive::normalize_tags(&p.tags)?,
            favorite: p.favorite,
            models: p.preferred_model_ids,
            parameters: p.parameters,
            variables: p.variable_defaults,
            source_job_id: None,
        };
        let id = insert(&tx, &clean, false)?;
        if let Some(vs) = p.versions {
            let mut max = 0;
            for v in vs {
                max = max.max(v.version);
                tx.execute(
                    "INSERT OR IGNORE INTO prompt_versions (id, prompt_id, version, title, body, tags_json, preferred_model_ids_json,
                       parameters_json, variable_defaults_json, created_at) VALUES (?1,?2,?3,?4,?5,'[]','[]','{}','{}',?6)",
                    params![new_id(), id, v.version, v.title, v.body, parse_iso(&v.created_at).unwrap_or(0)],
                )?;
            }
            tx.execute(
                "UPDATE prompts SET version=?2 WHERE id=?1",
                params![id, max + 1],
            )?;
        }
        imported += 1;
    }
    tx.commit()?;
    drop(conn);
    core.emit(StoreEvent::PromptsChanged);
    Ok((imported, skipped))
}

pub fn save_from_job(core: &Core, job_id: &str, title: &str) -> AppResult<Prompt> {
    validate_id(job_id)?;
    let job = db::get_job(&core.db.conn(), job_id)?
        .ok_or_else(|| AppError::not_found("Job not found."))?;
    let params: ParamValues = job
        .params
        .into_iter()
        .filter(|(_, v)| !v.is_array())
        .collect();
    create(
        core,
        PromptInput {
            title: title.to_string(),
            body: job.prompt,
            category_id: None,
            tags: vec![],
            favorite: false,
            preferred_model_ids: vec![job.model_id],
            parameters: params,
            variable_defaults: BTreeMap::new(),
            source_job_id: Some(job.id),
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::env;
    use serde_json::json;

    fn input(title: &str, body: &str) -> PromptInput {
        serde_json::from_value(json!({
            "title": title, "body": body, "categoryId": null, "tags": ["a", "A", " b "], "favorite": false,
            "preferredModelIds": ["replicate:google/veo-3"], "parameters": {"duration": 5}, "variableDefaults": {"subject": "cat"}
        }))
        .unwrap()
    }

    #[test]
    fn crud_versions_restore() {
        let e = env();
        let p = create(&e.core, input("Qwone", "body {subject}")).unwrap();
        assert_eq!(p.tags, vec!["a", "b"]);
        assert_eq!(p.version, 1);
        let p2 = update(&e.core, &p.id, input("Two", "body2")).unwrap();
        assert_eq!(p2.version, 2);
        let p3 = update(&e.core, &p.id, input("Three", "body3")).unwrap();
        assert_eq!(p3.version, 3);
        let vs = versions(&e.core, &p.id).unwrap();
        assert_eq!(vs.iter().map(|v| v.version).collect::<Vec<_>>(), vec![2, 1]);
        let r = restore_version(&e.core, &p.id, 1).unwrap();
        assert_eq!(r.title, "Qwone");
        assert_eq!(r.version, 4);
        assert_eq!(versions(&e.core, &p.id).unwrap().len(), 3);
        let d = duplicate(&e.core, &p.id).unwrap();
        assert_ne!(d.id, p.id);
        assert!(d.title.ends_with("(copy)"));
        assert!(list(
            &e.core,
            &PromptQuery {
                search: Some("THREE".into()),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty());
        assert_eq!(
            list(
                &e.core,
                &PromptQuery {
                    search: Some("qwone".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            2
        );
        delete(&e.core, &p.id).unwrap();
        assert!(versions(&e.core, &p.id).unwrap().is_empty());
        assert!(create(&e.core, input("", "x")).is_err());
        assert!(create(&e.core, input("x", &"y".repeat(20001))).is_err());
        let mut bad = input("x", "y");
        bad.parameters.insert("__proto__".into(), json!(1));
        assert!(create(&e.core, bad).is_err());
        assert!(serde_json::from_value::<PromptInput>(json!({"title": "x", "extra": 1})).is_err());
    }

    #[test]
    fn categories_builtin_protected() {
        let e = env();
        assert_eq!(categories(&e.core).unwrap().len(), 12);
        assert!(delete_category(&e.core, "builtin-sports").is_err());
        assert!(rename_category(&e.core, "builtin-sports", "x").is_err());
        let c = create_category(&e.core, "Mine").unwrap();
        assert!(create_category(&e.core, "Mine").is_err());
        let mut i = input("t", "b");
        i.category_id = Some(c.id.clone());
        let p = create(&e.core, i).unwrap();
        delete_category(&e.core, &c.id).unwrap();
        assert_eq!(
            get(&e.core.db.conn(), &p.id).unwrap().unwrap().category_id,
            None
        );
    }

    #[test]
    fn export_import_roundtrip_and_dedupe() {
        let e = env();
        let c = create_category(&e.core, "Custom").unwrap();
        let mut i = input("Exported", "text");
        i.category_id = Some(c.id);
        let p = create(&e.core, i).unwrap();
        update(&e.core, &p.id, input("Exported", "text v2")).unwrap();
        let json = export(&e.core, Some(std::slice::from_ref(&p.id))).unwrap();
        assert!(!json.contains(&p.id), "no internal ids");
        let e2 = env();
        let (imp, skip) = import(&e2.core, &json).unwrap();
        assert_eq!((imp, skip), (1, 0));
        let (imp, skip) = import(&e2.core, &json).unwrap();
        assert_eq!((imp, skip), (0, 1));
        let full = export(&e.core, None).unwrap();
        let parsed: Value = serde_json::from_str(&full).unwrap();
        assert_eq!(parsed["format"], "vidra.prompts");
    }

    #[test]
    fn malicious_imports_are_rejected() {
        let e = env();
        let ok = json!({"format":"vidra.prompts","formatVersion":1,"exportedAt":"2026-10-11T00:00:00.000Z","categories":[],"prompts":[
            {"title":"t","body":"b","category":null,"tags":[],"favorite":false,"preferredModelIds":[],"parameters":{},"variableDefaults":{}}]});
        assert!(parse_export(&ok.to_string()).is_ok());
        let cases = [
            r#"{"format":"vidra.prompts","formatVersion":1,"exportedAt":"2026-10-11T00:00:00Z","categories":[],"prompts":[],"__proto__":{"x":1}}"#.to_string(),
            ok.to_string().replace("\"parameters\":{}", "\"parameters\":{\"constructor\":1}"),
            ok.to_string().replace("\"favorite\":false", "\"favorite\":false,\"extra\":1"),
            ok.to_string().replace("\"formatVersion\":1", "\"formatVersion\":2"),
            ok.to_string().replace("2026-10-11T00:00:00.000Z", "yesterday"),
            ok.to_string().replace("\"title\":\"t\"", &format!("\"title\":\"{}\"", "x".repeat(121))),
            ok.to_string().replace("\"parameters\":{}", "\"parameters\":{\"a\":{\"nested\":1}}"),
            ok.to_string().replace("\"parameters\":{}", "\"parameters\":{\"1bad\":1}"),
            ok.to_string().replace("\"variableDefaults\":{}", &format!("\"variableDefaults\":{{\"a\":\"{}\"}}", "x".repeat(1001))),
            "not json".to_string(),
            "[".repeat(50) + &"]".repeat(50),
            "x".repeat(MAX_IMPORT_BYTES + 1),
        ];
        for (i, c) in cases.iter().enumerate() {
            assert!(parse_export(c).is_err(), "case {i}");
        }
        assert!(import(&e.core, &cases[0]).is_err());
    }

    #[test]
    fn save_from_job_and_job_delete_keeps_prompt() {
        let e = env();
        let job = crate::budget::tests_support_job();
        crate::jobs::insert_job(&e.core, &job, "k").unwrap();
        let p = save_from_job(&e.core, &job.id, "From job").unwrap();
        assert_eq!(p.source_job_id.as_deref(), Some(job.id.as_str()));
        crate::jobs::delete_job(&e.core, &job.id).unwrap();
        assert!(get(&e.core.db.conn(), &p.id).unwrap().is_some());
    }
}
