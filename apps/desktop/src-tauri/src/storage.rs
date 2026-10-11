//! Archive storage control: availability (external / network folders),
//! automatic download pausing, verified archive moves, reconnecting a moved
//! folder and the export folder.
//!
//! Safety rules: only files recorded in the database are ever copied or
//! removed; existing different files at a destination are never
//! overwritten; old copies are removed only on explicit request after every
//! file verified. Only unprivileged file APIs are used (no drive formatting,
//! no permission or ACL changes).

use crate::archive::{display_path, resolve_in_root};
use crate::core::Core;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::types::*;
use rusqlite::params;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;

/// Exists + writable probe: creates and removes a temp file in `<dir>/.tmp`.
/// Never creates `dir` itself.
pub fn probe_writable(dir: &Path) -> std::io::Result<()> {
    if !dir.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "folder is not available",
        ));
    }
    let tmp = dir.join(".tmp");
    std::fs::create_dir_all(&tmp)?;
    let f = tmp.join(format!("probe-{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&f, b"vidra")?;
    std::fs::remove_file(&f)
}

/// (is_network, is_removable) for the volume holding `path`.
#[cfg(windows)]
pub fn drive_kind(path: &Path) -> (bool, bool) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetVolumePathNameW};
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_REMOTE: u32 = 4;
    let s = path.to_string_lossy();
    if s.starts_with(r"\\?\UNC\")
        || (s.starts_with(r"\\") && !s.starts_with(r"\\?\") && !s.starts_with(r"\\.\"))
    {
        return (true, false);
    }
    let mut existing = path.to_path_buf();
    while !existing.exists() {
        if !existing.pop() {
            return (false, false);
        }
    }
    let wide: Vec<u16> = existing.as_os_str().encode_wide().chain([0]).collect();
    let mut buf = vec![0u16; 1024];
    // SAFETY: `wide` is NUL-terminated and `buf` is a writable buffer of the
    // given length; both outlive the calls. Read-only volume queries.
    let ok = unsafe { GetVolumePathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) };
    if ok == 0 {
        return (false, false);
    }
    // SAFETY: `buf` now holds a NUL-terminated volume root path.
    let t = unsafe { GetDriveTypeW(buf.as_ptr()) };
    (t == DRIVE_REMOTE, t == DRIVE_REMOVABLE)
}

#[cfg(not(windows))]
pub fn drive_kind(path: &Path) -> (bool, bool) {
    let s = path.to_string_lossy();
    (s.starts_with("//"), false)
}

/// Whether the archive root can be written right now. The default root
/// (under the user's Videos folder) is created on demand; a custom root that
/// is missing is treated as unplugged and never recreated.
pub fn root_available(core: &Core) -> bool {
    let root = core.archive_root();
    if !root.exists() && root == core.default_root {
        let _ = std::fs::create_dir_all(&root);
    }
    probe_writable(&root).is_ok()
}

/// Parks pending downloads while the root is unavailable and resumes the
/// parked ones when it is back. Returns availability.
pub fn reconcile_downloads(core: &Core) -> bool {
    let available = root_available(core);
    let c = core.db.conn();
    let now = now_ms();
    let res = if available {
        c.execute(
            "UPDATE download_tasks SET status='pending', next_attempt_at=NULL, last_error=NULL, last_error_code=NULL, updated_at=?1
             WHERE status='paused' AND last_error_code='storage_unavailable'",
            [now],
        )
        .and_then(|n| {
            if n > 0 {
                c.execute(
                    "UPDATE media_assets SET download_status='pending' WHERE download_status='paused'
                       AND id IN (SELECT asset_id FROM download_tasks WHERE status='pending')",
                    [],
                )?;
            }
            Ok(n)
        })
    } else {
        c.execute(
            "UPDATE download_tasks SET status='paused', last_error='The archive folder is not available.',
               last_error_code='storage_unavailable', updated_at=?1 WHERE status='pending'",
            [now],
        )
        .and_then(|n| {
            if n > 0 {
                c.execute(
                    "UPDATE media_assets SET download_status='paused' WHERE id IN
                       (SELECT asset_id FROM download_tasks WHERE status='paused' AND last_error_code='storage_unavailable')",
                    [],
                )?;
            }
            Ok(n)
        })
    };
    drop(c);
    if res.is_ok_and(|n| n > 0) {
        core.emit(StoreEvent::ArchiveChanged);
    }
    available
}

pub fn status(core: &Core) -> AppResult<StorageStatus> {
    let root = core.archive_root();
    let available = root_available(core);
    let (is_network, is_removable) = drive_kind(&root);
    let s = crate::settings::get(core);
    let c = core.db.conn();
    let used: i64 = c.query_row(
        "SELECT COALESCE(SUM(size_bytes),0) FROM media_assets WHERE download_status='saved'",
        [],
        |r| r.get(0),
    )?;
    let parked: i64 = c.query_row(
        "SELECT COUNT(*) FROM download_tasks WHERE status='paused' AND last_error_code='storage_unavailable'",
        [],
        |r| r.get(0),
    )?;
    let waiting: i64 = c.query_row(
        "SELECT COUNT(*) FROM download_tasks WHERE status IN ('pending','downloading')",
        [],
        |r| r.get(0),
    )?;
    Ok(StorageStatus {
        archive_root: display_path(&root),
        available,
        is_network,
        is_removable,
        free_bytes: if available {
            (core.free_space)(&root)
        } else {
            None
        },
        used_bytes: used,
        export_dir: s.export_dir,
        downloads_paused: parked > 0 || (!available && waiting > 0),
    })
}

fn unavailable() -> AppError {
    AppError::new(
        ErrorCode::StorageUnavailable,
        "The archive folder is not available. Reconnect the drive or choose its new location.",
    )
    .with_reason("archive_root_unavailable")
}

/* ── Archive move ──────────────────────────────────────────────────────── */

#[derive(Debug, Clone)]
pub struct MoveState {
    pub from: PathBuf,
    pub to: PathBuf,
    /// (relative path, expected sha256 when known)
    pub files: Vec<(String, Option<String>)>,
    /// Files this move created (the only ones cancel may remove).
    pub created: Vec<PathBuf>,
    pub result: Option<ArchiveMoveResult>,
}

fn managed_files(core: &Core) -> AppResult<Vec<(String, Option<String>)>> {
    let c = core.db.conn();
    let mut st = c.prepare(
        "SELECT local_path, sha256 FROM media_assets WHERE local_path IS NOT NULL
         UNION ALL SELECT thumbnail_path, NULL FROM media_assets WHERE thumbnail_path IS NOT NULL",
    )?;
    let rows = st.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
    })?;
    let mut map: BTreeMap<String, Option<String>> = BTreeMap::new();
    for row in rows {
        let (rel, sha) = row?;
        let e = map.entry(rel).or_insert(None);
        if e.is_none() {
            *e = sha;
        }
    }
    Ok(map.into_iter().collect())
}

fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.contains(':')
        && Path::new(rel)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex::encode(h.finalize()))
}

fn token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub fn check_token(t: &str) -> AppResult<()> {
    if t.len() == 32 && t.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(AppError::invalid("Invalid token.").with_reason("invalid_token"))
    }
}

/// Prepares a move to `target` (an existing folder chosen by the user).
/// Nothing is copied.
pub fn plan_move(core: &Core, target: &Path) -> AppResult<ArchiveMovePlan> {
    let from = core.archive_root();
    let from_c = std::fs::canonicalize(&from).map_err(|_| unavailable())?;
    let to_c = std::fs::canonicalize(target).map_err(|_| {
        AppError::invalid("The chosen folder does not exist.").with_reason("target_missing")
    })?;
    if to_c == from_c {
        return Err(
            AppError::invalid("This is already the archive folder.").with_reason("same_folder")
        );
    }
    if to_c.starts_with(&from_c) || from_c.starts_with(&to_c) {
        return Err(AppError::invalid(
            "Choose a folder that is not inside (or containing) the current archive.",
        )
        .with_reason("nested_folder"));
    }
    probe_writable(&to_c).map_err(|e| AppError::from(e).with_reason("target_not_writable"))?;
    let files = managed_files(core)?;
    let mut total = 0u64;
    for (rel, _) in &files {
        if let Ok(p) = resolve_in_root(&from_c, rel) {
            total += std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        }
    }
    let (is_network, is_removable) = drive_kind(&to_c);
    let free = (core.free_space)(&to_c);
    let mut warnings = Vec::new();
    if is_network {
        warnings.push("network_folder".to_string());
    }
    if is_removable {
        warnings.push("removable_drive".to_string());
    }
    if free.is_some_and(|f| f < total.saturating_add(total / 10)) {
        warnings.push("low_space".to_string());
    }
    let not_empty = std::fs::read_dir(&to_c)
        .map(|mut d| d.any(|e| e.is_ok_and(|e| e.file_name() != ".tmp")))
        .unwrap_or(false);
    if not_empty {
        warnings.push("not_empty".to_string());
    }
    let t = token();
    let plan = ArchiveMovePlan {
        token: t.clone(),
        from: display_path(&from_c),
        to: display_path(&to_c),
        file_count: files.len(),
        total_bytes: total,
        free_bytes: free,
        is_network,
        is_removable,
        warnings,
    };
    core.moves.lock().unwrap_or_else(|p| p.into_inner()).insert(
        t,
        MoveState {
            from: from_c,
            to: to_c,
            files,
            created: vec![],
            result: None,
        },
    );
    Ok(plan)
}

