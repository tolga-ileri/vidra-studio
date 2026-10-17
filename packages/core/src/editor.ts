import { z } from "zod"

/**
 * Video Editor core: the versioned project schema, pure (immutable) timeline
 * operations, and the render plan that drives BOTH the live preview and the
 * FFmpeg export, so what you see is what you export.
 *
 * Times are seconds (floats). A clip occupies [start, start + duration) on the
 * timeline, where duration = (out - in) / speed. Source files are never
 * modified: clips only reference media by id with in/out points.
 */

export const EDITOR_FORMAT = "vidra.editor"
export const EDITOR_FORMAT_VERSION = 1

export const ASPECTS = ["16:9", "9:16", "1:1", "4:5", "custom"] as const
export type Aspect = (typeof ASPECTS)[number]
export const FIT_MODES = ["fit", "fill", "blur"] as const
export type FitMode = (typeof FIT_MODES)[number]
export const EXPORT_PRESETS = ["720p", "1080p", "1440p", "2160p"] as const
export type ExportPreset = (typeof EXPORT_PRESETS)[number]

/** Shortest clip the editor allows (one frame at 60 fps, rounded up). */
export const MIN_CLIP = 0.05
/** Default length of a still image placed on the timeline. */
export const IMAGE_DEFAULT_SEC = 5

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const sec = z.number().finite().min(0).max(24 * 3600)

export const editorMediaSchema = z.object({
  id,
  kind: z.enum(["video", "audio", "image"]),
  name: z.string().min(1).max(260),
  /** Absolute path on this computer (display + preview only; native side owns it). */
  path: z.string().max(4096),
  durationSec: sec.nullable(),
  width: z.number().int().min(1).max(16384).nullable(),
  height: z.number().int().min(1).max(16384).nullable(),
  fps: z.number().positive().max(1000).nullable(),
  hasAudio: z.boolean(),
  hasVideo: z.boolean(),
  sizeBytes: z.number().int().min(0),
  /** False when the file was not found at `path` when the project opened. */
  available: z.boolean().default(true),
})
export type EditorMedia = z.infer<typeof editorMediaSchema>

export const trackSchema = z.object({
  id,
  kind: z.enum(["video", "audio"]),
  name: z.string().min(1).max(60),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
  locked: z.boolean().default(false),
  /** Track gain multiplier (audio tracks; also applies to video-clip audio on the track). */
  volume: z.number().min(0).max(4).default(1),
})
export type Track = z.infer<typeof trackSchema>

export const clipSchema = z.object({
  id,
  trackId: id,
  mediaId: id,
  start: sec,
  in: sec,
  out: sec,
  speed: z.number().min(0.25).max(4).default(1),
  volume: z.number().min(0).max(4).default(1),
  muted: z.boolean().default(false),
  fadeIn: z.number().min(0).max(60).default(0),
  fadeOut: z.number().min(0).max(60).default(0),
  opacity: z.number().min(0).max(1).default(1),
  fit: z.enum(FIT_MODES).default("fit"),
  /** Offset from the frame center as a fraction of the frame size. */
  x: z.number().min(-2).max(2).default(0),
  y: z.number().min(-2).max(2).default(0),
  /** Size relative to the fitted size. */
  scale: z.number().min(0.05).max(10).default(1),
})
export type Clip = z.infer<typeof clipSchema>

export const projectSettingsSchema = z.object({
  aspect: z.enum(ASPECTS),
  width: z.number().int().min(16).max(7680).refine((n) => n % 2 === 0, "width must be even"),
  height: z.number().int().min(16).max(7680).refine((n) => n % 2 === 0, "height must be even"),
  fps: z.number().int().min(1).max(120),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
})
export type ProjectSettings = z.infer<typeof projectSettingsSchema>

