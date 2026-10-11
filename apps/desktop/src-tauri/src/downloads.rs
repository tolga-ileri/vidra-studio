//! Download manager (architecture §5.4): bounded concurrency, resumable
//! `.part` files under `<root>/.tmp`, free-space checks, size caps, content
//! checks, streaming sha256, fsync + atomic rename, duplicate detection,
//! exponential backoff, expired-URL handling and progress events.

use crate::core::Core;
use crate::db::{self, ASSET_COLS, TASK_COLS};
use crate::error::{AppError, AppResult};
use crate::types::*;
use futures_util::StreamExt;
use reqwest::Method;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const VIDEO_CAP: u64 = 4 * 1024 * 1024 * 1024;
pub const IMAGE_CAP: u64 = 100 * 1024 * 1024;
pub const SPACE_MARGIN: u64 = 200 * 1024 * 1024;
pub const MAX_ATTEMPTS: i64 = 6;

#[derive(Default)]
pub struct DownloadState {
    notify: tokio::sync::Notify,
    active: Mutex<HashSet<String>>,
    stop: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DownloadState {
    pub fn notify(&self) {
        self.notify.notify_one();
    }
    pub fn stop_flag(&self, asset_id: &str) -> Option<Arc<AtomicBool>> {
        self.stop
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(asset_id)
            .cloned()
    }
    fn lock_active(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.active.lock().unwrap_or_else(|p| p.into_inner())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Saved,
    Paused,
    Retry(String),
    Failed(String),
}

/// Detects the media type from magic bytes: (mime, ext, kind).
pub fn sniff(head: &[u8]) -> Option<(&'static str, &'static str, &'static str)> {
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        let brand = &head[8..12];
        if brand == b"qt  " {
            return Some(("video/quicktime", "mov", "video"));
        }
        return Some(("video/mp4", "mp4", "video"));
    }
    if head.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some(("video/webm", "webm", "video"));
    }
    if head.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some(("image/png", "png", "image"));
    }
    if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(("image/jpeg", "jpg", "image"));
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        return Some(("image/webp", "webp", "image"));
    }
    None
}

fn content_type_ok(ct: Option<&str>, kind: &str) -> bool {
    let Some(ct) = ct else { return true };
    let ct = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    ct.is_empty()
        || ct == "application/octet-stream"
        || ct == "binary/octet-stream"
        || (kind == "video" && ct.starts_with("video/"))
        || (kind == "image" && ct.starts_with("image/"))
}

fn backoff_ms(retry: i64) -> i64 {
    5_000 * (1i64 << retry.clamp(0, 10))
}

