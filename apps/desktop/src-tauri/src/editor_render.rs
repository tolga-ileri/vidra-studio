//! Video Editor export: turns the render plan (built by `renderPlan` in
//! packages/core, the same plan the preview plays) into an FFmpeg command,
//! runs it in a queue with progress and cancellation, and validates the
//! output with FFprobe before it replaces anything at the chosen path.
//!
//! The command is an argument vector (no shell). File paths only ever appear
//! as `-i` arguments taken from the native media registry; the filter graph
//! contains numbers and fixed filter names only.

use crate::core::Core;
use crate::editor::{hidden, require_tools, run_tool, Tools};
use crate::error::{AppError, AppResult, ErrorCode};
use crate::types::StoreEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt::Write as _;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const MAX_ITEMS: usize = 400;

fn reason(e: &AppError) -> Option<&str> {
    e.details.as_ref()?.get("reason")?.as_str()
}
pub const MAX_DURATION: f64 = 6.0 * 3600.0;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanVideo {
    pub clip_id: String,
    pub media_id: String,
    pub kind: String,
    pub layer: i64,
    pub start: f64,
    pub end: f64,
    pub src_in: f64,
    pub src_out: f64,
    pub speed: f64,
    pub opacity: f64,
    pub fit: String,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanAudio {
    pub clip_id: String,
    pub media_id: String,
    pub start: f64,
    pub end: f64,
    pub src_in: f64,
    pub src_out: f64,
    pub speed: f64,
    pub gain: f64,
    pub fade_in: f64,
    pub fade_out: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderPlan {
    pub width: i64,
    pub height: i64,
    pub fps: i64,
    pub duration: f64,
    pub background: String,
    pub video: Vec<PlanVideo>,
    pub audio: Vec<PlanAudio>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExportOptions {
    /// "auto" (best available), "software" (libx264) or "hardware".
    pub encoder: String,
    /// Video bitrate in kbit/s.
    pub video_kbps: i64,
    pub audio_kbps: i64,
}

/// Source facts the graph needs (from the native registry, never the renderer).
#[derive(Debug, Clone)]
pub struct Source {
    pub path: PathBuf,
    pub width: f64,
    pub height: f64,
    pub has_audio: bool,
}

fn fin(v: f64, lo: f64, hi: f64) -> bool {
    v.is_finite() && v >= lo && v <= hi
}

/// Rejects anything outside the ranges the editor can produce.
pub fn validate(plan: &RenderPlan) -> AppResult<()> {
    let bad = |m: &str| Err(AppError::invalid(format!("Invalid export plan: {m}.")));
    if !(16..=7680).contains(&plan.width)
        || !(16..=7680).contains(&plan.height)
        || plan.width % 2 != 0
        || plan.height % 2 != 0
    {
        return bad("frame size");
    }
    if !(1..=120).contains(&plan.fps) {
        return bad("frame rate");
    }
    if !fin(plan.duration, 0.05, MAX_DURATION) {
        return bad("the timeline is empty or too long");
    }
    if plan.background.len() != 7
        || !plan.background.starts_with('#')
        || !plan.background[1..].chars().all(|c| c.is_ascii_hexdigit())
    {
        return bad("background color");
    }
    if plan.video.len() + plan.audio.len() > MAX_ITEMS {
        return bad("too many clips");
    }
    for v in &plan.video {
        if !(fin(v.start, 0.0, MAX_DURATION) && fin(v.end, v.start + 0.01, MAX_DURATION + 1.0))
            || !fin(v.src_in, 0.0, MAX_DURATION)
            || !fin(v.src_out, v.src_in + 0.001, MAX_DURATION + 1.0)
            || !fin(v.speed, 0.25, 4.0)
            || !fin(v.opacity, 0.0, 1.0)
            || !fin(v.scale, 0.05, 10.0)
            || !fin(v.x, -2.0, 2.0)
            || !fin(v.y, -2.0, 2.0)
            || !(0..=64).contains(&v.layer)
            || !matches!(v.kind.as_str(), "video" | "image")
            || !matches!(v.fit.as_str(), "fit" | "fill" | "blur")
        {
            return bad("video clip values");
        }
    }
    for a in &plan.audio {
        if !(fin(a.start, 0.0, MAX_DURATION) && fin(a.end, a.start + 0.01, MAX_DURATION + 1.0))
            || !fin(a.src_in, 0.0, MAX_DURATION)
            || !fin(a.src_out, a.src_in + 0.001, MAX_DURATION + 1.0)
            || !fin(a.speed, 0.25, 4.0)
            || !fin(a.gain, 0.0, 16.0)
            || !fin(a.fade_in, 0.0, 60.0)
            || !fin(a.fade_out, 0.0, 60.0)
        {
            return bad("audio clip values");
        }
    }
    Ok(())
}

fn even(v: f64) -> i64 {
    (((v / 2.0).round() as i64) * 2).max(2)
}

/// Same math as `placement` in packages/core/src/editor.ts.
#[allow(clippy::too_many_arguments)]
pub fn placement(
    fit: &str,
    sw: f64,
    sh: f64,
    w: f64,
    h: f64,
    scale: f64,
    x: f64,
    y: f64,
) -> (i64, i64, i64, i64) {
    let k = if fit == "fill" {
        (w / sw).max(h / sh)
    } else {
        (w / sw).min(h / sh)
    };
    let dw = even(sw * k * scale);
    let dh = even(sh * k * scale);
    let left = ((w - dw as f64) / 2.0 + x * w).round() as i64;
    let top = ((h - dh as f64) / 2.0 + y * h).round() as i64;
    (dw, dh, left, top)
}

/// atempo accepts 0.5..=2 per instance; chain for 0.25..=4.
fn atempo(speed: f64) -> String {
    let mut s = speed;
    let mut parts = Vec::new();
    while s > 2.0 + 1e-9 {
        parts.push("atempo=2".to_string());
        s /= 2.0;
    }
    while s < 0.5 - 1e-9 {
        parts.push("atempo=0.5".to_string());
        s /= 0.5;
    }
    if (s - 1.0).abs() > 1e-9 {
        parts.push(format!("atempo={s:.6}"));
    }
    parts.join(",")
}

pub struct Graph {
    pub inputs: Vec<String>,
    pub filter: String,
}

/// Builds the inputs and the filter graph. Pure (unit-tested).
pub fn build_graph(plan: &RenderPlan, source: &dyn Fn(&str) -> Option<Source>) -> AppResult<Graph> {
    let (w, h, fps, dur) = (
        plan.width as f64,
        plan.height as f64,
        plan.fps,
        plan.duration,
    );
    let mut inputs: Vec<String> = Vec::new();
    let mut f = String::new();
    let mut n = 0usize;
    let bg = &plan.background[1..];
    let _ = write!(
        f,
        "color=c=0x{bg}:s={}x{}:r={fps}:d={dur:.6},format=yuv420p[b0];",
        plan.width, plan.height
    );
    let mut base = "b0".to_string();
    let missing = || {
        AppError::new(
            ErrorCode::NotFound,
            "A media file used in the timeline is missing.",
        )
        .with_reason("media_missing")
    };
    for (k, v) in plan.video.iter().enumerate() {
        let src = source(&v.media_id).ok_or_else(missing)?;
        let len = v.end - v.start;
        if v.kind == "image" {
            inputs.extend([
                "-loop".into(),
                "1".into(),
                "-framerate".into(),
                fps.to_string(),
                "-t".into(),
                format!("{len:.6}"),
            ]);
        } else {
            inputs.extend([
                "-ss".into(),
                format!("{:.6}", v.src_in),
                "-t".into(),
                format!("{:.6}", v.src_out - v.src_in),
            ]);
        }
        inputs.extend(["-i".into(), src.path.to_string_lossy().into_owned()]);
        let idx = n;
        n += 1;
        let speed = if v.kind == "image" { 1.0 } else { v.speed };
        let timing = format!("setpts=(PTS-STARTPTS)/{speed:.6},fps={fps},trim=duration={len:.6}");
        let alpha = if v.opacity < 0.999 {
            format!(",colorchannelmixer=aa={:.4}", v.opacity)
        } else {
            String::new()
        };
        let shift = format!("setpts=PTS+{:.6}/TB", v.start);
        let mut layers: Vec<(String, i64, i64)> = Vec::new();
        if v.fit == "blur" {
            let (bw, bh, bl, bt) = placement("fill", src.width, src.height, w, h, 1.0, 0.0, 0.0);
            let (fw, fh, fl, ft) = placement("fit", src.width, src.height, w, h, v.scale, v.x, v.y);
            let _ = write!(
                f,
                "[{idx}:v]{timing},split=2[s{k}a][s{k}b];[s{k}a]scale={bw}:{bh},boxblur=24:2,format=yuva420p{alpha},{shift}[l{k}a];[s{k}b]scale={fw}:{fh},format=yuva420p{alpha},{shift}[l{k}b];"
            );
            layers.push((format!("l{k}a"), bl, bt));
            layers.push((format!("l{k}b"), fl, ft));
        } else {
            let (dw, dh, l, t) = placement(&v.fit, src.width, src.height, w, h, v.scale, v.x, v.y);
            let _ = write!(
                f,
                "[{idx}:v]{timing},scale={dw}:{dh},format=yuva420p{alpha},{shift}[l{k}];"
            );
            layers.push((format!("l{k}"), l, t));
        }
        for (i, (label, l, t)) in layers.into_iter().enumerate() {
            let next = format!("b{k}_{i}");
            let _ = write!(
                f,
                "[{base}][{label}]overlay=x={l}:y={t}:eof_action=pass:enable='between(t,{:.6},{:.6})'[{next}];",
                v.start, v.end
            );
            base = next;
        }
    }
    let _ = write!(f, "[{base}]format=yuv420p[vout];");

    let mut mix = Vec::new();
    for (j, a) in plan.audio.iter().enumerate() {
        let src = source(&a.media_id).ok_or_else(missing)?;
        if !src.has_audio {
            continue;
        }
        inputs.extend([
            "-ss".into(),
            format!("{:.6}", a.src_in),
            "-t".into(),
            format!("{:.6}", a.src_out - a.src_in),
            "-i".into(),
            src.path.to_string_lossy().into_owned(),
        ]);
        let idx = n;
        n += 1;
        let len = a.end - a.start;
        let mut chain = vec!["asetpts=PTS-STARTPTS".to_string()];
        let tempo = atempo(a.speed);
        if !tempo.is_empty() {
            chain.push(tempo);
        }
        chain.push("aresample=48000".into());
        chain.push("aformat=sample_fmts=fltp:channel_layouts=stereo".into());
        chain.push(format!("atrim=duration={len:.6}"));
        chain.push(format!("volume={:.6}", a.gain));
        if a.fade_in > 0.0 {
            chain.push(format!("afade=t=in:st=0:d={:.6}", a.fade_in));
        }
        if a.fade_out > 0.0 {
            chain.push(format!(
                "afade=t=out:st={:.6}:d={:.6}",
                (len - a.fade_out).max(0.0),
                a.fade_out
            ));
        }
        let delay = (a.start * 1000.0).round() as i64;
        chain.push(format!("adelay=delays={delay}:all=1"));
        let _ = write!(f, "[{idx}:a]{}[a{j}];", chain.join(","));
        mix.push(format!("[a{j}]"));
    }
    if mix.is_empty() {
        let _ = write!(
            f,
            "anullsrc=r=48000:cl=stereo,atrim=duration={dur:.6}[aout]"
        );
    } else {
        let _ = write!(
            f,
            "{}amix=inputs={}:normalize=0:dropout_transition=0,apad,atrim=duration={dur:.6},alimiter=limit=0.98[aout]",
            mix.join(""),
            mix.len()
        );
    }
    Ok(Graph { inputs, filter: f })
}

fn encoder_args(tools: &Tools, opts: &ExportOptions, fps: i64) -> AppResult<Vec<String>> {
    let has = |e: &str| tools.encoders.iter().any(|x| x == e);
    let kbps = opts.video_kbps.clamp(500, 200_000);
    let rate = |extra: &[&str]| {
        let mut v: Vec<String> = extra.iter().map(|s| s.to_string()).collect();
        v.extend([
            "-b:v".into(),
            format!("{kbps}k"),
            "-maxrate".into(),
            format!("{}k", kbps * 3 / 2),
            "-bufsize".into(),
            format!("{}k", kbps * 2),
        ]);
        v
    };
    let gop = (fps * 2).to_string();
    let software = || -> Vec<String> {
        let mut v: Vec<String> = vec![
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "medium".into(),
            "-crf".into(),
            "19".into(),
        ];
        v.extend([
            "-maxrate".into(),
            format!("{}k", kbps * 3 / 2),
            "-bufsize".into(),
            format!("{}k", kbps * 2),
        ]);
        v
    };
    let pick_hw = || {
        ["h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"]
            .into_iter()
            .find(|e| has(e))
    };
    let mut args = match opts.encoder.as_str() {
        "software" if has("libx264") => software(),
        "software" => {
            return Err(AppError::invalid(
                "This FFmpeg build has no software H.264 encoder (libx264).",
            ))
        }
        "hardware" => match pick_hw() {
            Some(e) => rate(&["-c:v", e]),
            None => {
                return Err(AppError::invalid(
                    "No hardware H.264 encoder is available in this FFmpeg build.",
                ))
            }
        },
        "auto" if has("libx264") => software(),
        "auto" => match pick_hw() {
            Some(e) => rate(&["-c:v", e]),
            None => {
                return Err(
                    AppError::invalid("This FFmpeg build cannot encode H.264 video.")
                        .with_reason("no_h264"),
                )
            }
        },
        _ => return Err(AppError::invalid("Unknown encoder option.")),
    };
    args.extend([
        "-g".into(),
        gop,
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-profile:v".into(),
        "high".into(),
    ]);
    Ok(args)
}

/* ── Export jobs ──────────────────────────────────────────────────────── */

pub struct ExportHandle {
    pub cancel: Arc<std::sync::atomic::AtomicBool>,
    pub child: Arc<Mutex<Option<Child>>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub width: i64,
    pub height: i64,
    pub duration_sec: f64,
    pub size_bytes: i64,
    pub video_codec: String,
    pub audio_codec: String,
}

fn emit(
    core: &Core,
    id: &str,
    status: &str,
    progress: f64,
    message: Option<String>,
    result: Option<&ExportResult>,
) {
    core.emit(StoreEvent::EditorExport {
        export_id: id.to_string(),
        status: status.to_string(),
        progress: progress.clamp(0.0, 1.0),
        message,
        output_path: result.map(|r| r.path.clone()),
    });
}

/// Starts an export in the background; returns its id immediately.
pub fn start(
    core: Arc<Core>,
    project_id: &str,
    plan: RenderPlan,
    opts: ExportOptions,
    output: PathBuf,
) -> AppResult<String> {
    crate::editor::check_id(project_id)?;
    validate(&plan)?;
    let tools = require_tools(&core)?;
    if !tools.encoders.iter().any(|e| e == "aac") {
        return Err(AppError::invalid(
            "This FFmpeg build has no AAC audio encoder.",
        ));
    }
    let enc = encoder_args(&tools, &opts, plan.fps)?;
    let lookup = |id: &str| -> Option<Source> {
        let (path, info) = core.editor.media_path(project_id, id).ok()?;
        if !path.is_file() {
            return None;
        }
        Some(Source {
            path,
            width: info.width.unwrap_or(16) as f64,
            height: info.height.unwrap_or(16) as f64,
            has_audio: info.has_audio,
        })
    };
    let graph = build_graph(&plan, &lookup)?;
    let id = format!("exp_{}", uuid::Uuid::new_v4().simple());
    let handle = ExportHandle {
        cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        child: Arc::new(Mutex::new(None)),
    };
    let (cancel, child_slot) = (handle.cancel.clone(), handle.child.clone());
    core.editor
        .exports
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(id.clone(), handle);
    emit(&core, &id, "queued", 0.0, None, None);
    let job_id = id.clone();
    let audio_kbps = opts.audio_kbps.clamp(64, 512);
    std::thread::spawn(move || {
        let _turn = core
            .editor
            .render_lock
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let outcome = if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            Err(AppError::new(ErrorCode::Unknown, "Canceled.").with_reason("canceled"))
        } else {
            run(
                &core,
                &tools,
                &job_id,
                &plan,
                &graph,
                &enc,
                audio_kbps,
                &output,
                &cancel,
                &child_slot,
            )
        };
        match outcome {
            Ok(r) => emit(&core, &job_id, "completed", 1.0, None, Some(&r)),
            Err(e) if reason(&e) == Some("canceled") => {
                emit(&core, &job_id, "canceled", 0.0, None, None)
            }
            Err(e) => emit(&core, &job_id, "failed", 0.0, Some(e.message), None),
        }
        core.editor
            .exports
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&job_id);
    });
    Ok(id)
}

pub fn cancel(core: &Core, export_id: &str) -> AppResult<()> {
    let exports = core
        .editor
        .exports
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let h = exports
        .get(export_id)
        .ok_or_else(|| AppError::not_found("This export is no longer running."))?;
    h.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(c) = h.child.lock().unwrap_or_else(|p| p.into_inner()).as_mut() {
        let _ = c.kill();
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn run(
    core: &Core,
    tools: &Tools,
    id: &str,
    plan: &RenderPlan,
    graph: &Graph,
    enc: &[String],
    audio_kbps: i64,
    output: &Path,
    cancel: &std::sync::atomic::AtomicBool,
    child_slot: &Mutex<Option<Child>>,
) -> AppResult<ExportResult> {
    let dir = output
        .parent()
        .ok_or_else(|| AppError::invalid("Choose a folder for the video."))?;
    std::fs::create_dir_all(dir)
        .map_err(|_| AppError::invalid("The chosen folder cannot be written."))?;
    let stem = output
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".into());
    let tmp = dir.join(format!(
        ".{stem}.vidra-export-{}.mp4",
        &id[4..12.min(id.len())]
    ));
    let script = crate::editor::cache_dir(core).join(format!("{id}.filter"));
    std::fs::create_dir_all(crate::editor::cache_dir(core))?;
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-y".into(),
        "-loglevel".into(),
        "error".into(),
    ];
    args.extend(graph.inputs.iter().cloned());
    if graph.filter.len() > 8000 {
        std::fs::write(&script, &graph.filter)?;
        args.extend([
            "-/filter_complex".into(),
            script.to_string_lossy().into_owned(),
        ]);
    } else {
        args.extend(["-filter_complex".into(), graph.filter.clone()]);
    }
    args.extend([
        "-map".into(),
        "[vout]".into(),
        "-map".into(),
        "[aout]".into(),
    ]);
    args.extend(enc.iter().cloned());
    args.extend([
        "-r".into(),
        plan.fps.to_string(),
        "-c:a".into(),
        "aac".into(),
        "-b:a".into(),
        format!("{audio_kbps}k"),
        "-ar".into(),
        "48000".into(),
        "-t".into(),
        format!("{:.6}", plan.duration),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        "-f".into(),
        "mp4".into(),
        tmp.to_string_lossy().into_owned(),
    ]);
    let mut cmd = Command::new(&tools.ffmpeg);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = hidden(&mut cmd).spawn().map_err(|_| {
        AppError::new(ErrorCode::NotFound, "FFmpeg could not be started.")
            .with_reason("ffmpeg_missing")
    })?;
    let stdout = child.stdout.take();
    let mut stderr = child.stderr.take();
    *child_slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(child);
    let err_t = std::thread::spawn(move || {
        let mut s = String::new();
        if let Some(e) = stderr.as_mut() {
            use std::io::Read;
            let _ = e.take(64 * 1024).read_to_string(&mut s);
        }
        s
    });
    emit(core, id, "rendering", 0.0, None, None);
    let mut last = Instant::now() - Duration::from_secs(1);
    if let Some(out) = stdout {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            if let Some(us) = line
                .strip_prefix("out_time_us=")
                .or_else(|| line.strip_prefix("out_time_ms="))
            {
                if let Ok(us) = us.trim().parse::<f64>() {
                    if last.elapsed() > Duration::from_millis(200) {
                        emit(
                            core,
                            id,
                            "rendering",
                            (us / 1e6) / plan.duration,
                            None,
                            None,
                        );
                        last = Instant::now();
                    }
                }
            }
        }
    }
    let status = child_slot
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .take()
        .map(|mut c| c.wait())
        .transpose()?;
    let stderr = err_t.join().unwrap_or_default();
    let _ = std::fs::remove_file(&script);
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::new(ErrorCode::Unknown, "Canceled.").with_reason("canceled"));
    }
    if !status.is_some_and(|s| s.success()) {
        let _ = std::fs::remove_file(&tmp);
        log::warn!(
            "ffmpeg export failed: {}",
            stderr.lines().last().unwrap_or("")
        );
        let last = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("unknown error");
        return Err(AppError::new(
            ErrorCode::Io,
            format!(
                "Rendering failed: {}",
                last.chars().take(240).collect::<String>()
            ),
        )
        .with_reason("render_failed"));
    }
    emit(core, id, "validating", 1.0, None, None);
    let result = match verify(tools, &tmp, plan) {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    if output.exists() {
        std::fs::remove_file(output).map_err(|_| {
            AppError::invalid(
                "The existing file at the chosen path could not be replaced (is it open?).",
            )
        })?;
    }
    std::fs::rename(&tmp, output)?;
    Ok(ExportResult {
        path: output.to_string_lossy().into_owned(),
        ..result
    })
}

