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

/// A keyframe on the timeline (absolute seconds), with the easing of the
/// segment that starts at it. Same curves as `ease()` in packages/core.
#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Anim {
    pub t: f64,
    pub v: f64,
    pub ease: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fade {
    pub t0: f64,
    pub t1: f64,
    pub from: f64,
    pub to: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Crop {
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoAnim {
    #[serde(default)]
    pub scale: Option<Vec<Anim>>,
    #[serde(default)]
    pub x: Option<Vec<Anim>>,
    #[serde(default)]
    pub y: Option<Vec<Anim>>,
    #[serde(default)]
    pub rotation: Option<Vec<Anim>>,
    #[serde(default)]
    pub opacity: Option<Vec<Anim>>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AnimVec {
    pub t: f64,
    pub v: Vec<f64>,
    pub ease: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Mask {
    pub shape: String,
    pub feather: f64,
    pub radius: f64,
}

impl Default for Mask {
    fn default() -> Self {
        Mask {
            shape: "none".into(),
            feather: 0.0,
            radius: 0.1,
        }
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanRegion {
    pub id: String,
    pub kind: String,
    pub shape: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub color: String,
    pub blur: f64,
    pub feather: f64,
    #[serde(default)]
    pub anim: Vec<AnimVec>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Wipe {
    pub t0: f64,
    pub t1: f64,
    pub mode: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanVideo {
    #[serde(default)]
    pub id: String,
    pub clip_id: String,
    pub media_id: String,
    pub kind: String,
    #[serde(default)]
    pub color: String,
    pub layer: f64,
    #[serde(default)]
    pub z: f64,
    pub start: f64,
    pub end: f64,
    pub src_in: f64,
    pub src_out: f64,
    pub speed: f64,
    #[serde(default)]
    pub hold_start: f64,
    #[serde(default)]
    pub hold_end: f64,
    pub opacity: f64,
    pub fit: String,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    #[serde(default)]
    pub rotation: f64,
    #[serde(default)]
    pub crop: Crop,
    #[serde(default)]
    pub anim: VideoAnim,
    #[serde(default)]
    pub t_scale: Vec<Anim>,
    #[serde(default)]
    pub t_x: Vec<Anim>,
    #[serde(default)]
    pub fades: Vec<Fade>,
    #[serde(default)]
    pub blur: f64,
    #[serde(default)]
    pub wipe: Option<Wipe>,
    #[serde(default)]
    pub corners: Option<Vec<f64>>,
    #[serde(default)]
    pub corners_anim: Vec<AnimVec>,
    #[serde(default)]
    pub mask: Mask,
    #[serde(default)]
    pub motion_blur: bool,
    #[serde(default)]
    pub regions: Vec<PlanRegion>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Default)]
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
    #[serde(default)]
    pub gain_anim: Vec<Anim>,
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
    let hex = |c: &str| {
        c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
    };
    let anims_ok = |list: &[Anim], lo: f64, hi: f64| {
        list.len() <= 1000
            && list.iter().all(|a| {
                fin(a.t, -10.0, MAX_DURATION + 10.0)
                    && fin(a.v, lo, hi)
                    && matches!(a.ease.as_str(), "linear" | "in" | "out" | "inOut" | "hold")
            })
    };
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
    if !hex(&plan.background) {
        return bad("background color");
    }
    if plan.video.len() + plan.audio.len() > MAX_ITEMS {
        return bad("too many clips");
    }
    for v in &plan.video {
        let a = &v.anim;
        if !(fin(v.start, 0.0, MAX_DURATION) && fin(v.end, v.start + 0.01, MAX_DURATION + 1.0))
            || !fin(v.src_in, 0.0, MAX_DURATION)
            || !fin(v.src_out, v.src_in + 0.001, MAX_DURATION + 1.0)
            || !fin(v.speed, 0.25, 4.0)
            || !fin(v.hold_start, 0.0, 10.0)
            || !fin(v.hold_end, 0.0, 10.0)
            || !fin(v.opacity, 0.0, 1.0)
            || !fin(v.scale, 0.05, 10.0)
            || !fin(v.x, -2.0, 2.0)
            || !fin(v.y, -2.0, 2.0)
            || !fin(v.rotation, -3600.0, 3600.0)
            || !fin(v.layer, 0.0, 64.0)
            || !fin(v.z, -10.0, 10.0)
            || !fin(v.blur, 0.0, 0.2)
            || !(fin(v.crop.l, 0.0, 0.9)
                && fin(v.crop.t, 0.0, 0.9)
                && fin(v.crop.r, 0.0, 0.9)
                && fin(v.crop.b, 0.0, 0.9))
            || v.crop.l + v.crop.r >= 0.95
            || v.crop.t + v.crop.b >= 0.95
            || !matches!(v.kind.as_str(), "video" | "image" | "color")
            || (v.kind == "color" && !hex(&v.color))
            || !matches!(v.fit.as_str(), "fit" | "fill" | "blur")
            || !anims_ok(a.scale.as_deref().unwrap_or(&[]), 0.05, 10.0)
            || !anims_ok(a.x.as_deref().unwrap_or(&[]), -2.0, 2.0)
            || !anims_ok(a.y.as_deref().unwrap_or(&[]), -2.0, 2.0)
            || !anims_ok(a.rotation.as_deref().unwrap_or(&[]), -3600.0, 3600.0)
            || !anims_ok(a.opacity.as_deref().unwrap_or(&[]), 0.0, 1.0)
            || !anims_ok(&v.t_scale, 0.05, 10.0)
            || !anims_ok(&v.t_x, -2.0, 2.0)
            || v.fades.len() > 8
            || !v.fades.iter().all(|f| {
                fin(f.t0, 0.0, MAX_DURATION + 1.0)
                    && fin(f.t1, f.t0 + 0.001, MAX_DURATION + 1.0)
                    && fin(f.from, 0.0, 1.0)
                    && fin(f.to, 0.0, 1.0)
            })
            || v.wipe.as_ref().is_some_and(|w| {
                !(fin(w.t0, 0.0, MAX_DURATION + 1.0)
                    && fin(w.t1, w.t0 + 0.001, MAX_DURATION + 1.0)
                    && matches!(w.mode.as_str(), "in" | "out"))
            })
            || v.corners
                .as_ref()
                .is_some_and(|c| c.len() != 8 || !c.iter().all(|x| fin(*x, -3.0, 4.0)))
            || v.corners_anim.len() > 500
            || !v.corners_anim.iter().all(|a| {
                fin(a.t, -10.0, MAX_DURATION + 10.0)
                    && a.v.len() == 8
                    && a.v.iter().all(|x| fin(*x, -3.0, 4.0))
                    && matches!(a.ease.as_str(), "linear" | "in" | "out" | "inOut" | "hold")
            })
            || !matches!(v.mask.shape.as_str(), "none" | "ellipse" | "roundRect")
            || !fin(v.mask.feather, 0.0, 0.5)
            || !fin(v.mask.radius, 0.0, 0.5)
            || v.regions.len() > 50
            || !v.regions.iter().all(|r| {
                matches!(r.kind.as_str(), "blur" | "color")
                    && matches!(r.shape.as_str(), "rect" | "ellipse")
                    && fin(r.x, -1.0, 2.0)
                    && fin(r.y, -1.0, 2.0)
                    && fin(r.w, 0.005, 2.0)
                    && fin(r.h, 0.005, 2.0)
                    && hex(&r.color)
                    && fin(r.blur, 0.002, 0.1)
                    && fin(r.feather, 0.0, 0.5)
                    && r.anim.len() <= 500
                    && r.anim.iter().all(|a| {
                        fin(a.t, -10.0, MAX_DURATION + 10.0)
                            && a.v.len() == 2
                            && a.v.iter().all(|x| fin(*x, -1.0, 2.0))
                    })
            })
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
            || !anims_ok(&a.gain_anim, 0.0, 4.0)
        {
            return bad("audio clip values");
        }
    }
    Ok(())
}

/// FFmpeg expression of a cubic easing curve of `u` (0..1). Mirrors `ease()` in packages/core.
fn ease_expr(kind: &str, u: &str) -> String {
    match kind {
        "in" => format!("pow({u},3)"),
        "out" => format!("1-pow(1-{u},3)"),
        "inOut" => format!("if(lt({u},0.5),4*pow({u},3),1-pow(-2*{u}+2,3)/2)"),
        "hold" => format!("if(lt({u},1),0,1)"),
        _ => u.to_string(),
    }
}

/// FFmpeg expression for an animation at time variable `tv` with `shift`
/// subtracted from the keyframe times (item-relative filters), or `base`
/// when there is none. Mirrors `animAt()` in packages/core.
fn anim_expr(list: &[Anim], tv: &str, shift: f64, base: f64) -> String {
    let Some(first) = list.first() else {
        return format!("{base:.6}");
    };
    let last = list.last().unwrap_or(first);
    let mut e = format!("{:.6}", last.v);
    for w in list.windows(2).rev() {
        let (a, b) = (&w[0], &w[1]);
        let (ta, tb) = (a.t - shift, b.t - shift);
        let span = (tb - ta).max(1e-6);
        let u = format!("clip(({tv}-{ta:.6})/{span:.6},0,1)");
        let seg = format!("{:.6}+({:.6})*({})", a.v, b.v - a.v, ease_expr(&a.ease, &u));
        e = format!("if(lt({tv},{tb:.6}),{seg},{e})");
    }
    format!("if(lt({tv},{:.6}),{:.6},{e})", first.t - shift, first.v)
}

/// A quoted filter option value with its commas escaped.
fn q(expr: &str) -> String {
    format!("'{}'", expr.replace(',', "\\,"))
}

/// One component of a vector animation as a scalar one.
fn component(list: &[AnimVec], i: usize) -> Vec<Anim> {
    list.iter()
        .map(|a| Anim {
            t: a.t,
            v: a.v.get(i).copied().unwrap_or(0.0),
            ease: a.ease.clone(),
        })
        .collect()
}

/// Alpha factor (0..1) of a soft ellipse / rounded rectangle inside the
/// current frame (geq variables W, H, X, Y), as a fraction of its size.
fn shape_factor(shape: &str, feather: f64, radius: f64) -> Option<String> {
    let f = feather.max(0.002);
    match shape {
        "ellipse" => Some(format!(
            "clip((1-sqrt(pow((X+0.5-W/2)/(W/2),2)+pow((Y+0.5-H/2)/(H/2),2)))/{f:.4},0,1)"
        )),
        "roundRect" => {
            // Signed distance to a rounded rectangle, negative inside.
            let r = format!("{radius:.4}*min(W,H)");
            Some(format!(
                "clip(-(hypot(max(abs(X+0.5-W/2)-(W/2-{r}),0),max(abs(Y+0.5-H/2)-(H/2-{r}),0))-{r})/({f:.4}*min(W,H)),0,1)"
            ))
        }
        "rect" if feather > 0.0 => Some(format!(
            "clip(min(min(X,W-1-X),min(Y,H-1-Y))/({f:.4}*min(W,H)),0,1)"
        )),
        _ => None,
    }
}

/// geq that multiplies the alpha plane by `factor` (lum/chroma untouched).
fn alpha_geq(factor: &str) -> String {
    format!(
        ",geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a={}",
        q(&format!("alpha(X,Y)*{factor}"))
    )
}

fn max_of(list: &[Anim], base: f64) -> f64 {
    if list.is_empty() {
        base
    } else {
        list.iter().fold(f64::MIN, |m, a| m.max(a.v))
    }
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
/// After an item is composited: frame-blend motion blur while it animates,
/// then its blur / cover regions. Returns the new base label.
#[allow(clippy::too_many_arguments)]
fn post_item(
    f: &mut String,
    mut base: String,
    v: &PlanVideo,
    k: usize,
    w: i64,
    h: i64,
    fps: i64,
    duration: f64,
) -> String {
    if v.motion_blur {
        let a = &v.anim;
        let times: Vec<f64> = [
            a.scale.as_deref(),
            a.x.as_deref(),
            a.y.as_deref(),
            a.rotation.as_deref(),
        ]
        .into_iter()
        .flatten()
        .flat_map(|l| l.iter().map(|k| k.t))
        .collect();
        if let (Some(t0), Some(t1)) = (
            times.iter().cloned().reduce(f64::min),
            times.iter().cloned().reduce(f64::max),
        ) {
            if t1 > t0 {
                let next = format!("mb{k}");
                let _ = write!(f, "[{base}]tmix=frames=3:weights='1 2 1':enable='between(t,{t0:.6},{t1:.6})'[{next}];");
                base = next;
            }
        }
    }
    for (j, r) in v.regions.iter().enumerate() {
        let rw = even(r.w * w as f64).clamp(2, w);
        let rh = even(r.h * h as f64).clamp(2, h);
        let xe = anim_expr(&component(&r.anim, 0), "t", 0.0, r.x);
        let ye = anim_expr(&component(&r.anim, 1), "t", 0.0, r.y);
        let xpx = q(&format!("clip(({xe})*{w},0,{})", w - rw));
        let ypx = q(&format!("clip(({ye})*{h},0,{})", h - rh));
        let shape = shape_factor(&r.shape, r.feather, 0.0)
            .map(|fac| format!(",format=yuva420p{}", alpha_geq(&fac)))
            .unwrap_or_default();
        let enable = format!("enable='between(t,{:.6},{:.6})'", v.start, v.end);
        let src = format!("rg{k}_{j}");
        if r.kind == "blur" {
            let br = ((r.blur * h as f64).round() as i64).clamp(1, (rw.min(rh) / 2 - 1).max(1));
            let _ = write!(
                f,
                "[{base}]split[{src}a][{src}b];[{src}b]crop=w={rw}:h={rh}:x={xpx}:y={ypx},boxblur=luma_radius={br}:luma_power=2:chroma_radius={br}:chroma_power=2{shape}[{src}c];[{src}a][{src}c]overlay=x={xpx}:y={ypx}:eval=frame:eof_action=pass:{enable}[{src}];"
            );
        } else {
            let c = r.color.trim_start_matches('#');
            let _ = write!(
                f,
                "color=c=0x{c}:s={rw}x{rh}:r={fps}:d={:.6},format=yuva420p{shape}[{src}c];[{base}][{src}c]overlay=x={xpx}:y={ypx}:eval=frame:eof_action=pass:{enable}[{src}];",
                duration + 1.0
            );
        }
        base = src;
    }
    base
}

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
        let len = v.end - v.start;
        let shift = format!("setpts=PTS+{:.6}/TB", v.start);
        let enable = format!("enable='between(t,{:.6},{:.6})'", v.start, v.end);
        // Alpha: static opacity, linear ramps (transitions), keyframed opacity and wipes.
        let mut alpha = String::new();
        let a = &v.anim;
        let opacity_anim = a.opacity.as_deref().unwrap_or(&[]);
        if opacity_anim.is_empty() && v.opacity < 0.999 {
            let _ = write!(alpha, ",colorchannelmixer=aa={:.4}", v.opacity);
        }
        for fd in &v.fades {
            let (t0, d) = ((fd.t0 - v.start).max(0.0), (fd.t1 - fd.t0).max(0.001));
            if fd.from < fd.to {
                let _ = write!(alpha, ",fade=t=in:st={t0:.6}:d={d:.6}:alpha=1");
            } else if fd.from > fd.to {
                let _ = write!(alpha, ",fade=t=out:st={t0:.6}:d={d:.6}:alpha=1");
            }
        }
        if !opacity_anim.is_empty() || v.wipe.is_some() {
            let mut factor = "1".to_string();
            if !opacity_anim.is_empty() {
                factor = format!(
                    "clip({},0,1)",
                    anim_expr(opacity_anim, "T", v.start, v.opacity)
                );
            }
            let mut geq_enable = String::new();
            if let Some(wp) = &v.wipe {
                let span = (wp.t1 - wp.t0).max(0.001);
                let u = format!("clip((T-{:.6})/{span:.6},0,1)", wp.t0 - v.start);
                let mask = if wp.mode == "in" {
                    format!("lte(X,W*{u})")
                } else {
                    format!("gte(X,W*{u})")
                };
                factor = format!("{factor}*{mask}");
                if opacity_anim.is_empty() {
                    // Before/after the wipe the mask is all or nothing; only evaluate during it.
                    if wp.mode == "in" {
                        geq_enable = format!(":enable='lte(t,{:.6})'", wp.t1 - v.start);
                    } else {
                        geq_enable = format!(":enable='gte(t,{:.6})'", wp.t0 - v.start);
                    }
                }
            }
            let _ = write!(
                alpha,
                ",geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a={}{geq_enable}",
                q(&format!("alpha(X,Y)*{factor}"))
            );
        }
        if v.blur > 0.0 {
            let r = ((v.blur * h).round() as i64).clamp(1, 64);
            let _ = write!(alpha, ",boxblur=luma_radius={r}:luma_power=2:chroma_radius={r}:chroma_power=2:alpha_radius=0");
        }

        if v.kind == "color" {
            let c = &v.color[1..];
            let _ = write!(
                f,
                "color=c=0x{c}:s={}x{}:r={fps}:d={len:.6},format=yuva420p{alpha},{shift}[l{k}];",
                plan.width, plan.height
            );
            let next = format!("b{k}_0");
            let _ = write!(
                f,
                "[{base}][l{k}]overlay=x=0:y=0:eof_action=pass:{enable}[{next}];"
            );
            base = next;
            continue;
        }

        let src = source(&v.media_id).ok_or_else(missing)?;
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
        let body = if v.kind == "image" {
            len
        } else {
            (v.src_out - v.src_in) / speed
        };
        let mut timing =
            format!("setpts=(PTS-STARTPTS)/{speed:.6},fps={fps},trim=duration={body:.6}");
        if v.hold_start > 0.0 || v.hold_end > 0.0 {
            let _ = write!(
                timing,
                ",tpad=start_mode=clone:start_duration={:.6}:stop_mode=clone:stop_duration={:.6}",
                v.hold_start, v.hold_end
            );
        }
        let c = &v.crop;
        let (sw, sh) = (
            src.width * (1.0 - c.l - c.r),
            src.height * (1.0 - c.t - c.b),
        );
        if c.l + c.r + c.t + c.b > 1e-6 {
            let _ = write!(
                timing,
                ",crop=w=trunc(iw*{:.6}/2)*2:h=trunc(ih*{:.6}/2)*2:x=trunc(iw*{:.6}):y=trunc(ih*{:.6})",
                1.0 - c.l - c.r,
                1.0 - c.t - c.b,
                c.l,
                c.t
            );
        }
        let scale_anim = a.scale.as_deref().unwrap_or(&[]);
        let x_anim = a.x.as_deref().unwrap_or(&[]);
        let y_anim = a.y.as_deref().unwrap_or(&[]);
        let rot_anim = a.rotation.as_deref().unwrap_or(&[]);
        let animated = !scale_anim.is_empty()
            || !x_anim.is_empty()
            || !y_anim.is_empty()
            || !rot_anim.is_empty()
            || !v.t_scale.is_empty()
            || !v.t_x.is_empty()
            || v.rotation.abs() > 1e-6;

        let mut layers: Vec<(String, String, String, bool)> = Vec::new();
        let mut fg_source = format!("[{idx}:v]{timing},");
        // Shape masks are applied before scaling (relative coordinates survive any zoom).
        let mask = shape_factor(&v.mask.shape, v.mask.feather, v.mask.radius)
            .map(|f| format!("format=yuva420p{},", alpha_geq(&f)))
            .unwrap_or_default();
        if let Some(c) = &v.corners {
            // Corner pin: the picture is stretched to the frame, then mapped onto the quad
            // (sense=destination). Outside the quad the warp edge-extends, so a polygon
            // mask of the same quad supplies the alpha.
            let fps_f = fps as f64;
            let tv_p = format!("(in/{fps_f:.6})");
            let px = |i: usize, tv: &str| -> String {
                let dim = if i % 2 == 0 { w } else { h };
                let e = anim_expr(&component(&v.corners_anim, i), tv, v.start, c[i]);
                format!("({e})*{dim:.6}")
            };
            let mut persp = String::from("perspective=");
            for (i, name) in ["x0", "y0", "x1", "y1", "x2", "y2", "x3", "y3"]
                .iter()
                .enumerate()
            {
                let _ = write!(persp, "{name}={}:", q(&px(i, &tv_p)));
            }
            persp.push_str("sense=destination:eval=frame");
            // Polygon TL → TR → BR → BL in geq (X, Y, T).
            let pt = |i: usize| (px(2 * i, "T"), px(2 * i + 1, "T"));
            let order = [0usize, 1, 3, 2];
            let mut cross = Vec::new();
            for e in 0..4 {
                let (ax, ay) = pt(order[e]);
                let (bx, by) = pt(order[(e + 1) % 4]);
                cross.push(format!(
                    "(({bx})-({ax}))*(Y-({ay}))-(({by})-({ay}))*(X-({ax}))"
                ));
            }
            let all = |cmp: &str| {
                cross
                    .iter()
                    .map(|c| format!("{cmp}({c},0)"))
                    .collect::<Vec<_>>()
                    .join("*")
            };
            let poly = format!("255*max({},{})", all("gte"), all("lte"));
            let _ = write!(
                f,
                "{fg_source}{mask}scale={w}:{h}:flags=bicubic,format=yuv444p,{persp}[w{k}];color=c=black:s={w}x{h}:r={fps}:d={:.6},format=gray,geq=lum={},boxblur=luma_radius=1:luma_power=1[m{k}];[w{k}][m{k}]alphamerge,format=yuva420p{alpha},{shift}[l{k}];",
                len + v.hold_start + v.hold_end + 1.0,
                q(&poly)
            );
            layers.push((format!("l{k}"), "0".into(), "0".into(), false));
            for (i, (label, l, t, dynamic)) in layers.into_iter().enumerate() {
                let next = format!("b{k}_{i}");
                let eval = if dynamic { ":eval=frame" } else { "" };
                let _ = write!(
                    f,
                    "[{base}][{label}]overlay=x={l}:y={t}:eof_action=pass{eval}:{enable}[{next}];"
                );
                base = next;
            }
            base = post_item(&mut f, base, v, k, w as i64, h as i64, fps, plan.duration);
            continue;
        }
        if v.fit == "blur" {
            let (bw, bh, bl, bt) = placement("fill", sw, sh, w, h, 1.0, 0.0, 0.0);
            let _ = write!(
                f,
                "{fg_source}split=2[s{k}a][s{k}b];[s{k}a]scale={bw}:{bh},boxblur=24:2,format=yuva420p{alpha},{shift}[l{k}a];"
            );
            layers.push((format!("l{k}a"), bl.to_string(), bt.to_string(), false));
            fg_source = format!("[s{k}b]");
        }
        let fit = if v.fit == "fill" { "fill" } else { "fit" };
        if !animated {
            let (dw, dh, l, t) = placement(fit, sw, sh, w, h, v.scale, v.x, v.y);
            let _ = write!(
                f,
                "{fg_source}{mask}scale={dw}:{dh},format=yuva420p{alpha},{shift}[l{k}];"
            );
            layers.push((format!("l{k}"), l.to_string(), t.to_string(), false));
        } else {
            // Size at scale 1, then a per-frame scale factor S(t) (and rotation R(t)).
            let (bw, bh, _, _) = placement(fit, sw, sh, w, h, 1.0, 0.0, 0.0);
            let s_expr = format!(
                "({})*({})",
                anim_expr(scale_anim, "t", v.start, v.scale),
                anim_expr(&v.t_scale, "t", v.start, 1.0)
            );
            let rotated = !rot_anim.is_empty() || v.rotation.abs() > 1e-6;
            let chain = if rotated {
                // Render at the largest size first so zooming never upsamples twice.
                let smax =
                    (max_of(scale_anim, v.scale) * max_of(&v.t_scale, 1.0)).clamp(0.05, 10.0);
                let (pw, ph) = (even(bw as f64 * smax), even(bh as f64 * smax));
                let r_expr = anim_expr(rot_anim, "t", v.start, v.rotation);
                format!(
                    "scale={pw}:{ph},format=yuva420p,rotate=a={}:ow='hypot(iw,ih)':oh=ow:c=none,scale=w={}:h={}:eval=frame",
                    q(&format!("({r_expr})*PI/180")),
                    q(&format!("max(2,trunc(iw*({s_expr})/{smax:.6}/2)*2)")),
                    q(&format!("max(2,trunc(ih*({s_expr})/{smax:.6}/2)*2)"))
                )
            } else {
                format!(
                    "scale=w={}:h={}:eval=frame,format=yuva420p",
                    q(&format!("max(2,trunc({bw}*({s_expr})/2)*2)")),
                    q(&format!("max(2,trunc({bh}*({s_expr})/2)*2)"))
                )
            };
            let _ = write!(f, "{fg_source}{mask}{chain}{alpha},{shift}[l{k}];");
            let x_expr = format!(
                "({})+({})",
                anim_expr(x_anim, "t", 0.0, v.x),
                anim_expr(&v.t_x, "t", 0.0, 0.0)
            );
            let y_expr = anim_expr(y_anim, "t", 0.0, v.y);
            layers.push((
                format!("l{k}"),
                q(&format!("(W-w)/2+({x_expr})*W")),
                q(&format!("(H-h)/2+({y_expr})*H")),
                true,
            ));
        }
        for (i, (label, l, t, dynamic)) in layers.into_iter().enumerate() {
            let next = format!("b{k}_{i}");
            let eval = if dynamic { ":eval=frame" } else { "" };
            let _ = write!(
                f,
                "[{base}][{label}]overlay=x={l}:y={t}:eof_action=pass{eval}:{enable}[{next}];"
            );
            base = next;
        }
        base = post_item(&mut f, base, v, k, w as i64, h as i64, fps, plan.duration);
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
        if a.gain_anim.is_empty() {
            chain.push(format!("volume={:.6}", a.gain));
        } else {
            let g = anim_expr(&a.gain_anim, "t", a.start, 1.0);
            chain.push(format!(
                "volume={}:eval=frame",
                q(&format!("{:.6}*max(0,{g})", a.gain))
            ));
        }
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

pub(crate) fn encoder_args(
    tools: &Tools,
    opts: &ExportOptions,
    fps: i64,
) -> AppResult<Vec<String>> {
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
                    layer: 0.0,
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
                    ..Default::default()
                },
                PlanVideo {
                    clip_id: "c2".into(),
                    media_id: "logo".into(),
                    kind: "image".into(),
                    layer: 1.0,
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
                    ..Default::default()
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
                    ..Default::default()
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
                    ..Default::default()
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
    /// Renders a plan to `out` with libx264 (test helper); returns false when ffmpeg is missing.
    fn render_plan(
        p: &RenderPlan,
        src: &dyn Fn(&str) -> Option<Source>,
        out: &Path,
        secs: f64,
    ) -> bool {
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
            return false;
        };
        validate(p).unwrap();
        let g = build_graph(p, src).unwrap();
        let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        args.extend(g.inputs.clone());
        args.extend([
            "-filter_complex".into(),
            g.filter.clone(),
            "-map".into(),
            "[vout]".into(),
        ]);
        if g.filter.contains("[aout]") {
            args.extend(["-map".into(), "[aout]".into()]);
        }
        args.extend(
            [
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                "-r",
                &p.fps.to_string(),
                "-t",
                &format!("{secs}"),
            ]
            .iter()
            .map(|s| s.to_string()),
        );
        args.push(out.to_string_lossy().into_owned());
        let (ok, _, err) = run_tool(&ffmpeg, &args, Duration::from_secs(300)).unwrap();
        assert!(ok, "{err}\n{}", g.filter);
        true
    }

    fn gray_frame(file: &Path, t: f64) -> Vec<u8> {
        let ffmpeg = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|d| {
                d.join(if cfg!(windows) {
                    "ffmpeg.exe"
                } else {
                    "ffmpeg"
                })
            })
            .find(|f| f.is_file())
            .unwrap();
        let out = file.with_extension(format!("{}.gray", (t * 1000.0) as i64));
        let args: Vec<String> = [
            "-y",
            "-loglevel",
            "error",
            "-ss",
            &format!("{t}"),
            "-i",
            file.to_str().unwrap(),
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "gray",
            out.to_str().unwrap(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(run_tool(&ffmpeg, &args, Duration::from_secs(60)).unwrap().0);
        std::fs::read(out).unwrap()
    }

    fn white_png(dir: &Path, w: u32, h: u32) -> PathBuf {
        let ffmpeg = std::env::split_paths(&std::env::var_os("PATH").unwrap())
            .map(|d| {
                d.join(if cfg!(windows) {
                    "ffmpeg.exe"
                } else {
                    "ffmpeg"
                })
            })
            .find(|f| f.is_file())
            .unwrap();
        let file = dir.join(format!("white{w}x{h}.png"));
        let args: Vec<String> = [
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            &format!("color=c=white:s={w}x{h}:d=1"),
            "-frames:v",
            "1",
            file.to_str().unwrap(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(run_tool(&ffmpeg, &args, Duration::from_secs(60)).unwrap().0);
        file
    }

    fn image_item(media: &str, start: f64, end: f64) -> PlanVideo {
        PlanVideo {
            clip_id: media.into(),
            media_id: media.into(),
            kind: "image".into(),
            start,
            end,
            src_out: end - start,
            speed: 1.0,
            opacity: 1.0,
            fit: "fit".into(),
            scale: 1.0,
            ..Default::default()
        }
    }

    fn one_image_plan(w: i64, h: i64, item: PlanVideo) -> RenderPlan {
        RenderPlan {
            width: w,
            height: h,
            fps: 30,
            duration: item.end,
            background: "#000000".into(),
            video: vec![item],
            audio: vec![],
        }
    }

    #[test]
    fn corner_pins_an_image_exactly_in_a_real_render() {
        let dir = tempfile::tempdir().unwrap();
        let png = white_png(dir.path(), 200, 100);
        let (w, h) = (640i64, 360i64);
        let mut it = image_item("w", 0.0, 2.0);
        // Quad in frame fractions: TL, TR, BL, BR — a screen seen at an angle.
        let quad = [0.15, 0.14, 0.78, 0.22, 0.19, 0.83, 0.75, 0.69];
        it.corners = Some(quad.to_vec());
        // It slides right by 0.1 over the second second.
        let moved: Vec<f64> = quad
            .iter()
            .enumerate()
            .map(|(i, v)| if i % 2 == 0 { v + 0.1 } else { *v })
            .collect();
        it.corners_anim = vec![
            AnimVec {
                t: 1.0,
                v: quad.to_vec(),
                ease: "linear".into(),
            },
            AnimVec {
                t: 2.0,
                v: moved.clone(),
                ease: "linear".into(),
            },
        ];
        let p = one_image_plan(w, h, it);
        let src = |id: &str| {
            (id == "w").then(|| Source {
                path: png.clone(),
                width: 200.0,
                height: 100.0,
                has_audio: false,
            })
        };
        let out = dir.path().join("pin.mp4");
        if !render_plan(&p, &src, &out, 2.0) {
            return;
        }
        let px = |frame: &[u8], x: f64, y: f64| {
            frame[((y * h as f64) as usize).min(h as usize - 1) * w as usize
                + ((x * w as f64) as usize).min(w as usize - 1)]
        };
        let f0 = gray_frame(&out, 0.5);
        // Inside near each corner (3 % inwards along the diagonal) is white, outside is black.
        let cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4.0;
        let cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4.0;
        for i in 0..4 {
            let (x, y) = (quad[2 * i], quad[2 * i + 1]);
            let (ix, iy) = (x + (cx - x) * 0.06, y + (cy - y) * 0.06);
            let (ox, oy) = (x - (cx - x) * 0.06, y - (cy - y) * 0.06);
            assert!(
                px(&f0, ix, iy) > 200,
                "corner {i} inside {}",
                px(&f0, ix, iy)
            );
            assert!(
                px(&f0, ox, oy) < 40,
                "corner {i} outside {}",
                px(&f0, ox, oy)
            );
        }
        assert!(px(&f0, cx, cy) > 200);
        // At 1.5 s the quad has moved half way (+0.05): the old left edge is now black, the new one white.
        let f1 = gray_frame(&out, 1.5);
        assert!(
            px(&f1, quad[0] + 0.02, cy) < 40,
            "old left edge {}",
            px(&f1, quad[0] + 0.02, cy)
        );
        assert!(
            px(&f1, quad[0] + 0.05 + 0.03, cy) > 200,
            "new left edge {}",
            px(&f1, quad[0] + 0.08, cy)
        );
        assert!(
            px(&f1, quad[2] + 0.05 + 0.03, 0.4) < 40 || px(&f1, quad[2] + 0.05 - 0.03, 0.4) > 200
        );
    }

    #[test]
    fn masks_and_regions_render_as_expected() {
        let dir = tempfile::tempdir().unwrap();
        let png = white_png(dir.path(), 320, 180);
        let (w, h) = (640i64, 360i64);
        let mut it = image_item("w", 0.0, 1.0);
        it.mask = Mask {
            shape: "ellipse".into(),
            feather: 0.0,
            radius: 0.1,
        };
        it.regions = vec![
            PlanRegion {
                id: "r1".into(),
                kind: "color".into(),
                shape: "rect".into(),
                x: 0.4,
                y: 0.4,
                w: 0.2,
                h: 0.2,
                color: "#000000".into(),
                blur: 0.03,
                feather: 0.0,
                anim: vec![],
            },
            PlanRegion {
                id: "r2".into(),
                kind: "blur".into(),
                shape: "rect".into(),
                x: 0.0,
                y: 0.0,
                w: 0.3,
                h: 0.3,
                color: "#000000".into(),
                blur: 0.04,
                feather: 0.0,
                anim: vec![],
            },
        ];
        let p = one_image_plan(w, h, it);
        let src = |id: &str| {
            (id == "w").then(|| Source {
                path: png.clone(),
                width: 320.0,
                height: 180.0,
                has_audio: false,
            })
        };
        let out = dir.path().join("mask.mp4");
        if !render_plan(&p, &src, &out, 1.0) {
            return;
        }
        let f = gray_frame(&out, 0.5);
        let px = |x: usize, y: usize| f[y * w as usize + x];
        // Ellipse: the frame corners of the (full-frame) picture are transparent → black; the middle ring is white.
        assert!(px(4, 4) < 40, "corner {}", px(4, 4));
        assert!(px(320, 60) > 200, "top middle {}", px(320, 60));
        // Cover box at the centre is black.
        assert!(px(320, 180) < 20, "cover {}", px(320, 180));
        // Blur region in the top-left: the ellipse edge inside it is now soft (a mid grey exists).
        let soft = (0..108).any(|y| (0..192).any(|x| (60..200).contains(&px(x, y))));
        assert!(soft, "no soft pixel in the blurred region");
    }

    #[test]
    fn renders_4k_in_both_orientations() {
        let dir = tempfile::tempdir().unwrap();
        let png = white_png(dir.path(), 640, 360);
        for (w, h) in [(3840i64, 2160i64), (2160i64, 3840i64)] {
            let mut it = image_item("w", 0.0, 0.5);
            it.fit = "fill".into();
            let p = one_image_plan(w, h, it);
            let src = |id: &str| {
                (id == "w").then(|| Source {
                    path: png.clone(),
                    width: 640.0,
                    height: 360.0,
                    has_audio: false,
                })
            };
            let out = dir.path().join(format!("uhd-{w}x{h}.mp4"));
            if !render_plan(&p, &src, &out, 0.5) {
                return;
            }
            let ffprobe = std::env::split_paths(&std::env::var_os("PATH").unwrap())
                .map(|d| {
                    d.join(if cfg!(windows) {
                        "ffprobe.exe"
                    } else {
                        "ffprobe"
                    })
                })
                .find(|f| f.is_file())
                .unwrap();
            let tools = crate::editor::Tools {
                ffmpeg: ffprobe.with_file_name(if cfg!(windows) {
                    "ffmpeg.exe"
                } else {
                    "ffmpeg"
                }),
                ffprobe,
                version: String::new(),
                source: "path".into(),
                encoders: vec!["libx264".into()],
            };
            let r = verify(&tools, &out, &p).unwrap();
            assert_eq!((r.width, r.height), (w, h));
            let f = gray_frame(&out, 0.2);
            assert_eq!(f.len(), (w * h) as usize);
            assert!(f[(h / 2 * w + w / 2) as usize] > 200);
        }
    }

    #[test]
    fn animates_zoom_and_dips_in_a_real_render() {
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
        let dir = tempfile::tempdir().unwrap();
        let white = dir.path().join("white.png");
        let run = |a: Vec<String>| {
            let (ok, _, err) = run_tool(&ffmpeg, &a, Duration::from_secs(120)).unwrap();
            assert!(ok, "{err}");
        };
        let sv = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        run(sv(&[
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:s=320x180:d=1",
            "-frames:v",
            "1",
            white.to_str().unwrap(),
        ]));
        let k = |t: f64, v: f64| Anim {
            t,
            v,
            ease: "linear".into(),
        };
        let p = RenderPlan {
            width: 640,
            height: 360,
            fps: 30,
            duration: 4.0,
            background: "#000000".into(),
            video: vec![
                PlanVideo {
                    clip_id: "c1".into(),
                    media_id: "w".into(),
                    kind: "image".into(),
                    start: 0.0,
                    end: 4.0,
                    src_out: 4.0,
                    speed: 1.0,
                    opacity: 1.0,
                    fit: "fit".into(),
                    scale: 1.0,
                    anim: VideoAnim {
                        scale: Some(vec![k(0.0, 0.5), k(2.0, 1.0)]),
                        ..Default::default()
                    },
                    ..Default::default()
                },
                PlanVideo {
                    clip_id: "dip".into(),
                    media_id: String::new(),
                    kind: "color".into(),
                    color: "#000000".into(),
                    layer: 0.5,
                    start: 3.0,
                    end: 4.0,
                    src_out: 1.0,
                    speed: 1.0,
                    opacity: 1.0,
                    fit: "fit".into(),
                    scale: 1.0,
                    fades: vec![
                        Fade {
                            t0: 3.0,
                            t1: 3.5,
                            from: 0.0,
                            to: 1.0,
                        },
                        Fade {
                            t0: 3.5,
                            t1: 4.0,
                            from: 1.0,
                            to: 0.0,
                        },
                    ],
                    ..Default::default()
                },
            ],
            audio: vec![],
        };
        validate(&p).unwrap();
        let src = |id: &str| {
            (id == "w").then(|| Source {
                path: white.clone(),
                width: 320.0,
                height: 180.0,
                has_audio: false,
            })
        };
        let g = build_graph(&p, &src).unwrap();
        let out = dir.path().join("out.mp4");
        let mut args = sv(&["-hide_banner", "-nostdin", "-y", "-loglevel", "error"]);
        args.extend(g.inputs.clone());
        args.extend([
            "-filter_complex".into(),
            g.filter.clone(),
            "-map".into(),
            "[vout]".into(),
        ]);
        if g.filter.contains("[aout]") {
            args.extend(["-map".into(), "[aout]".into()]);
        }
        args.extend(sv(&[
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "30", "-t", "4",
        ]));
        args.push(out.to_string_lossy().into_owned());
        run(args);
        // Grab a grey frame and count white pixels on the middle row.
        let frame = |t: f64| {
            let f = dir.path().join(format!("f{}.gray", (t * 10.0) as i64));
            run(vec![
                "-y".into(),
                "-loglevel".into(),
                "error".into(),
                "-ss".into(),
                format!("{t}"),
                "-i".into(),
                out.to_string_lossy().into_owned(),
                "-frames:v".into(),
                "1".into(),
                "-f".into(),
                "rawvideo".into(),
                "-pix_fmt".into(),
                "gray".into(),
                f.to_string_lossy().into_owned(),
            ]);
            std::fs::read(f).unwrap()
        };
        let row_white = |t: f64| {
            frame(t)[180 * 640..181 * 640]
                .iter()
                .filter(|&&b| b > 128)
                .count() as f64
        };
        let mean = |t: f64| {
            let b = frame(t);
            b.iter().map(|&x| x as f64).sum::<f64>() / b.len() as f64
        };
        let (w0, w1, w2) = (row_white(0.0), row_white(1.0), row_white(2.5));
        assert!((w0 - 320.0).abs() < 12.0, "t=0 width {w0}");
        assert!((w1 - 480.0).abs() < 12.0, "t=1 width {w1}");
        assert!((w2 - 640.0).abs() < 12.0, "t=2.5 width {w2}");
        let (m25, m35) = (mean(2.5), mean(3.5));
        assert!(m25 > 200.0 && m35 < 40.0, "dip {m25} -> {m35}");
    }

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