fn load(
    core: &Core,
    asset_id: &str,
) -> AppResult<(MediaAsset, Option<DownloadTask>, Option<String>, bool)> {
    let c = core.db.conn();
    let asset =
        db::get_asset(&c, asset_id)?.ok_or_else(|| AppError::not_found("Asset not found."))?;
    let extra: Option<(Option<String>, i64)> = rusqlite::OptionalExtension::optional(c.query_row(
        "SELECT validator, accept_ranges FROM download_tasks WHERE asset_id=?1",
        [asset_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ))?;
    let task = db::get_task(&c, asset_id)?;
    let (validator, ranges) = extra.unwrap_or((None, 0));
    Ok((asset, task, validator, ranges != 0))
}

fn set_task(core: &Core, asset_id: &str, status: &str, asset_status: &str) -> AppResult<()> {
    let c = core.db.conn();
    c.execute(
        "UPDATE download_tasks SET status=?2, updated_at=?3 WHERE asset_id=?1",
        params![asset_id, status, now_ms()],
    )?;
    c.execute(
        "UPDATE media_assets SET download_status=?2 WHERE id=?1",
        params![asset_id, asset_status],
    )?;
    Ok(())
}

fn record_error(core: &Core, asset_id: &str, code: &str, msg: &str, retry: bool) -> AppResult<()> {
    let c = core.db.conn();
    let count: i64 = c
        .query_row(
            "SELECT retry_count FROM download_tasks WHERE asset_id=?1",
            [asset_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let now = now_ms();
    if retry && count + 1 < MAX_ATTEMPTS {
        c.execute(
            "UPDATE download_tasks SET status='pending', retry_count=?2, next_attempt_at=?3, last_error=?4, last_error_code=?5, updated_at=?6 WHERE asset_id=?1",
            params![asset_id, count + 1, now + backoff_ms(count), msg, code, now],
        )?;
        c.execute(
            "UPDATE media_assets SET download_status='pending' WHERE id=?1",
            [asset_id],
        )?;
    } else {
        c.execute(
            "UPDATE download_tasks SET status='failed', retry_count=?2, next_attempt_at=NULL, last_error=?3, last_error_code=?4, updated_at=?5 WHERE asset_id=?1",
            params![asset_id, count + if retry { 1 } else { 0 }, msg, code, now],
        )?;
        c.execute(
            "UPDATE media_assets SET download_status='failed' WHERE id=?1",
            [asset_id],
        )?;
    }
    Ok(())
}

pub fn part_path(root: &Path, asset_id: &str) -> PathBuf {
    root.join(".tmp").join(format!("{asset_id}.part"))
}

async fn hash_existing(
    path: &Path,
    hasher: &mut Sha256,
    head: &mut Vec<u8>,
) -> std::io::Result<u64> {
    let mut f = tokio::fs::File::open(path).await?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        if head.len() < 16 {
            let take = (16 - head.len()).min(n);
            head.extend_from_slice(&buf[..take]);
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok(total)
}

fn parse_content_range_start(v: &str) -> Option<u64> {
    let rest = v.trim().strip_prefix("bytes ")?;
    rest.split('-').next()?.trim().parse().ok()
}

/// Downloads one asset. Never panics; records the outcome in the database.
pub async fn run(core: &Core, asset_id: &str) -> AppResult<Outcome> {
    let stop = Arc::new(AtomicBool::new(false));
    core.downloads
        .stop
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(asset_id.to_string(), stop.clone());
    let res = run_inner(core, asset_id, &stop).await;
    core.downloads
        .stop
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(asset_id);
    let outcome = match res {
        Ok(o) => o,
        Err(e) => {
            let code = if e.code == crate::error::ErrorCode::DiskFull {
                "disk_full"
            } else {
                "io"
            };
            record_error(core, asset_id, code, &e.message, false)?;
            Outcome::Failed(code.into())
        }
    };
    core.emit(StoreEvent::ArchiveChanged);
    Ok(outcome)
}

async fn run_inner(core: &Core, asset_id: &str, stop: &AtomicBool) -> AppResult<Outcome> {
    let (asset, task, validator, accept_ranges) = load(core, asset_id)?;
    if task.is_none() {
        return Err(AppError::not_found("No download task."));
    }
    let root = core.archive_root();
    if !crate::storage::root_available(core) {
        // Never recreate a missing custom root: park until it is back.
        core.db.conn().execute(
            "UPDATE download_tasks SET status='paused', last_error='The archive folder is not available.',
               last_error_code='storage_unavailable', updated_at=?2 WHERE asset_id=?1",
            params![asset_id, now_ms()],
        )?;
        core.db.conn().execute(
            "UPDATE media_assets SET download_status='paused' WHERE id=?1",
            [asset_id],
        )?;
        return Ok(Outcome::Paused);
    }
    let tmp = root.join(".tmp");
    tokio::fs::create_dir_all(&tmp).await?;
    let part = part_path(&root, asset_id);
    set_task(core, asset_id, "downloading", "downloading")?;
    core.emit(StoreEvent::ArchiveChanged);

    let cap = if asset.kind == "video" {
        VIDEO_CAP
    } else {
        IMAGE_CAP
    };
    let mut existing = match tokio::fs::metadata(&part).await {
        Ok(m) if accept_ranges && validator.is_some() => m.len(),
        _ => 0,
    };
    if existing >= cap {
        existing = 0;
    }
    let range_validator = validator.clone();
    let resp = core
        .net
        .external(Method::GET, &asset.original_url, |r| {
            if existing > 0 {
                let r = r.header("Range", format!("bytes={existing}-"));
                match &range_validator {
                    Some(v) => r.header("If-Range", v.as_str()),
                    None => r,
                }
            } else {
                r
            }
        })
        .await;
    let resp = match resp {
        Ok(r) => r,
        Err(e) if e.details.as_ref().and_then(|d| d.get("reason")).is_some() => {
            record_error(
                core,
                asset_id,
                "blocked_url",
                "The download address is not allowed.",
                false,
            )?;
            return Ok(Outcome::Failed("blocked_url".into()));
        }
        Err(e) => {
            record_error(core, asset_id, "network", &e.message, true)?;
            return Ok(Outcome::Retry("network".into()));
        }
    };
    let status = resp.status().as_u16();
    if matches!(status, 403 | 404 | 410) {
        let _ = tokio::fs::remove_file(&part).await;
        record_error(
            core,
            asset_id,
            "expired",
            "The download link has expired or was removed by the provider. The file can no longer be downloaded.",
            false,
        )?;
        return Ok(Outcome::Failed("expired".into()));
    }
    if !(status == 200 || status == 206) {
        let code = format!("http_{status}");
        record_error(
            core,
            asset_id,
            &code,
            &format!("The server responded with HTTP {status}."),
            true,
        )?;
        return Ok(Outcome::Retry(code));
    }
    let headers = resp.headers().clone();
    let hdr = |k: &str| {
        headers
            .get(k)
            .and_then(|v| v.to_str().ok())
            .map(String::from)
    };
    let resumed = status == 206
        && existing > 0
        && hdr("content-range").and_then(|v| parse_content_range_start(&v)) == Some(existing);
    if !resumed {
        existing = 0;
    }
    if !content_type_ok(hdr("content-type").as_deref(), &asset.kind) {
        let _ = tokio::fs::remove_file(&part).await;
        record_error(
            core,
            asset_id,
            "integrity",
            "The server returned an unexpected content type.",
            false,
        )?;
        return Ok(Outcome::Failed("integrity".into()));
    }
    let len = resp.content_length();
    let total = len.map(|l| l + existing);
    if total.is_some_and(|t| t > cap) {
        let _ = tokio::fs::remove_file(&part).await;
        record_error(
            core,
            asset_id,
            "too_large",
            "The file is larger than the allowed maximum.",
            false,
        )?;
        return Ok(Outcome::Failed("too_large".into()));
    }
    let new_validator = hdr("etag").or_else(|| hdr("last-modified"));
    let ranges = hdr("accept-ranges").is_some_and(|v| v.eq_ignore_ascii_case("bytes"));
    {
        let c = core.db.conn();
        c.execute(
            "UPDATE download_tasks SET validator=?2, accept_ranges=?3, total_bytes=?4, bytes_downloaded=?5, updated_at=?6 WHERE asset_id=?1",
            params![asset_id, new_validator, ranges as i64, total.map(|t| t as i64), existing as i64, now_ms()],
        )?;
    }
    let needed = len.unwrap_or(0) + SPACE_MARGIN;
    if (core.free_space)(&root).is_some_and(|free| free < needed) {
        record_error(
            core,
            asset_id,
            "disk_full",
            "Not enough free disk space for this download.",
            false,
        )?;
        return Ok(Outcome::Failed("disk_full".into()));
    }

    let mut hasher = Sha256::new();
    let mut head = Vec::with_capacity(16);
    let mut file = if resumed {
        hash_existing(&part, &mut hasher, &mut head).await?;
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .await?
    } else {
        tokio::fs::File::create(&part).await?
    };
    let mut written = existing;
    let mut stream = resp.bytes_stream();
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    let mut last_space = Instant::now();
    while let Some(chunk) = stream.next().await {
        if stop.load(Ordering::SeqCst) {
            file.flush().await?;
            drop(file);
            core.db.conn().execute(
                "UPDATE download_tasks SET bytes_downloaded=?2, updated_at=?3 WHERE asset_id=?1",
                params![asset_id, written as i64, now_ms()],
            )?;
            set_task(core, asset_id, "paused", "paused")?;
            return Ok(Outcome::Paused);
        }
        let chunk = match chunk {
            Ok(c) => c,
            Err(_) => {
                file.flush().await?;
                drop(file);
                core.db.conn().execute(
                    "UPDATE download_tasks SET bytes_downloaded=?2 WHERE asset_id=?1",
                    params![asset_id, written as i64],
                )?;
                record_error(
                    core,
                    asset_id,
                    "network",
                    "The connection was interrupted.",
                    true,
                )?;
                return Ok(Outcome::Retry("network".into()));
            }
        };
        if written + chunk.len() as u64 > cap
            || total.is_some_and(|t| written + chunk.len() as u64 > t)
        {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            record_error(
                core,
                asset_id,
                "too_large",
                "The file is larger than the allowed maximum.",
                false,
            )?;
            return Ok(Outcome::Failed("too_large".into()));
        }
        if head.len() < 16 {
            let take = (16 - head.len()).min(chunk.len());
            head.extend_from_slice(&chunk[..take]);
        }
        hasher.update(&chunk);
        if let Err(e) = file.write_all(&chunk).await {
            drop(file);
            if crate::error::is_disk_full(&e) {
                record_error(core, asset_id, "disk_full", "The disk is full.", false)?;
                return Ok(Outcome::Failed("disk_full".into()));
            }
            return Err(e.into());
        }
        written += chunk.len() as u64;
        if last_space.elapsed() > Duration::from_secs(2) {
            last_space = Instant::now();
            if (core.free_space)(&root).is_some_and(|f| f < SPACE_MARGIN / 2) {
                drop(file);
                record_error(
                    core,
                    asset_id,
                    "disk_full",
                    "Not enough free disk space for this download.",
                    false,
                )?;
                return Ok(Outcome::Failed("disk_full".into()));
            }
        }
        if last_emit.elapsed() > Duration::from_millis(250) {
            last_emit = Instant::now();
            core.db.conn().execute(
                "UPDATE download_tasks SET bytes_downloaded=?2, updated_at=?3 WHERE asset_id=?1",
                params![asset_id, written as i64, now_ms()],
            )?;
            core.emit(StoreEvent::DownloadProgress {
                asset_id: asset_id.to_string(),
                bytes_downloaded: written as i64,
                total_bytes: total.map(|t| t as i64),
            });
        }
    }
    file.flush().await?;
    file.sync_all().await?;
    drop(file);
    if total.is_some_and(|t| t != written) {
        record_error(core, asset_id, "network", "The download ended early.", true)?;
        return Ok(Outcome::Retry("network".into()));
    }
    let Some((mime, ext, kind)) = sniff(&head) else {
        let _ = tokio::fs::remove_file(&part).await;
        record_error(
            core,
            asset_id,
            "integrity",
            "The downloaded file is not a supported video or image.",
            false,
        )?;
        return Ok(Outcome::Failed("integrity".into()));
    };
    if kind != asset.kind {
        let _ = tokio::fs::remove_file(&part).await;
        record_error(
            core,
            asset_id,
            "integrity",
            "The downloaded file type does not match the generation.",
            false,
        )?;
        return Ok(Outcome::Failed("integrity".into()));
    }
    let sha = hex::encode(hasher.finalize());
    finalize(core, &root, &asset, &part, mime, ext, &sha, written)?;
    Ok(Outcome::Saved)
}

#[allow(clippy::too_many_arguments)]
fn finalize(
    core: &Core,
    root: &Path,
    asset: &MediaAsset,
    part: &Path,
    mime: &str,
    ext: &str,
    sha: &str,
    size: u64,
) -> AppResult<()> {
    let created =
        chrono::DateTime::from_timestamp_millis(asset.created_at).unwrap_or_else(chrono::Utc::now);
    let rel_dir = format!("media/{}/{}", created.format("%Y"), created.format("%m"));
    let rel = format!("{rel_dir}/{}.{ext}", asset.id);
    std::fs::create_dir_all(root.join(&rel_dir))?;
    let dest = root.join(&rel);
    std::fs::rename(part, &dest)?;
    let stem = asset
        .filename
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(&asset.filename);
    let filename = format!("{stem}.{ext}");
    let duplicate: Option<String> = {
        let c = core.db.conn();
        rusqlite::OptionalExtension::optional(c.query_row(
            "SELECT id FROM media_assets WHERE sha256=?1 AND id != ?2 AND download_status='saved' ORDER BY created_at LIMIT 1",
            params![sha, asset.id],
            |r| r.get(0),
        ))?
    };
    let (w, h, thumb) = if asset.kind == "image" {
        image_thumb(root, &dest, &asset.id)
    } else {
        (None, None, None)
    };
    let c = core.db.conn();
    c.execute(
        "UPDATE media_assets SET local_path=?2, filename=?3, mime_type=?4, size_bytes=?5, sha256=?6, download_status='saved',
           duplicate_of_asset_id=?7, width=COALESCE(?8,width), height=COALESCE(?9,height), thumbnail_path=COALESCE(?10,thumbnail_path) WHERE id=?1",
        params![asset.id, rel, filename, mime, size as i64, sha, duplicate, w, h, thumb],
    )?;
    c.execute(
        "UPDATE download_tasks SET status='completed', bytes_downloaded=?2, total_bytes=?2, next_attempt_at=NULL, last_error=NULL, last_error_code=NULL, updated_at=?3 WHERE asset_id=?1",
        params![asset.id, size as i64, now_ms()],
    )?;
    Ok(())
}

/// Generates `thumbs/<id>.jpg` for PNG/JPEG images. Returns (w, h, rel path).
pub fn image_thumb(
    root: &Path,
    file: &Path,
    id: &str,
) -> (Option<i64>, Option<i64>, Option<String>) {
    let reader = match image::ImageReader::open(file).and_then(|r| r.with_guessed_format()) {
        Ok(r) => r,
        Err(_) => return (None, None, None),
    };
    let mut reader = reader;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(512 * 1024 * 1024);
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    reader.limits(limits);
    let Ok(img) = reader.decode() else {
        return (None, None, None);
    };
    let (w, h) = (img.width() as i64, img.height() as i64);
    let thumb = img.thumbnail(512, 512).to_rgb8();
    let rel = format!("thumbs/{id}.jpg");
    let _ = std::fs::create_dir_all(root.join("thumbs"));
    let ok = thumb
        .save_with_format(root.join(&rel), image::ImageFormat::Jpeg)
        .is_ok();
    (Some(w), Some(h), ok.then_some(rel))
}

/* ── Scheduling and controls ───────────────────────────────────────────── */

fn due_tasks(core: &Core, limit: usize) -> AppResult<Vec<String>> {
    let c = core.db.conn();
    let mut st = c.prepare(
        "SELECT asset_id FROM download_tasks WHERE status='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
         ORDER BY updated_at LIMIT ?2",
    )?;
    let rows = st.query_map(params![now_ms(), limit as i64 + 8], |r| r.get(0))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Starts due downloads up to the configured concurrency.
pub fn schedule(core: &Arc<Core>) -> AppResult<()> {
    // Downloads pause while the archive folder is unavailable (unplugged
    // drive, offline share) or being moved, and resume automatically.
    if core.moving.load(std::sync::atomic::Ordering::SeqCst)
        || !crate::storage::reconcile_downloads(core)
    {
        return Ok(());
    }
    let concurrency = crate::settings::get(core).download_concurrency.clamp(1, 4) as usize;
    let due = due_tasks(core, concurrency)?;
    let mut active = core.downloads.lock_active();
    for id in due {
        if active.len() >= concurrency {
            break;
        }
        if !active.insert(id.clone()) {
            continue;
        }
        let core = core.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = run(&core, &id).await {
                log::warn!("download {id} failed: {}", e.code);
            }
            core.downloads.lock_active().remove(&id);
            core.downloads.notify();
        });
    }
    Ok(())
}

/// Startup recovery: interrupted downloads go back to pending (resumable).
pub fn recover(core: &Core) -> AppResult<()> {
    let c = core.db.conn();
    c.execute("UPDATE download_tasks SET status='pending', next_attempt_at=NULL WHERE status='downloading'", [])?;
    c.execute(
        "UPDATE media_assets SET download_status='pending' WHERE download_status='downloading'
           AND id IN (SELECT asset_id FROM download_tasks WHERE status='pending')",
        [],
    )?;
    Ok(())
}

pub fn spawn_manager(core: Arc<Core>) {
    tauri::async_runtime::spawn(async move {
        if let Err(e) = recover(&core) {
            log::error!("download recovery failed: {}", e.code);
        }
        loop {
            if let Err(e) = schedule(&core) {
                log::warn!("download schedule failed: {}", e.code);
            }
            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                _ = core.downloads.notify.notified() => {}
            }
        }
    });
}

pub fn pause(core: &Core, asset_id: &str) -> AppResult<()> {
    validate_id(asset_id)?;
    if let Some(flag) = core
        .downloads
        .stop
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(asset_id)
    {
        flag.store(true, Ordering::SeqCst);
    }
    let c = core.db.conn();
    let n = c.execute(
        "UPDATE download_tasks SET status='paused', updated_at=?2 WHERE asset_id=?1 AND status IN ('pending','downloading')",
        params![asset_id, now_ms()],
    )?;
    if n > 0 {
        c.execute(
            "UPDATE media_assets SET download_status='paused' WHERE id=?1",
            [asset_id],
        )?;
    }
    drop(c);
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

pub fn resume(core: &Core, asset_id: &str) -> AppResult<()> {
    validate_id(asset_id)?;
    let c = core.db.conn();
    let n = c.execute(
        "UPDATE download_tasks SET status='pending', next_attempt_at=NULL, updated_at=?2 WHERE asset_id=?1 AND status='paused'",
        params![asset_id, now_ms()],
    )?;
    if n > 0 {
        c.execute(
            "UPDATE media_assets SET download_status='pending' WHERE id=?1",
            [asset_id],
        )?;
    }
    drop(c);
    core.downloads.notify();
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

/// Retries a failed/missing download, or starts one when autoSave was off.
pub fn retry(core: &Core, asset_id: &str) -> AppResult<()> {
    validate_id(asset_id)?;
    let c = core.db.conn();
    let asset =
        db::get_asset(&c, asset_id)?.ok_or_else(|| AppError::not_found("Asset not found."))?;
    if asset.download_status == "saved" && asset.local_path.is_some() {
        return Ok(());
    }
    let now = now_ms();
    c.execute(
        "INSERT INTO download_tasks (id, asset_id, status, updated_at) VALUES (?1, ?2, 'pending', ?3)
         ON CONFLICT(asset_id) DO UPDATE SET status='pending', retry_count=0, next_attempt_at=NULL, last_error=NULL,
           last_error_code=NULL, updated_at=excluded.updated_at",
        params![new_id(), asset_id, now],
    )?;
    c.execute(
        "UPDATE media_assets SET download_status='pending', local_path=NULL WHERE id=?1",
        [asset_id],
    )?;
    drop(c);
    core.downloads.notify();
    core.emit(StoreEvent::ArchiveChanged);
    Ok(())
}

pub fn list(core: &Core) -> AppResult<Vec<DownloadListEntry>> {
    let c = core.db.conn();
    let tcols: String = TASK_COLS
        .split(',')
        .map(|s| format!("t.{}", s.trim()))
        .collect::<Vec<_>>()
        .join(",");
    let acols: String = ASSET_COLS
        .split(',')
        .map(|s| format!("a.{}", s.trim()))
        .collect::<Vec<_>>()
        .join(",");
    let jcols: String = db::JOB_COLS
        .split(',')
        .map(|s| format!("j.{}", s.trim()))
        .collect::<Vec<_>>()
        .join(",");
    let mut st = c.prepare(&format!(
        "SELECT {tcols}, {acols}, {jcols} FROM download_tasks t JOIN media_assets a ON a.id=t.asset_id
         JOIN generation_jobs j ON j.id=a.job_id ORDER BY t.updated_at DESC LIMIT 1000"
    ))?;
    let rows = st.query_map([], |r| {
        Ok(DownloadListEntry {
            task: db::task_from_row(r, 0)?,
            asset: db::asset_from_row(r, db::TASK_NCOLS)?,
            job: db::job_from_row(r, db::TASK_NCOLS + db::ASSET_NCOLS)?,
        })
    })?;
    Ok(rows.collect::<Result<_, _>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::*;
    use crate::manifest::Registry;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    pub fn mp4_bytes(n: usize) -> Vec<u8> {
        let mut v = vec![
            0, 0, 0, 0x18, b'f', b't', b'y', b'p', b'i', b's', b'o', b'm',
        ];
        v.extend((0..n).map(|i| (i % 251) as u8));
        v
    }

    pub fn seed_asset(core: &Core, url: &str, kind: &str) -> String {
        let job_id = new_id();
        let asset_id = new_id();
        let c = core.db.conn();
        c.execute("INSERT INTO generation_jobs (id,provider,model_id,model_name,workflow,output,status,prompt,params_json,idempotency_key,created_at,updated_at) VALUES (?1,'replicate','replicate:m','M','text-to-video',?2,'completed','a prompt','{}',?1,1,1)", params![job_id, kind]).unwrap();
        c.execute("INSERT INTO media_assets (id,job_id,output_index,kind,original_url,filename,download_status,created_at) VALUES (?1,?2,0,?3,?4,'out.mp4','pending',?5)", params![asset_id, job_id, kind, url, now_ms()]).unwrap();
        c.execute(
            "INSERT INTO archive_items (id,asset_id) VALUES (?1,?2)",
            params![new_id(), asset_id],
        )
        .unwrap();
        c.execute(
            "INSERT INTO download_tasks (id,asset_id,status,updated_at) VALUES (?1,?2,'pending',0)",
            params![new_id(), asset_id],
        )
        .unwrap();
        asset_id
    }

    fn task(core: &Core, id: &str) -> DownloadTask {
        db::get_task(&core.db.conn(), id).unwrap().unwrap()
    }

    #[tokio::test]
    async fn success_atomic_rename_and_sha() {
        let e = env();
        let s = MockServer::start().await;
        let body = mp4_bytes(100_000);
        Mock::given(path("/v.mp4"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(body.clone(), "video/mp4"))
            .mount(&s)
            .await;
        let id = seed_asset(&e.core, &format!("{}/v.mp4", s.uri()), "video");
        assert_eq!(run(&e.core, &id).await.unwrap(), Outcome::Saved);
        let a = db::get_asset(&e.core.db.conn(), &id).unwrap().unwrap();
        assert_eq!(a.download_status, "saved");
        let rel = a.local_path.unwrap();
        assert!(rel.starts_with("media/") && rel.ends_with(&format!("{id}.mp4")));
        let data = std::fs::read(e.core.archive_root().join(&rel)).unwrap();
        assert_eq!(data, body);
        assert_eq!(a.sha256.unwrap(), hex::encode(Sha256::digest(&body)));
        assert!(!part_path(&e.core.archive_root(), &id).exists());
        assert_eq!(task(&e.core, &id).status, "completed");
        // duplicate detection
        let id2 = seed_asset(&e.core, &format!("{}/v.mp4", s.uri()), "video");
        run(&e.core, &id2).await.unwrap();
        let a2 = db::get_asset(&e.core.db.conn(), &id2).unwrap().unwrap();
        assert_eq!(a2.duplicate_of_asset_id.as_deref(), Some(id.as_str()));
    }

    struct RangeResponder {
        body: Vec<u8>,
        honor: bool,
    }
    impl Respond for RangeResponder {
        fn respond(&self, req: &Request) -> ResponseTemplate {
            if let Some(r) = req.headers.get("range").and_then(|v| v.to_str().ok()) {
                assert_eq!(
                    req.headers.get("if-range").and_then(|v| v.to_str().ok()),
                    Some("\"v1\"")
                );
                if self.honor {
                    let start: usize = r
                        .trim_start_matches("bytes=")
                        .trim_end_matches('-')
                        .parse()
                        .unwrap();
                    return ResponseTemplate::new(206)
                        .insert_header("etag", "\"v1\"")
                        .insert_header("accept-ranges", "bytes")
                        .insert_header(
                            "content-range",
                            format!("bytes {start}-{}/{}", self.body.len() - 1, self.body.len()),
                        )
                        .set_body_raw(self.body[start..].to_vec(), "video/mp4");
                }
            }
            ResponseTemplate::new(200)
                .insert_header("etag", "\"v1\"")
                .insert_header("accept-ranges", "bytes")
                .set_body_raw(self.body.clone(), "video/mp4")
        }
    }

    async fn resume_case(honor: bool) {
        let e = env();
        let s = MockServer::start().await;
        let body = mp4_bytes(50_000);
        Mock::given(path("/r.mp4"))
            .respond_with(RangeResponder {
                body: body.clone(),
                honor,
            })
            .mount(&s)
            .await;
        let id = seed_asset(&e.core, &format!("{}/r.mp4", s.uri()), "video");
        // simulate an interrupted earlier attempt: 20 000 bytes on disk + validator
        let root = e.core.archive_root();
        std::fs::create_dir_all(root.join(".tmp")).unwrap();
        std::fs::write(part_path(&root, &id), &body[..20_000]).unwrap();
        e.core
            .db
            .conn()
            .execute(
                "UPDATE download_tasks SET validator='\"v1\"', accept_ranges=1 WHERE asset_id=?1",
                [&id],
            )
            .unwrap();
        assert_eq!(run(&e.core, &id).await.unwrap(), Outcome::Saved);
        let a = db::get_asset(&e.core.db.conn(), &id).unwrap().unwrap();
        assert_eq!(
            std::fs::read(root.join(a.local_path.unwrap())).unwrap(),
            body
        );
        assert_eq!(a.sha256.unwrap(), hex::encode(Sha256::digest(&body)));
        let reqs = s.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1);
        assert!(reqs[0].headers.get("range").is_some());
    }

    #[tokio::test]
    async fn resume_with_range() {
        resume_case(true).await;
    }

    #[tokio::test]
    async fn server_ignoring_range_restarts_from_zero() {
        resume_case(false).await;
    }

    #[tokio::test]
    async fn expired_urls_do_not_retry() {
        for code in [403u16, 404, 410] {
            let e = env();
            let s = MockServer::start().await;
            Mock::given(method("GET"))
                .respond_with(ResponseTemplate::new(code))
                .mount(&s)
                .await;
            let id = seed_asset(&e.core, &format!("{}/gone.mp4", s.uri()), "video");
            assert_eq!(
                run(&e.core, &id).await.unwrap(),
                Outcome::Failed("expired".into())
            );
            let t = task(&e.core, &id);
            assert_eq!(t.status, "failed");
            assert_eq!(t.last_error_code.as_deref(), Some("expired"));
            assert!(t.next_attempt_at.is_none());
            assert!(t.last_error.unwrap().contains("expired"));
        }
    }

    #[tokio::test]
    async fn integrity_failure_on_wrong_magic() {
        let e = env();
        let s = MockServer::start().await;
        Mock::given(path("/x"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_raw(b"<html>nope</html>".to_vec(), "application/octet-stream"),
            )
            .mount(&s)
            .await;
        Mock::given(path("/img"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(mp4_bytes(10), "text/html"))
            .mount(&s)
            .await;
        let id = seed_asset(&e.core, &format!("{}/x", s.uri()), "video");
        assert_eq!(
            run(&e.core, &id).await.unwrap(),
            Outcome::Failed("integrity".into())
        );
        let id = seed_asset(&e.core, &format!("{}/img", s.uri()), "video");
        assert_eq!(
            run(&e.core, &id).await.unwrap(),
            Outcome::Failed("integrity".into())
        );
        // kind mismatch: mp4 bytes for an image asset
        let s2 = MockServer::start().await;
        Mock::given(path("/i"))
            .respond_with(
                ResponseTemplate::new(200).set_body_raw(mp4_bytes(10), "application/octet-stream"),
            )
            .mount(&s2)
            .await;
        let id = seed_asset(&e.core, &format!("{}/i", s2.uri()), "image");
        assert_eq!(
            run(&e.core, &id).await.unwrap(),
            Outcome::Failed("integrity".into())
        );
    }

    #[tokio::test]
    async fn disk_full_simulation() {
        let e = env_with(
            None,
            Registry::from_models(vec![]),
            Some(Arc::new(|_: &Path| Some(10 * 1024 * 1024))),
        );
        let s = MockServer::start().await;
        Mock::given(path("/v"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(mp4_bytes(1000), "video/mp4"))
            .mount(&s)
            .await;
        let id = seed_asset(&e.core, &format!("{}/v", s.uri()), "video");
        assert_eq!(
            run(&e.core, &id).await.unwrap(),
            Outcome::Failed("disk_full".into())
        );
        assert_eq!(
            task(&e.core, &id).last_error_code.as_deref(),
            Some("disk_full")
        );
    }

    #[tokio::test]
    async fn size_cap() {
        let e = env();
        let s = MockServer::start().await;
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.resize((IMAGE_CAP + 10) as usize, 0);
        Mock::given(path("/big.png"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(png, "image/png"))
            .mount(&s)
            .await;
        let id = seed_asset(&e.core, &format!("{}/big.png", s.uri()), "image");
        assert_eq!(
            run(&e.core, &id).await.unwrap(),
            Outcome::Failed("too_large".into())
        );
    }

    #[tokio::test]
    async fn retry_with_backoff_then_manual_retry() {
        let e = env();
        let s = MockServer::start().await;
        Mock::given(path("/flaky"))
            .respond_with(ResponseTemplate::new(503))
            .up_to_n_times(1)
            .mount(&s)
            .await;
        Mock::given(path("/flaky"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(mp4_bytes(100), "video/mp4"))
            .mount(&s)
            .await;
        let id = seed_asset(&e.core, &format!("{}/flaky", s.uri()), "video");
        assert_eq!(
            run(&e.core, &id).await.unwrap(),
            Outcome::Retry("http_503".into())
        );
        let t = task(&e.core, &id);
        assert_eq!(t.status, "pending");
        assert_eq!(t.retry_count, 1);
        assert!(t.next_attempt_at.unwrap() >= now_ms() + 4_000);
        assert!(
            due_tasks(&e.core, 4).unwrap().is_empty(),
            "not due before backoff"
        );
        retry(&e.core, &id).unwrap();
        assert_eq!(task(&e.core, &id).retry_count, 0);
        assert_eq!(run(&e.core, &id).await.unwrap(), Outcome::Saved);
        // after MAX_ATTEMPTS the task fails permanently
        let s2 = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(500))
            .mount(&s2)
            .await;
        let id = seed_asset(&e.core, &format!("{}/x", s2.uri()), "video");
        for _ in 0..MAX_ATTEMPTS {
            run(&e.core, &id).await.unwrap();
        }
        assert_eq!(task(&e.core, &id).status, "failed");
    }

    #[tokio::test]
    async fn blocked_urls_are_not_fetched() {
        let e = env();
        let id = seed_asset(&e.core, "https://127.0.0.1/x.mp4", "video");
        assert_eq!(
            run(&e.core, &id).await.unwrap(),
            Outcome::Failed("blocked_url".into())
        );
        let id = seed_asset(&e.core, "http://example.com/x.mp4", "video");
        assert_eq!(
            run(&e.core, &id).await.unwrap(),
            Outcome::Failed("blocked_url".into())
        );
    }

    #[tokio::test]
    async fn pause_resume_and_recovery() {
        let e = env();
        let id = seed_asset(&e.core, "https://cdn.example.com/x.mp4", "video");
        pause(&e.core, &id).unwrap();
        assert_eq!(task(&e.core, &id).status, "paused");
        resume(&e.core, &id).unwrap();
        assert_eq!(task(&e.core, &id).status, "pending");
        e.core
            .db
            .conn()
            .execute("UPDATE download_tasks SET status='downloading'", [])
            .unwrap();
        recover(&e.core).unwrap();
        assert_eq!(task(&e.core, &id).status, "pending");
        assert_eq!(list(&e.core).unwrap().len(), 1);
        let _ = header("x", "y");
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff(&mp4_bytes(4)).unwrap().1, "mp4");
        assert_eq!(sniff(b"\x00\x00\x00\x14ftypqt  ").unwrap().1, "mov");
        assert_eq!(sniff(&[0x1A, 0x45, 0xDF, 0xA3, 0]).unwrap().1, "webm");
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap().1, "jpg");
        assert_eq!(sniff(b"RIFF\x00\x00\x00\x00WEBPVP8 ").unwrap().1, "webp");
        assert!(sniff(b"GIF89a").is_none());
    }
}
