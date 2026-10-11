//! `.vidra` backup (architecture §6): a zip with `manifest.json` (sha256 per
//! file), `metadata.json`, `media/` and `thumbs/`. Imports are validated
//! (allowlisted names, no symlinks, limits, hashes, free space), staged under
//! `<root>/.tmp/import-<token>`, previewed, then committed with ID remapping.

use crate::core::Core;
use crate::db::{self, ASSET_COLS, ITEM_COLS, JOB_COLS, PROMPT_COLS, VERSION_COLS};
use crate::error::{AppError, AppResult};
use crate::types::*;
use regex::Regex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024 * 1024;
pub const MAX_ENTRIES: usize = 100_000;
pub const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_METADATA_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub format: String,
    pub version: u32,
    pub created_at: i64,
    pub app_version: String,
    pub files: Vec<ManifestFile>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub jobs: Vec<GenerationJob>,
    pub assets: Vec<MediaAsset>,
    pub items: Vec<ArchiveItem>,
    pub projects: Vec<Project>,
    pub prompts: Vec<Prompt>,
    pub versions: Vec<PromptVersion>,
    pub categories: Vec<PromptCategory>,
}

pub struct StagedImport {
    pub dir: PathBuf,
    pub metadata: Metadata,
    pub created_at: i64,
}

fn name_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^(manifest\.json|metadata\.json|media/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|mov|webm|png|jpg|webp)|thumbs/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg)$")
            .expect("regex")
    })
}

fn bad(msg: &str) -> AppError {
    AppError::invalid(format!("This backup cannot be imported: {msg}"))
}

fn query_all<T>(
    core: &Core,
    sql: &str,
    f: impl Fn(&rusqlite::Row) -> rusqlite::Result<T>,
) -> AppResult<Vec<T>> {
    let c = core.db.conn();
    let mut st = c.prepare(sql)?;
    let rows = st.query_map([], f)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

pub fn collect_metadata(core: &Core) -> AppResult<Metadata> {
    Ok(Metadata {
        jobs: query_all(
            core,
            &format!("SELECT {JOB_COLS} FROM generation_jobs"),
            |r| db::job_from_row(r, 0),
        )?,
        assets: query_all(
            core,
            &format!("SELECT {ASSET_COLS} FROM media_assets"),
            |r| db::asset_from_row(r, 0),
        )?,
        items: query_all(
            core,
            &format!("SELECT {ITEM_COLS} FROM archive_items"),
            |r| db::item_from_row(r, 0),
        )?,
        projects: query_all(core, "SELECT id, name, created_at FROM projects", |r| {
            Ok(Project {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
            })
        })?,
        prompts: query_all(
            core,
            &format!("SELECT {PROMPT_COLS} FROM prompts"),
            db::prompt_from_row,
        )?,
        versions: query_all(
            core,
            &format!("SELECT {VERSION_COLS} FROM prompt_versions"),
            db::version_from_row,
        )?,
        categories: query_all(
            core,
            "SELECT id, name, built_in, created_at FROM prompt_categories",
            db::category_from_row,
        )?,
    })
}

/// Writes a backup to `dest` (atomically via a temp file).
pub fn export(core: &Core, dest: &Path) -> AppResult<()> {
    let root = core.archive_root();
    let mut meta = collect_metadata(core)?;
    let tmp = dest.with_extension("vidra-part");
    let file = std::fs::File::create(&tmp)?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let stored = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);
    let deflate = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut files = Vec::new();
    let zerr = |_| AppError::io("Could not write the backup.");
    for a in meta.assets.iter_mut() {
        let mut add =
            |rel: &Option<String>, name: String, zip: &mut zip::ZipWriter<_>| -> AppResult<bool> {
                let Some(rel) = rel else { return Ok(false) };
                let Ok(src) = crate::archive::resolve_in_root(&root, rel) else {
                    return Ok(false);
                };
                let mut f = std::fs::File::open(&src)?;
                zip.start_file(name.as_str(), stored).map_err(zerr)?;
                let mut h = Sha256::new();
                let mut buf = vec![0u8; 1024 * 1024];
                let mut size = 0u64;
                loop {
                    let n = f.read(&mut buf)?;
                    if n == 0 {
                        break;
                    }
                    h.update(&buf[..n]);
                    zip.write_all(&buf[..n])?;
                    size += n as u64;
                }
                files.push(ManifestFile {
                    name,
                    sha256: hex::encode(h.finalize()),
                    size,
                });
                Ok(true)
            };
        let ext = a
            .local_path
            .as_deref()
            .and_then(|p| p.rsplit_once('.'))
            .map(|(_, e)| e.to_ascii_lowercase())
            .unwrap_or_default();
        let saved = a.download_status == "saved"
            && ["mp4", "mov", "webm", "png", "jpg", "webp"].contains(&ext.as_str())
            && add(&a.local_path, format!("media/{}.{ext}", a.id), &mut zip)?;
        a.local_path = saved.then(|| format!("media/{}.{ext}", a.id));
        if !saved && a.download_status == "saved" {
            a.download_status = "missing".into();
        }
        let thumb = a
            .thumbnail_path
            .as_deref()
            .is_some_and(|t| t.ends_with(".jpg"))
            && add(&a.thumbnail_path, format!("thumbs/{}.jpg", a.id), &mut zip)?;
        a.thumbnail_path = thumb.then(|| format!("thumbs/{}.jpg", a.id));
    }
    let meta_bytes = serde_json::to_vec(&meta)?;
    zip.start_file("metadata.json", deflate).map_err(zerr)?;
    zip.write_all(&meta_bytes)?;
    files.push(ManifestFile {
        name: "metadata.json".into(),
        sha256: hex::encode(Sha256::digest(&meta_bytes)),
        size: meta_bytes.len() as u64,
    });
    let manifest = BackupManifest {
        format: "vidra-archive".into(),
        version: 1,
        created_at: now_ms(),
        app_version: env!("CARGO_PKG_VERSION").into(),
        files,
    };
    zip.start_file("manifest.json", deflate).map_err(zerr)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
    let mut w = zip.finish().map_err(zerr)?;
    w.flush()?;
    w.get_ref().sync_all()?;
    drop(w);
    std::fs::rename(&tmp, dest)?;
    Ok(())
}

