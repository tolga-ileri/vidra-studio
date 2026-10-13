//! Reference files. They reach Rust only from a native dialog or a native
//! drag-drop event (token-based), are validated by size and signature, then
//! uploaded with the provider's documented method.

use crate::core::Core;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::types::*;
use base64::Engine;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

pub const IMAGE_MAX: u64 = 20 * 1024 * 1024;
pub const VIDEO_MAX: u64 = 200 * 1024 * 1024;
pub const AUDIO_MAX: u64 = 50 * 1024 * 1024;
pub const TOKEN_TTL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone)]
pub struct DropEntry {
    pub path: PathBuf,
    pub expires: Instant,
}

pub fn kind_from_ext(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg" | "webp") => "image",
        Some("mp4" | "mov" | "webm") => "video",
        Some("wav" | "mp3") => "audio",
        _ => "unsupported",
    }
}

pub fn dialog_extensions(kind: &str) -> &'static [&'static str] {
    match kind {
        "image" => &["png", "jpg", "jpeg", "webp"],
        "video" => &["mp4", "mov", "webm"],
        _ => &["wav", "mp3"],
    }
}

/// (mime, kind) from magic bytes.
pub fn sniff_reference(head: &[u8]) -> Option<(&'static str, &'static str)> {
    if let Some((mime, _, kind)) = crate::downloads::sniff(head) {
        return Some((mime, kind));
    }
    if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WAVE" {
        return Some(("audio/wav", "audio"));
    }
    if head.starts_with(b"ID3") || (head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0)
    {
        return Some(("audio/mpeg", "audio"));
    }
    None
}

pub fn issue_drop_tokens(core: &Core, paths: &[PathBuf]) -> Vec<DroppedFile> {
    let mut drops = core.drops.lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    drops.retain(|_, e| e.expires > now);
    paths
        .iter()
        .take(20)
        .map(|p| {
            let token = hex::encode(rand::random::<[u8; 24]>());
            drops.insert(
                token.clone(),
                DropEntry {
                    path: p.clone(),
                    expires: now + TOKEN_TTL,
                },
            );
            DroppedFile {
                token,
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                kind: kind_from_ext(p).to_string(),
            }
        })
        .collect()
}

/// Consumes a drop token (single use).
pub fn take_drop(core: &Core, token: &str) -> AppResult<PathBuf> {
    if token.len() != 48 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::invalid("Invalid or expired file token."));
    }
    let mut drops = core.drops.lock().unwrap_or_else(|p| p.into_inner());
    match drops.remove(token) {
        Some(e) if e.expires > Instant::now() => Ok(e.path),
        _ => Err(AppError::invalid("Invalid or expired file token.")),
    }
}

pub struct ValidFile {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub kind: &'static str,
    pub name: String,
}

pub fn validate_file(path: &Path, expected: Option<&str>) -> AppResult<ValidFile> {
    let meta = std::fs::metadata(path)
        .map_err(|_| AppError::not_found("The file could not be opened."))?;
    if !meta.is_file() {
        return Err(AppError::invalid("Not a file."));
    }
    let mut head = [0u8; 16];
    {
        use std::io::Read;
        let mut f = std::fs::File::open(path)?;
        let n = f.read(&mut head)?;
        if n < 4 {
            return Err(AppError::invalid("The file is empty or not supported."));
        }
    }
    let (mime, kind) =
        sniff_reference(&head).ok_or_else(|| AppError::invalid("Unsupported file type."))?;
    if expected.is_some_and(|k| k != kind) {
        return Err(AppError::invalid(format!(
            "Please choose a {} file.",
            expected.unwrap_or("")
        )));
    }
    let max = match kind {
        "image" => IMAGE_MAX,
        "video" => VIDEO_MAX,
        _ => AUDIO_MAX,
    };
    if meta.len() > max {
        return Err(AppError::invalid(format!(
            "The file is too large (max {} MB).",
            max / 1024 / 1024
        )));
    }
    let bytes = std::fs::read(path)?;
    let name: String = path
        .file_name()
        .map(|n| {
            n.to_string_lossy()
                .chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect()
        })
        .unwrap_or_else(|| "reference".into());
    Ok(ValidFile {
        bytes,
        mime,
        kind,
        name,
    })
}

pub(crate) fn preview(bytes: &[u8], mime: &str) -> Option<String> {
    let fmt = match mime {
        "image/png" => image::ImageFormat::Png,
        "image/jpeg" => image::ImageFormat::Jpeg,
        _ => return None,
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), fmt);
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let thumb = img.thumbnail(256, 256).to_rgb8();
    let mut out = Vec::new();
    thumb
        .write_to(
            &mut std::io::Cursor::new(&mut out),
            image::ImageFormat::Jpeg,
        )
        .ok()?;
    if out.len() > 256 * 1024 {
        return None;
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out)
    ))
}