export const editorProjectSchema = z
  .object({
    format: z.literal(EDITOR_FORMAT),
    formatVersion: z.literal(EDITOR_FORMAT_VERSION),
    id,
    name: z.string().min(1).max(120),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    settings: projectSettingsSchema,
    media: z.array(editorMediaSchema).max(2000),
    tracks: z.array(trackSchema).min(1).max(32),
    clips: z.array(clipSchema).max(5000),
  })
  .superRefine((p, ctx) => {
    const media = new Map(p.media.map((m) => [m.id, m]))
    const tracks = new Map(p.tracks.map((t) => [t.id, t]))
    if (media.size !== p.media.length) ctx.addIssue({ code: "custom", message: "duplicate media id" })
    if (tracks.size !== p.tracks.length) ctx.addIssue({ code: "custom", message: "duplicate track id" })
    const seen = new Set<string>()
    for (const c of p.clips) {
      if (seen.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate clip id ${c.id}` })
      seen.add(c.id)
      const m = media.get(c.mediaId)
      const t = tracks.get(c.trackId)
      if (!m || !t) {
        ctx.addIssue({ code: "custom", message: `clip ${c.id} references missing media or track` })
        continue
      }
      if (c.out - c.in < MIN_CLIP / 4) ctx.addIssue({ code: "custom", message: `clip ${c.id} is empty` })
      if (t.kind === "audio" && !m.hasAudio) ctx.addIssue({ code: "custom", message: `clip ${c.id}: no audio on an audio track` })
      if (t.kind === "video" && m.kind === "audio") ctx.addIssue({ code: "custom", message: `clip ${c.id}: audio file on a video track` })
    }
  })
export type EditorProject = z.infer<typeof editorProjectSchema>

/* ── Formats ─────────────────────────────────────────────────────────── */

const PRESET_SHORT: Record<ExportPreset, number> = { "720p": 720, "1080p": 1080, "1440p": 1440, "2160p": 2160 }
const RATIO: Record<Exclude<Aspect, "custom">, [number, number]> = { "16:9": [16, 9], "9:16": [9, 16], "1:1": [1, 1], "4:5": [4, 5] }
const even = (n: number) => Math.max(16, Math.round(n / 2) * 2)

/** Frame size for an aspect and preset: the preset is the SHORT side (1080p 9:16 = 1080×1920). */
export function frameSize(aspect: Aspect, preset: ExportPreset, custom?: { width: number; height: number }): { width: number; height: number } {
  if (aspect === "custom") {
    const w = custom?.width ?? 1920
    const h = custom?.height ?? 1080
    const short = PRESET_SHORT[preset]
    const k = short / Math.min(w, h)
    return { width: even(w * k), height: even(h * k) }
  }
  const [rw, rh] = RATIO[aspect]
  const short = PRESET_SHORT[preset]
  return rw >= rh ? { width: even((short * rw) / rh), height: short } : { width: short, height: even((short * rh) / rw) }
}

/** Export size for a project at a preset, keeping its aspect ratio. */
export function exportSize(settings: ProjectSettings, preset: ExportPreset) {
  return frameSize(settings.aspect, preset, { width: settings.width, height: settings.height })
}

/* ── Construction ────────────────────────────────────────────────────── */

let counter = 0
export function newId(prefix: string): string {
  counter = (counter + 1) % 1_000_000
  const rnd = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rnd}`
}

export function newProject(name: string, aspect: Aspect = "16:9", now = Date.now()): EditorProject {
  const { width, height } = frameSize(aspect, "1080p")
  return {
    format: EDITOR_FORMAT,
    formatVersion: EDITOR_FORMAT_VERSION,
    id: newId("prj"),
    name: name.trim() || "Untitled",
    createdAt: now,
    updatedAt: now,
    settings: { aspect, width, height, fps: 30, background: "#000000" },
    media: [],
    tracks: [
      { id: newId("trk"), kind: "video", name: "V2", muted: false, hidden: false, locked: false, volume: 1 },
      { id: newId("trk"), kind: "video", name: "V1", muted: false, hidden: false, locked: false, volume: 1 },
      { id: newId("trk"), kind: "audio", name: "A1", muted: false, hidden: false, locked: false, volume: 1 },
      { id: newId("trk"), kind: "audio", name: "A2", muted: false, hidden: false, locked: false, volume: 1 },
    ],
    clips: [],
  }
}

/** Parses a saved project, filling defaults; throws with a readable message. */
export function parseProject(raw: unknown): EditorProject {
  const r = editorProjectSchema.safeParse(raw)
  if (!r.success) throw new Error(`Invalid project: ${r.error.issues[0]?.message ?? "unknown error"}`)
  return r.data
}

/* ── Queries ─────────────────────────────────────────────────────────── */

export const clipDuration = (c: Pick<Clip, "in" | "out" | "speed">) => (c.out - c.in) / c.speed
export const clipEnd = (c: Clip) => c.start + clipDuration(c)
const EPS = 1e-6

export function projectDuration(p: EditorProject): number {
  let end = 0
  for (const c of p.clips) end = Math.max(end, clipEnd(c))
  return end
}

export function trackClips(p: EditorProject, trackId: string): Clip[] {
  return p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start)
}

/** Longest the clip may extend to (source length), in source seconds. */
function sourceLimit(p: EditorProject, c: Clip): number {
  const m = p.media.find((x) => x.id === c.mediaId)
  if (!m || m.kind === "image" || m.durationSec == null) return Number.POSITIVE_INFINITY
  return m.durationSec
}

/** True when [start, end) on the track overlaps another clip (other than `ignore`). */
export function overlaps(p: EditorProject, trackId: string, start: number, end: number, ignore: ReadonlySet<string> = new Set()): boolean {
  return p.clips.some((c) => c.trackId === trackId && !ignore.has(c.id) && start < clipEnd(c) - EPS && end > c.start + EPS)
}

/** First free start ≥ `from` on the track where a clip of `len` fits. */
export function firstFreeStart(p: EditorProject, trackId: string, len: number, from = 0, ignore: ReadonlySet<string> = new Set()): number {
  let t = Math.max(0, from)
  for (const c of trackClips(p, trackId)) {
    if (ignore.has(c.id)) continue
    if (t + len <= c.start + EPS) break
    if (clipEnd(c) > t) t = clipEnd(c)
  }
  return t
}

/* ── Operations (pure: they return a new project) ────────────────────── */

const touch = (p: EditorProject, patch: Partial<EditorProject>): EditorProject => ({ ...p, ...patch, updatedAt: Date.now() })

export function addMedia(p: EditorProject, items: EditorMedia[]): EditorProject {
  const have = new Set(p.media.map((m) => m.id))
  return touch(p, { media: [...p.media, ...items.filter((m) => !have.has(m.id))] })
}

export function removeMedia(p: EditorProject, mediaId: string): EditorProject {
  return touch(p, { media: p.media.filter((m) => m.id !== mediaId), clips: p.clips.filter((c) => c.mediaId !== mediaId) })
}

/** The default track for a media item: audio files go to audio tracks, the rest to the lowest video track. */
export function defaultTrackFor(p: EditorProject, media: EditorMedia): Track | null {
  const kind = media.kind === "audio" ? "audio" : "video"
  const list = p.tracks.filter((t) => t.kind === kind && !t.locked)
  if (!list.length) return null
  return (kind === "video" ? list[list.length - 1] : list[0]) ?? null
}

export interface PlaceOptions {
  trackId?: string
  start?: number
  clipId?: string
}

/**
 * Places a media item on a track. Without a start it is appended after the
 * track's last clip; with a start, the first free position at or after it.
 */
export function placeMedia(p: EditorProject, mediaId: string, opts: PlaceOptions = {}): { project: EditorProject; clip: Clip } {
  const media = p.media.find((m) => m.id === mediaId)
  if (!media) throw new Error("Unknown media")
  const track = opts.trackId ? p.tracks.find((t) => t.id === opts.trackId) : defaultTrackFor(p, media)
  if (!track) throw new Error("No suitable track")
  if (track.locked) throw new Error("The track is locked")
  if (track.kind === "audio" && !media.hasAudio) throw new Error("This file has no audio")
  if (track.kind === "video" && media.kind === "audio") throw new Error("Audio files go on audio tracks")
  const len = media.kind === "image" || media.durationSec == null ? IMAGE_DEFAULT_SEC : media.durationSec
  const start =
    opts.start === undefined
      ? trackClips(p, track.id).reduce((end, c) => Math.max(end, clipEnd(c)), 0)
      : firstFreeStart(p, track.id, len, opts.start)
  const clip: Clip = {
    id: opts.clipId ?? newId("clp"),
    trackId: track.id,
    mediaId,
    start,
    in: 0,
    out: len,
    speed: 1,
    volume: 1,
    muted: false,
    fadeIn: 0,
    fadeOut: 0,
    opacity: 1,
    fit: media.kind === "image" && track !== defaultTrackFor(p, media) ? "fit" : "fit",
    x: 0,
    y: 0,
    scale: 1,
  }
  return { project: touch(p, { clips: [...p.clips, clip] }), clip }
}

export function updateClip(p: EditorProject, clipId: string, patch: Partial<Omit<Clip, "id" | "mediaId">>): EditorProject {
  return touch(p, { clips: p.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)) })
}

