//! Media archive: listing with derived state, organisation, trash and
//! permanent deletion (only inside the root), file verification and stats.

use crate::core::Core;
use crate::db::{self, ASSET_COLS, ITEM_COLS, JOB_COLS, TASK_COLS};
use crate::error::{AppError, AppResult};
use crate::types::*;
use base64::Engine;
use rusqlite::params;
use rusqlite::types::Value as SqlValue;
use std::path::{Component, Path, PathBuf};

/// Mirrors `deriveArchiveState` in archive-state.ts.
pub fn derive_state(
    job: &GenerationJob,
    asset: Option<&MediaAsset>,
    item: Option<&ArchiveItem>,
    task: Option<&DownloadTask>,
) -> &'static str {
    if item.is_some_and(|i| i.deleted_at.is_some()) {
        return "trashed";
    }
    match job.status {
        JobStatus::Submitting | JobStatus::Queued => return "generation_queued",
        JobStatus::Generating => return "generating",
        JobStatus::Failed | JobStatus::Canceled | JobStatus::Blocked => return "generation_failed",
        JobStatus::Completed => {}
    }
    let Some(asset) = asset else {
        return "download_pending";
    };
    match asset.download_status.as_str() {
        "saved" => {
            if asset.local_path.is_some() {
                "saved"
            } else {
                "missing"
            }
        }
        "missing" => "missing",
        "failed" => "download_failed",
        "downloading" => "downloading",
        _ => {
            if task.is_some_and(|t| t.status == "downloading") {
                "downloading"
            } else {
                "download_pending"
            }
        }
    }
}

const STATES: &[&str] = &[
    "generation_queued",
    "generating",
    "generation_failed",
    "download_pending",
    "downloading",
    "saved",
    "download_failed",
    "missing",
    "trashed",
];

fn prefixed(cols: &str, p: &str) -> String {
    cols.split(',')
        .map(|s| format!("{p}.{}", s.trim()))
        .collect::<Vec<_>>()
        .join(",")
}