/// Checks the rendered file: H.264 + AAC, the planned size, and the duration.
pub fn verify(tools: &Tools, file: &Path, plan: &RenderPlan) -> AppResult<ExportResult> {
    let args: Vec<String> = vec![
        "-v".into(),
        "error".into(),
        "-print_format".into(),
        "json".into(),
        "-show_format".into(),
        "-show_streams".into(),
        file.to_string_lossy().into_owned(),
    ];
    let (ok, out, _) = run_tool(&tools.ffprobe, &args, Duration::from_secs(30))?;
    let v: Value = serde_json::from_slice(&out).unwrap_or(Value::Null);
    let fail = |m: &str| {
        Err(AppError::new(
            ErrorCode::Io,
            format!("The exported file did not pass validation: {m}."),
        )
        .with_reason("output_invalid"))
    };
    if !ok {
        return fail("it could not be read");
    }
    let streams = v
        .get("streams")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let vs = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("video"));
    let a = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"));
    let (Some(vs), Some(a)) = (vs, a) else {
        return fail("video or audio stream missing");
    };
    let vcodec = vs
        .get("codec_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let acodec = a
        .get("codec_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let (w, h) = (
        vs.get("width").and_then(Value::as_i64).unwrap_or(0),
        vs.get("height").and_then(Value::as_i64).unwrap_or(0),
    );
    let dur = v
        .pointer("/format/duration")
        .and_then(Value::as_str)
        .and_then(|d| d.parse::<f64>().ok())
        .unwrap_or(0.0);
    if vcodec != "h264" || acodec != "aac" {
        return fail("unexpected codecs");
    }
    if w != plan.width || h != plan.height {
        return fail("unexpected frame size");
    }
    if (dur - plan.duration).abs() > 0.25 + 2.0 / plan.fps as f64 {
        return fail("unexpected duration");
    }
    Ok(ExportResult {
        path: file.to_string_lossy().into_owned(),
        width: w,
        height: h,
        duration_sec: dur,
        size_bytes: std::fs::metadata(file).map(|m| m.len() as i64).unwrap_or(0),
        video_codec: vcodec,
        audio_codec: acodec,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> RenderPlan {
        RenderPlan {
            width: 1080,
            height: 1920,
            fps: 30,
            duration: 8.0,
            background: "#000000".into(),
            video: vec![
                PlanVideo {
                    clip_id: "c1".into(),
                    media_id: "a".into(),
                    kind: "video".into(),
                    layer: 0,
                    start: 0.0,
                    end: 4.0,
                    src_in: 1.0,
                    src_out: 5.0,
                    speed: 1.0,
                    opacity: 1.0,
                    fit: "blur".into(),
                    x: 0.0,
                    y: 0.0,
                    scale: 1.0,
                },
                PlanVideo {
                    clip_id: "c2".into(),
                    media_id: "logo".into(),
                    kind: "image".into(),
                    layer: 1,
                    start: 0.0,
                    end: 8.0,
                    src_in: 0.0,
                    src_out: 8.0,
                    speed: 1.0,
                    opacity: 0.5,
                    fit: "fit".into(),
                    x: 0.3,
                    y: -0.4,
                    scale: 0.2,
                },
            ],
            audio: vec![
                PlanAudio {
                    clip_id: "c1".into(),
                    media_id: "a".into(),
                    start: 0.0,
                    end: 4.0,
                    src_in: 1.0,
                    src_out: 5.0,
                    speed: 1.0,
                    gain: 1.0,
                    fade_in: 0.0,
                    fade_out: 0.0,
                },
                PlanAudio {
                    clip_id: "m".into(),
                    media_id: "music".into(),
                    start: 2.0,
                    end: 8.0,
                    src_in: 0.0,
                    src_out: 12.0,
                    speed: 2.0,
                    gain: 0.3,
                    fade_in: 1.0,
                    fade_out: 2.0,
                },
            ],
        }
    }

    fn src(id: &str) -> Option<Source> {
        match id {
            "a" => Some(Source {
                path: "C:/m/a b.mp4".into(),
                width: 1920.0,
                height: 1080.0,
                has_audio: true,
            }),
            "logo" => Some(Source {
                path: "C:/m/logo.png".into(),
                width: 500.0,
                height: 500.0,
                has_audio: false,
            }),
            "music" => Some(Source {
                path: "C:/m/music.mp3".into(),
                width: 16.0,
                height: 16.0,
                has_audio: true,
            }),
            _ => None,
        }
    }

    #[test]
    fn builds_the_graph_from_the_plan() {
        let g = build_graph(&plan(), &src).unwrap();
        // Paths only appear as separate -i arguments, never inside the graph.
        assert!(g.inputs.contains(&"C:/m/a b.mp4".to_string()));
        assert!(!g.filter.contains("C:/m"));
        assert_eq!(g.inputs.iter().filter(|a| *a == "-i").count(), 4);
        assert!(g.inputs.windows(2).any(|w| w[0] == "-loop" && w[1] == "1"));
        assert!(g
            .filter
            .starts_with("color=c=0x000000:s=1080x1920:r=30:d=8.000000"));
        // Blur = blurred fill background + fitted foreground.
        assert!(g.filter.contains("scale=3414:1920,boxblur=24:2"));
        assert!(g.filter.contains("scale=1080:608"));
        // Logo: 20% of the fitted size, offset and half transparent.
        assert!(g
            .filter
            .contains("scale=216:216,format=yuva420p,colorchannelmixer=aa=0.5000"));
        assert!(g.filter.contains("overlay=x=756:y=84"));
        // Music: speed 2 → atempo, gain, fades relative to the clip, delayed to 2 s.
        assert!(g.filter.contains("atempo=2"));
        assert!(g.filter.contains("volume=0.300000"));
        assert!(g.filter.contains("afade=t=out:st=4.000000:d=2.000000"));
        assert!(g.filter.contains("adelay=delays=2000:all=1"));
        assert!(g.filter.contains("amix=inputs=2:normalize=0"));
        assert!(g.filter.ends_with("[aout]"));
    }

    #[test]
    fn silent_timelines_get_a_silent_track_and_missing_media_is_an_error() {
        let mut p = plan();
        p.audio.clear();
        assert!(build_graph(&p, &src)
            .unwrap()
            .filter
            .contains("anullsrc=r=48000:cl=stereo"));
        p.video[0].media_id = "gone".into();
        assert_eq!(
            reason(&build_graph(&p, &src).err().unwrap()),
            Some("media_missing")
        );
    }

    #[test]
    fn rejects_out_of_range_plans() {
        assert!(validate(&plan()).is_ok());
        let mut p = plan();
        p.width = 1081;
        assert!(validate(&p).is_err());
        let mut p = plan();
        p.video[0].speed = 10.0;
        assert!(validate(&p).is_err());
        let mut p = plan();
        p.background = "#00000g".into();
        assert!(validate(&p).is_err());
        let mut p = plan();
        p.duration = f64::NAN;
        assert!(validate(&p).is_err());
        let mut p = plan();
        p.video[0].fit = "x;rm".into();
        assert!(validate(&p).is_err());
    }

    #[test]
    fn atempo_chains_stay_in_range() {
        assert_eq!(atempo(1.0), "");
        assert_eq!(atempo(4.0), "atempo=2,atempo=2.000000");
        assert_eq!(atempo(0.25), "atempo=0.5,atempo=0.500000");
        assert_eq!(atempo(1.5), "atempo=1.500000");
    }

    /// End-to-end with the real FFmpeg on PATH (skipped when absent): renders
    /// a 9:16 timeline from generated clips and validates the MP4.
    #[test]
    fn renders_a_real_mp4_when_ffmpeg_is_available() {
        let Some(ffmpeg) = std::env::var_os("PATH").and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| {
                    d.join(if cfg!(windows) {
                        "ffmpeg.exe"
                    } else {
                        "ffmpeg"
                    })
                })
                .find(|f| f.is_file())
        }) else {
            eprintln!("ffmpeg not on PATH; skipping");
            return;
        };
        let ffprobe = ffmpeg.with_file_name(if cfg!(windows) {
            "ffprobe.exe"
        } else {
            "ffprobe"
        });
        let dir = tempfile::tempdir().unwrap();
        let clip = dir.path().join("clip.mp4");
        let music = dir.path().join("music.wav");
        let logo = dir.path().join("logo.png");
        let gen = |args: &[&str]| {
            let a: Vec<String> = args.iter().map(|s| s.to_string()).collect();
            assert!(
                run_tool(&ffmpeg, &a, Duration::from_secs(60)).unwrap().0,
                "{args:?}"
            );
        };
        gen(&[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=640x360:r=30:d=3",
            "-f",
            "lavfi",
            "-i",
            "sine=f=440:d=3",
            "-shortest",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            clip.to_str().unwrap(),
        ]);
        gen(&[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "sine=f=220:d=6",
            music.to_str().unwrap(),
        ]);
        gen(&[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=200x100:d=1",
            "-frames:v",
            "1",
            logo.to_str().unwrap(),
        ]);
        let tools = crate::editor::Tools {
            ffmpeg: ffmpeg.clone(),
            ffprobe,
            version: String::new(),
            source: "path".into(),
            encoders: vec!["libx264".into(), "aac".into()],
        };
        let mut p = plan();
        p.width = 360;
        p.height = 640;
        p.duration = 5.0;
        p.video[0].src_in = 0.5;
        p.video[0].src_out = 3.0;
        p.video[0].end = 2.5;
        p.video[1].end = 5.0;
        p.audio[0].src_in = 0.5;
        p.audio[0].src_out = 3.0;
        p.audio[0].end = 2.5;
        p.audio[1].src_out = 6.0;
        p.audio[1].end = 5.0;
        p.audio[1].start = 2.0;
        p.audio[1].speed = 1.0;
        p.audio[1].src_out = 3.0;
        let paths = |id: &str| match id {
            "a" => Some(Source {
                path: clip.clone(),
                width: 640.0,
                height: 360.0,
                has_audio: true,
            }),
            "logo" => Some(Source {
                path: logo.clone(),
                width: 200.0,
                height: 100.0,
                has_audio: false,
            }),
            "music" => Some(Source {
                path: music.clone(),
                width: 16.0,
                height: 16.0,
                has_audio: true,
            }),
            _ => None,
        };
        let g = build_graph(&p, &paths).unwrap();
        let out = dir.path().join("out.mp4");
        let mut args: Vec<String> = vec![
            "-hide_banner".into(),
            "-nostdin".into(),
            "-y".into(),
            "-loglevel".into(),
            "error".into(),
        ];
        args.extend(g.inputs.clone());
        args.extend([
            "-filter_complex".into(),
            g.filter.clone(),
            "-map".into(),
            "[vout]".into(),
            "-map".into(),
            "[aout]".into(),
        ]);
        args.extend(
            encoder_args(
                &tools,
                &ExportOptions {
                    encoder: "auto".into(),
                    video_kbps: 2000,
                    audio_kbps: 128,
                },
                30,
            )
            .unwrap(),
        );
        args.extend(
            ["-r", "30", "-c:a", "aac", "-t", "5", "-f", "mp4"]
                .iter()
                .map(|s| s.to_string()),
        );
        args.push(out.to_string_lossy().into_owned());
        let (ok, _, err) = run_tool(&ffmpeg, &args, Duration::from_secs(120)).unwrap();
        assert!(ok, "{err}");
        let r = verify(&tools, &out, &p).unwrap();
        assert_eq!(
            (
                r.width,
                r.height,
                r.video_codec.as_str(),
                r.audio_codec.as_str()
            ),
            (360, 640, "h264", "aac")
        );
        assert!((r.duration_sec - 5.0).abs() < 0.3, "{}", r.duration_sec);
    }
}
