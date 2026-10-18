//! Video Editor (native side): FFmpeg discovery, media probing and import,
//! thumbnail/waveform caches, and project files (save/open/autosave/recover).
//!
//! Security model, same as the rest of the app: the renderer never sends a
//! file path. Files arrive through native dialogs, drag-and-drop tokens or the
//! archive; each project's media registry (id → path) lives here, and saved
//! projects always take paths from that registry, never from the renderer.
//! FFmpeg/FFprobe run with argument vectors (no shell) and a hidden console.

use crate::core::Core;
use crate::error::{AppError, AppResult, ErrorCode};
use crate::types::now_ms;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const PROJECT_EXT: &str = "vidraproj";
pub const PROJECT_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const VIDEO_EXTS: &[&str] = &["mp4", "mov", "m4v", "webm", "mkv", "avi"];
pub const AUDIO_EXTS: &[&str] = &["mp3", "wav", "aac", "m4a", "flac", "ogg", "opus"];
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "webp"];
const RECENT_KEY: &str = "editor:recent";
const CONFIG_KEY: &str = "editor:config";
const RECENT_MAX: usize = 12;
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/* ── State ─────────────────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub duration_sec: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub has_audio: bool,
    pub has_video: bool,
    pub size_bytes: i64,
    pub available: bool,
}

#[derive(Default)]
pub struct Session {
    /// Where the project was last saved or opened from.
    pub file: Option<PathBuf>,
    pub media: HashMap<String, MediaInfo>,
}

#[derive(Default)]
pub struct EditorState {
    pub sessions: Mutex<HashMap<String, Session>>,
    pub tools: Mutex<Option<Tools>>,
    pub exports: Mutex<HashMap<String, crate::editor_render::ExportHandle>>,
    /// Serializes renders (the render queue).
    pub render_lock: Mutex<()>,
    /// Output path of each started export (for "show in folder").
    pub done: Mutex<HashMap<String, PathBuf>>,
}

impl EditorState {
    pub fn media_path(&self, project_id: &str, media_id: &str) -> AppResult<(PathBuf, MediaInfo)> {
        let s = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let m = s
            .get(project_id)
            .and_then(|x| x.media.get(media_id))
            .ok_or_else(|| AppError::not_found("Media is not part of this project."))?;
        Ok((PathBuf::from(&m.path), m.clone()))
    }

    fn register(&self, project_id: &str, media: &[MediaInfo]) {
        let mut s = self.sessions.lock().unwrap_or_else(|p| p.into_inner());
        let session = s.entry(project_id.to_string()).or_default();
        for m in media {
            session.media.insert(m.id.clone(), m.clone());
        }
    }
}

/* ── FFmpeg discovery ─────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub version: String,
    /// "configured", "bundled" or "path".
    pub source: String,
    pub encoders: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub available: bool,
    pub version: Option<String>,
    pub source: Option<String>,
    pub ffmpeg_path: Option<String>,
    /// H.264 encoders this FFmpeg build has (libx264, h264_nvenc, h264_qsv, h264_amf, h264_mf).
    pub h264_encoders: Vec<String>,
    pub has_aac: bool,
}

pub fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn configured_dir(core: &Core) -> Option<PathBuf> {
    read_kv(core, CONFIG_KEY)
        .and_then(|v| {
            v.get("ffmpegDir")
                .and_then(Value::as_str)
                .map(PathBuf::from)
        })
        .filter(|p| !p.as_os_str().is_empty())
}

fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(exe(name)))
        .find(|p| p.is_file())
}

fn candidates(core: &Core) -> Vec<(PathBuf, PathBuf, &'static str)> {
    let mut out = Vec::new();
    if let Some(d) = configured_dir(core) {
        out.push((d.join(exe("ffmpeg")), d.join(exe("ffprobe")), "configured"));
    }
    if let Some(d) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        out.push((d.join(exe("ffmpeg")), d.join(exe("ffprobe")), "bundled"));
    }
    if let (Some(f), Some(p)) = (on_path("ffmpeg"), on_path("ffprobe")) {
        out.push((f, p, "path"));
    }
    out
}

/// Runs a tool with a timeout; returns (status ok, stdout, stderr).
pub fn run_tool(
    program: &Path,
    args: &[String],
    timeout: Duration,
) -> AppResult<(bool, Vec<u8>, String)> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = hidden(&mut cmd).spawn().map_err(|_| {
        AppError::new(ErrorCode::NotFound, "FFmpeg could not be started.")
            .with_reason("ffmpeg_missing")
    })?;
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let out_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(o) = out.as_mut() {
            let _ = o.read_to_end(&mut b);
        }
        b
    });
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        if let Some(e) = err.as_mut() {
            let _ = e.take(64 * 1024).read_to_end(&mut b);
        }
        String::from_utf8_lossy(&b).into_owned()
    });
    let started = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait()? {
            break s;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(
                AppError::new(ErrorCode::Io, "The media tool did not respond in time.")
                    .with_reason("ffmpeg_timeout"),
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    Ok((status.success(), stdout, stderr))
}

fn detect(ffmpeg: &Path, ffprobe: &Path, source: &str) -> Option<Tools> {
    if !ffmpeg.is_file() || !ffprobe.is_file() {
        return None;
    }
    let (ok, out, _) = run_tool(
        ffmpeg,
        &["-hide_banner".into(), "-version".into()],
        Duration::from_secs(10),
    )
    .ok()?;
    if !ok {
        return None;
    }
    let version = String::from_utf8_lossy(&out)
        .lines()
        .next()
        .unwrap_or("ffmpeg")
        .chars()
        .take(160)
        .collect::<String>();
    let (ok, enc, _) = run_tool(
        ffmpeg,
        &["-hide_banner".into(), "-encoders".into()],
        Duration::from_secs(10),
    )
    .ok()?;
    if !ok {
        return None;
    }
    let enc = String::from_utf8_lossy(&enc);
    let encoders = [
        "libx264",
        "h264_nvenc",
        "h264_qsv",
        "h264_amf",
        "h264_mf",
        "aac",
    ]
    .iter()
    .filter(|n| {
        enc.lines()
            .any(|l| l.split_whitespace().nth(1) == Some(**n))
    })
    .map(|s| s.to_string())
    .collect();
    Some(Tools {
        ffmpeg: ffmpeg.to_path_buf(),
        ffprobe: ffprobe.to_path_buf(),
        version,
        source: source.to_string(),
        encoders,
    })
}

/// The FFmpeg to use (cached). Re-detected when `refresh` is set.
pub fn tools(core: &Core, refresh: bool) -> Option<Tools> {
    let mut cached = core.editor.tools.lock().unwrap_or_else(|p| p.into_inner());
    if refresh || cached.is_none() {
        *cached = candidates(core)
            .into_iter()
            .find_map(|(f, p, s)| detect(&f, &p, s));
    }
    cached.clone()
}

pub fn require_tools(core: &Core) -> AppResult<Tools> {
    tools(core, false).ok_or_else(|| {
        AppError::new(
            ErrorCode::NotFound,
            "FFmpeg was not found. Install FFmpeg or choose its folder in the Video Editor.",
        )
        .with_reason("ffmpeg_missing")
    })
}

pub fn status(core: &Core, refresh: bool) -> ToolStatus {
    match tools(core, refresh) {
        Some(t) => ToolStatus {
            available: t
                .encoders
                .iter()
                .any(|e| e.starts_with("h264") || e == "libx264"),
            version: Some(t.version.clone()),
            source: Some(t.source.clone()),
            ffmpeg_path: Some(t.ffmpeg.to_string_lossy().into_owned()),
            h264_encoders: t.encoders.iter().filter(|e| *e != "aac").cloned().collect(),
            has_aac: t.encoders.iter().any(|e| e == "aac"),
        },
        None => ToolStatus {
            available: false,
            version: None,
            source: None,
            ffmpeg_path: None,
            h264_encoders: vec![],
            has_aac: false,
        },
    }
}

/// Uses FFmpeg from a folder the user picked (must contain ffmpeg + ffprobe).
pub fn set_tools_dir(core: &Core, dir: &Path) -> AppResult<ToolStatus> {
    if detect(
        &dir.join(exe("ffmpeg")),
        &dir.join(exe("ffprobe")),
        "configured",
    )
    .is_none()
    {
        return Err(AppError::invalid(
            "This folder does not contain a working ffmpeg and ffprobe.",
        ));
    }
    write_kv(
        core,
        CONFIG_KEY,
        &json!({ "ffmpegDir": dir.to_string_lossy() }),
    )?;
    Ok(status(core, true))
}

/* ── Probing ──────────────────────────────────────────────────────────── */