fn like_escape(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub fn list(core: &Core, q: &ArchiveQuery) -> AppResult<Vec<ArchiveEntry>> {
    if let Some(states) = &q.states {
        if states.len() > 20 || states.iter().any(|s| !STATES.contains(&s.as_str())) {
            return Err(AppError::invalid("Invalid state filter."));
        }
    }
    let mut sql = format!(
        "SELECT {}, {}, {}, {} FROM generation_jobs j
         LEFT JOIN media_assets a ON a.job_id = j.id
         LEFT JOIN archive_items i ON i.asset_id = a.id
         LEFT JOIN download_tasks t ON t.asset_id = a.id WHERE 1=1",
        prefixed(JOB_COLS, "j"),
        prefixed(ASSET_COLS, "a"),
        prefixed(ITEM_COLS, "i"),
        prefixed(TASK_COLS, "t")
    );
    let mut args: Vec<SqlValue> = Vec::new();
    if let Some(s) = q.search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if s.chars().count() > 200 {
            return Err(AppError::invalid("Search text is too long."));
        }
        let pat = format!("%{}%", like_escape(s));
        sql.push_str(
            " AND (j.prompt LIKE ? ESCAPE '\\' OR i.custom_title LIKE ? ESCAPE '\\' OR a.filename LIKE ? ESCAPE '\\'
                   OR i.tags_json LIKE ? ESCAPE '\\' OR j.model_name LIKE ? ESCAPE '\\')",
        );
        for _ in 0..5 {
            args.push(SqlValue::Text(pat.clone()));
        }
    }
    if let Some(p) = q.provider {
        sql.push_str(" AND j.provider = ?");
        args.push(SqlValue::Text(p.as_str().into()));
    }
    if let Some(m) = &q.model_id {
        sql.push_str(" AND j.model_id = ?");
        args.push(SqlValue::Text(m.chars().take(200).collect()));
    }
    if let Some(o) = &q.output {
        if o != "video" && o != "image" {
            return Err(AppError::invalid("Invalid output filter."));
        }
        sql.push_str(" AND j.output = ?");
        args.push(SqlValue::Text(o.clone()));
    }
    if let Some(f) = q.from {
        sql.push_str(" AND j.created_at >= ?");
        args.push(SqlValue::Integer(f));
    }
    if let Some(t) = q.to {
        sql.push_str(" AND j.created_at <= ?");
        args.push(SqlValue::Integer(t));
    }
    if let Some(f) = q.favorite {
        sql.push_str(if f {
            " AND i.favorite = 1"
        } else {
            " AND COALESCE(i.favorite,0) = 0"
        });
    }
    match &q.project_id {
        Some(Some(p)) => {
            validate_id(p)?;
            sql.push_str(" AND COALESCE(i.project_id, j.project_id) = ?");
            args.push(SqlValue::Text(p.clone()));
        }
        Some(None) => sql.push_str(" AND COALESCE(i.project_id, j.project_id) IS NULL"),
        None => {}
    }
    if q.trashed == Some(true) {
        sql.push_str(" AND i.deleted_at IS NOT NULL");
    } else {
        sql.push_str(" AND i.deleted_at IS NULL");
    }
    let dir = if q.direction.as_deref() == Some("asc") {
        "ASC"
    } else {
        "DESC"
    };
    let order = match q.sort.as_deref() {
        Some("size") => format!("COALESCE(a.size_bytes, -1) {dir}, j.created_at DESC"),
        Some("duration") => format!(
            "COALESCE(a.duration_sec, j.requested_duration_sec, -1) {dir}, j.created_at DESC"
        ),
        _ => format!("j.created_at {dir}, a.output_index ASC"),
    };
    sql.push_str(&format!(" ORDER BY {order} LIMIT 5000"));
    let c = core.db.conn();
    let mut st = c.prepare(&sql)?;
    let jn = db::JOB_NCOLS;
    let an = db::ASSET_NCOLS;
    let inn = db::ITEM_NCOLS;
    let rows = st.query_map(rusqlite::params_from_iter(args), |r| {
        let job = db::job_from_row(r, 0)?;
        let asset = match r.get::<_, Option<String>>(jn)? {
            Some(_) => Some(db::asset_from_row(r, jn)?),
            None => None,
        };
        let item = match r.get::<_, Option<String>>(jn + an)? {
            Some(_) => Some(db::item_from_row(r, jn + an)?),
            None => None,
        };
        let task = match r.get::<_, Option<String>>(jn + an + inn)? {
            Some(_) => Some(db::task_from_row(r, jn + an + inn)?),
            None => None,
        };
        Ok((job, asset, item, task))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (job, asset, item, task) = row?;
        let state = derive_state(&job, asset.as_ref(), item.as_ref(), task.as_ref()).to_string();
        if let Some(states) = &q.states {
            if !states.contains(&state) {
                continue;
            }
        }
        out.push(ArchiveEntry {
            job,
            asset,
            item,
            task,
            state,
        });
    }
    Ok(out)
}

fn validate_ids(ids: &[String]) -> AppResult<()> {
    if ids.len() > 10_000 {
        return Err(AppError::invalid("Too many items."));
    }
    ids.iter().try_for_each(|i| validate_id(i))
}