/**
 * Moves clips by `delta` seconds (and optionally to another track of the same
 * kind). Refused (returns the project unchanged) when any clip would overlap
 * another or start before 0, so the timeline never has stacked clips on one track.
 */
export function moveClips(p: EditorProject, ids: string[], delta: number, toTrackId?: string): EditorProject {
  const moving = new Set(ids)
  const sel = p.clips.filter((c) => moving.has(c.id))
  if (!sel.length) return p
  const target = toTrackId ? p.tracks.find((t) => t.id === toTrackId) : undefined
  if (toTrackId && (!target || target.locked)) return p
  const next = sel.map((c) => ({ ...c, start: c.start + delta, trackId: target?.id ?? c.trackId }))
  for (const c of next) {
    if (c.start < -EPS) return p
    const track = p.tracks.find((t) => t.id === c.trackId)
    const media = p.media.find((m) => m.id === c.mediaId)
    if (!track || !media || track.locked) return p
    if (track.kind === "audio" && !media.hasAudio) return p
    if (track.kind === "video" && media.kind === "audio") return p
    if (overlaps(p, c.trackId, c.start, clipEnd(c), moving)) return p
    if (next.some((o) => o !== c && o.trackId === c.trackId && c.start < clipEnd(o) - EPS && clipEnd(c) > o.start + EPS)) return p
  }
  const byId = new Map(next.map((c) => [c.id, { ...c, start: Math.max(0, c.start) }]))
  return touch(p, { clips: p.clips.map((c) => byId.get(c.id) ?? c) })
}