/// Prefix of opaque inline-reference tokens returned to the renderer.
pub const INLINE_PREFIX: &str = "vidra-ref:";
const INLINE_TTL: std::time::Duration = std::time::Duration::from_secs(12 * 60 * 60);
const INLINE_MAX_TOTAL: usize = 400 * 1024 * 1024;

/// A validated reference file held in memory until submit.
pub struct InlineRef {
    pub bytes: std::sync::Arc<Vec<u8>>,
    pub created: std::time::Instant,
}

/// Providers whose APIs accept reference media inline (base64) rather than
/// through an upload endpoint.
pub fn takes_inline_references(provider: ProviderId) -> bool {
    provider == ProviderId::Kling
}

pub fn store_inline(core: &Core, bytes: Vec<u8>) -> String {
    let mut map = core.inline_refs.lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, r| r.created.elapsed() < INLINE_TTL);
    let mut total: usize = map.values().map(|r| r.bytes.len()).sum::<usize>() + bytes.len();
    while total > INLINE_MAX_TOTAL {
        let Some(oldest) = map
            .iter()
            .min_by_key(|(_, r)| r.created)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        if let Some(r) = map.remove(&oldest) {
            total -= r.bytes.len();
        }
    }
    let token = format!("{INLINE_PREFIX}{}", uuid::Uuid::new_v4());
    map.insert(
        token.clone(),
        InlineRef {
            bytes: std::sync::Arc::new(bytes),
            created: std::time::Instant::now(),
        },
    );
    token
}

/// Replaces inline-reference tokens in a request body with raw base64 (Kling
/// documents URL or Base64 inputs). Tokens are refused for every other
/// provider, and an unknown/expired token is a clear user error.
pub fn resolve_inline(
    core: &Core,
    provider: ProviderId,
    body: &serde_json::Value,
) -> AppResult<serde_json::Value> {
    use base64::Engine;
    use serde_json::Value;
    fn walk(v: &Value, f: &mut dyn FnMut(&str) -> AppResult<Option<String>>) -> AppResult<Value> {
        Ok(match v {
            Value::String(s) => match f(s)? {
                Some(r) => Value::String(r),
                None => v.clone(),
            },
            Value::Array(a) => {
                Value::Array(a.iter().map(|x| walk(x, f)).collect::<AppResult<_>>()?)
            }
            Value::Object(o) => {
                let mut out = serde_json::Map::new();
                for (k, x) in o {
                    out.insert(k.clone(), walk(x, f)?);
                }
                Value::Object(out)
            }
            other => other.clone(),
        })
    }
    let map = core.inline_refs.lock().unwrap_or_else(|e| e.into_inner());
    walk(body, &mut |s: &str| {
        if !s.starts_with(INLINE_PREFIX) {
            return Ok(None);
        }
        if !takes_inline_references(provider) {
            return Err(AppError::invalid(
                "This reference file belongs to another provider. Add it again.",
            ));
        }
        match map.get(s) {
            Some(r) if r.created.elapsed() < INLINE_TTL => Ok(Some(
                base64::engine::general_purpose::STANDARD.encode(r.bytes.as_slice()),
            )),
            _ => Err(AppError::invalid(
                "A reference file is no longer available. Please add it again.",
            )),
        }
    })
}

