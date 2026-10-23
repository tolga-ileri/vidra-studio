//! Smart Reframe analysis: finds and follows the main subject of a video,
//! fully offline. Faces are detected with the SeetaFace cascade (rustface,
//! BSD-2; model vendored in `models/`), with a motion-energy fallback when no
//! face is visible. Frames are decoded by FFmpeg at a low rate and size, so a
//! minute of video takes a few seconds. Nothing leaves the computer.

use crate::core::Core;
use crate::editor::{require_tools, run_tool};
use crate::error::{AppError, AppResult};
use rustface::{Detector, ImageData};
use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;

static MODEL: &[u8] = include_bytes!("../models/seeta_fd_frontal_v1.0.bin");

/// Analysis width in pixels (frames are downscaled for speed).
const WIDTH: u32 = 480;
/// Frames analyzed per second of video.
const RATE: f64 = 5.0;
/// Longest range analyzed in one call.
const MAX_SPAN: f64 = 20.0 * 60.0;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub t: f64,
    pub cx: f64,
    pub cy: f64,
    pub w: f64,
    pub h: f64,
    pub conf: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Subject {
    pub id: String,
    pub coverage: f64,
    pub size: f64,
    pub samples: Vec<Sample>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Analysis {
    /// "face" | "motion" | "none"
    pub method: String,
    pub fps: f64,
    pub from: f64,
    pub to: f64,
    pub frames: usize,
    pub subjects: Vec<Subject>,
    pub warnings: Vec<String>,
}

/// One detector per process (loading the cascade takes a moment).
fn detector() -> &'static Mutex<Box<dyn Detector + Send>> {
    static D: std::sync::OnceLock<Mutex<Box<dyn Detector + Send>>> = std::sync::OnceLock::new();
    D.get_or_init(|| {
        let model = rustface::model::read_model(MODEL).expect("bundled face model");
        let mut d: Box<dyn Detector + Send> =
            Box::new(SendDetector(rustface::create_detector_with_model(model)));
        d.set_min_face_size(20);
        d.set_score_thresh(2.0);
        d.set_pyramid_scale_factor(0.8);
        d.set_slide_window_step(4, 4);
        Mutex::new(d)
    })
}

/// rustface's detector holds no thread-bound state; it is only used behind a mutex.
struct SendDetector(Box<dyn Detector>);
unsafe impl Send for SendDetector {}
impl Detector for SendDetector {
    fn detect(&mut self, image: &ImageData) -> Vec<rustface::FaceInfo> {
        self.0.detect(image)
    }
    fn set_window_size(&mut self, wnd_size: u32) {
        self.0.set_window_size(wnd_size)
    }
    fn set_slide_window_step(&mut self, step_x: u32, step_y: u32) {
        self.0.set_slide_window_step(step_x, step_y)
    }
    fn set_min_face_size(&mut self, min_face_size: u32) {
        self.0.set_min_face_size(min_face_size)
    }
    fn set_max_face_size(&mut self, max_face_size: u32) {
        self.0.set_max_face_size(max_face_size)
    }
    fn set_pyramid_scale_factor(&mut self, scale_factor: f32) {
        self.0.set_pyramid_scale_factor(scale_factor)
    }
    fn set_score_thresh(&mut self, thresh: f64) {
        self.0.set_score_thresh(thresh)
    }
}

/// A detection in frame fractions.
#[derive(Debug, Clone, Copy)]
struct Det {
    cx: f64,
    cy: f64,
    w: f64,
    h: f64,
    conf: f64,
}

/// Faces in a grey frame (fractions of the frame).
pub fn faces(gray: &[u8], w: u32, h: u32) -> Vec<(f64, f64, f64, f64, f64)> {
    let img = ImageData::new(gray, w, h);
    let mut d = detector().lock().unwrap_or_else(|p| p.into_inner());
    d.detect(&img)
        .into_iter()
        .map(|f| {
            let b = f.bbox();
            (
                (b.x() as f64 + b.width() as f64 / 2.0) / w as f64,
                (b.y() as f64 + b.height() as f64 / 2.0) / h as f64,
                b.width() as f64 / w as f64,
                b.height() as f64 / h as f64,
                f.score(),
            )
        })
        .collect()
}