/**
 * Trims a clip edge to a new timeline time. The edge is clamped to the
 * source length, the neighbouring clips and the minimum clip length.
 */
export function trimClip(p: EditorProject, clipId: string, edge: "start" | "end", time: number): EditorProject {
  const c = p.clips.find((x) => x.id === clipId)
  if (!c) return p
  const others = trackClips(p, c.trackId).filter((x) => x.id !== c.id)
  if (edge === "start") {
    const prevEnd = others.filter((o) => clipEnd(o) <= c.start + EPS).reduce((m, o) => Math.max(m, clipEnd(o)), 0)
    const end = clipEnd(c)
    const minStart = Math.max(prevEnd, c.start - c.in / c.speed)
    const t = Math.min(Math.max(time, minStart), end - MIN_CLIP)
    const newIn = c.in + (t - c.start) * c.speed
    return updateClip(p, c.id, { start: t, in: Math.max(0, newIn) })
  }
  const nextStart = others.filter((o) => o.start >= clipEnd(c) - EPS).reduce((m, o) => Math.min(m, o.start), Number.POSITIVE_INFINITY)
  const maxEnd = Math.min(nextStart, c.start + (sourceLimit(p, c) - c.in) / c.speed)
  const t = Math.max(Math.min(time, maxEnd), c.start + MIN_CLIP)
  return updateClip(p, c.id, { out: c.in + (t - c.start) * c.speed })
}

/** Splits every given clip that spans `time` into two adjacent clips. */
export function splitAt(p: EditorProject, time: number, ids?: string[]): { project: EditorProject; created: string[] } {
  const pick = ids ? new Set(ids) : null
  const created: string[] = []
  const clips: Clip[] = []
  for (const c of p.clips) {
    const inside = time > c.start + MIN_CLIP / 2 && time < clipEnd(c) - MIN_CLIP / 2
    const track = p.tracks.find((t) => t.id === c.trackId)
    if (!inside || (pick && !pick.has(c.id)) || track?.locked) {
      clips.push(c)
      continue
    }
    const cut = c.in + (time - c.start) * c.speed
    const right: Clip = { ...c, id: newId("clp"), start: time, in: cut, fadeIn: 0 }
    clips.push({ ...c, out: cut, fadeOut: 0 }, right)
    created.push(right.id)
  }
  return { project: created.length ? touch(p, { clips }) : p, created }
}

/** Removes clips; with `ripple`, later clips on the same tracks close the gap. */
export function deleteClips(p: EditorProject, ids: string[], ripple = false): EditorProject {
  const del = new Set(ids)
  const removed = p.clips.filter((c) => del.has(c.id))
  if (!removed.length) return p
  let clips = p.clips.filter((c) => !del.has(c.id))
  if (ripple) {
    for (const r of [...removed].sort((a, b) => b.start - a.start)) {
      const len = clipDuration(r)
      clips = clips.map((c) => (c.trackId === r.trackId && c.start >= r.start - EPS ? { ...c, start: Math.max(0, c.start - len) } : c))
    }
  }
  return touch(p, { clips })
}

