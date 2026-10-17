//! Local library of reference images (mascots, products, styles, scenes,
//! frames) that can be reused across generations.
//!
//! Files picked or dropped by the user are first *staged* under the app data
//! directory (named by their SHA-256, cleaned up after a day) so that a just
//! uploaded image can still be saved to the library or re-uploaded for another
//! provider without asking for the file again. Saved references live under the
//! archive root (`references/<id>.<ext>`), move with it, and are re-uploaded
//! to the provider each time they are attached to a generation: the provider's
//! upload storage is documented as temporary, so a stored provider URL is never
//! trusted to stay valid.

use crate::core::Core;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::references::{validate_file, ValidFile};
use crate::types::*;
use rusqlite::{params, OptionalExtension, Row};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;

pub const REF_TYPES: &[&str] = &[
    "character",
    "product",
    "style",
    "scene",
    "start_frame",
    "end_frame",
];
pub const NAME_MAX: usize = 120;
const STAGING_TTL: Duration = Duration::from_secs(24 * 60 * 60);

const COLS: &str =
    "id, name, ref_type, kind, mime, local_path, size_bytes, sha256, width, height, \
                    preview_data_url, use_count, last_used_at, created_at";

fn from_row(r: &Row) -> rusqlite::Result<(ReferenceAsset, String)> {
    Ok((
        ReferenceAsset {
            id: r.get(0)?,
            name: r.get(1)?,
            ref_type: r.get(2)?,
            kind: r.get(3)?,
            mime: r.get(4)?,
            size_bytes: r.get(6)?,
            sha256: r.get(7)?,
            width: r.get(8)?,
            height: r.get(9)?,
            preview_data_url: r.get(10)?,
            use_count: r.get(11)?,
            last_used_at: r.get(12)?,
            created_at: r.get(13)?,
        },
        r.get(5)?,
    ))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn ext_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/wav" => "wav",
        "audio/mpeg" => "mp3",
        _ => "bin",
    }
}

/// Pixel size of an image, when the format can be decoded.
pub fn image_dimensions(bytes: &[u8]) -> Option<(i64, i64)> {
    image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?
        .into_dimensions()
        .ok()
        .map(|(w, h)| (i64::from(w), i64::from(h)))
}

fn staging_dir(core: &Core) -> PathBuf {
    core.data_dir.join("references-staging")
}

fn library_dir(core: &Core) -> PathBuf {
    core.archive_root().join("references")
}