/// Centre and extent of the pixels that changed since the previous frame, if enough did.
fn motion(prev: &[u8], cur: &[u8], w: usize, h: usize) -> Option<Det> {
    let (mut n, mut sx, mut sy) = (0u64, 0u64, 0u64);
    let (mut minx, mut miny, mut maxx, mut maxy) = (w, h, 0usize, 0usize);
    // 2×2 blocks keep sensor noise out.
    for y in (0..h.saturating_sub(1)).step_by(2) {
        for x in (0..w.saturating_sub(1)).step_by(2) {
            let i = y * w + x;
            let d = (prev[i] as i32 - cur[i] as i32).abs()
                + (prev[i + 1] as i32 - cur[i + 1] as i32).abs()
                + (prev[i + w] as i32 - cur[i + w] as i32).abs()
                + (prev[i + w + 1] as i32 - cur[i + w + 1] as i32).abs();
            if d > 4 * 28 {
                n += 1;
                sx += x as u64;
                sy += y as u64;
                minx = minx.min(x);
                miny = miny.min(y);
                maxx = maxx.max(x);
                maxy = maxy.max(y);
            }
        }
    }
    let blocks = ((w / 2) * (h / 2)) as u64;
    // Under 0.3 % of the picture moving is noise; over 60 % is a camera move or a cut.
    if n < blocks * 3 / 1000 || n > blocks * 6 / 10 {
        return None;
    }
    Some(Det {
        cx: sx as f64 / n as f64 / w as f64,
        cy: sy as f64 / n as f64 / h as f64,
        w: ((maxx - minx) as f64 / w as f64).clamp(0.02, 1.0),
        h: ((maxy - miny) as f64 / h as f64).clamp(0.02, 1.0),
        conf: (n as f64 / blocks as f64 * 20.0).min(1.0),
    })
}

struct Track {
    samples: Vec<Sample>,
    last: Det,
    last_t: f64,
    sum_size: f64,
}

/// Associates detections to tracks by nearest centre, frame after frame.
fn track(frames: &[(f64, Vec<Det>)], max_gap: f64) -> Vec<Track> {
    let mut tracks: Vec<Track> = Vec::new();
    for (t, dets) in frames {
        let mut taken = vec![false; tracks.len()];
        for d in dets {
            let mut best: Option<(usize, f64)> = None;
            for (i, tr) in tracks.iter().enumerate() {
                // Tracks started in this frame (beyond `taken`) are not candidates.
                if taken.get(i).copied().unwrap_or(true) || *t - tr.last_t > max_gap {
                    continue;
                }
                let reach = 0.08 + tr.last.w.max(d.w);
                let dist = ((tr.last.cx - d.cx).powi(2) + (tr.last.cy - d.cy).powi(2)).sqrt();
                if dist < reach && best.map_or(true, |(_, b)| dist < b) {
                    best = Some((i, dist));
                }
            }
            let s = Sample {
                t: *t,
                cx: d.cx,
                cy: d.cy,
                w: d.w,
                h: d.h,
                conf: d.conf,
            };
            match best {
                Some((i, _)) => {
                    taken[i] = true;
                    let tr = &mut tracks[i];
                    tr.samples.push(s);
                    tr.last = *d;
                    tr.last_t = *t;
                    tr.sum_size += d.w * d.h;
                }
                None => tracks.push(Track {
                    samples: vec![s],
                    last: *d,
                    last_t: *t,
                    sum_size: d.w * d.h,
                }),
            }
        }
    }
    tracks
}

/// Grey frames of `path` between `from` and `to`, at RATE fps and WIDTH px wide.
fn decode(
    core: &Core,
    path: &std::path::Path,
    src_w: i64,
    src_h: i64,
    from: f64,
    to: f64,
) -> AppResult<(Vec<Vec<u8>>, u32, u32)> {
    let tools = require_tools(core)?;
    let w = WIDTH;
    let h =
        (((src_h.max(1) as f64 * w as f64 / src_w.max(1) as f64) / 2.0).round() as u32 * 2).max(2);
    let args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "error".into(),
        "-nostdin".into(),
        "-ss".into(),
        format!("{from:.3}"),
        "-t".into(),
        format!("{:.3}", to - from),
        "-i".into(),
        path.to_string_lossy().into_owned(),
        "-an".into(),
        "-sn".into(),
        "-vf".into(),
        format!("fps={RATE},scale={w}:{h}:flags=area,format=gray"),
        "-f".into(),
        "rawvideo".into(),
        "-".into(),
    ];
    let (ok, out, err) = run_tool(&tools.ffmpeg, &args, Duration::from_secs(600))?;
    if !ok {
        return Err(AppError::invalid(format!(
            "The video could not be read for analysis. {}",
            err.lines().last().unwrap_or("")
        )));
    }
    let n = (w * h) as usize;
    let frames = out.chunks_exact(n).map(|c| c.to_vec()).collect();
    Ok((frames, w, h))
}