pub fn ext_kind(path: &Path) -> Option<&'static str> {
    let e = path.extension()?.to_str()?.to_ascii_lowercase();
    if VIDEO_EXTS.contains(&e.as_str()) {
        Some("video")
    } else if AUDIO_EXTS.contains(&e.as_str()) {
        Some("audio")
    } else if IMAGE_EXTS.contains(&e.as_str()) {
        Some("image")
    } else {
        None
    }
}

fn parse_rate(s: &str) -> Option<f64> {
    let (n, d) = s.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (d > 0.0 && n > 0.0).then_some(n / d)
}

/// What a file contains, as read by FFprobe.
#[derive(Debug, Clone, PartialEq)]
pub struct ProbeFacts {
    pub kind: String,
    pub duration: Option<f64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub fps: Option<f64>,
    pub has_audio: bool,
    pub has_video: bool,
}

/// Interprets ffprobe JSON. Pure (tested with captured output).
pub fn interpret_probe(kind_hint: &str, v: &Value) -> AppResult<ProbeFacts> {
    let streams = v
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let is_cover = |s: &Value| {
        s.pointer("/disposition/attached_pic")
            .and_then(Value::as_i64)
            == Some(1)
    };
    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("video") && !is_cover(s));
    let has_audio = streams
        .iter()
        .any(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let duration = v
        .pointer("/format/duration")
        .and_then(Value::as_str)
        .and_then(|d| d.parse::<f64>().ok())
        .filter(|d| d.is_finite() && *d > 0.0);
    let kind = match kind_hint {
        "image" if video.is_some() => "image",
        "audio" if has_audio => "audio",
        _ if video.is_some() => "video",
        _ if has_audio => "audio",
        _ => {
            return Err(
                AppError::invalid("The file has no playable video or audio.")
                    .with_reason("media_unreadable"),
            )
        }
    };
    let (mut w, mut h, mut fps) = (None, None, None);
    if let Some(s) = video {
        w = s.get("width").and_then(Value::as_i64);
        h = s.get("height").and_then(Value::as_i64);
        fps = s
            .get("avg_frame_rate")
            .and_then(Value::as_str)
            .and_then(parse_rate)
            .filter(|f| *f < 1000.0);
        let rot = s
            .get("side_data_list")
            .and_then(Value::as_array)
            .and_then(|l| {
                l.iter()
                    .find_map(|d| d.get("rotation").and_then(Value::as_f64))
            })
            .or_else(|| {
                s.pointer("/tags/rotate")
                    .and_then(Value::as_str)
                    .and_then(|r| r.parse().ok())
            });
        if rot.is_some_and(|r: f64| (r.abs() - 90.0).abs() < 1.0 || (r.abs() - 270.0).abs() < 1.0) {
            std::mem::swap(&mut w, &mut h);
        }
    }
    if kind == "video" && duration.is_none() {
        return Err(AppError::invalid("The video has no readable duration.")
            .with_reason("media_unreadable"));
    }
    if kind != "audio" && (w.unwrap_or(0) < 1 || h.unwrap_or(0) < 1) {
        return Err(AppError::invalid("The picture size could not be read.")
            .with_reason("media_unreadable"));
    }
    Ok(ProbeFacts {
        kind: kind.to_string(),
        duration: if kind == "image" { None } else { duration },
        width: if kind == "audio" { None } else { w },
        height: if kind == "audio" { None } else { h },
        fps: if kind == "video" { fps } else { None },
        has_audio: kind != "image" && has_audio,
        has_video: kind != "audio",
    })
}

