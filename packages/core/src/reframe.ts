import { clipEnd, clipValueAt, kfSource, placement, updateClip, type Clip, type EditorProject, type Keyframe, type Keyframes } from "./editor"

/**
 * Smart Reframe: turns a subject track (from the native analyzer) into
 * smooth position keyframes that keep the subject inside a frame of another
 * aspect ratio. Everything here is pure, so it is unit tested; the detector
 * lives in Rust (editor_reframe.rs).
 */

/** One detection, in fractions of the source picture (center and size). */
export interface Sample {
  t: number
  cx: number
  cy: number
  w: number
  h: number
  conf: number
}

export interface Subject {
  id: string
  /** Fraction of analyzed frames in which the subject was seen. */
  coverage: number
  /** Mean size as a fraction of the source. */
  size: number
  samples: Sample[]
}

export interface Analysis {
  method: "face" | "motion" | "none"
  /** Analysis sample rate. */
  fps: number
  /** Source time range analyzed. */
  from: number
  to: number
  frames: number
  subjects: Subject[]
  warnings: string[]
}

export interface ReframeOptions {
  /** Smoothing window in seconds (Gaussian sigma). */
  sigma?: number
  /** Dead zone as a fraction of the frame: the crop only moves when the subject drifts further than this. */
  deadZone?: number
  /** Minimum keyframe spacing in seconds after simplification. */
  minGap?: number
  /** Maximum position error (frame fraction) when simplifying. */
  tolerance?: number
}

const DEFAULTS: Required<ReframeOptions> = { sigma: 0.5, deadZone: 0.02, minGap: 0.1, tolerance: 0.004 }

/** Fills gaps by linear interpolation and resamples at a fixed step. */
export function resample(samples: Sample[], from: number, to: number, step: number): { t: number; cx: number; cy: number }[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t)
  const out: { t: number; cx: number; cy: number }[] = []
  if (!sorted.length) return out
  let i = 0
  for (let t = from; t <= to + 1e-9; t += step) {
    while (i < sorted.length - 1 && (sorted[i + 1]?.t ?? Infinity) <= t) i++
    const a = sorted[i]
    const b = sorted[i + 1]
    if (!a) break
    if (!b || t <= a.t) out.push({ t, cx: a.cx, cy: a.cy })
    else {
      const u = Math.min(1, Math.max(0, (t - a.t) / Math.max(1e-6, b.t - a.t)))
      out.push({ t, cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u })
    }
  }
  return out
}

/** Gaussian smoothing (sigma in samples). */
export function smooth(values: number[], sigma: number): number[] {
  if (sigma <= 0 || values.length < 3) return [...values]
  const r = Math.ceil(sigma * 3)
  const k: number[] = []
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)))
  return values.map((_, i) => {
    let s = 0
    let w = 0
    for (let j = -r; j <= r; j++) {
      const v = values[Math.min(values.length - 1, Math.max(0, i + j))]
      const kw = k[j + r] ?? 0
      if (v === undefined) continue
      s += v * kw
      w += kw
    }
    return w ? s / w : (values[i] ?? 0)
  })
}

/** Applies a dead zone: the output only follows the input once it drifts further than `zone`. */
export function deadZone(values: number[], zone: number): number[] {
  let cur = values[0] ?? 0
  return values.map((v) => {
    if (v > cur + zone) cur = v - zone
    else if (v < cur - zone) cur = v + zone
    return cur
  })
}

/** Ramer–Douglas–Peucker on (t, v) points. */
export function simplify(points: { t: number; v: number }[], tolerance: number): { t: number; v: number }[] {
  if (points.length <= 2) return points
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return points
  let maxD = 0
  let idx = 0
  for (let i = 1; i < points.length - 1; i++) {
    const pt = points[i]
    if (!pt) continue
    const u = (pt.t - first.t) / Math.max(1e-9, last.t - first.t)
    const d = Math.abs(pt.v - (first.v + (last.v - first.v) * u))
    if (d > maxD) {
      maxD = d
      idx = i
    }
  }
  if (maxD <= tolerance) return [first, last]
  return [...simplify(points.slice(0, idx + 1), tolerance).slice(0, -1), ...simplify(points.slice(idx), tolerance)]
}