fn read_entry_limited(
    zip: &mut zip::ZipArchive<std::fs::File>,
    name: &str,
    limit: u64,
) -> AppResult<Vec<u8>> {
    let entry = zip
        .by_name(name)
        .map_err(|_| bad(&format!("{name} is missing")))?;
    if entry.size() > limit {
        return Err(bad(&format!("{name} is too large")));
    }
    let mut out = Vec::new();
    entry
        .take(limit + 1)
        .read_to_end(&mut out)
        .map_err(|_| bad("corrupted archive"))?;
    if out.len() as u64 > limit {
        return Err(bad(&format!("{name} is too large")));
    }
    Ok(out)
}

pub fn preview(core: &Core, path: &Path) -> AppResult<ImportPreview> {
    let file = std::fs::File::open(path)
        .map_err(|_| AppError::not_found("The file could not be opened."))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| bad("not a valid .vidra file"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(bad("too many entries"));
    }
    let mut declared_total = 0u64;
    let mut names = HashSet::new();
    for i in 0..zip.len() {
        let e = zip.by_index_raw(i).map_err(|_| bad("corrupted archive"))?;
        let name = e.name().to_string();
        if e.is_dir() {
            if name == "media/" || name == "thumbs/" {
                continue;
            }
            return Err(bad("unexpected folder"));
        }
        if e.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) || e.is_symlink() {
            return Err(bad("symbolic links are not allowed"));
        }
        if !name_re().is_match(&name) || e.enclosed_name().is_none() {
            return Err(bad("unexpected file name"));
        }
        if !names.insert(name) {
            return Err(bad("duplicate entry"));
        }
        declared_total = declared_total.saturating_add(e.size());
    }
    if declared_total > MAX_TOTAL_BYTES {
        return Err(bad("the archive is larger than 20 GiB"));
    }
    let manifest: BackupManifest = serde_json::from_slice(&read_entry_limited(
        &mut zip,
        "manifest.json",
        MAX_MANIFEST_BYTES,
    )?)
    .map_err(|_| bad("invalid manifest"))?;
    if manifest.format != "vidra-archive" || manifest.version != 1 {
        return Err(bad("unsupported format version"));
    }
    if manifest.files.len() > MAX_ENTRIES {
        return Err(bad("too many entries"));
    }
    let listed: HashMap<&str, &ManifestFile> = manifest
        .files
        .iter()
        .map(|f| (f.name.as_str(), f))
        .collect();
    for n in &names {
        if n != "manifest.json" && !listed.contains_key(n.as_str()) {
            return Err(bad("a file is not listed in the manifest"));
        }
    }
    for f in &manifest.files {
        if !names.contains(&f.name) {
            return Err(bad("a listed file is missing"));
        }
    }
    let root = core.archive_root();
    let tmp_root = root.join(".tmp");
    std::fs::create_dir_all(&tmp_root)?;
    let free_needed = declared_total + crate::downloads::SPACE_MARGIN;
    if (core.free_space)(&root).is_some_and(|f| f < free_needed) {
        return Err(AppError::new(
            crate::error::ErrorCode::DiskFull,
            "Not enough free disk space to import this backup.",
        ));
    }
    let token = hex::encode(rand::random::<[u8; 16]>());
    let dir = tmp_root.join(format!("import-{token}"));
    std::fs::create_dir_all(dir.join("media"))?;
    std::fs::create_dir_all(dir.join("thumbs"))?;
    let result = (|| -> AppResult<Metadata> {
        let mut written = 0u64;
        for f in &manifest.files {
            let mut e = zip.by_name(&f.name).map_err(|_| bad("corrupted archive"))?;
            let limit = if f.name == "metadata.json" {
                MAX_METADATA_BYTES
            } else {
                MAX_TOTAL_BYTES
            };
            if f.size > limit || e.size() != f.size {
                return Err(bad("size mismatch"));
            }
            // Names are allowlisted, so this join cannot escape the staging dir.
            let dest = dir.join(&f.name);
            let mut out = std::fs::File::create(&dest)?;
            let mut h = Sha256::new();
            let mut buf = vec![0u8; 1024 * 1024];
            let mut size = 0u64;
            loop {
                let n = e.read(&mut buf).map_err(|_| bad("corrupted archive"))?;
                if n == 0 {
                    break;
                }
                size += n as u64;
                written += n as u64;
                if size > f.size || written > MAX_TOTAL_BYTES {
                    return Err(bad("size mismatch"));
                }
                h.update(&buf[..n]);
                out.write_all(&buf[..n])?;
            }
            out.sync_all()?;
            if size != f.size || !hex::encode(h.finalize()).eq_ignore_ascii_case(&f.sha256) {
                return Err(bad("a file failed the integrity check (sha256 mismatch)"));
            }
        }
        let meta_bytes = std::fs::read(dir.join("metadata.json"))?;
        serde_json::from_slice::<Metadata>(&meta_bytes).map_err(|_| bad("invalid metadata"))
    })();
    let metadata = match result {
        Ok(m) => m,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    let existing: HashSet<String> = query_all(
        core,
        "SELECT sha256 FROM media_assets WHERE sha256 IS NOT NULL",
        |r| r.get(0),
    )?
    .into_iter()
    .collect();
    let duplicate_count = metadata
        .assets
        .iter()
        .filter(|a| a.sha256.as_ref().is_some_and(|s| existing.contains(s)))
        .count();
    let mut warnings = Vec::new();
    let missing = metadata
        .assets
        .iter()
        .filter(|a| a.download_status == "saved" && a.local_path.is_none())
        .count();
    if missing > 0 {
        warnings.push(format!(
            "{missing} item(s) have no media file in the backup."
        ));
    }
    let preview = ImportPreview {
        token: token.clone(),
        format_version: manifest.version,
        created_at: manifest.created_at,
        job_count: metadata.jobs.len(),
        asset_count: metadata.assets.len(),
        prompt_count: metadata.prompts.len(),
        total_bytes: declared_total,
        duplicate_count,
        warnings,
    };
    core.imports
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(
            token,
            StagedImport {
                dir,
                metadata,
                created_at: manifest.created_at,
            },
        );
    Ok(preview)
}