pub fn probe(tools: &Tools, path: &Path, id: String) -> AppResult<MediaInfo> {
    let hint = ext_kind(path).ok_or_else(|| {
        AppError::invalid("This file type is not supported.").with_reason("media_unsupported")
    })?;
    let meta = std::fs::metadata(path)
        .map_err(|_| AppError::not_found("The file could not be opened."))?;
    if !meta.is_file() {
        return Err(AppError::invalid("Not a file."));
    }
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        path.to_string_lossy().into_owned(),
    ];
    let (ok, out, _) = run_tool(&tools.ffprobe, &args, PROBE_TIMEOUT)?;
    let v: Value = serde_json::from_slice(&out).unwrap_or(Value::Null);
    if !ok || v.is_null() {
        return Err(
            AppError::invalid("The file is damaged or not a supported media file.")
                .with_reason("media_unreadable"),
        );
    }
    let ProbeFacts {
        kind,
        duration,
        width: w,
        height: h,
        fps,
        has_audio,
        has_video,
    } = interpret_probe(hint, &v)?;
    Ok(MediaInfo {
        id,
        kind,
        name: path
            .file_name()
            .map(|n| {
                n.to_string_lossy()
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(250)
                    .collect()
            })
            .unwrap_or_else(|| "media".into()),
        path: path.to_string_lossy().into_owned(),
        duration_sec: duration,
        width: w,
        height: h,
        fps,
        has_audio,
        has_video,
        size_bytes: meta.len() as i64,
        available: true,
    })
}