pub async fn upload(
    core: &Core,
    provider: ProviderId,
    path: &Path,
    expected: Option<&str>,
) -> AppResult<UploadedReference> {
    if !core.provider_enabled(provider)? {
        return Err(AppError::new(
            ErrorCode::ProviderDisabled,
            format!("{} is disabled in Settings.", provider.display_name()),
        ));
    }
    let p = core.providers.get(provider);
    if !p.capabilities().upload_references {
        return Err(AppError::invalid(format!(
            "{} does not support uploading reference files.",
            provider.display_name()
        )));
    }
    let creds = core.creds(provider)?;
    let path = path.to_path_buf();
    let expected = expected.map(String::from);
    let file = tokio::task::spawn_blocking(move || validate_file(&path, expected.as_deref()))
        .await
        .map_err(|_| AppError::unknown("Validation failed."))??;
    let preview_data_url = if file.kind == "image" {
        preview(&file.bytes, file.mime)
    } else {
        None
    };
    // Keep the bytes until the user saves the image or a day passes, so it
    // can be stored in the library or re-uploaded for another provider.
    let sha256 = crate::reference_library::stage(core, &file)?;
    let (width, height) = if file.kind == "image" {
        crate::reference_library::image_dimensions(&file.bytes)
            .map_or((None, None), |(w, h)| (Some(w), Some(h)))
    } else {
        (None, None)
    };
    let size_bytes = file.bytes.len() as i64;
    let describe = |url: String| UploadedReference {
        url,
        kind: file.kind.to_string(),
        name: file.name.clone(),
        preview_data_url: preview_data_url.clone(),
        sha256: sha256.clone(),
        mime: file.mime.to_string(),
        size_bytes,
        width,
        height,
        saved_id: None,
    };
    if takes_inline_references(provider) {
        // Kling: documented inputs are URL or Base64; jpg/png only for frames.
        if !matches!(file.mime, "image/jpeg" | "image/png") {
            return Err(AppError::invalid(
                "Kling AI accepts JPG or PNG images for reference frames.",
            ));
        }
        let described = describe(String::new());
        let url = store_inline(core, file.bytes);
        return Ok(UploadedReference { url, ..described });
    }
    let url = p
        .upload_reference(&creds, file.bytes.clone(), file.mime, &file.name)
        .await?;
    Ok(describe(url))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::env;

    #[test]
    fn tokens_and_validation() {
        let e = env();
        let dir = e.dir.path();
        let png = dir.join("a.png");
        let mut bytes = Vec::new();
        image::RgbImage::new(4, 4)
            .write_to(
                &mut std::io::Cursor::new(&mut bytes),
                image::ImageFormat::Png,
            )
            .unwrap();
        std::fs::write(&png, &bytes).unwrap();
        let fake = dir.join("fake.png");
        std::fs::write(&fake, b"MZ\x90\x00 this is an exe").unwrap();
        let toks = issue_drop_tokens(&e.core, &[png.clone(), fake.clone(), dir.join("x.exe")]);
        assert_eq!(toks[0].kind, "image");
        assert_eq!(toks[2].kind, "unsupported");
        assert_eq!(take_drop(&e.core, &toks[0].token).unwrap(), png);
        assert!(take_drop(&e.core, &toks[0].token).is_err(), "single use");
        assert!(take_drop(&e.core, "deadbeef").is_err());
        assert!(take_drop(&e.core, &"0".repeat(48)).is_err());
        let v = validate_file(&png, Some("image")).unwrap();
        assert_eq!(v.mime, "image/png");
        assert!(preview(&v.bytes, v.mime)
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        assert!(validate_file(&fake, None).is_err());
        assert!(validate_file(&png, Some("video")).is_err());
        let big = dir.join("big.png");
        let mut b = bytes.clone();
        b.resize((IMAGE_MAX + 1) as usize, 0);
        std::fs::write(&big, b).unwrap();
        assert!(validate_file(&big, None).is_err());
        // expired token
        let t = issue_drop_tokens(&e.core, &[png])[0].token.clone();
        e.core.drops.lock().unwrap().get_mut(&t).unwrap().expires =
            Instant::now() - Duration::from_secs(1);
        assert!(take_drop(&e.core, &t).is_err());
    }

    #[test]
    fn inline_references_resolve_only_for_kling() {
        use base64::Engine;
        let e = env();
        let token = store_inline(&e.core, b"fake image bytes".to_vec());
        assert!(token.starts_with(INLINE_PREFIX));
        let body = serde_json::json!({"contents": [{"type": "first_frame", "url": token}]});
        let out = resolve_inline(&e.core, ProviderId::Kling, &body).unwrap();
        let expected = base64::engine::general_purpose::STANDARD.encode(b"fake image bytes");
        assert_eq!(out["contents"][0]["url"], serde_json::json!(expected));
        // never sent to providers with an upload API
        assert!(resolve_inline(&e.core, ProviderId::Replicate, &body).is_err());
        // unknown / forged token
        let forged = serde_json::json!({"x": "vidra-ref:00000000-0000-0000-0000-000000000000"});
        assert!(resolve_inline(&e.core, ProviderId::Kling, &forged).is_err());
        // untouched bodies pass through
        let plain = serde_json::json!({"prompt": "hello", "n": 1});
        assert_eq!(
            resolve_inline(&e.core, ProviderId::Kling, &plain).unwrap(),
            plain
        );
    }

    #[test]
    fn kling_image_to_video_body_from_bundled_manifest() {
        let reg = crate::manifest::Registry::bundled();
        let m = reg
            .get("kling:image-to-video/kling-3.0")
            .expect("bundled i2v model");
        let mut v = crate::types::ParamValues::new();
        let token = format!("{INLINE_PREFIX}{}", uuid::Uuid::new_v4());
        v.insert("image".into(), serde_json::json!(token));
        v.insert("duration".into(), serde_json::json!(5));
        let values = crate::manifest::validate_params(&m.def, &v).unwrap();
        let body = crate::manifest::build_body(&m.def, "slow push-in", None, &values, true);
        assert_eq!(
            body["contents"],
            serde_json::json!([{"type": "prompt", "text": "slow push-in"}, {"type": "first_frame", "url": token}])
        );
        assert_eq!(body["settings"]["duration"], serde_json::json!(5));
        assert!(body.get("prompt").is_none());
    }
}