enum CopyOutcome {
    Created,
    AlreadyIdentical,
}

fn copy_verified(src: &Path, dst: &Path, expected: Option<&str>) -> Result<CopyOutcome, String> {
    let src_sha = sha256_file(src).map_err(|e| format!("read source: {e}"))?;
    if expected.is_some_and(|x| !x.eq_ignore_ascii_case(&src_sha)) {
        return Err("source does not match the recorded checksum".into());
    }
    if dst.exists() {
        let dst_sha = sha256_file(dst).map_err(|e| format!("read destination: {e}"))?;
        return if dst_sha == src_sha {
            Ok(CopyOutcome::AlreadyIdentical)
        } else {
            Err("a different file already exists at the destination".into())
        };
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create folder: {e}"))?;
    }
    let mut part = dst.as_os_str().to_owned();
    part.push(".vidra-part");
    let part = PathBuf::from(part);
    let write = || -> std::io::Result<()> {
        let mut input = std::fs::File::open(src)?;
        let mut out = std::fs::File::create(&part)?;
        std::io::copy(&mut input, &mut out)?;
        out.flush()?;
        out.sync_all()
    };
    if let Err(e) = write() {
        if part.exists() && std::fs::metadata(&part).is_ok_and(|m| !m.permissions().readonly()) {
            let _ = std::fs::remove_file(&part);
        }
        return Err(format!("copy: {e}"));
    }
    if dst.exists() {
        let _ = std::fs::remove_file(&part);
        return Err("a file appeared at the destination during the copy".into());
    }
    std::fs::rename(&part, dst).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("rename: {e}")
    })?;
    match sha256_file(dst) {
        Ok(h) if h == src_sha => Ok(CopyOutcome::Created),
        _ => {
            let _ = std::fs::remove_file(dst);
            Err("verification failed".into())
        }
    }
}

/// Copies every managed file (media + thumbnails) and verifies sha256.
/// Old files are untouched.
pub fn start_move(core: &Core, token: &str) -> AppResult<ArchiveMoveResult> {
    check_token(token)?;
    let state = core
        .moves
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(token)
        .cloned()
        .ok_or_else(|| {
            AppError::not_found("This move was not prepared.").with_reason("unknown_token")
        })?;
    if !state.from.is_dir() {
        return Err(unavailable());
    }
    if core.moving.swap(true, Ordering::SeqCst) {
        return Err(
            AppError::invalid("Another move is in progress.").with_reason("move_in_progress")
        );
    }
    let total = state.files.len();
    let mut result = ArchiveMoveResult {
        token: token.to_string(),
        ..Default::default()
    };
    let mut created = Vec::new();
    for (i, (rel, sha)) in state.files.iter().enumerate() {
        let outcome = if !safe_rel(rel) {
            Err("unsafe path".to_string())
        } else {
            match resolve_in_root(&state.from, rel) {
                Ok(src) if src.is_file() => {
                    copy_verified(&src, &state.to.join(rel), sha.as_deref())
                }
                _ => Err("source file is missing".into()),
            }
        };
        match outcome {
            Ok(CopyOutcome::Created) => {
                result.copied += 1;
                result.verified += 1;
                created.push(state.to.join(rel));
            }
            Ok(CopyOutcome::AlreadyIdentical) => result.verified += 1,
            Err(reason) => {
                log::warn!("archive move: {rel}: {reason}");
                result.failed += 1;
                result.failures.push(rel.clone());
            }
        }
        core.emit(StoreEvent::ArchiveMoveProgress {
            token: token.to_string(),
            processed: i + 1,
            total,
        });
    }
    core.moving.store(false, Ordering::SeqCst);
    if let Some(s) = core
        .moves
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_mut(token)
    {
        s.created.extend(created);
        s.result = Some(result.clone());
    }
    Ok(result)
}