fn valid_sha(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn check_name(name: &str) -> AppResult<String> {
    let name: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if name.is_empty() || name.chars().count() > NAME_MAX {
        return Err(AppError::invalid(format!(
            "A name of 1–{NAME_MAX} characters is required."
        )));
    }
    Ok(name)
}

pub fn check_type(t: &str) -> AppResult<()> {
    if REF_TYPES.contains(&t) {
        Ok(())
    } else {
        Err(AppError::invalid("Unknown reference type."))
    }
}

/// Removes staged files older than a day. Abandoned uploads never pile up.
pub fn cleanup_staging(core: &Core) {
    let Ok(entries) = std::fs::read_dir(staging_dir(core)) else {
        return;
    };
    for e in entries.flatten() {
        let old = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > STAGING_TTL);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Keeps a validated file's bytes until the user saves it or the day ends.
/// Returns the SHA-256 that identifies it.
pub fn stage(core: &Core, file: &ValidFile) -> AppResult<String> {
    let sha = sha256_hex(&file.bytes);
    let dir = staging_dir(core);
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{sha}.{}", ext_for(file.mime)));
    if !path.exists() {
        let tmp = dir.join(format!("{sha}.part"));
        std::fs::write(&tmp, &file.bytes)?;
        std::fs::rename(&tmp, &path)?;
    }
    cleanup_staging(core);
    Ok(sha)
}

fn staged_path(core: &Core, sha: &str) -> Option<PathBuf> {
    if !valid_sha(sha) {
        return None;
    }
    let dir = staging_dir(core);
    ["png", "jpg", "webp", "gif"]
        .iter()
        .map(|e| dir.join(format!("{sha}.{e}")))
        .find(|p| p.is_file())
}

pub fn list(core: &Core) -> AppResult<Vec<ReferenceAsset>> {
    let c = core.db.conn();
    let mut st = c.prepare(&format!(
        "SELECT {COLS} FROM reference_assets ORDER BY COALESCE(last_used_at, created_at) DESC, created_at DESC"
    ))?;
    let rows = st.query_map([], |r| from_row(r).map(|(a, _)| a))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

fn get_with_path(core: &Core, id: &str) -> AppResult<(ReferenceAsset, String)> {
    core.db
        .conn()
        .query_row(
            &format!("SELECT {COLS} FROM reference_assets WHERE id=?1"),
            [id],
            from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::not_found("Reference not found."))
}

pub fn get(core: &Core, id: &str) -> AppResult<ReferenceAsset> {
    get_with_path(core, id).map(|(a, _)| a)
}

/// Copies a staged upload into the library. The same image (by hash) is
/// never stored twice: saving it again returns the existing entry.
pub fn save(core: &Core, sha256: &str, name: &str, ref_type: &str) -> AppResult<ReferenceAsset> {
    let name = check_name(name)?;
    check_type(ref_type)?;
    if let Some(existing) = core
        .db
        .conn()
        .query_row(
            &format!("SELECT {COLS} FROM reference_assets WHERE sha256=?1"),
            [sha256],
            from_row,
        )
        .optional()?
    {
        return Ok(existing.0);
    }
    let src = staged_path(core, sha256).ok_or_else(|| {
        AppError::new(
            ErrorCode::NotFound,
            "This image is no longer available to save. Add it again.",
        )
        .with_reason("staging_expired")
    })?;
    let file = validate_file(&src, Some("image"))?;
    if sha256_hex(&file.bytes) != sha256 {
        return Err(AppError::invalid("The staged file changed on disk."));
    }
    let id = new_id();
    let rel = format!("references/{id}.{}", ext_for(file.mime));
    let dir = library_dir(core);
    std::fs::create_dir_all(&dir).map_err(|_| storage_unavailable())?;
    // `id` is a fresh UUID, so the destination cannot escape the library.
    let dest = dir.join(format!("{id}.{}", ext_for(file.mime)));
    let tmp = dir.join(format!("{id}.part"));
    std::fs::write(&tmp, &file.bytes).map_err(|_| storage_unavailable())?;
    std::fs::rename(&tmp, &dest).map_err(|_| storage_unavailable())?;
    let (w, h) = image_dimensions(&file.bytes).map_or((None, None), |(w, h)| (Some(w), Some(h)));
    let asset = ReferenceAsset {
        id,
        name,
        ref_type: ref_type.to_string(),
        kind: "image".into(),
        mime: file.mime.to_string(),
        size_bytes: file.bytes.len() as i64,
        sha256: sha256.to_string(),
        width: w,
        height: h,
        preview_data_url: crate::references::preview(&file.bytes, file.mime),
        use_count: 0,
        last_used_at: None,
        created_at: now_ms(),
    };
    core.db.conn().execute(
        &format!("INSERT INTO reference_assets ({COLS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"),
        params![
            asset.id, asset.name, asset.ref_type, asset.kind, asset.mime, rel, asset.size_bytes,
            asset.sha256, asset.width, asset.height, asset.preview_data_url, asset.use_count,
            asset.last_used_at, asset.created_at
        ],
    )?;
    core.emit(StoreEvent::ReferencesChanged);
    Ok(asset)
}

pub fn update(
    core: &Core,
    id: &str,
    name: Option<&str>,
    ref_type: Option<&str>,
) -> AppResult<ReferenceAsset> {
    let (current, _) = get_with_path(core, id)?;
    let name = match name {
        Some(n) => check_name(n)?,
        None => current.name,
    };
    let ref_type = match ref_type {
        Some(t) => {
            check_type(t)?;
            t.to_string()
        }
        None => current.ref_type,
    };
    core.db.conn().execute(
        "UPDATE reference_assets SET name=?2, ref_type=?3 WHERE id=?1",
        params![id, name, ref_type],
    )?;
    core.emit(StoreEvent::ReferencesChanged);
    get(core, id)
}

/// Removes the library entry and its file. Past generations keep their own
/// record of the reference (name, type, hash) in the job.
pub fn delete(core: &Core, id: &str) -> AppResult<()> {
    let (_, rel) = get_with_path(core, id)?;
    if let Ok(path) = crate::archive::resolve_in_root(&core.archive_root(), &rel) {
        if let Err(e) = std::fs::remove_file(&path) {
            if path.exists() {
                return Err(e.into());
            }
        }
    }
    core.db
        .conn()
        .execute("DELETE FROM reference_assets WHERE id=?1", [id])?;
    core.emit(StoreEvent::ReferencesChanged);
    Ok(())
}

fn storage_unavailable() -> AppError {
    AppError::new(
        ErrorCode::StorageUnavailable,
        "The archive folder is not available, so the reference could not be saved.",
    )
}

/// Where a reference to attach comes from.
pub enum AttachSource<'a> {
    Saved(&'a str),
    Staged(&'a str),
}

/// Uploads a library or staged image to `provider` for a new generation.
pub async fn attach(
    core: &Core,
    provider: ProviderId,
    source: AttachSource<'_>,
) -> AppResult<UploadedReference> {
    let (path, saved_id) = match source {
        AttachSource::Saved(id) => {
            let (asset, rel) = get_with_path(core, id)?;
            let path = match crate::archive::resolve_in_root(&core.archive_root(), &rel) {
                Ok(p) if p.is_file() => p,
                _ => {
                    return Err(AppError::new(
                        ErrorCode::StorageUnavailable,
                        "The reference file is missing from the archive folder.",
                    )
                    .with_reason("reference_missing"))
                }
            };
            (path, Some(asset.id))
        }
        AttachSource::Staged(sha) => {
            let path = staged_path(core, sha).ok_or_else(|| {
                AppError::new(
                    ErrorCode::NotFound,
                    "This image is no longer available. Add it again.",
                )
                .with_reason("staging_expired")
            })?;
            (path, None)
        }
    };
    let mut uploaded = crate::references::upload(core, provider, &path, Some("image")).await?;
    if let Some(id) = &saved_id {
        core.db.conn().execute(
            "UPDATE reference_assets SET use_count=use_count+1, last_used_at=?2 WHERE id=?1",
            params![id, now_ms()],
        )?;
        core.emit(StoreEvent::ReferencesChanged);
    }
    uploaded.saved_id = saved_id;
    Ok(uploaded)
}

/// Validates the references declared on a generation against its parameters:
/// every reference must sit in a media parameter of the model with exactly
/// that URL, so the job record never claims an image that was not sent.
pub fn check_generation_references(
    refs: &[GenerationReference],
    model: &crate::manifest::ModelDef,
    values: &serde_json::Map<String, serde_json::Value>,
) -> AppResult<()> {
    if refs.len() > 60 {
        return Err(AppError::invalid("Too many references."));
    }
    for r in refs {
        check_type(&r.ref_type)?;
        check_name(&r.name)?;
        if !valid_sha(&r.sha256) {
            return Err(AppError::invalid("Invalid reference hash."));
        }
        let is_media = model.params.iter().any(|p| {
            p.key == r.param_key && matches!(p.kind, crate::manifest::ParamKind::Media { .. })
        });
        let present = values.get(&r.param_key).is_some_and(|v| match v {
            serde_json::Value::String(s) => s == &r.url,
            serde_json::Value::Array(a) => a.iter().any(|x| x.as_str() == Some(&r.url)),
            _ => false,
        });
        if !is_media || !present {
            return Err(AppError::invalid(format!(
                "Reference \"{}\" is not part of the request.",
                r.name
            ))
            .with_details(
                serde_json::json!({ "code": "reference_mismatch", "field": r.param_key }),
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::env;

    fn png() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(8, 6, image::Rgb([200, 30, 30]));
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    fn staged(e: &crate::core::testing::TestEnv) -> String {
        let file = ValidFile {
            bytes: png(),
            mime: "image/png",
            kind: "image",
            name: "mascot.png".into(),
        };
        stage(&e.core, &file).unwrap()
    }

    #[test]
    fn save_list_update_delete_round_trip() {
        let e = env();
        std::fs::create_dir_all(e.core.archive_root()).unwrap();
        let sha = staged(&e);
        let a = save(&e.core, &sha, "  ZihinLab mascot ", "character").unwrap();
        assert_eq!(a.name, "ZihinLab mascot");
        assert_eq!((a.width, a.height), (Some(8), Some(6)));
        assert!(a
            .preview_data_url
            .as_deref()
            .unwrap()
            .starts_with("data:image/jpeg"));
        assert!(e
            .core
            .archive_root()
            .join(format!("references/{}.png", a.id))
            .is_file());
        // Same image again: no duplicate entry.
        assert_eq!(save(&e.core, &sha, "again", "product").unwrap().id, a.id);
        assert_eq!(list(&e.core).unwrap().len(), 1);
        let b = update(&e.core, &a.id, Some("Mascot v2"), Some("product")).unwrap();
        assert_eq!(
            (b.name.as_str(), b.ref_type.as_str()),
            ("Mascot v2", "product")
        );
        assert!(update(&e.core, &a.id, None, Some("hero")).is_err());
        delete(&e.core, &a.id).unwrap();
        assert!(list(&e.core).unwrap().is_empty());
        assert!(!e
            .core
            .archive_root()
            .join(format!("references/{}.png", a.id))
            .exists());
    }

    #[test]
    fn saving_needs_a_staged_file_and_a_real_name() {
        let e = env();
        std::fs::create_dir_all(e.core.archive_root()).unwrap();
        let sha = staged(&e);
        assert!(save(&e.core, &sha, "   ", "character").is_err());
        assert!(save(&e.core, &sha, "x", "mascot").is_err());
        let gone = save(&e.core, &"0".repeat(64), "x", "character").unwrap_err();
        assert_eq!(gone.code, ErrorCode::NotFound);
    }

    #[test]
    fn stale_staging_is_removed() {
        let e = env();
        let sha = staged(&e);
        let path = staged_path(&e.core, &sha).unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(2 * 24 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(old)
            .unwrap();
        cleanup_staging(&e.core);
        assert!(!path.exists());
    }

    #[test]
    fn generation_references_must_match_the_request() {
        let m = crate::manifest::Registry::bundled()
            .get("higgsfield:bytedance/seedance-2.5/reference-to-video")
            .unwrap()
            .def
            .clone();
        let url = "https://cdn.example.com/m.png";
        let r = GenerationReference {
            param_key: "reference_images".into(),
            url: url.into(),
            name: "Mascot".into(),
            ref_type: "character".into(),
            sha256: "a".repeat(64),
            saved_id: None,
        };
        let mut values = serde_json::Map::new();
        values.insert("reference_images".into(), serde_json::json!([url]));
        check_generation_references(std::slice::from_ref(&r), &m, &values).unwrap();
        let wrong = GenerationReference {
            url: "https://cdn.example.com/other.png".into(),
            ..r.clone()
        };
        assert!(check_generation_references(&[wrong], &m, &values).is_err());
        let not_media = GenerationReference {
            param_key: "duration".into(),
            ..r
        };
        assert!(check_generation_references(&[not_media], &m, &values).is_err());
    }
}