pub fn cancel(core: &Core, token: &str) -> AppResult<()> {
    if let Some(s) = core
        .imports
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(token)
    {
        let _ = std::fs::remove_dir_all(&s.dir);
    }
    Ok(())
}

fn valid_staged_rel(rel: &str, id: &str) -> bool {
    name_re().is_match(rel)
        && (rel.starts_with(&format!("media/{id}.")) || rel == format!("thumbs/{id}.jpg"))
}

pub fn confirm(core: &Core, token: &str) -> AppResult<ImportResult> {
    let staged = core
        .imports
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(token)
        .ok_or_else(|| {
            AppError::not_found("This import has expired. Please choose the file again.")
        })?;
    let res = commit(core, &staged);
    let _ = std::fs::remove_dir_all(&staged.dir);
    core.emit(StoreEvent::JobsChanged);
    core.emit(StoreEvent::ArchiveChanged);
    core.emit(StoreEvent::PromptsChanged);
    res
}

fn commit(core: &Core, s: &StagedImport) -> AppResult<ImportResult> {
    let m = &s.metadata;
    let root = core.archive_root();
    let mut result = ImportResult::default();
    let mut moved: Vec<PathBuf> = Vec::new();
    let mut conn = core.db.conn();
    let tx = conn.transaction()?;
    let exists = |tx: &rusqlite::Transaction, table: &str, id: &str| -> AppResult<bool> {
        Ok(tx
            .query_row(&format!("SELECT 1 FROM {table} WHERE id=?1"), [id], |_| {
                Ok(())
            })
            .optional()?
            .is_some())
    };
    let fresh = |tx: &rusqlite::Transaction, table: &str, id: &str| -> AppResult<String> {
        Ok(if is_uuid(id) && !exists(tx, table, id)? {
            id.to_string()
        } else {
            new_id()
        })
    };
    // categories: by name
    let mut cat_map: HashMap<String, String> = HashMap::new();
    for c in &m.categories {
        let name = db::validate_name(&c.name, 60)?;
        let found: Option<String> = tx
            .query_row(
                "SELECT id FROM prompt_categories WHERE lower(name)=lower(?1)",
                [&name],
                |r| r.get(0),
            )
            .optional()?;
        let id = match found {
            Some(id) => id,
            None => {
                let id = new_id();
                tx.execute("INSERT INTO prompt_categories (id,name,built_in,created_at) VALUES (?1,?2,0,?3)", params![id, name, c.created_at])?;
                id
            }
        };
        cat_map.insert(c.id.clone(), id);
    }
    let mut proj_map: HashMap<String, String> = HashMap::new();
    for p in &m.projects {
        let name = db::validate_name(&p.name, 80)?;
        let found: Option<String> = tx
            .query_row("SELECT id FROM projects WHERE name=?1", [&name], |r| {
                r.get(0)
            })
            .optional()?;
        let id = match found {
            Some(id) => id,
            None => {
                let id = fresh(&tx, "projects", &p.id)?;
                tx.execute(
                    "INSERT INTO projects (id,name,created_at) VALUES (?1,?2,?3)",
                    params![id, name, p.created_at],
                )?;
                id
            }
        };
        proj_map.insert(p.id.clone(), id);
    }
    let mut prompt_map: HashMap<String, String> = HashMap::new();
    for p in &m.prompts {
        let dup: Option<String> = tx
            .query_row(
                "SELECT id FROM prompts WHERE title=?1 AND body=?2",
                params![p.title, p.body],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(id) = dup {
            prompt_map.insert(p.id.clone(), id);
            continue;
        }
        if p.title.chars().count() > 120 || p.body.chars().count() > 20000 {
            return Err(bad("invalid prompt"));
        }
        let id = fresh(&tx, "prompts", &p.id)?;
        tx.execute(
            "INSERT INTO prompts (id,title,body,category_id,tags_json,favorite,preferred_model_ids_json,parameters_json,variable_defaults_json,version,built_in,source_job_id,created_at,updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,NULL,?12,?13)",
            params![id, p.title, p.body, p.category_id.as_ref().and_then(|c| cat_map.get(c)), serde_json::to_string(&p.tags)?, p.favorite as i64,
                serde_json::to_string(&p.preferred_model_ids)?, serde_json::to_string(&p.parameters)?, serde_json::to_string(&p.variable_defaults)?,
                p.version.max(1), p.built_in as i64, p.created_at, p.updated_at],
        )?;
        prompt_map.insert(p.id.clone(), id);
        result.imported_prompts += 1;
    }
    for v in &m.versions {
        if let Some(pid) = prompt_map.get(&v.prompt_id) {
            tx.execute(
                "INSERT OR IGNORE INTO prompt_versions (id,prompt_id,version,title,body,tags_json,preferred_model_ids_json,parameters_json,variable_defaults_json,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![new_id(), pid, v.version, v.title, v.body, serde_json::to_string(&v.tags)?, serde_json::to_string(&v.preferred_model_ids)?,
                    serde_json::to_string(&v.parameters)?, serde_json::to_string(&v.variable_defaults)?, v.created_at],
            )?;
        }
    }
    let mut job_map: HashMap<String, String> = HashMap::new();
    for j in &m.jobs {
        if let Some(rid) = &j.provider_request_id {
            let dup = tx
                .query_row(
                    "SELECT 1 FROM generation_jobs WHERE provider=?1 AND provider_request_id=?2",
                    params![j.provider.as_str(), rid],
                    |_| Ok(()),
                )
                .optional()?;
            if dup.is_some() {
                continue;
            }
        }
        let id = fresh(&tx, "generation_jobs", &j.id)?;
        let mut job = j.clone();
        job.id = id.clone();
        job.prompt_id = j
            .prompt_id
            .as_ref()
            .and_then(|p| prompt_map.get(p))
            .cloned();
        job.project_id = j.project_id.as_ref().and_then(|p| proj_map.get(p)).cloned();
        if !job.status.is_terminal() {
            job.status = JobStatus::Failed;
            job.error_code = Some("imported".into());
            job.error_message = Some("Imported while still running; status unknown.".into());
        }
        crate::jobs::insert_job_tx(&tx, &job, &new_id())?;
        job_map.insert(j.id.clone(), id);
        result.imported_jobs += 1;
    }
    let mut asset_map: HashMap<String, String> = HashMap::new();
    for a in &m.assets {
        let Some(job_id) = job_map.get(&a.job_id) else {
            continue;
        };
        if let Some(sha) = &a.sha256 {
            let dup = tx
                .query_row("SELECT 1 FROM media_assets WHERE sha256=?1", [sha], |_| {
                    Ok(())
                })
                .optional()?;
            if dup.is_some() {
                result.skipped_duplicates += 1;
                continue;
            }
        }
        if !is_uuid(&a.id) {
            continue;
        }
        let id = fresh(&tx, "media_assets", &a.id)?;
        let created =
            chrono::DateTime::from_timestamp_millis(a.created_at).unwrap_or_else(chrono::Utc::now);
        let mut local = None;
        if let Some(rel) = a
            .local_path
            .as_deref()
            .filter(|r| valid_staged_rel(r, &a.id))
        {
            let src = s.dir.join(rel);
            if src.is_file() {
                let ext = rel.rsplit_once('.').map(|(_, e)| e).unwrap_or("bin");
                let dest_rel = format!(
                    "media/{}/{}/{id}.{ext}",
                    created.format("%Y"),
                    created.format("%m")
                );
                let dest = root.join(&dest_rel);
                std::fs::create_dir_all(dest.parent().unwrap_or(&root))?;
                std::fs::rename(&src, &dest)?;
                moved.push(dest);
                local = Some(dest_rel);
            }
        }
        let mut thumb = None;
        if let Some(rel) = a
            .thumbnail_path
            .as_deref()
            .filter(|r| valid_staged_rel(r, &a.id))
        {
            let src = s.dir.join(rel);
            if src.is_file() {
                let dest_rel = format!("thumbs/{id}.jpg");
                std::fs::create_dir_all(root.join("thumbs"))?;
                std::fs::rename(&src, root.join(&dest_rel))?;
                moved.push(root.join(&dest_rel));
                thumb = Some(dest_rel);
            }
        }
        let status = if local.is_some() { "saved" } else { "failed" };
        tx.execute(
            "INSERT INTO media_assets (id,job_id,output_index,kind,original_url,local_path,filename,mime_type,size_bytes,sha256,duration_sec,width,height,thumbnail_path,download_status,created_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![id, job_id, a.output_index, if a.kind == "image" { "image" } else { "video" }, a.original_url, local,
                a.filename.chars().take(200).collect::<String>(), a.mime_type, a.size_bytes, a.sha256, a.duration_sec, a.width, a.height, thumb, status, a.created_at],
        )?;
        asset_map.insert(a.id.clone(), id);
        result.imported_assets += 1;
    }
    for i in &m.items {
        let Some(asset_id) = asset_map.get(&i.asset_id) else {
            continue;
        };
        let tags = crate::archive::normalize_tags(&i.tags).unwrap_or_default();
        tx.execute(
            "INSERT INTO archive_items (id,asset_id,project_id,custom_title,favorite,tags_json,deleted_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![new_id(), asset_id, i.project_id.as_ref().and_then(|p| proj_map.get(p)), i.custom_title, i.favorite as i64, serde_json::to_string(&tags)?, i.deleted_at],
        )?;
    }
    // Assets without an item (should not happen) get one.
    for id in asset_map.values() {
        tx.execute(
            "INSERT OR IGNORE INTO archive_items (id,asset_id,tags_json) VALUES (?1,?2,'[]')",
            params![new_id(), id],
        )?;
    }
    if let Err(e) = tx.commit() {
        for p in moved {
            let _ = std::fs::remove_file(p);
        }
        return Err(e.into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::env;
    use crate::secrets::SecretStore;
    use zip::write::SimpleFileOptions;

    fn seed(core: &Core) -> String {
        let job = crate::budget::tests_support_job();
        crate::jobs::insert_job(core, &job, &new_id()).unwrap();
        let asset = new_id();
        let root = core.archive_root();
        std::fs::create_dir_all(root.join("media/2026/10")).unwrap();
        let bytes = b"\x00\x00\x00\x18ftypisom-video-bytes".to_vec();
        let rel = format!("media/2026/10/{asset}.mp4");
        std::fs::write(root.join(&rel), &bytes).unwrap();
        let sha = hex::encode(Sha256::digest(&bytes));
        let c = core.db.conn();
        c.execute("INSERT INTO media_assets (id,job_id,output_index,kind,original_url,local_path,filename,sha256,size_bytes,download_status,created_at) VALUES (?1,?2,0,'video','https://x.example.com/v',?3,'v.mp4',?4,?5,'saved',1)",
            params![asset, job.id, rel, sha, bytes.len() as i64]).unwrap();
        c.execute(
            "INSERT INTO archive_items (id,asset_id,tags_json) VALUES (?1,?2,'[\"t\"]')",
            params![new_id(), asset],
        )
        .unwrap();
        drop(c);
        crate::prompts::create(core, serde_json::from_value(serde_json::json!({"title":"Mine","body":"custom body","categoryId":null,"tags":[],"favorite":false,"preferredModelIds":[],"parameters":{},"variableDefaults":{}})).unwrap()).unwrap();
        asset
    }

    #[test]
    fn roundtrip_and_no_secrets() {
        let src = env();
        src.secrets
            .set("replicate:api_token", "SUPER-SECRET-KEY-123")
            .unwrap();
        seed(&src.core);
        let out = src.dir.path().join("backup.vidra");
        export(&src.core, &out).unwrap();
        let bytes = std::fs::read(&out).unwrap();
        assert!(!bytes.windows(20).any(|w| w == b"SUPER-SECRET-KEY-123"));
        let root_str = src.core.archive_root().to_string_lossy().into_owned();
        assert!(
            !String::from_utf8_lossy(&bytes).contains(&root_str),
            "no absolute paths"
        );

        let dst = env();
        let p = preview(&dst.core, &out).unwrap();
        assert_eq!(p.job_count, 1);
        assert_eq!(p.asset_count, 1);
        assert_eq!(p.duplicate_count, 0);
        let r = confirm(&dst.core, &p.token).unwrap();
        assert_eq!(r.imported_jobs, 1);
        assert_eq!(r.imported_assets, 1);
        assert!(r.imported_prompts >= 1);
        let entries = crate::archive::list(&dst.core, &ArchiveQuery::default()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].state, "saved");
        assert!(
            crate::archive::saved_file(&dst.core, &entries[0].asset.as_ref().unwrap().id).is_ok()
        );
        // importing again: duplicates by job request id / hash are skipped
        let p2 = preview(&dst.core, &out).unwrap();
        assert_eq!(p2.duplicate_count, 1);
        let r2 = confirm(&dst.core, &p2.token).unwrap();
        assert_eq!(r2.imported_assets, 0);
        // staging cleaned
        let staged: Vec<_> = std::fs::read_dir(dst.core.archive_root().join(".tmp"))
            .unwrap()
            .collect();
        assert!(staged.is_empty());
        // cancel cleans too
        let p3 = preview(&dst.core, &out).unwrap();
        cancel(&dst.core, &p3.token).unwrap();
        assert!(confirm(&dst.core, &p3.token).is_err());
    }

    fn write_zip(path: &Path, entries: &[(&str, Vec<u8>)]) {
        let f = std::fs::File::create(path).unwrap();
        let mut z = zip::ZipWriter::new(f);
        for (n, b) in entries {
            z.start_file(*n, SimpleFileOptions::default()).unwrap();
            z.write_all(b).unwrap();
        }
        z.finish().unwrap();
    }

    fn manifest_for(files: &[(&str, &[u8])]) -> Vec<u8> {
        let m = BackupManifest {
            format: "vidra-archive".into(),
            version: 1,
            created_at: 1,
            app_version: "0".into(),
            files: files
                .iter()
                .map(|(n, b)| ManifestFile {
                    name: n.to_string(),
                    sha256: hex::encode(Sha256::digest(b)),
                    size: b.len() as u64,
                })
                .collect(),
        };
        serde_json::to_vec(&m).unwrap()
    }

    #[test]
    fn rejects_bad_archives() {
        let e = env();
        let dir = e.dir.path();
        let meta = serde_json::to_vec(&Metadata::default()).unwrap();
        // corrupted zip
        let p = dir.join("corrupt.vidra");
        std::fs::write(&p, b"PK\x03\x04garbage").unwrap();
        assert!(preview(&e.core, &p).is_err());
        // hash mismatch
        let p = dir.join("hash.vidra");
        let mut man: BackupManifest =
            serde_json::from_slice(&manifest_for(&[("metadata.json", &meta)])).unwrap();
        man.files[0].sha256 = "00".repeat(32);
        write_zip(
            &p,
            &[
                ("manifest.json", serde_json::to_vec(&man).unwrap()),
                ("metadata.json", meta.clone()),
            ],
        );
        let err = preview(&e.core, &p).unwrap_err();
        assert!(err.message.contains("sha256"), "{}", err.message);
        // zip-slip / unexpected names
        for evil in [
            "../evil.txt",
            "/abs/evil.txt",
            "C:\\evil.txt",
            "media/../../evil.mp4",
            "media\\..\\x.mp4",
            "other.txt",
            "media/not-a-uuid.mp4",
        ] {
            let p = dir.join("slip.vidra");
            write_zip(
                &p,
                &[
                    (
                        "manifest.json",
                        manifest_for(&[("metadata.json", &meta), (evil, b"x")]),
                    ),
                    ("metadata.json", meta.clone()),
                    (evil, b"x".to_vec()),
                ],
            );
            assert!(preview(&e.core, &p).is_err(), "{evil}");
            assert!(!dir.join("evil.txt").exists());
        }
        // oversized manifest
        let p = dir.join("big.vidra");
        write_zip(
            &p,
            &[
                (
                    "manifest.json",
                    vec![b' '; (MAX_MANIFEST_BYTES + 1) as usize],
                ),
                ("metadata.json", meta.clone()),
            ],
        );
        assert!(preview(&e.core, &p).is_err());
        // unlisted file
        let p = dir.join("unlisted.vidra");
        let id = new_id();
        let name = format!("media/{id}.mp4");
        write_zip(
            &p,
            &[
                ("manifest.json", manifest_for(&[("metadata.json", &meta)])),
                ("metadata.json", meta.clone()),
                (name.as_str(), b"x".to_vec()),
            ],
        );
        assert!(preview(&e.core, &p).is_err());
        // valid minimal archive passes
        let p = dir.join("ok.vidra");
        write_zip(
            &p,
            &[
                ("manifest.json", manifest_for(&[("metadata.json", &meta)])),
                ("metadata.json", meta.clone()),
            ],
        );
        let pv = preview(&e.core, &p).unwrap();
        cancel(&e.core, &pv.token).unwrap();
    }
}