pub fn new_media_id() -> String {
    format!("med_{}", uuid::Uuid::new_v4().simple())
}

/// Probes files and registers them with the project. Each file that fails is
/// reported by name (the rest still import).
pub fn import_paths(core: &Core, project_id: &str, paths: &[PathBuf]) -> AppResult<ImportResult> {
    check_id(project_id)?;
    let tools = require_tools(core)?;
    let mut media = Vec::new();
    let mut failed = Vec::new();
    for p in paths.iter().take(200) {
        match probe(&tools, p, new_media_id()) {
            Ok(m) => media.push(m),
            Err(e) => failed.push(ImportFailure {
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                message: e.message,
            }),
        }
    }
    core.editor.register(project_id, &media);
    Ok(ImportResult { media, failed })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFailure {
    pub name: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub media: Vec<MediaInfo>,
    pub failed: Vec<ImportFailure>,
}

/// Imports a saved archive video ("Open in Video Editor").
pub fn import_archive_asset(
    core: &Core,
    project_id: &str,
    asset_id: &str,
) -> AppResult<ImportResult> {
    let rel: Option<String> = core
        .db
        .conn()
        .query_row(
            "SELECT local_path FROM media_assets WHERE id=?1 AND download_status='saved'",
            [asset_id],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    let rel = rel.ok_or_else(|| AppError::not_found("This item has no saved file."))?;
    let path = crate::archive::resolve_in_root(&core.archive_root(), &rel)?;
    import_paths(core, project_id, &[path])
}

/// Points a media item at a new file (missing-media relinking).
pub fn relink(core: &Core, project_id: &str, media_id: &str, path: &Path) -> AppResult<MediaInfo> {
    let tools = require_tools(core)?;
    let (_, old) = core.editor.media_path(project_id, media_id)?;
    let m = probe(&tools, path, media_id.to_string())?;
    let compatible = (old.kind == m.kind) || (old.kind == "video" && m.kind == "video");
    if !compatible {
        return Err(AppError::invalid(
            "Choose a file of the same type (video, audio or image).",
        ));
    }
    core.editor.register(project_id, std::slice::from_ref(&m));
    Ok(m)
}

/* ── Thumbnails and waveforms (cached) ────────────────────────────────── */

pub fn cache_dir(core: &Core) -> PathBuf {
    core.data_dir.join("editor-cache")
}

fn cache_key(info: &MediaInfo) -> String {
    let mtime = std::fs::metadata(&info.path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    crate::reference_library::sha256_hex(
        format!("{}|{}|{mtime}", info.path, info.size_bytes).as_bytes(),
    )[..32]
        .to_string()
}

/// Up to `count` evenly spaced JPEG thumbnails (paths in the cache folder).
pub fn thumbnails(
    core: &Core,
    project_id: &str,
    media_id: &str,
    count: usize,
) -> AppResult<Vec<String>> {
    let tools = require_tools(core)?;
    let (path, info) = core.editor.media_path(project_id, media_id)?;
    if info.kind == "audio" {
        return Ok(vec![]);
    }
    let count = count.clamp(1, 12);
    let dir = cache_dir(core).join("thumbs");
    std::fs::create_dir_all(&dir)?;
    let key = cache_key(&info);
    let mut out = Vec::new();
    for i in 0..count {
        let file = dir.join(format!("{key}-{count}-{i}.jpg"));
        if !file.is_file() {
            let at = match info.duration_sec {
                Some(d) if info.kind == "video" => {
                    (d * (i as f64 + 0.5) / count as f64).min((d - 0.05).max(0.0))
                }
                _ => 0.0,
            };
            let args: Vec<String> = vec![
                "-hide_banner".into(),
                "-loglevel".into(),
                "error".into(),
                "-nostdin".into(),
                "-y".into(),
                "-ss".into(),
                format!("{at:.3}"),
                "-i".into(),
                path.to_string_lossy().into_owned(),
                "-frames:v".into(),
                "1".into(),
                "-vf".into(),
                "scale=-2:96".into(),
                "-q:v".into(),
                "6".into(),
                file.to_string_lossy().into_owned(),
            ];
            let (ok, _, _) = run_tool(&tools.ffmpeg, &args, Duration::from_secs(30))?;
            if !ok || !file.is_file() {
                break;
            }
        }
        out.push(file.to_string_lossy().into_owned());
        if info.kind == "image" {
            break;
        }
    }
    Ok(out)
}

/// Peak levels 0..=255, `per_sec` buckets per second of audio (capped).
pub fn waveform(core: &Core, project_id: &str, media_id: &str) -> AppResult<Waveform> {
    let tools = require_tools(core)?;
    let (path, info) = core.editor.media_path(project_id, media_id)?;
    if !info.has_audio {
        return Ok(Waveform {
            per_sec: 0.0,
            peaks: vec![],
        });
    }
    let dir = cache_dir(core).join("waves");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("{}.json", cache_key(&info)));
    if let Ok(b) = std::fs::read(&file) {
        if let Ok(w) = serde_json::from_slice::<Waveform>(&b) {
            return Ok(w);
        }
    }
    const RATE: usize = 4000;
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-i".into(),
        path.to_string_lossy().into_owned(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        RATE.to_string(),
        "-t".into(),
        "21600".into(),
        "-f".into(),
        "s16le".into(),
        "-".into(),
    ];
    let (ok, pcm, _) = run_tool(&tools.ffmpeg, &args, Duration::from_secs(300))?;
    if !ok {
        return Err(
            AppError::invalid("The audio could not be read.").with_reason("media_unreadable")
        );
    }
    let samples = pcm.len() / 2;
    let secs = samples as f64 / RATE as f64;
    let per_sec = if secs > 0.0 {
        (8000.0 / secs).clamp(5.0, 100.0)
    } else {
        50.0
    };
    let bucket = ((RATE as f64 / per_sec).round() as usize).max(1);
    let peaks = pcm
        .chunks(bucket * 2)
        .map(|c| {
            let m = c
                .chunks_exact(2)
                .map(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs())
                .max()
                .unwrap_or(0);
            ((m as f64 / 32768.0).sqrt() * 255.0).round().min(255.0) as u8
        })
        .collect();
    let w = Waveform {
        per_sec: RATE as f64 / bucket as f64,
        peaks,
    };
    let _ = std::fs::write(&file, serde_json::to_vec(&w)?);
    Ok(w)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    pub per_sec: f64,
    pub peaks: Vec<u8>,
}

/* ── Projects ─────────────────────────────────────────────────────────── */

pub fn check_id(id: &str) -> AppResult<()> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(AppError::invalid("Invalid project id."));
    }
    Ok(())
}