/** Duplicates clips right after themselves (or the first free spot) on the same track. */
export function duplicateClips(p: EditorProject, ids: string[]): { project: EditorProject; created: string[] } {
  let project = p
  const created: string[] = []
  for (const c of p.clips.filter((x) => ids.includes(x.id))) {
    const copy: Clip = { ...c, id: newId("clp"), start: firstFreeStart(project, c.trackId, clipDuration(c), clipEnd(c)) }
    project = touch(project, { clips: [...project.clips, copy] })
    created.push(copy.id)
  }
  return { project, created }
}

/** Pastes copied clips at `time`, keeping their relative offsets, each on its own track. */
export function pasteClips(p: EditorProject, copied: Clip[], time: number): { project: EditorProject; created: string[] } {
  if (!copied.length) return { project: p, created: [] }
  const base = Math.min(...copied.map((c) => c.start))
  let project = p
  const created: string[] = []
  for (const c of copied) {
    if (!project.tracks.some((t) => t.id === c.trackId) || !project.media.some((m) => m.id === c.mediaId)) continue
    const at = firstFreeStart(project, c.trackId, clipDuration(c), time + (c.start - base))
    const copy: Clip = { ...c, id: newId("clp"), start: at }
    project = touch(project, { clips: [...project.clips, copy] })
    created.push(copy.id)
  }
  return { project, created }
}

export function addTrack(p: EditorProject, kind: "video" | "audio"): EditorProject {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1
  const track: Track = { id: newId("trk"), kind, name: `${kind === "video" ? "V" : "A"}${n}`, muted: false, hidden: false, locked: false, volume: 1 }
  // Video tracks are listed top-down (the first one is drawn on top).
  const tracks = kind === "video" ? [track, ...p.tracks] : [...p.tracks, track]
  return touch(p, { tracks })
}

export function updateTrack(p: EditorProject, trackId: string, patch: Partial<Omit<Track, "id" | "kind">>): EditorProject {
  return touch(p, { tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) })
}

/** Changes the frame without touching any edit (clips keep their relative position and fit). */
export function setFormat(p: EditorProject, aspect: Aspect, custom?: { width: number; height: number }): EditorProject {
  const { width, height } = aspect === "custom" && custom ? { width: even(custom.width), height: even(custom.height) } : frameSize(aspect, "1080p")
  return touch(p, { settings: { ...p.settings, aspect, width, height } })
}

/**
 * Snaps `time` to the nearest clip edge or the playhead within `threshold`
 * seconds (excluding the clips being dragged).
 */
export function snapTime(p: EditorProject, time: number, threshold: number, exclude: ReadonlySet<string>, extra: number[] = []): number {
  let best = time
  let dist = threshold
  const candidates = [0, ...extra]
  for (const c of p.clips) {
    if (exclude.has(c.id)) continue
    candidates.push(c.start, clipEnd(c))
  }
  for (const t of candidates) {
    const d = Math.abs(t - time)
    if (d < dist) {
      dist = d
      best = t
    }
  }
  return best
}

/* ── Undo / redo ─────────────────────────────────────────────────────── */

export interface History {
  past: EditorProject[]
  present: EditorProject
  future: EditorProject[]
}
export const HISTORY_LIMIT = 200

export const initHistory = (p: EditorProject): History => ({ past: [], present: p, future: [] })
export function commit(h: History, next: EditorProject): History {
  if (next === h.present) return h
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: next, future: [] }
}
export function undo(h: History): History {
  const prev = h.past[h.past.length - 1]
  return prev ? { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] } : h
}
export function redo(h: History): History {
  const next = h.future[0]
  return next ? { past: [...h.past, h.present], present: next, future: h.future.slice(1) } : h
}

/* ── Render plan (shared by preview and export) ──────────────────────── */

export interface PlanVideo {
  clipId: string
  mediaId: string
  kind: "video" | "image"
  /** Draw order: 0 = bottom. */
  layer: number
  start: number
  end: number
  srcIn: number
  srcOut: number
  speed: number
  opacity: number
  fit: FitMode
  x: number
  y: number
  scale: number
}

export interface PlanAudio {
  clipId: string
  mediaId: string
  start: number
  end: number
  srcIn: number
  srcOut: number
  speed: number
  /** Clip × track volume. */
  gain: number
  fadeIn: number
  fadeOut: number
}