pub fn rename_item(core: &Core, id: &str, title: Option<String>) -> AppResult<()> {
    validate_id(id)?;
    let title = match title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
    {
        Some(t) if t.chars().count() > 200 || t.chars().any(char::is_control) => {
            return Err(AppError::invalid("Titles are limited to 200 characters."))
        }
        other => other,
    };
    let n = core.db.conn().execute(
        "UPDATE archive_items SET custom_title=?2 WHERE id=?1",
        params![id, title],
    )?;
    if n == 0 {
        return Err(AppError::not_found("Item not found."));
    }
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

fn update_many(core: &Core, ids: &[String], sql: &str, value: SqlValue) -> AppResult<()> {
    validate_ids(ids)?;
    let mut c = core.db.conn();
    let tx = c.transaction()?;
    for id in ids {
        tx.execute(sql, params![id, value])?;
    }
    tx.commit()?;
    drop(c);
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

pub fn set_favorite(core: &Core, ids: &[String], fav: bool) -> AppResult<()> {
    update_many(
        core,
        ids,
        "UPDATE archive_items SET favorite=?2 WHERE id=?1",
        SqlValue::Integer(fav as i64),
    )
}

pub fn normalize_tags(tags: &[String]) -> AppResult<Vec<String>> {
    if tags.len() > 30 {
        return Err(AppError::invalid("At most 30 tags."));
    }
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim();
        if t.is_empty() || t.chars().count() > 40 || t.chars().any(char::is_control) {
            return Err(AppError::invalid("Tags must be 1–40 characters."));
        }
        if !out.iter().any(|x| x.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    Ok(out)
}

pub fn set_tags(core: &Core, id: &str, tags: &[String]) -> AppResult<()> {
    validate_id(id)?;
    let tags = normalize_tags(tags)?;
    let n = core.db.conn().execute(
        "UPDATE archive_items SET tags_json=?2 WHERE id=?1",
        params![id, serde_json::to_string(&tags)?],
    )?;
    if n == 0 {
        return Err(AppError::not_found("Item not found."));
    }
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

pub fn move_to_project(core: &Core, ids: &[String], project: Option<String>) -> AppResult<()> {
    if let Some(p) = &project {
        validate_id(p)?;
        let n: i64 =
            core.db
                .conn()
                .query_row("SELECT COUNT(*) FROM projects WHERE id=?1", [p], |r| {
                    r.get(0)
                })?;
        if n == 0 {
            return Err(AppError::not_found("Project not found."));
        }
    }
    update_many(
        core,
        ids,
        "UPDATE archive_items SET project_id=?2 WHERE id=?1",
        project.map(SqlValue::Text).unwrap_or(SqlValue::Null),
    )
}

/// Trash never cancels jobs or deletes files.
pub fn trash(core: &Core, ids: &[String]) -> AppResult<()> {
    update_many(
        core,
        ids,
        "UPDATE archive_items SET deleted_at=?2 WHERE id=?1 AND deleted_at IS NULL",
        SqlValue::Integer(now_ms()),
    )
}

pub fn restore(core: &Core, ids: &[String]) -> AppResult<()> {
    update_many(
        core,
        ids,
        "UPDATE archive_items SET deleted_at=NULL WHERE id=?1 AND ?2 IS NULL",
        SqlValue::Null,
    )
}

/// Resolves a stored relative path strictly inside the root.
pub fn resolve_in_root(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let p = Path::new(rel);
    if rel.is_empty() || rel.contains(':') || rel.starts_with('\\') || rel.starts_with('/') {
        return Err(AppError::invalid("Invalid path."));
    }
    if p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(AppError::invalid("Invalid path."));
    }
    let joined = root.join(p);
    let canon_root = std::fs::canonicalize(root)
        .map_err(|_| AppError::not_found("The archive folder is not available."))?;
    match std::fs::canonicalize(&joined) {
        Ok(c) if c.starts_with(&canon_root) => Ok(c),
        Ok(_) => Err(AppError::invalid("Path is outside the archive folder.")),
        Err(_) => Err(AppError::not_found("The file is missing.")),
    }
}

fn remove_rel(root: &Path, rel: Option<&str>) {
    if let Some(rel) = rel {
        if let Ok(p) = resolve_in_root(root, rel) {
            if p.is_file() {
                if let Err(e) = std::fs::remove_file(&p) {
                    log::warn!("could not remove file: {e}");
                }
            }
        }
    }
}

/// Removes files (inside the root only), then the asset rows (which cascade
/// to items and download tasks). Jobs and prompts are kept.
pub fn delete_permanently(core: &Core, ids: &[String]) -> AppResult<()> {
    validate_ids(ids)?;
    let root = core.archive_root();
    for id in ids {
        let row: Option<(String, Option<String>, Option<String>)> = {
            let c = core.db.conn();
            rusqlite::OptionalExtension::optional(c.query_row(
                "SELECT a.id, a.local_path, a.thumbnail_path FROM archive_items i JOIN media_assets a ON a.id=i.asset_id WHERE i.id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ))?
        };
        let Some((asset_id, local, thumb)) = row else {
            continue;
        };
        if let Some(flag) = core.downloads.stop_flag(&asset_id) {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        remove_rel(&root, local.as_deref());
        remove_rel(&root, thumb.as_deref());
        let _ = std::fs::remove_file(crate::downloads::part_path(&root, &asset_id));
        core.db
            .conn()
            .execute("DELETE FROM media_assets WHERE id=?1", [&asset_id])?;
    }
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

pub fn verify_files(core: &Core) -> AppResult<i64> {
    let root = core.archive_root();
    let saved: Vec<(String, Option<String>)> = {
        let c = core.db.conn();
        let mut st =
            c.prepare("SELECT id, local_path FROM media_assets WHERE download_status='saved'")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut missing = 0;
    for (id, rel) in saved {
        let ok = rel
            .as_deref()
            .is_some_and(|r| resolve_in_root(&root, r).is_ok_and(|p| p.is_file()));
        if !ok {
            core.db.conn().execute(
                "UPDATE media_assets SET download_status='missing' WHERE id=?1",
                [&id],
            )?;
            missing += 1;
        }
    }
    if missing > 0 {
        core.emit(StoreEvent::ArchiveChanged);
    }
    Ok(missing)
}

pub fn storage_stats(core: &Core) -> AppResult<StorageStats> {
    let root = core.archive_root();
    let c = core.db.conn();
    let (used, saved): (i64, i64) = c.query_row(
        "SELECT COALESCE(SUM(size_bytes),0), COUNT(*) FROM media_assets WHERE download_status='saved'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    let trashed: i64 = c.query_row(
        "SELECT COUNT(*) FROM archive_items WHERE deleted_at IS NOT NULL",
        [],
        |r| r.get(0),
    )?;
    let missing: i64 = c.query_row(
        "SELECT COUNT(*) FROM media_assets WHERE download_status='missing'",
        [],
        |r| r.get(0),
    )?;
    Ok(StorageStats {
        used_bytes: used,
        saved_count: saved,
        trashed_count: trashed,
        missing_count: missing,
        free_bytes: (core.free_space)(&root),
        archive_root: root.to_string_lossy().into_owned(),
    })
}

pub fn purge_trash(core: &Core) -> AppResult<usize> {
    let days = crate::settings::get(core)
        .trash_retention_days
        .clamp(1, 365) as i64;
    let cutoff = now_ms() - days * 86_400_000;
    let ids: Vec<String> = {
        let c = core.db.conn();
        let mut st = c.prepare(
            "SELECT id FROM archive_items WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
        )?;
        let rows = st.query_map([cutoff], |r| r.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    delete_permanently(core, &ids)?;
    Ok(ids.len())
}

fn asset(core: &Core, id: &str) -> AppResult<MediaAsset> {
    validate_id(id)?;
    db::get_asset(&core.db.conn(), id)?.ok_or_else(|| AppError::not_found("Asset not found."))
}

pub fn media_path(core: &Core, id: &str) -> AppResult<Option<String>> {
    let a = asset(core, id)?;
    if a.download_status != "saved" {
        return Ok(None);
    }
    Ok(a.local_path
        .and_then(|r| resolve_in_root(&core.archive_root(), &r).ok())
        .map(|p| display_path(&p)))
}

pub fn thumbnail_path(core: &Core, id: &str) -> AppResult<Option<String>> {
    let a = asset(core, id)?;
    Ok(a.thumbnail_path
        .and_then(|r| resolve_in_root(&core.archive_root(), &r).ok())
        .map(|p| display_path(&p)))
}

/// Strips the Windows `\\?\` verbatim prefix added by canonicalize.
pub fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().into_owned();
    if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s)
}

pub const MAX_THUMB_BYTES: usize = 2 * 1024 * 1024;

pub fn save_thumbnail(
    core: &Core,
    id: &str,
    b64: &str,
    duration: Option<f64>,
    width: Option<i64>,
    height: Option<i64>,
) -> AppResult<()> {
    let a = asset(core, id)?;
    if b64.len() > MAX_THUMB_BYTES * 4 / 3 + 64 {
        return Err(AppError::invalid("The thumbnail is too large."));
    }
    let b64 = b64.split_once("base64,").map(|(_, d)| d).unwrap_or(b64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| AppError::invalid("Invalid image data."))?;
    if bytes.len() > MAX_THUMB_BYTES {
        return Err(AppError::invalid("The thumbnail is too large."));
    }
    let format = match crate::downloads::sniff(&bytes) {
        Some(("image/png", ..)) => image::ImageFormat::Png,
        Some(("image/jpeg", ..)) => image::ImageFormat::Jpeg,
        _ => return Err(AppError::invalid("Thumbnails must be PNG or JPEG.")),
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let img = reader
        .decode()
        .map_err(|_| AppError::invalid("Invalid image data."))?;
    let thumb = img.thumbnail(512, 512).to_rgb8();
    let root = core.archive_root();
    std::fs::create_dir_all(root.join("thumbs"))?;
    let rel = format!("thumbs/{}.jpg", a.id);
    let tmp = root.join("thumbs").join(format!("{}.jpg.tmp", a.id));
    thumb
        .save_with_format(&tmp, image::ImageFormat::Jpeg)
        .map_err(|_| AppError::io("Could not write the thumbnail."))?;
    std::fs::rename(&tmp, root.join(&rel))?;
    let ok = |v: Option<f64>| v.filter(|d| d.is_finite() && *d >= 0.0 && *d < 1e7);
    let dim = |v: Option<i64>| v.filter(|d| *d > 0 && *d < 100_000);
    core.db.conn().execute(
        "UPDATE media_assets SET thumbnail_path=?2, duration_sec=COALESCE(?3,duration_sec), width=COALESCE(?4,width), height=COALESCE(?5,height) WHERE id=?1",
        params![a.id, rel, ok(duration), dim(width), dim(height)],
    )?;
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

/// Absolute path of a saved asset (validated inside the root).
pub fn saved_file(core: &Core, id: &str) -> AppResult<PathBuf> {
    let a = asset(core, id)?;
    let rel = a
        .local_path
        .filter(|_| a.download_status == "saved")
        .ok_or_else(|| AppError::not_found("The file is not saved yet."))?;
    resolve_in_root(&core.archive_root(), &rel)
}

pub fn export_media(core: &Core, id: &str, dest: &Path) -> AppResult<()> {
    let src = saved_file(core, id)?;
    let tmp = dest.with_extension("vidra-tmp");
    std::fs::copy(&src, &tmp)?;
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

/// Sanitizes a suggested export file name.
pub fn safe_file_name(name: &str, ext: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || " -_.()".contains(c) {
                c
            } else {
                '_'
            }
        })
        .take(100)
        .collect();
    s = s.trim().trim_matches('.').to_string();
    if s.is_empty() {
        s = "vidra-export".into();
    }
    if !s.to_ascii_lowercase().ends_with(&format!(".{ext}")) {
        s.push('.');
        s.push_str(ext);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::env;

    fn seed_saved(core: &Core, job_status: &str) -> (String, String, String) {
        let job = new_id();
        let asset = new_id();
        let item = new_id();
        let root = core.archive_root();
        std::fs::create_dir_all(root.join("media/2026/10")).unwrap();
        let rel = format!("media/2026/10/{asset}.mp4");
        std::fs::write(root.join(&rel), b"data").unwrap();
        let c = core.db.conn();
        c.execute("INSERT INTO prompts (id,title,body,tags_json,preferred_model_ids_json,parameters_json,variable_defaults_json,version,created_at,updated_at) VALUES (?1,'t','b','[]','[]','{}','{}',1,0,0)", [&job]).unwrap();
        c.execute("INSERT INTO generation_jobs (id,provider,model_id,model_name,workflow,output,status,prompt,params_json,prompt_id,idempotency_key,created_at,updated_at) VALUES (?1,'replicate','replicate:m','Model','text-to-video','video',?2,'sunset beach','{}',?1,?1,1,1)", params![job, job_status]).unwrap();
        c.execute("INSERT INTO media_assets (id,job_id,output_index,kind,original_url,local_path,filename,size_bytes,download_status,created_at) VALUES (?1,?2,0,'video','https://x.example.com/a',?3,'clip.mp4',4,'saved',1)", params![asset, job, rel]).unwrap();
        c.execute(
            "INSERT INTO archive_items (id,asset_id,tags_json) VALUES (?1,?2,'[\"holiday\"]')",
            params![item, asset],
        )
        .unwrap();
        (job, asset, item)
    }

    #[test]
    fn list_filters_and_state() {
        let e = env();
        let (job, _asset, item) = seed_saved(&e.core, "completed");
        let all = list(&e.core, &ArchiveQuery::default()).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].state, "saved");
        for s in ["sunset", "holiday", "clip", "SUNSET"] {
            assert_eq!(
                list(
                    &e.core,
                    &ArchiveQuery {
                        search: Some(s.into()),
                        ..Default::default()
                    }
                )
                .unwrap()
                .len(),
                1,
                "{s}"
            );
        }
        assert!(list(
            &e.core,
            &ArchiveQuery {
                search: Some("%".into()),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty());
        rename_item(&e.core, &item, Some("My Title".into())).unwrap();
        assert_eq!(
            list(
                &e.core,
                &ArchiveQuery {
                    search: Some("my title".into()),
                    ..Default::default()
                }
            )
            .unwrap()
            .len(),
            1
        );
        assert!(list(
            &e.core,
            &ArchiveQuery {
                states: Some(vec!["missing".into()]),
                ..Default::default()
            }
        )
        .unwrap()
        .is_empty());
        assert!(list(
            &e.core,
            &ArchiveQuery {
                states: Some(vec!["bogus".into()]),
                ..Default::default()
            }
        )
        .is_err());
        trash(&e.core, std::slice::from_ref(&item)).unwrap();
        assert!(list(&e.core, &ArchiveQuery::default()).unwrap().is_empty());
        let t = list(
            &e.core,
            &ArchiveQuery {
                trashed: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(t[0].state, "trashed");
        restore(&e.core, std::slice::from_ref(&item)).unwrap();
        assert_eq!(list(&e.core, &ArchiveQuery::default()).unwrap().len(), 1);
        let _ = job;
    }

    #[test]
    fn trash_delete_keeps_prompts_and_jobs_and_files_go() {
        let e = env();
        let (job, asset, item) = seed_saved(&e.core, "completed");
        let file = e
            .core
            .archive_root()
            .join(format!("media/2026/10/{asset}.mp4"));
        assert!(file.exists());
        trash(&e.core, std::slice::from_ref(&item)).unwrap();
        assert!(file.exists(), "trash keeps files");
        delete_permanently(&e.core, std::slice::from_ref(&item)).unwrap();
        assert!(!file.exists());
        let c = e.core.db.conn();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM prompts WHERE id=?1", [&job], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(n, 1, "prompt kept");
        let n: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM generation_jobs WHERE id=?1",
                [&job],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "job kept");
    }

    #[test]
    fn trashing_does_not_cancel_active_jobs() {
        let e = env();
        let (job, _a, item) = seed_saved(&e.core, "generating");
        trash(&e.core, std::slice::from_ref(&item)).unwrap();
        delete_permanently(&e.core, std::slice::from_ref(&item)).unwrap();
        let st: String = e
            .core
            .db
            .conn()
            .query_row(
                "SELECT status FROM generation_jobs WHERE id=?1",
                [&job],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(st, "generating");
        assert!(
            crate::jobs::delete_job(&e.core, &job).is_err(),
            "active job cannot be deleted"
        );
    }

    #[test]
    fn path_traversal_is_rejected() {
        let e = env();
        let root = e.core.archive_root();
        std::fs::create_dir_all(&root).unwrap();
        let outside = e.dir.path().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        for bad in [
            "../secret.txt",
            "..\\secret.txt",
            "media/../../secret.txt",
            "/etc/passwd",
            "C:\\Windows\\win.ini",
            "\\\\server\\share\\x",
            "",
        ] {
            assert!(resolve_in_root(&root, bad).is_err(), "{bad}");
        }
        // a DB row pointing outside the root is never deleted or exported
        let (_job, asset, item) = seed_saved(&e.core, "completed");
        e.core
            .db
            .conn()
            .execute(
                "UPDATE media_assets SET local_path='../secret.txt' WHERE id=?1",
                [&asset],
            )
            .unwrap();
        assert!(export_media(&e.core, &asset, &e.dir.path().join("out.mp4")).is_err());
        delete_permanently(&e.core, &[item]).unwrap();
        assert!(outside.exists());
    }

    #[test]
    fn verify_and_stats() {
        let e = env();
        let (_j, asset, _i) = seed_saved(&e.core, "completed");
        assert_eq!(verify_files(&e.core).unwrap(), 0);
        std::fs::remove_file(
            e.core
                .archive_root()
                .join(format!("media/2026/10/{asset}.mp4")),
        )
        .unwrap();
        assert_eq!(verify_files(&e.core).unwrap(), 1);
        let s = storage_stats(&e.core).unwrap();
        assert_eq!(s.missing_count, 1);
        assert_eq!(
            list(&e.core, &ArchiveQuery::default()).unwrap()[0].state,
            "missing"
        );
    }

    #[test]
    fn thumbnails_are_validated() {
        let e = env();
        let (_j, asset, _i) = seed_saved(&e.core, "completed");
        assert!(save_thumbnail(&e.core, &asset, "not base64!!", None, None, None).is_err());
        let gif = base64::engine::general_purpose::STANDARD.encode(b"GIF89a....");
        assert!(save_thumbnail(&e.core, &asset, &gif, None, None, None).is_err());
        let mut png = Vec::new();
        image::RgbImage::new(8, 8)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let b = base64::engine::general_purpose::STANDARD.encode(&png);
        save_thumbnail(
            &e.core,
            &asset,
            &format!("data:image/png;base64,{b}"),
            Some(5.0),
            Some(1280),
            Some(720),
        )
        .unwrap();
        assert!(thumbnail_path(&e.core, &asset).unwrap().is_some());
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; MAX_THUMB_BYTES + 10]);
        assert!(save_thumbnail(&e.core, &asset, &big, None, None, None).is_err());
    }

    #[test]
    fn derive_matches_core() {
        let mut job = crate::budget::tests_support_job();
        let asset_none = None;
        job.status = JobStatus::Queued;
        assert_eq!(
            derive_state(&job, asset_none, None, None),
            "generation_queued"
        );
        job.status = JobStatus::Blocked;
        assert_eq!(derive_state(&job, None, None, None), "generation_failed");
        job.status = JobStatus::Completed;
        assert_eq!(derive_state(&job, None, None, None), "download_pending");
    }
}
