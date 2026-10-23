//! Proxy media for smooth previews of large (4K) sources. A proxy is a
//! 720p H.264 copy in the editor cache; only the preview uses it. Exports
//! always read the original file (see editor_render::start).

use crate::core::Core;
use crate::editor::{cache_dir, cache_key, require_tools, run_tool};
use crate::editor_render::{encoder_args, ExportOptions};
use crate::error::{AppError, AppResult};
use serde::Serialize;
use std::path::PathBuf;
use std::time::Duration;

/// Sources whose longer side is above this get a proxy.
pub const PROXY_THRESHOLD: i64 = 1920;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProxyInfo {
    pub media_id: String,
    /// null when the source is small enough to preview directly.
    pub path: Option<String>,
    pub width: i64,
    pub height: i64,
}

fn proxy_path(core: &Core, info: &crate::editor::MediaInfo) -> PathBuf {
    cache_dir(core)
        .join("proxies")
        .join(format!("{}-720.mp4", cache_key(info)))
}

/// Whether a media file needs a proxy (large video).
pub fn needs_proxy(info: &crate::editor::MediaInfo) -> bool {
    info.kind == "video" && info.width.unwrap_or(0).max(info.height.unwrap_or(0)) > PROXY_THRESHOLD
}

/// Returns the proxy for a media file, creating it when missing (blocking).
pub fn proxy(core: &Core, project_id: &str, media_id: &str) -> AppResult<ProxyInfo> {
    let (path, info) = core.editor.media_path(project_id, media_id)?;
    let (w, h) = (info.width.unwrap_or(0), info.height.unwrap_or(0));
    if !needs_proxy(&info) {
        return Ok(ProxyInfo {
            media_id: media_id.into(),
            path: None,
            width: w,
            height: h,
        });
    }
    let tools = require_tools(core)?;
    let out = proxy_path(core, &info);
    let (pw, ph) = if w >= h {
        ((720 * w / h.max(1)) / 2 * 2, 720)
    } else {
        (720, (720 * h / w.max(1)) / 2 * 2)
    };
    if out.is_file() {
        return Ok(ProxyInfo {
            media_id: media_id.into(),
            path: Some(out.to_string_lossy().into_owned()),
            width: pw,
            height: ph,
        });
    }
    std::fs::create_dir_all(out.parent().unwrap_or(&out))?;
    let tmp = out.with_extension("part.mp4");
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-y".into(),
        "-i".into(),
        path.to_string_lossy().into_owned(),
        "-vf".into(),
        format!("scale={pw}:{ph}:flags=bicubic,format=yuv420p"),
        "-map".into(),
        "0:v:0".into(),
        "-map".into(),
        "0:a?".into(),
    ];
    let fps = info.fps.unwrap_or(30.0).round().clamp(1.0, 120.0) as i64;
    args.extend(encoder_args(
        &tools,
        &ExportOptions {
            encoder: "auto".into(),
            video_kbps: 3000,
            audio_kbps: 96,
        },
        fps,
    )?);
    args.extend([
        "-c:a".into(),
        "aac".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-f".into(),
        "mp4".into(),
    ]);
    args.push(tmp.to_string_lossy().into_owned());
    let (ok, _, err) = run_tool(&tools.ffmpeg, &args, Duration::from_secs(20 * 60))?;
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::invalid(format!(
            "The preview proxy could not be created. {}",
            err.lines().last().unwrap_or("")
        )));
    }
    std::fs::rename(&tmp, &out)?;
    Ok(ProxyInfo {
        media_id: media_id.into(),
        path: Some(out.to_string_lossy().into_owned()),
        width: pw,
        height: ph,
    })
}