export interface RenderPlan {
  width: number
  height: number
  fps: number
  duration: number
  background: string
  video: PlanVideo[]
  audio: PlanAudio[]
}

/**
 * Flattens the project into what is drawn and heard: hidden tracks are
 * skipped, muted clips/tracks contribute no audio, video clips contribute
 * their own audio from their track, and fades are clamped to the clip.
 */
export function renderPlan(p: EditorProject, size?: { width: number; height: number }): RenderPlan {
  const width = size?.width ?? p.settings.width
  const height = size?.height ?? p.settings.height
  const media = new Map(p.media.map((m) => [m.id, m]))
  const videoTracks = p.tracks.filter((t) => t.kind === "video")
  const video: PlanVideo[] = []
  const audio: PlanAudio[] = []
  for (const c of p.clips) {
    const track = p.tracks.find((t) => t.id === c.trackId)
    const m = media.get(c.mediaId)
    if (!track || !m || !m.available) continue
    const start = c.start
    const end = clipEnd(c)
    if (end - start < MIN_CLIP / 4) continue
    if (track.kind === "video" && !track.hidden && m.kind !== "audio") {
      video.push({
        clipId: c.id,
        mediaId: m.id,
        kind: m.kind === "image" ? "image" : "video",
        layer: videoTracks.length - 1 - videoTracks.indexOf(track),
        start,
        end,
        srcIn: c.in,
        srcOut: c.out,
        speed: c.speed,
        opacity: c.opacity,
        fit: c.fit,
        x: c.x,
        y: c.y,
        scale: c.scale,
      })
    }
    const audible = m.hasAudio && !c.muted && !track.muted && c.volume * track.volume > 0
    if (audible) {
      const len = end - start
      audio.push({
        clipId: c.id,
        mediaId: m.id,
        start,
        end,
        srcIn: c.in,
        srcOut: c.out,
        speed: c.speed,
        gain: c.volume * track.volume,
        fadeIn: Math.min(c.fadeIn, len),
        fadeOut: Math.min(c.fadeOut, len),
      })
    }
  }
  video.sort((a, b) => a.layer - b.layer || a.start - b.start)
  audio.sort((a, b) => a.start - b.start)
  return { width, height, fps: p.settings.fps, duration: projectDuration(p), background: p.settings.background, video, audio }
}

/** Video items visible at time `t`, bottom first (used by the preview). */
export function activeVideo(plan: RenderPlan, t: number): PlanVideo[] {
  return plan.video.filter((v) => t >= v.start - EPS && t < v.end - EPS)
}

/** Source time inside a clip for timeline time `t`. */
export function sourceTime(item: { start: number; srcIn: number; speed: number }, t: number): number {
  return item.srcIn + (t - item.start) * item.speed
}

/** Volume envelope (0..1 × gain) of an audio item at time `t`. */
export function gainAt(a: PlanAudio, t: number): number {
  if (t < a.start || t >= a.end) return 0
  let g = a.gain
  if (a.fadeIn > 0 && t < a.start + a.fadeIn) g *= (t - a.start) / a.fadeIn
  if (a.fadeOut > 0 && t > a.end - a.fadeOut) g *= (a.end - t) / a.fadeOut
  return Math.max(0, g)
}

/**
 * Placement of a source frame of size (sw, sh) in the output frame (W, H):
 * "fit" letterboxes, "fill" covers (cropped), "blur" fits over a blurred fill.
 * Returns the drawn size and the top-left offset, after scale and x/y offset.
 */
export function placement(
  fit: FitMode,
  sw: number,
  sh: number,
  W: number,
  H: number,
  scale = 1,
  x = 0,
  y = 0
): { w: number; h: number; left: number; top: number } {
  const k = fit === "fill" ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh)
  const w = even(sw * k * scale)
  const h = even(sh * k * scale)
  return { w, h, left: Math.round((W - w) / 2 + x * W), top: Math.round((H - h) / 2 + y * H) }
}

/** Seconds → "m:ss.cc" (or "h:mm:ss.cc"), used in the UI and tests. */
export function formatTimecode(t: number, fps = 30): string {
  const total = Math.max(0, t)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = Math.floor(total % 60)
  const f = Math.floor((total - Math.floor(total)) * fps)
  const ss = String(s).padStart(2, "0")
  const ff = String(f).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}:${ff}` : `${m}:${ss}:${ff}`
}