/// Analyzes one media file's source range and returns the subjects found.
pub fn analyze(
    core: &Core,
    project_id: &str,
    media_id: &str,
    from: f64,
    to: f64,
) -> AppResult<Analysis> {
    let (path, info) = core.editor.media_path(project_id, media_id)?;
    if info.kind != "video" {
        return Err(AppError::invalid(
            "Only video clips can be reframed automatically.",
        ));
    }
    let from = from.max(0.0);
    let to = to
        .min(from + MAX_SPAN)
        .min(info.duration_sec.unwrap_or(f64::MAX));
    if to - from < 0.2 {
        return Err(AppError::invalid("The clip is too short to analyze."));
    }
    let (frames, w, h) = decode(
        core,
        &path,
        info.width.unwrap_or(16),
        info.height.unwrap_or(9),
        from,
        to,
    )?;
    Ok(analyze_frames(&frames, w, h, from))
}

/// The pure part: detections → tracks → ranked subjects (unit tested).
pub fn analyze_frames(frames: &[Vec<u8>], w: u32, h: u32, from: f64) -> Analysis {
    let mut warnings = Vec::new();
    let step = 1.0 / RATE;
    let mut face_frames: Vec<(f64, Vec<Det>)> = Vec::new();
    let mut motion_frames: Vec<(f64, Vec<Det>)> = Vec::new();
    let mut prev: Option<&Vec<u8>> = None;
    for (i, f) in frames.iter().enumerate() {
        let t = from + i as f64 * step;
        let dets: Vec<Det> = faces(f, w, h)
            .into_iter()
            .map(|(cx, cy, fw, fh, score)| Det {
                cx,
                cy,
                w: fw,
                h: fh,
                conf: (score / 10.0).clamp(0.0, 1.0),
            })
            .collect();
        face_frames.push((t, dets));
        if let Some(p) = prev {
            if let Some(m) = motion(p, f, w as usize, h as usize) {
                motion_frames.push((t, vec![m]));
            }
        }
        prev = Some(f);
    }
    let n = frames.len().max(1) as f64;
    let rank = |tracks: Vec<Track>, prefix: &str| -> Vec<Subject> {
        let mut subs: Vec<Subject> = tracks
            .into_iter()
            .filter(|tr| tr.samples.len() >= 3)
            .map(|tr| Subject {
                id: String::new(),
                coverage: (tr.samples.len() as f64 / n).min(1.0),
                size: tr.sum_size / tr.samples.len() as f64,
                samples: tr.samples,
            })
            .collect();
        subs.sort_by(|a, b| {
            (b.coverage * b.size.sqrt())
                .partial_cmp(&(a.coverage * a.size.sqrt()))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        subs.truncate(5);
        for (i, s) in subs.iter_mut().enumerate() {
            s.id = format!("{prefix}{}", i + 1);
        }
        subs
    };
    let face_subjects = rank(track(&face_frames, 1.5), "face");
    let best_face = face_subjects.first().map(|s| s.coverage).unwrap_or(0.0);
    if best_face >= 0.3 {
        if best_face < 0.8 {
            warnings.push("The face is not visible in every frame; check the result.".into());
        }
        return Analysis {
            method: "face".into(),
            fps: RATE,
            from,
            to: from + frames.len() as f64 * step,
            frames: frames.len(),
            subjects: face_subjects,
            warnings,
        };
    }
    // Motion fallback: one moving thing, tracked as a single subject.
    let motion_subjects = rank(track(&motion_frames, 1.0), "motion");
    let best_motion = motion_subjects.first().map(|s| s.coverage).unwrap_or(0.0);
    if best_motion >= 0.3 {
        warnings.push("No face was found; the crop follows the moving area instead.".into());
        return Analysis {
            method: "motion".into(),
            fps: RATE,
            from,
            to: from + frames.len() as f64 * step,
            frames: frames.len(),
            subjects: motion_subjects,
            warnings,
        };
    }
    warnings.push(
        "No subject could be tracked. Choose a focus point or a blurred background instead.".into(),
    );
    Analysis {
        method: "none".into(),
        fps: RATE,
        from,
        to: from + frames.len() as f64 * step,
        frames: frames.len(),
        subjects: vec![],
        warnings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rustface ships a group photo in its crate; use it when it is in the cargo cache.
    fn sample_photo() -> Option<(Vec<u8>, u32, u32)> {
        let home = std::env::var_os("CARGO_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE").map(|h| std::path::PathBuf::from(h).join(".cargo"))
            })?;
        let src = home.join("registry").join("src");
        let dir = std::fs::read_dir(src).ok()?.flatten().find_map(|e| {
            let p = e.path().join("rustface-0.1.7").join("test.png");
            p.is_file().then_some(p)
        })?;
        let img = image::open(dir).ok()?.to_luma8();
        let (w, h) = img.dimensions();
        Some((img.into_raw(), w, h))
    }

    #[test]
    fn finds_faces_in_a_real_photo() {
        let Some((gray, w, h)) = sample_photo() else {
            eprintln!("sample photo not in the cargo cache; skipping");
            return;
        };
        // Downscale with area averaging to 1000 px (the 1927 group photo has ~30 faces of ~30 px then).
        let img = image::GrayImage::from_raw(w, h, gray).unwrap();
        let (sw, sh) = (1000u32, 1000 * h / w);
        let small =
            image::imageops::resize(&img, sw, sh, image::imageops::FilterType::Triangle).into_raw();
        let f = faces(&small, sw, sh);
        assert!(f.len() >= 10, "expected many faces, found {}", f.len());
        for (cx, cy, fw, fh, _) in &f {
            assert!((0.0..=1.0).contains(cx) && (0.0..=1.0).contains(cy) && *fw > 0.0 && *fh > 0.0);
        }
    }

    #[test]
    fn tracks_a_moving_bright_square_by_motion() {
        // A 40×40 square moving left → right over 3 s at 5 fps on a dark frame.
        let (w, h) = (320usize, 180usize);
        let mut frames = Vec::new();
        for i in 0..15 {
            let mut f = vec![10u8; w * h];
            let x0 = 20 + i * 16;
            for y in 70..110 {
                for x in x0..x0 + 40 {
                    f[y * w + x] = 230;
                }
            }
            frames.push(f);
        }
        let a = analyze_frames(&frames, w as u32, h as u32, 2.0);
        assert_eq!(a.method, "motion");
        let s = &a.subjects[0];
        assert!(s.coverage > 0.8, "coverage {}", s.coverage);
        let first = s.samples.first().unwrap();
        let last = s.samples.last().unwrap();
        assert!(last.cx > first.cx + 0.4, "{} -> {}", first.cx, last.cx);
        assert!((first.t - 2.2).abs() < 1e-6);
        assert!((s.samples[0].cy - 0.5).abs() < 0.05);
    }

    /// End to end through the registry and FFmpeg (the same path the command uses).
    #[test]
    fn analyzes_a_real_file_through_the_core() {
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
        let e = crate::core::testing::env();
        let file = e.dir.path().join("walk.mp4");
        let args: Vec<String> = [
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x303030:s=640x360:r=30:d=4",
            "-f",
            "lavfi",
            "-i",
            "color=c=white:s=60x150:r=30:d=4",
            "-filter_complex",
            "[0:v][1:v]overlay=x='40+500*t/4':y=100:eval=frame,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            file.to_str().unwrap(),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert!(run_tool(&ffmpeg, &args, Duration::from_secs(60)).unwrap().0);
        crate::editor::begin(&e.core, "prj_1").unwrap();
        let info = crate::editor::MediaInfo {
            id: "med_1".into(),
            kind: "video".into(),
            name: "walk.mp4".into(),
            path: file.to_string_lossy().into_owned(),
            duration_sec: Some(4.0),
            width: Some(640),
            height: Some(360),
            fps: Some(30.0),
            has_audio: false,
            has_video: true,
            size_bytes: 1,
            available: true,
        };
        e.core.editor.register("prj_1", std::slice::from_ref(&info));
        let a = analyze(&e.core, "prj_1", "med_1", 0.0, 4.0).unwrap();
        assert_eq!(a.method, "motion", "{a:?}");
        assert!(a.subjects[0].coverage > 0.7);
    }

    #[test]
    fn reports_failure_honestly_on_a_static_scene() {
        let frames = vec![vec![40u8; 320 * 180]; 10];
        let a = analyze_frames(&frames, 320, 180, 0.0);
        assert_eq!(a.method, "none");
        assert!(a.subjects.is_empty());
        assert!(!a.warnings.is_empty());
    }

    #[test]
    fn associates_detections_into_separate_tracks() {
        let d = |cx: f64| Det {
            cx,
            cy: 0.5,
            w: 0.1,
            h: 0.1,
            conf: 1.0,
        };
        let frames: Vec<(f64, Vec<Det>)> = (0..10)
            .map(|i| {
                (
                    i as f64 * 0.2,
                    vec![d(0.2 + i as f64 * 0.01), d(0.8 - i as f64 * 0.01)],
                )
            })
            .collect();
        let tr = track(&frames, 1.0);
        assert_eq!(tr.len(), 2);
        assert!(tr.iter().all(|t| t.samples.len() == 10));
    }
}