/** Mean absolute frame-to-frame change: a jitter measure (lower is smoother). */
export function jitter(values: number[]): number {
  if (values.length < 2) return 0
  let s = 0
  for (let i = 1; i < values.length; i++) s += Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0))
  return s / (values.length - 1)
}

export interface Frame {
  W: number
  H: number
  sw: number
  sh: number
}

/**
 * Position (x, y as frame fractions) that puts source point (cx, cy) at the
 * frame center for a "fill" placement, clamped so the picture always covers the frame.
 */
export function focusOffset(cx: number, cy: number, frame: Frame, scale = 1): { x: number; y: number } {
  const q = placement("fill", frame.sw, frame.sh, frame.W, frame.H, scale)
  const limX = Math.max(0, (q.w - frame.W) / 2 / frame.W)
  const limY = Math.max(0, (q.h - frame.H) / 2 / frame.H)
  const x = ((0.5 - cx) * q.w) / frame.W
  const y = ((0.5 - cy) * q.h) / frame.H
  return { x: Math.min(limX, Math.max(-limX, x)), y: Math.min(limY, Math.max(-limY, y)) }
}

/** True when the source already has the frame's aspect ratio (no reframing needed). */
export function sameAspect(frame: Frame, tol = 0.02): boolean {
  return Math.abs(frame.sw / frame.sh - frame.W / frame.H) < tol
}

/**
 * Smooth, simplified x/y keyframes (source time) that follow a subject.
 * Returns the per-sample path too, so the UI and tests can judge the motion.
 */
export function reframeKeyframes(
  clip: Clip,
  subject: Subject,
  frame: Frame,
  opts: ReframeOptions = {}
): { x: Keyframe[]; y: Keyframe[]; path: { t: number; x: number; y: number }[] } {
  const o = { ...DEFAULTS, ...opts }
  const step = 1 / 10
  const from = clip.in
  const to = clip.out
  const rs = resample(subject.samples, from, to, step)
  if (!rs.length) return { x: [], y: [], path: [] }
  const sig = o.sigma / step
  const scale = clipValueAt(clip, "scale", clip.start)
  // The dead zone is a fraction of the output frame; convert it to source fractions.
  const q = placement("fill", frame.sw, frame.sh, frame.W, frame.H, scale)
  const cx = deadZone(smooth(rs.map((r) => r.cx), sig), (o.deadZone * frame.W) / q.w)
  const cy = deadZone(smooth(rs.map((r) => r.cy), sig), (o.deadZone * frame.H) / q.h)
  const path = rs.map((r, i) => {
    const off = focusOffset(cx[i] ?? 0.5, cy[i] ?? 0.5, frame, scale)
    return { t: r.t, x: off.x, y: off.y }
  })
  const toKf = (pts: { t: number; v: number }[]): Keyframe[] => {
    const simp = simplify(pts, o.tolerance)
    const out: Keyframe[] = []
    for (const pt of simp) {
      const last = out[out.length - 1]
      if (last && pt.t - last.s < o.minGap && pt !== simp[simp.length - 1]) continue
      out.push({ s: pt.t, v: Math.round(pt.v * 10000) / 10000, ease: "linear" })
    }
    return out
  }
  return { x: toKf(path.map((q) => ({ t: q.t, v: q.x }))), y: toKf(path.map((q) => ({ t: q.t, v: q.y }))), path }
}

/** Writes the reframe as fill + x/y keyframes on the clip. */
export function applyReframe(p: EditorProject, clipId: string, subject: Subject, frame: Frame, analysis: Pick<Analysis, "method">, opts?: ReframeOptions): EditorProject {
  const c = p.clips.find((q) => q.id === clipId)
  if (!c) return p
  const { x, y } = reframeKeyframes(c, subject, frame, opts)
  if (!x.length) return p
  const keyframes: Keyframes = { ...c.keyframes, x, y }
  const status = subject.coverage >= 0.8 ? "ok" : subject.coverage >= 0.4 ? "weak" : "failed"
  return updateClip(p, clipId, { fit: "fill", keyframes, reframe: { mode: "auto", subject: subject.id, status, method: analysis.method } })
}