/// Switches the archive root to the verified copy. Old managed files are
/// removed only when `remove_old` is true; never any other file.
/// Returns (settings, old root, new root).
pub fn finalize_move(
    core: &Core,
    token: &str,
    remove_old: bool,
) -> AppResult<(AppSettings, PathBuf, PathBuf)> {
    check_token(token)?;
    let state = core
        .moves
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(token)
        .cloned()
        .ok_or_else(|| {
            AppError::not_found("This move was not prepared.").with_reason("unknown_token")
        })?;
    let Some(result) = &state.result else {
        return Err(AppError::invalid("Copy the files first.").with_reason("move_not_started"));
    };
    if result.failed > 0 {
        return Err(AppError::invalid(
            "Some files could not be copied and verified. Resolve them or cancel the move.",
        )
        .with_details(serde_json::json!({"reason": "move_incomplete", "failed": result.failed})));
    }
    let mut s = crate::settings::get(core);
    s.archive_root = display_path(&state.to);
    crate::settings::save(core, &s)?;
    if remove_old {
        for (rel, _) in &state.files {
            // Only paths recorded in the database, only inside the old root,
            // and only when the verified copy exists.
            if !safe_rel(rel) || !state.to.join(rel).is_file() {
                continue;
            }
            if let Ok(old) = resolve_in_root(&state.from, rel) {
                if old.is_file() {
                    if let Err(e) = std::fs::remove_file(&old) {
                        log::warn!("old copy not removed: {e}");
                    }
                }
            }
        }
    }
    core.moves
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(token);
    core.downloads.notify();
    core.emit(StoreEvent::SettingsChanged);
    core.emit(StoreEvent::ArchiveChanged);
    Ok((s, state.from, state.to))
}

/// Abandons a move: removes only the files this move created.
pub fn cancel_move(core: &Core, token: &str) -> AppResult<()> {
    check_token(token)?;
    let state = core
        .moves
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(token);
    if let Some(state) = state {
        for f in state.created {
            if f.starts_with(&state.to) && f.is_file() {
                let _ = std::fs::remove_file(&f);
            }
        }
    }
    Ok(())
}

/// Points Vidra at the archive folder's new location (e.g. a drive letter
/// change) without copying. Accepted only when the folder contains at least
/// one managed file whose sha256 matches the database (sample ≤ 20).
pub fn reconnect(core: &Core, folder: &Path) -> AppResult<(StorageStatus, PathBuf)> {
    let root = std::fs::canonicalize(folder).map_err(|_| {
        AppError::invalid("The chosen folder does not exist.").with_reason("target_missing")
    })?;
    let samples: Vec<(String, String)> = {
        let c = core.db.conn();
        let mut st = c.prepare(
            "SELECT local_path, sha256 FROM media_assets WHERE local_path IS NOT NULL AND sha256 IS NOT NULL
             AND download_status IN ('saved','missing') ORDER BY created_at DESC LIMIT 20",
        )?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<_, _>>()?
    };
    let matched = samples.iter().any(|(rel, sha)| {
        resolve_in_root(&root, rel)
            .ok()
            .and_then(|p| sha256_file(&p).ok())
            .is_some_and(|h| h.eq_ignore_ascii_case(sha))
    });
    if !matched {
        return Err(
            AppError::invalid("This folder does not contain your Vidra archive.")
                .with_reason("no_matching_files"),
        );
    }
    let mut s = crate::settings::get(core);
    s.archive_root = display_path(&root);
    crate::settings::save(core, &s)?;
    // Files that were marked missing while the drive was away are back.
    {
        let c = core.db.conn();
        let missing: Vec<(String, String)> = {
            let mut st = c.prepare(
                "SELECT id, local_path FROM media_assets WHERE download_status='missing' AND local_path IS NOT NULL",
            )?;
            let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
            rows.collect::<Result<_, _>>()?
        };
        for (id, rel) in missing {
            if resolve_in_root(&root, &rel).is_ok_and(|p| p.is_file()) {
                c.execute(
                    "UPDATE media_assets SET download_status='saved' WHERE id=?1",
                    params![id],
                )?;
            }
        }
    }
    reconcile_downloads(core);
    core.downloads.notify();
    core.emit(StoreEvent::SettingsChanged);
    core.emit(StoreEvent::ArchiveChanged);
    Ok((status(core)?, root))
}

/// Stores the default export folder after a writability check.
pub fn set_export_dir(core: &Core, dir: &Path) -> AppResult<AppSettings> {
    let c = std::fs::canonicalize(dir).map_err(|_| {
        AppError::invalid("The chosen folder does not exist.").with_reason("target_missing")
    })?;
    probe_writable(&c).map_err(|e| AppError::from(e).with_reason("target_not_writable"))?;
    let mut s = crate::settings::get(core);
    s.export_dir = Some(display_path(&c));
    crate::settings::save(core, &s)?;
    core.emit(StoreEvent::SettingsChanged);
    Ok(s)
}

/// Export dialogs start here when it exists.
pub fn export_dir(core: &Core) -> Option<PathBuf> {
    crate::settings::get(core)
        .export_dir
        .map(PathBuf::from)
        .filter(|p| p.is_dir())
}

#[cfg(test)]
#[path = "storage_tests.rs"]
mod tests;