fn read_kv(core: &Core, key: &str) -> Option<Value> {
    let s: Option<String> = core
        .db
        .conn()
        .query_row("SELECT value_json FROM settings WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()
        .ok()
        .flatten();
    s.and_then(|s| serde_json::from_str(&s).ok())
}

fn write_kv(core: &Core, key: &str, v: &Value) -> AppResult<()> {
    core.db.conn().execute(
        "INSERT INTO settings (key, value_json) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json",
        rusqlite::params![key, v.to_string()],
    )?;
    Ok(())
}

/// Checks the parts of a project document the native side relies on. The
/// full schema is validated in the renderer (`parseProject`).
fn check_doc(doc: &Value) -> AppResult<String> {
    if doc.get("format").and_then(Value::as_str) != Some("vidra.editor") {
        return Err(AppError::invalid(
            "This is not a Vidra Studio editor project.",
        ));
    }
    if !matches!(
        doc.get("formatVersion").and_then(Value::as_i64),
        Some(1 | 2)
    ) {
        return Err(
            AppError::invalid("This project was made by a newer version of Vidra Studio.")
                .with_reason("project_version"),
        );
    }
    let id = doc
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    check_id(&id)?;
    if doc.get("media").and_then(Value::as_array).is_none()
        || doc.get("clips").and_then(Value::as_array).is_none()
    {
        return Err(AppError::invalid("The project file is incomplete."));
    }
    Ok(id)
}

/// The document with media paths taken from the native registry. Media the
/// registry does not know (never imported in this session) is refused.
fn with_native_paths(core: &Core, mut doc: Value) -> AppResult<(String, Value)> {
    let id = check_doc(&doc)?;
    let sessions = core
        .editor
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = sessions.get(&id);
    if let Some(media) = doc.get_mut("media").and_then(Value::as_array_mut) {
        for m in media.iter_mut() {
            let mid = m
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let known = session.and_then(|s| s.media.get(&mid)).ok_or_else(|| {
                AppError::invalid("The project references a file that was not imported.")
            })?;
            m["path"] = Value::String(known.path.clone());
        }
    }
    drop(sessions);
    let bytes = serde_json::to_vec(&doc)?;
    if bytes.len() as u64 > PROJECT_MAX_BYTES {
        return Err(AppError::invalid("The project is too large to save."));
    }
    Ok((id, doc))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let tmp = path.with_extension(format!("{PROJECT_EXT}.part"));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn projects_dir() -> Option<PathBuf> {
    dirs_next_documents().map(|d| d.join("Vidra Studio Projects"))
}

fn dirs_next_documents() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join("Documents"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedProject {
    pub path: String,
    pub doc: Value,
}

/// Saves to `path` (a save-dialog choice or the project's current file).
pub fn save_to(core: &Core, doc: Value, path: &Path) -> AppResult<SavedProject> {
    let (id, doc) = with_native_paths(core, doc)?;
    let path = if path.extension().and_then(|e| e.to_str()) == Some(PROJECT_EXT) {
        path.to_path_buf()
    } else {
        path.with_extension(PROJECT_EXT)
    };
    atomic_write(&path, &serde_json::to_vec_pretty(&doc)?)?;
    {
        let mut s = core
            .editor
            .sessions
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        s.entry(id.clone()).or_default().file = Some(path.clone());
    }
    let _ = std::fs::remove_file(recovery_file(core, &id));
    remember_recent(
        core,
        &path,
        doc.get("name").and_then(Value::as_str).unwrap_or("Project"),
    )?;
    Ok(SavedProject {
        path: path.to_string_lossy().into_owned(),
        doc,
    })
}

pub fn current_file(core: &Core, project_id: &str) -> Option<PathBuf> {
    core.editor
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(project_id)
        .and_then(|s| s.file.clone())
}

/// Opens a project file: registers its media (marking missing files) and
/// allows the renderer to preview them.
pub fn open_file(core: &Core, path: &Path) -> AppResult<(SavedProject, Vec<PathBuf>)> {
    let meta = std::fs::metadata(path)
        .map_err(|_| AppError::not_found("The project file was not found."))?;
    if meta.len() > PROJECT_MAX_BYTES {
        return Err(AppError::invalid("The project file is too large."));
    }
    let doc: Value = serde_json::from_slice(&std::fs::read(path)?)
        .map_err(|_| AppError::invalid("The project file is damaged (not valid JSON)."))?;
    let (doc, files) = load_doc(core, doc, Some(path))?;
    remember_recent(
        core,
        path,
        doc.get("name").and_then(Value::as_str).unwrap_or("Project"),
    )?;
    Ok((
        SavedProject {
            path: path.to_string_lossy().into_owned(),
            doc,
        },
        files,
    ))
}

fn load_doc(core: &Core, mut doc: Value, file: Option<&Path>) -> AppResult<(Value, Vec<PathBuf>)> {
    let id = check_doc(&doc)?;
    let mut infos = Vec::new();
    let mut present = Vec::new();
    if let Some(media) = doc.get_mut("media").and_then(Value::as_array_mut) {
        for m in media.iter_mut() {
            let mut info: MediaInfo = serde_json::from_value(m.clone())
                .map_err(|_| AppError::invalid("A media entry in the project is damaged."))?;
            check_id(&info.id)?;
            let p = PathBuf::from(&info.path);
            info.available = p.is_absolute() && p.is_file();
            if info.available {
                present.push(p);
            }
            m["available"] = Value::Bool(info.available);
            infos.push(info);
        }
    }
    let mut s = core
        .editor
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let session = s.entry(id).or_default();
    session.media = infos.into_iter().map(|m| (m.id.clone(), m)).collect();
    if let Some(f) = file {
        session.file = Some(f.to_path_buf());
    }
    Ok((doc, present))
}

/// Registers a brand-new (empty) project with the native side.
pub fn begin(core: &Core, project_id: &str) -> AppResult<()> {
    check_id(project_id)?;
    core.editor
        .sessions
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(project_id.to_string(), Session::default());
    Ok(())
}

/* ── Autosave and recovery ────────────────────────────────────────────── */

fn recovery_dir(core: &Core) -> PathBuf {
    core.data_dir.join("editor-recovery")
}

fn recovery_file(core: &Core, project_id: &str) -> PathBuf {
    recovery_dir(core).join(format!("{project_id}.json"))
}

/// Writes an autosave copy (never over the user's project file).
pub fn autosave(core: &Core, doc: Value) -> AppResult<()> {
    let (id, doc) = with_native_paths(core, doc)?;
    std::fs::create_dir_all(recovery_dir(core))?;
    let wrapper = json!({ "savedAt": now_ms(), "file": current_file(core, &id).map(|p| p.to_string_lossy().into_owned()), "doc": doc });
    let path = recovery_file(core, &id);
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, serde_json::to_vec(&wrapper)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recovery {
    pub project_id: String,
    pub name: String,
    pub saved_at: i64,
    pub file: Option<String>,
}

/// Autosaves that are newer than their saved project file.
pub fn recoveries(core: &Core) -> Vec<Recovery> {
    let Ok(entries) = std::fs::read_dir(recovery_dir(core)) else {
        return vec![];
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let Ok(b) = std::fs::read(e.path()) else {
            continue;
        };
        let Ok(v) = serde_json::from_slice::<Value>(&b) else {
            continue;
        };
        let saved_at = v.get("savedAt").and_then(Value::as_i64).unwrap_or(0);
        let file = v.get("file").and_then(Value::as_str).map(String::from);
        let newer = match file
            .as_deref()
            .and_then(|f| std::fs::metadata(f).ok()?.modified().ok())
        {
            Some(m) => m
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| saved_at > d.as_millis() as i64 + 1000)
                .unwrap_or(true),
            None => true,
        };
        let Some(id) = v
            .pointer("/doc/id")
            .and_then(Value::as_str)
            .map(String::from)
        else {
            continue;
        };
        if newer && check_id(&id).is_ok() {
            out.push(Recovery {
                project_id: id,
                name: v
                    .pointer("/doc/name")
                    .and_then(Value::as_str)
                    .unwrap_or("Project")
                    .chars()
                    .take(120)
                    .collect(),
                saved_at,
                file,
            });
        }
    }
    out.sort_by_key(|r| -r.saved_at);
    out
}

pub fn recover(core: &Core, project_id: &str) -> AppResult<(SavedProject, Vec<PathBuf>)> {
    check_id(project_id)?;
    let b = std::fs::read(recovery_file(core, project_id))
        .map_err(|_| AppError::not_found("No recovery copy for this project."))?;
    let v: Value = serde_json::from_slice(&b)
        .map_err(|_| AppError::invalid("The recovery copy is damaged."))?;
    let file = v.get("file").and_then(Value::as_str).map(PathBuf::from);
    let doc = v.get("doc").cloned().unwrap_or(Value::Null);
    let (doc, present) = load_doc(core, doc, file.as_deref())?;
    Ok((
        SavedProject {
            path: file
                .map(|f| f.to_string_lossy().into_owned())
                .unwrap_or_default(),
            doc,
        },
        present,
    ))
}

pub fn discard_recovery(core: &Core, project_id: &str) -> AppResult<()> {
    check_id(project_id)?;
    let _ = std::fs::remove_file(recovery_file(core, project_id));
    Ok(())
}

/* ── Recent projects ──────────────────────────────────────────────────── */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    /// Stable id (hash of the path): the renderer refers to recents by id.
    pub id: String,
    pub name: String,
    pub path: String,
    pub opened_at: i64,
    #[serde(default)]
    pub exists: bool,
}

fn recent_id(path: &Path) -> String {
    crate::reference_library::sha256_hex(path.to_string_lossy().to_lowercase().as_bytes())[..24]
        .to_string()
}

fn remember_recent(core: &Core, path: &Path, name: &str) -> AppResult<()> {
    let mut list = recent(core);
    let id = recent_id(path);
    list.retain(|r| r.id != id);
    list.insert(
        0,
        RecentProject {
            id,
            name: name.chars().take(120).collect(),
            path: path.to_string_lossy().into_owned(),
            opened_at: now_ms(),
            exists: true,
        },
    );
    list.truncate(RECENT_MAX);
    write_kv(core, RECENT_KEY, &serde_json::to_value(&list)?)
}

pub fn recent(core: &Core) -> Vec<RecentProject> {
    let mut list: Vec<RecentProject> = read_kv(core, RECENT_KEY)
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    for r in list.iter_mut() {
        r.exists = Path::new(&r.path).is_file();
    }
    list
}

pub fn recent_path(core: &Core, id: &str) -> AppResult<PathBuf> {
    recent(core)
        .into_iter()
        .find(|r| r.id == id)
        .map(|r| PathBuf::from(r.path))
        .ok_or_else(|| AppError::not_found("This project is no longer in the recent list."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::testing::env;

    #[test]
    fn interprets_probe_output() {
        let v = json!({
            "streams": [
                {"codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30000/1001"},
                {"codec_type": "audio"}
            ],
            "format": {"duration": "12.5"}
        });
        let f = interpret_probe("video", &v).unwrap();
        assert_eq!(
            (
                f.kind.as_str(),
                f.duration,
                f.width,
                f.height,
                f.has_audio,
                f.has_video
            ),
            ("video", Some(12.5), Some(1920), Some(1080), true, true)
        );
        assert!((f.fps.unwrap() - 29.97).abs() < 0.01);

        let rotated = json!({"streams": [{"codec_type": "video", "width": 1920, "height": 1080, "avg_frame_rate": "30/1",
            "side_data_list": [{"rotation": -90}]}], "format": {"duration": "3"}});
        let f = interpret_probe("video", &rotated).unwrap();
        assert_eq!((f.width, f.height), (Some(1080), Some(1920)));

        let image = json!({"streams": [{"codec_type": "video", "width": 400, "height": 200}], "format": {}});
        let f = interpret_probe("image", &image).unwrap();
        assert_eq!((f.kind.as_str(), f.duration), ("image", None));

        let mp3_with_cover = json!({"streams": [{"codec_type": "audio"}, {"codec_type": "video", "width": 300, "height": 300,
            "disposition": {"attached_pic": 1}}], "format": {"duration": "60"}});
        let f = interpret_probe("audio", &mp3_with_cover).unwrap();
        assert_eq!((f.kind.as_str(), f.width), ("audio", None));

        assert!(interpret_probe("video", &json!({"streams": [], "format": {}})).is_err());
    }

    fn doc(id: &str, media: Value) -> Value {
        json!({"format": "vidra.editor", "formatVersion": 1, "id": id, "name": "P", "media": media, "clips": [], "tracks": []})
    }

    #[test]
    fn saving_takes_paths_from_the_registry_never_the_renderer() {
        let e = env();
        let file = e.dir.path().join("real.mp4");
        std::fs::write(&file, b"x").unwrap();
        begin(&e.core, "prj_1").unwrap();
        let info = MediaInfo {
            id: "med_1".into(),
            kind: "video".into(),
            name: "real.mp4".into(),
            path: file.to_string_lossy().into_owned(),
            duration_sec: Some(1.0),
            width: Some(2),
            height: Some(2),
            fps: Some(30.0),
            has_audio: false,
            has_video: true,
            size_bytes: 1,
            available: true,
        };
        e.core.editor.register("prj_1", std::slice::from_ref(&info));
        let mut tampered = serde_json::to_value(&info).unwrap();
        tampered["path"] = json!("C:/Windows/System32/secret.dat");
        let out = e.dir.path().join("p.vidraproj");
        let saved = save_to(&e.core, doc("prj_1", json!([tampered])), &out).unwrap();
        assert_eq!(saved.doc["media"][0]["path"], json!(info.path));
        // Unknown media is refused.
        let unknown = json!([{"id": "med_x", "path": "C:/x.mp4"}]);
        assert!(save_to(&e.core, doc("prj_1", unknown), &out).is_err());

        // Reopen: media registered again, recents updated, missing files flagged.
        std::fs::remove_file(&file).unwrap();
        let (opened, present) = open_file(&e.core, &out).unwrap();
        assert!(present.is_empty());
        assert_eq!(opened.doc["media"][0]["available"], json!(false));
        let r = recent(&e.core);
        assert_eq!(r.len(), 1);
        assert_eq!(recent_path(&e.core, &r[0].id).unwrap(), out);
    }

    #[test]
    fn autosave_and_recovery() {
        let e = env();
        begin(&e.core, "prj_2").unwrap();
        autosave(&e.core, doc("prj_2", json!([]))).unwrap();
        let list = recoveries(&e.core);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].project_id, "prj_2");
        let (p, _) = recover(&e.core, "prj_2").unwrap();
        assert_eq!(p.doc["id"], json!("prj_2"));
        discard_recovery(&e.core, "prj_2").unwrap();
        assert!(recoveries(&e.core).is_empty());
        assert!(check_doc(&json!({"format": "vidra.editor", "formatVersion": 2})).is_err());
        assert!(check_id("../../evil").is_err());
    }
}