/** Manual focus point (source fractions): a static fill position. */
export function applyFocus(p: EditorProject, clipId: string, cx: number, cy: number, frame: Frame): EditorProject {
  const c = p.clips.find((q) => q.id === clipId)
  if (!c) return p
  const { x, y } = focusOffset(cx, cy, frame, c.scale)
  const keyframes: Keyframes = { ...c.keyframes }
  delete keyframes.x
  delete keyframes.y
  return updateClip(p, clipId, { fit: "fill", x, y, keyframes, reframe: { ...c.reframe, mode: "manual" } })
}

/** Blurred-background fallback: the whole picture fits, over a blurred fill. */
export function applyBlurFallback(p: EditorProject, clipId: string): EditorProject {
  const c = p.clips.find((q) => q.id === clipId)
  if (!c) return p
  const keyframes: Keyframes = { ...c.keyframes }
  delete keyframes.x
  delete keyframes.y
  return updateClip(p, clipId, { fit: "blur", x: 0, y: 0, keyframes, reframe: { ...c.reframe, mode: "blur" } })
}

export function clearReframe(p: EditorProject, clipId: string): EditorProject {
  const c = p.clips.find((q) => q.id === clipId)
  if (!c) return p
  const keyframes: Keyframes = { ...c.keyframes }
  delete keyframes.x
  delete keyframes.y
  return updateClip(p, clipId, { fit: "fit", x: 0, y: 0, keyframes, reframe: { mode: "off", subject: null, status: null, method: null } })
}

/** Source time range a clip shows (for the analyzer). */
export const clipSourceRange = (c: Clip) => ({ from: c.in, to: c.out, span: clipEnd(c) - c.start, s: (t: number) => kfSource(c, t) })

/* ── Homography (corner pin preview) ─────────────────────────────────── */

/** Solves the 3×3 homography mapping four source points to four destination points. */
export function homography(src: [number, number][], dst: [number, number][]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i] ?? [0, 0]
    const [u, v] = dst[i] ?? [0, 0]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const h = solve(A, b)
  return [...h, 1]
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i] ?? 0])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]?.[c] ?? 0) > Math.abs(M[piv]?.[c] ?? 0)) piv = r
    const rowP = M[piv]
    const rowC = M[c]
    if (!rowP || !rowC) continue
    M[piv] = rowC
    M[c] = rowP
    const d = rowP[c] ?? 1
    if (Math.abs(d) < 1e-12) continue
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const row = M[r]
      if (!row) continue
      const f = (row[c] ?? 0) / d
      for (let k = c; k <= n; k++) row[k] = (row[k] ?? 0) - f * (rowP[k] ?? 0)
    }
  }
  return M.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1))
}

/** CSS matrix3d() that maps an element of size (w, h) at origin 0,0 onto the quad (pixels). */
export function cornerPinCss(w: number, h: number, quad: number[]): string {
  const dst: [number, number][] = [
    [quad[0] ?? 0, quad[1] ?? 0],
    [quad[2] ?? w, quad[3] ?? 0],
    [quad[4] ?? 0, quad[5] ?? h],
    [quad[6] ?? w, quad[7] ?? h],
  ]
  const H = homography(
    [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ],
    dst
  )
  const [a, b, c, d, e, f, g, i] = H
  // Column-major 4×4 from the 3×3 homography (z row/column identity).
  const m = [a, d, 0, g, b, e, 0, i, 0, 0, 1, 0, c, f, 0, 1].map((v) => Number((v ?? 0).toFixed(6)))
  return `matrix3d(${m.join(",")})`
}

/** Applies the homography to a point. */
export function project(H: number[], x: number, y: number): [number, number] {
  const [a = 1, b = 0, c = 0, d = 0, e = 1, f = 0, g = 0, i = 0] = H
  const w = g * x + i * y + 1
  return [(a * x + b * y + c) / w, (d * x + e * y + f) / w]
}
