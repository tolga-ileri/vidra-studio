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
/** Version 2 adds keyframes, transitions, rotation, crop and markers (v1 projects upgrade on open). */
export const EDITOR_FORMAT_VERSION = 2

export const ASPECTS = ["16:9", "9:16", "1:1", "4:5", "custom"] as const
export type Aspect = (typeof ASPECTS)[number]
export const FIT_MODES = ["fit", "fill", "blur"] as const
export type FitMode = (typeof FIT_MODES)[number]
export const EXPORT_PRESETS = ["720p", "1080p", "1440p", "2160p"] as const
/** Easing of the segment that starts at a keyframe (cubic curves; "hold" = step). */
export const EASES = ["linear", "in", "out", "inOut", "hold"] as const
export type Ease = (typeof EASES)[number]
/** Animatable clip properties. `gain` multiplies the clip volume. */
export const KF_PROPS = ["scale", "x", "y", "rotation", "opacity", "gain"] as const
export type KfProp = (typeof KF_PROPS)[number]
export const TRANSITIONS = ["dissolve", "fade", "dipBlack", "dipWhite", "dipColor", "zoom", "blur", "slideLeft", "slideRight", "wipe"] as const
export type TransitionKind = (typeof TRANSITIONS)[number]
export type ExportPreset = (typeof EXPORT_PRESETS)[number]

/** Shortest clip the editor allows (one frame at 60 fps, rounded up). */
export const MIN_CLIP = 0.05
/** Default length of a still image placed on the timeline. */
export const IMAGE_DEFAULT_SEC = 5

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const sec = z.number().finite().min(0).max(24 * 3600)
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/)

/** A keyframe at a SOURCE time `s` (so it stays on the same frame when the clip is trimmed or split). */
export const keyframeSchema = z.object({
  s: z.number().finite().min(-1).max(24 * 3600),
  v: z.number().finite().min(-3600).max(3600),
  ease: z.enum(EASES).default("linear"),
})
export type Keyframe = z.infer<typeof keyframeSchema>
const kfList = z.array(keyframeSchema).max(500).optional()
export const keyframesSchema = z
  .object({ scale: kfList, x: kfList, y: kfList, rotation: kfList, opacity: kfList, gain: kfList })
  .default({})
export type Keyframes = z.infer<typeof keyframesSchema>

export const transitionSchema = z.object({
  kind: z.enum(TRANSITIONS),
  duration: z.number().min(0.1).max(5),
  color: hex.default("#000000"),
})
export type Transition = z.infer<typeof transitionSchema>

export const markerSchema = z.object({
  id,
  t: sec,
  label: z.string().max(60).default(""),
  color: hex.default("#f59e0b"),
})
export type Marker = z.infer<typeof markerSchema>

const cropSchema = z
  .object({ l: z.number().min(0).max(0.9), t: z.number().min(0).max(0.9), r: z.number().min(0).max(0.9), b: z.number().min(0).max(0.9) })
  .refine((c) => c.l + c.r < 0.95 && c.t + c.b < 0.95, "crop leaves no picture")
  .default({ l: 0, t: 0, r: 0, b: 0 })

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
  /** Degrees, clockwise. */
  rotation: z.number().min(-3600).max(3600).default(0),
  /** Fractions of the source cut from each side (before fitting). */
  crop: cropSchema,
  keyframes: keyframesSchema,
  /** Transition at the clip start (from the previous adjacent clip, or from nothing). */
  transIn: transitionSchema.nullable().default(null),
  /** Transition at the clip end when no clip follows directly (fade out). */
  transOut: transitionSchema.nullable().default(null),
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
    // v1 (0.3.0) projects are accepted and upgraded: every new field has a default.
    formatVersion: z.union([z.literal(1), z.literal(2)]).transform((): typeof EDITOR_FORMAT_VERSION => EDITOR_FORMAT_VERSION),
    id,
    name: z.string().min(1).max(120),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    settings: projectSettingsSchema,
    media: z.array(editorMediaSchema).max(2000),
    tracks: z.array(trackSchema).min(1).max(32),
    clips: z.array(clipSchema).max(5000),
    markers: z.array(markerSchema).max(1000).default([]),
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
    markers: [],
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
    rotation: 0,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    keyframes: {},
    transIn: null,
    transOut: null,
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
    const right: Clip = { ...c, id: newId("clp"), start: time, in: cut, fadeIn: 0, transIn: null }
    clips.push({ ...c, out: cut, fadeOut: 0, transOut: null }, right)
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
  const candidates = [0, ...extra, ...p.markers.map((m) => m.t)]
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

/** Rounds a time to the nearest frame boundary. */
export function frameRound(t: number, fps: number): number {
  return Math.round(t * fps) / fps
}

/** Trims every given clip that spans `time`: its start (`edge` "start") or end to the playhead. */
export function trimToPlayhead(p: EditorProject, time: number, edge: "start" | "end", ids?: string[]): EditorProject {
  let next = p
  for (const c of p.clips) {
    if (ids && !ids.includes(c.id)) continue
    if (!(time > c.start + MIN_CLIP / 2 && time < clipEnd(c) - MIN_CLIP / 2)) continue
    if (p.tracks.find((t) => t.id === c.trackId)?.locked) continue
    next = trimClip(next, c.id, edge, time)
  }
  return next
}

/**
 * Removes the time range [a, b) from every unlocked track and closes the gap
 * (later clips move left by b − a). Clips crossing the range are cut.
 */
export function removeRange(p: EditorProject, a: number, b: number): EditorProject {
  if (b - a < MIN_CLIP / 2) return p
  const len = b - a
  let next = splitAt(p, a).project
  next = splitAt(next, b).project
  const locked = new Set(next.tracks.filter((t) => t.locked).map((t) => t.id))
  const clips = next.clips
    .filter((c) => locked.has(c.trackId) || !(c.start >= a - EPS && clipEnd(c) <= b + EPS))
    .map((c) => (!locked.has(c.trackId) && c.start >= b - EPS ? { ...c, start: Math.max(0, c.start - len) } : c))
  const markers = next.markers.filter((m) => m.t < a || m.t >= b).map((m) => (m.t >= b ? { ...m, t: m.t - len } : m))
  return touch(next, { clips, markers })
}

/** True when B continues A seamlessly (same media, same settings, adjacent on timeline and in the source). */
export function canJoin(a: Clip, b: Clip): boolean {
  const same = (k: keyof Clip) => JSON.stringify(a[k]) === JSON.stringify(b[k])
  return (
    a.trackId === b.trackId &&
    a.mediaId === b.mediaId &&
    Math.abs(clipEnd(a) - b.start) < 1e-3 &&
    Math.abs(a.out - b.in) < 1e-3 &&
    (["speed", "volume", "muted", "opacity", "fit", "x", "y", "scale", "rotation", "crop"] as const).every(same) &&
    !a.transOut &&
    !b.transIn
  )
}

/** Joins selected clips that continue each other (undoes a split without touching the source). */
export function joinClips(p: EditorProject, ids: string[]): EditorProject {
  const sel = p.clips.filter((c) => ids.includes(c.id)).sort((x, y) => x.trackId.localeCompare(y.trackId) || x.start - y.start)
  const removed = new Set<string>()
  const merged = new Map<string, Clip>()
  for (let i = 0; i < sel.length; i++) {
    const cur = sel[i]
    if (!cur) continue
    let base = merged.get(cur.id) ?? cur
    if (removed.has(base.id)) continue
    let j = i + 1
    for (let nxt = sel[j]; nxt && canJoin(base, nxt); nxt = sel[++j]) {
      const kf: Keyframes = { ...base.keyframes }
      for (const k of KF_PROPS) {
        const list = [...(base.keyframes[k] ?? []), ...(nxt.keyframes[k] ?? [])]
        if (list.length) kf[k] = dedupeKeyframes(list)
      }
      base = { ...base, out: nxt.out, fadeOut: nxt.fadeOut, transOut: nxt.transOut, keyframes: kf }
      removed.add(nxt.id)
    }
    merged.set(base.id, base)
  }
  if (!removed.size) return p
  return touch(p, { clips: p.clips.filter((c) => !removed.has(c.id)).map((c) => merged.get(c.id) ?? c) })
}

/* ── Markers ─────────────────────────────────────────────────────────── */

export function addMarker(p: EditorProject, t: number, label = ""): EditorProject {
  if (p.markers.some((m) => Math.abs(m.t - t) < 1e-3)) return p
  const marker: Marker = { id: newId("mrk"), t: Math.max(0, t), label: label.slice(0, 60), color: "#f59e0b" }
  return touch(p, { markers: [...p.markers, marker].sort((a, b) => a.t - b.t) })
}

export function removeMarker(p: EditorProject, markerId: string): EditorProject {
  return touch(p, { markers: p.markers.filter((m) => m.id !== markerId) })
}

/* ── Keyframes and easing ────────────────────────────────────────────── */

/** Cubic easing curves; the export uses the same formulas (see editor_render.rs). */
export function ease(kind: Ease, u: number): number {
  const x = Math.min(1, Math.max(0, u))
  switch (kind) {
    case "in":
      return x * x * x
    case "out":
      return 1 - (1 - x) ** 3
    case "inOut":
      return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
    case "hold":
      return x < 1 ? 0 : 1
    default:
      return x
  }
}

/** A keyframe on the timeline: absolute time `t` (seconds). */
export interface Anim {
  t: number
  v: number
  ease: Ease
}

/** Value of an animation at time `t` (holds the first/last value outside it). */
export function animAt(list: readonly Anim[] | undefined, t: number, base: number): number {
  const first = list?.[0]
  if (!list || !first) return base
  if (t <= first.t) return first.v
  let a = first
  for (const b of list.slice(1)) {
    if (t < b.t) {
      const span = b.t - a.t
      const u = span > 0 ? (t - a.t) / span : 1
      return a.v + (b.v - a.v) * ease(a.ease, u)
    }
    a = b
  }
  return a.v
}

function dedupeKeyframes(list: Keyframe[]): Keyframe[] {
  const sorted = [...list].sort((a, b) => a.s - b.s)
  const out: Keyframe[] = []
  for (const k of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.s - k.s) < 1e-4) out[out.length - 1] = k
    else out.push(k)
  }
  return out
}

/** Timeline time of a source time inside a clip, and back. */
export const kfTimeline = (c: Pick<Clip, "start" | "in" | "speed">, s: number) => c.start + (s - c.in) / c.speed
export const kfSource = (c: Pick<Clip, "start" | "in" | "speed">, t: number) => c.in + (t - c.start) * c.speed

/** The clip's keyframes for a property as timeline animations. */
export function clipAnim(c: Clip, prop: KfProp): Anim[] | undefined {
  const list = c.keyframes[prop]
  if (!list?.length) return undefined
  return list.map((k) => ({ t: kfTimeline(c, k.s), v: k.v, ease: k.ease }))
}

const STATIC: Record<KfProp, (c: Clip) => number> = {
  scale: (c) => c.scale,
  x: (c) => c.x,
  y: (c) => c.y,
  rotation: (c) => c.rotation,
  opacity: (c) => c.opacity,
  gain: () => 1,
}

/** Current value of a property at timeline time `t` (keyframes win over the static value). */
export function clipValueAt(c: Clip, prop: KfProp, t: number): number {
  return animAt(clipAnim(c, prop), t, STATIC[prop](c))
}

/** Adds or replaces a keyframe at timeline time `t`. */
export function setKeyframe(p: EditorProject, clipId: string, prop: KfProp, t: number, v: number, easeKind: Ease = "linear"): EditorProject {
  const c = p.clips.find((x) => x.id === clipId)
  if (!c) return p
  const s = kfSource(c, Math.min(Math.max(t, c.start), clipEnd(c)))
  const list = dedupeKeyframes([...(c.keyframes[prop] ?? []), { s, v, ease: easeKind }])
  return updateClip(p, clipId, { keyframes: { ...c.keyframes, [prop]: list } })
}

export function removeKeyframe(p: EditorProject, clipId: string, prop: KfProp, index: number): EditorProject {
  const c = p.clips.find((x) => x.id === clipId)
  const list = c?.keyframes[prop]
  if (!c || !list?.[index]) return p
  const next = list.filter((_, i) => i !== index)
  return updateClip(p, clipId, { keyframes: { ...c.keyframes, [prop]: next.length ? next : undefined } })
}

/** Moves one keyframe to timeline time `t` (kept inside the clip and in order). */
export function moveKeyframe(p: EditorProject, clipId: string, prop: KfProp, index: number, t: number): EditorProject {
  const c = p.clips.find((x) => x.id === clipId)
  const list = c?.keyframes[prop]
  if (!c || !list?.[index]) return p
  const s = kfSource(c, Math.min(Math.max(t, c.start), clipEnd(c)))
  const next = dedupeKeyframes(list.map((k, i) => (i === index ? { ...k, s } : k)))
  return updateClip(p, clipId, { keyframes: { ...c.keyframes, [prop]: next } })
}

export function setKeyframeEase(p: EditorProject, clipId: string, prop: KfProp, index: number, easeKind: Ease): EditorProject {
  const c = p.clips.find((x) => x.id === clipId)
  const list = c?.keyframes[prop]
  if (!c || !list?.[index]) return p
  return updateClip(p, clipId, { keyframes: { ...c.keyframes, [prop]: list.map((k, i) => (i === index ? { ...k, ease: easeKind } : k)) } })
}

export function clearKeyframes(p: EditorProject, clipId: string, props: readonly KfProp[] = KF_PROPS): EditorProject {
  const c = p.clips.find((x) => x.id === clipId)
  if (!c) return p
  const kf: Keyframes = {}
  for (const k of KF_PROPS) if (!props.includes(k) && c.keyframes[k]) kf[k] = c.keyframes[k]
  return updateClip(p, clipId, { keyframes: kf })
}

/** Copies a clip's animation onto other clips, keeping the timing relative to each clip's start. */
export function pasteKeyframes(p: EditorProject, from: Clip, toIds: string[]): EditorProject {
  let next = p
  for (const id of toIds) {
    const c = next.clips.find((x) => x.id === id)
    if (!c || c.id === from.id) continue
    const kf: Keyframes = {}
    for (const k of KF_PROPS) {
      const list = from.keyframes[k]
      if (!list?.length) continue
      kf[k] = list
        .map((x) => ({ ...x, s: c.in + ((x.s - from.in) / from.speed) * c.speed }))
        .filter((x) => x.s >= c.in - 1e-6 && x.s <= c.out + 1e-6)
    }
    next = updateClip(next, id, { keyframes: kf })
  }
  return next
}

/* ── Motion presets (animated zoom / pan) ────────────────────────────── */

export const MOTION_PRESETS = [
  "zoomIn",
  "zoomOut",
  "pushIn",
  "pullBack",
  "punch",
  "panLeft",
  "panRight",
  "panZoom",
  "kenBurns",
  "custom",
] as const
export type MotionPreset = (typeof MOTION_PRESETS)[number]

export interface MotionParams {
  /** Interval in timeline seconds (inside the clip). */
  from: number
  to: number
  startScale: number
  endScale: number
  /** Focal point inside the picture (0..1, 0.5 = center); it stays in place while zooming. */
  cx: number
  cy: number
  /** Pan distance as a fraction of the frame width (positive = toward the right). */
  panX: number
  panY: number
  ease: Ease
}

/** Sensible parameters for a preset on a clip, starting from its current values at `from`. */
export function motionDefaults(c: Clip, preset: MotionPreset, from?: number, to?: number): MotionParams {
  const len = clipEnd(c) - c.start
  const short = Math.min(2, len)
  const a = from ?? c.start
  const span = (d: number) => Math.min(clipEnd(c), a + d)
  const s0 = clipValueAt(c, "scale", a)
  const base: MotionParams = { from: a, to: to ?? span(short), startScale: s0, endScale: s0, cx: 0.5, cy: 0.5, panX: 0, panY: 0, ease: "inOut" }
  switch (preset) {
    case "zoomIn":
      return { ...base, endScale: round3(s0 * 1.25) }
    case "zoomOut":
      return { ...base, endScale: s0 > 1.001 ? 1 : 1, startScale: s0 > 1.001 ? s0 : 1.25 }
    case "pushIn":
      return { ...base, to: to ?? clipEnd(c), endScale: round3(s0 * 1.15), ease: "inOut" }
    case "pullBack":
      return { ...base, to: to ?? clipEnd(c), startScale: s0 > 1.001 ? s0 : 1.15, endScale: 1, ease: "inOut" }
    case "punch":
      return { ...base, to: to ?? span(0.2), endScale: round3(s0 * 1.3), ease: "out" }
    case "panLeft":
      return { ...base, to: to ?? clipEnd(c), startScale: 1.2, endScale: 1.2, panX: 0.08, ease: "inOut" }
    case "panRight":
      return { ...base, to: to ?? clipEnd(c), startScale: 1.2, endScale: 1.2, panX: -0.08, ease: "inOut" }
    case "panZoom":
      return { ...base, to: to ?? clipEnd(c), endScale: round3(s0 * 1.2), panX: -0.05, ease: "inOut" }
    case "kenBurns":
      return { ...base, to: to ?? clipEnd(c), startScale: 1.05, endScale: 1.2, panX: -0.04, panY: 0.03, ease: "linear" }
    default:
      return { ...base, to: to ?? span(short) }
  }
}

const round3 = (n: number) => Math.round(n * 1000) / 1000

/**
 * Applies an animated zoom/pan over [from, to] as ordinary, editable keyframes
 * on scale, x and y (other keyframes outside the interval are kept, so zooms
 * can be chained). The focal point stays fixed while the scale changes.
 */
export function applyMotion(p: EditorProject, clipId: string, m: MotionParams, frame: { W: number; H: number; sw: number; sh: number }): EditorProject {
  const c = p.clips.find((x) => x.id === clipId)
  if (!c) return p
  const a = Math.max(c.start, Math.min(m.from, m.to))
  const b = Math.min(clipEnd(c), Math.max(m.from, m.to))
  if (b - a < 1 / 120) return p
  const fit = placement(c.fit === "fill" ? "fill" : "fit", frame.sw, frame.sh, frame.W, frame.H)
  // Focal point offset from the picture center, in frame fractions at scale 1.
  const fx = ((m.cx - 0.5) * fit.w) / frame.W
  const fy = ((m.cy - 0.5) * fit.h) / frame.H
  const x0 = clipValueAt(c, "x", a)
  const y0 = clipValueAt(c, "y", a)
  const s0 = clipValueAt(c, "scale", a)
  const pos = (s: number, base: number, f: number) => base + (s0 - s) * f
  const sa = kfSource(c, a)
  const sb = kfSource(c, b)
  const within = (k: Keyframe) => k.s > sa - 1e-6 && k.s < sb + 1e-6
  const put = (prop: KfProp, va: number, vb: number): Keyframe[] => {
    const kept = (c.keyframes[prop] ?? []).filter((k) => !within(k))
    // Keep the value before the interval: pin it at `a` if earlier keyframes differ.
    return dedupeKeyframes([...kept, { s: sa, v: va, ease: m.ease }, { s: sb, v: vb, ease: "linear" }])
  }
  const keyframes: Keyframes = {
    ...c.keyframes,
    scale: put("scale", m.startScale, m.endScale),
    x: put("x", pos(m.startScale, x0, fx), pos(m.endScale, x0, fx) + m.panX),
    y: put("y", pos(m.startScale, y0, fy), pos(m.endScale, y0, fy) + m.panY),
  }
  return updateClip(p, clipId, { keyframes })
}

/* ── Transitions ─────────────────────────────────────────────────────── */

/** The clip that ends exactly where `c` starts on the same track, if any. */
export function previousAdjacent(p: EditorProject, c: Clip): Clip | undefined {
  return p.clips.find((o) => o.trackId === c.trackId && o.id !== c.id && Math.abs(clipEnd(o) - c.start) < 1e-3)
}
export function nextAdjacent(p: EditorProject, c: Clip): Clip | undefined {
  return p.clips.find((o) => o.trackId === c.trackId && o.id !== c.id && Math.abs(o.start - clipEnd(c)) < 1e-3)
}

/** Sets (or with null removes) a transition at a clip edge. */
export function setTransition(p: EditorProject, clipId: string, edge: "in" | "out", t: Transition | null): EditorProject {
  const c = p.clips.find((x) => x.id === clipId)
  if (!c) return p
  // An out-transition between two adjacent clips is stored as the next clip's in-transition.
  if (edge === "out" && t) {
    const n = nextAdjacent(p, c)
    if (n) return updateClip(updateClip(p, c.id, { transOut: null }), n.id, { transIn: t })
  }
  return updateClip(p, clipId, edge === "in" ? { transIn: t } : { transOut: t })
}

/** Usable transition length: never longer than either clip. */
export function transitionLength(t: Transition, ...lens: number[]): number {
  return Math.max(0.05, Math.min(t.duration, ...lens))
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

/** Linear alpha ramp of a plan item (transitions, fades). */
export interface PlanFade {
  t0: number
  t1: number
  from: number
  to: number
}

export interface PlanVideo {
  /** Unique within the plan (a clip can yield more than one item, e.g. blur copies). */
  id: string
  clipId: string
  mediaId: string
  /** "color": a solid layer (dip-to-color transitions); no media. */
  kind: "video" | "image" | "color"
  color: string
  /** Draw order: lower first. Tracks use whole numbers; transition overlays use fractions. */
  layer: number
  /** Order within a layer when items start together. */
  z: number
  start: number
  end: number
  srcIn: number
  srcOut: number
  speed: number
  /** Seconds of frozen first / last frame (transitions past the source). */
  holdStart: number
  holdEnd: number
  opacity: number
  fit: FitMode
  x: number
  y: number
  scale: number
  rotation: number
  crop: { l: number; t: number; r: number; b: number }
  /** Keyframed properties (absolute timeline times); they replace the static value. */
  anim: Partial<Record<"scale" | "x" | "y" | "rotation" | "opacity", Anim[]>>
  /** Transition multipliers / offsets on top of the clip's own animation. */
  tScale: Anim[]
  tX: Anim[]
  fades: PlanFade[]
  /** Static blur radius as a fraction of the frame height (blur transitions). */
  blur: number
  /** Wipe reveal ("in") or hide ("out") from left to right over [t0, t1]. */
  wipe: { t0: number; t1: number; mode: "in" | "out" } | null
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
  /** Keyframed gain multiplier (absolute timeline times). */
  gainAnim: Anim[]
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

const DIP_COLOR: Partial<Record<TransitionKind, string>> = { dipBlack: "#000000", dipWhite: "#ffffff" }
const isDip = (k: TransitionKind) => k === "fade" || k === "dipBlack" || k === "dipWhite" || k === "dipColor"

/**
 * Flattens the project into what is drawn and heard: hidden tracks are
 * skipped, muted clips/tracks contribute no audio, video clips contribute
 * their own audio from their track, fades are clamped to the clip, and
 * transitions become overlaps, alpha ramps and animations of the items.
 */
export function renderPlan(p: EditorProject, size?: { width: number; height: number }): RenderPlan {
  const width = size?.width ?? p.settings.width
  const height = size?.height ?? p.settings.height
  const media = new Map(p.media.map((m) => [m.id, m]))
  const videoTracks = p.tracks.filter((t) => t.kind === "video")
  const video: PlanVideo[] = []
  const audio: PlanAudio[] = []
  const items = new Map<string, PlanVideo>()
  for (const c of p.clips) {
    const track = p.tracks.find((t) => t.id === c.trackId)
    const m = media.get(c.mediaId)
    if (!track || !m || !m.available) continue
    const start = c.start
    const end = clipEnd(c)
    if (end - start < MIN_CLIP / 4) continue
    if (track.kind === "video" && !track.hidden && m.kind !== "audio") {
      const anim: PlanVideo["anim"] = {}
      for (const k of ["scale", "x", "y", "rotation", "opacity"] as const) {
        const a = clipAnim(c, k)
        if (a) anim[k] = a
      }
      const item: PlanVideo = {
        id: c.id,
        clipId: c.id,
        mediaId: m.id,
        kind: m.kind === "image" ? "image" : "video",
        color: "#000000",
        layer: videoTracks.length - 1 - videoTracks.indexOf(track),
        z: 0,
        start,
        end,
        srcIn: c.in,
        srcOut: c.out,
        speed: c.speed,
        holdStart: 0,
        holdEnd: 0,
        opacity: c.opacity,
        fit: c.fit,
        x: c.x,
        y: c.y,
        scale: c.scale,
        rotation: c.rotation,
        crop: c.crop,
        anim,
        tScale: [],
        tX: [],
        fades: [],
        blur: 0,
        wipe: null,
      }
      video.push(item)
      items.set(c.id, item)
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
        gainAnim: clipAnim(c, "gain") ?? [],
        fadeIn: Math.min(c.fadeIn, len),
        fadeOut: Math.min(c.fadeOut, len),
      })
    }
  }

  // Transitions.
  const sourceLen = (it: PlanVideo) => (it.kind === "image" ? Number.POSITIVE_INFINITY : (media.get(it.mediaId)?.durationSec ?? Number.POSITIVE_INFINITY))
  const extendEnd = (it: PlanVideo, by: number) => {
    it.end += by
    const want = it.srcOut + by * it.speed
    const max = sourceLen(it)
    if (want > max) {
      it.holdEnd = (want - max) / it.speed
      it.srcOut = max
    } else it.srcOut = want
  }
  const extendStart = (it: PlanVideo, by: number) => {
    it.start -= by
    const want = it.srcIn - by * it.speed
    if (want < 0) {
      it.holdStart = -want / it.speed
      it.srcIn = 0
    } else it.srcIn = want
  }
  const colorItem = (base: PlanVideo, t0: number, t1: number, color: string, fades: PlanFade[]): PlanVideo => ({
    ...base,
    id: `${base.clipId}:dip:${t0.toFixed(3)}`,
    kind: "color",
    color,
    layer: base.layer + 0.5,
    z: 0,
    start: t0,
    end: t1,
    srcIn: 0,
    srcOut: t1 - t0,
    speed: 1,
    holdStart: 0,
    holdEnd: 0,
    opacity: 1,
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    anim: {},
    tScale: [],
    tX: [],
    fades,
    blur: 0,
    wipe: null,
  })
  const blurCopy = (it: PlanVideo, z: number, fades: PlanFade[], t0: number, t1: number): PlanVideo => ({
    ...it,
    id: `${it.id}:blur`,
    z,
    start: t0,
    end: t1,
    srcIn: it.srcIn + (t0 - it.start) * it.speed,
    srcOut: it.srcIn + (t1 - it.start) * it.speed,
    holdStart: 0,
    holdEnd: 0,
    fades,
    blur: 0.025,
  })
  const incoming = (it: PlanVideo, kind: TransitionKind, t0: number, t1: number, color: string, extra: PlanVideo[]) => {
    const mid = (t0 + t1) / 2
    switch (kind) {
      case "slideLeft":
        it.tX = [{ t: t0, v: 1, ease: "inOut" }, { t: t1, v: 0, ease: "linear" }]
        break
      case "slideRight":
        it.tX = [{ t: t0, v: -1, ease: "inOut" }, { t: t1, v: 0, ease: "linear" }]
        break
      case "wipe":
        it.wipe = { t0, t1, mode: "in" }
        break
      case "zoom":
        it.tScale = [{ t: t0, v: 0.85, ease: "out" }, { t: t1, v: 1, ease: "linear" }]
        it.fades.push({ t0, t1, from: 0, to: 1 })
        break
      case "blur":
        it.z = 2
        it.fades.push({ t0, t1, from: 0, to: 1 })
        extra.push(blurCopy(it, 3, [{ t0, t1: mid, from: 0, to: 1 }, { t0: mid, t1, from: 1, to: 0 }], t0, t1))
        break
      case "dissolve":
        it.fades.push({ t0, t1, from: 0, to: 1 })
        break
      default:
        if (isDip(kind) && kind !== "fade") extra.push(colorItem(it, t0, t1, color, [{ t0, t1, from: 1, to: 0 }]))
        else it.fades.push({ t0, t1, from: 0, to: 1 })
    }
  }
  const outgoing = (it: PlanVideo, kind: TransitionKind, t0: number, t1: number, color: string, extra: PlanVideo[], paired: boolean) => {
    switch (kind) {
      case "slideLeft":
        it.tX = [...it.tX, { t: t0, v: 0, ease: "inOut" }, { t: t1, v: -1, ease: "linear" }]
        break
      case "slideRight":
        it.tX = [...it.tX, { t: t0, v: 0, ease: "inOut" }, { t: t1, v: 1, ease: "linear" }]
        break
      case "wipe":
        if (!paired) it.wipe = { t0, t1, mode: "out" }
        break
      case "zoom":
        it.tScale = [...it.tScale, { t: t0, v: 1, ease: "in" }, { t: t1, v: 1.3, ease: "linear" }]
        if (!paired) it.fades.push({ t0, t1, from: 1, to: 0 })
        break
      case "blur":
        it.z = Math.min(it.z, 0)
        extra.push(blurCopy(it, 1, [{ t0, t1: (t0 + t1) / 2, from: 0, to: 1 }], t0, t1))
        if (!paired) it.fades.push({ t0, t1, from: 1, to: 0 })
        break
      case "dissolve":
        if (!paired) it.fades.push({ t0, t1, from: 1, to: 0 })
        break
      default:
        if (isDip(kind) && kind !== "fade") extra.push(colorItem(it, t0, t1, color, [{ t0, t1, from: 0, to: 1 }]))
        else if (!paired) it.fades.push({ t0, t1, from: 1, to: 0 })
    }
  }
  const extra: PlanVideo[] = []
  for (const c of p.clips) {
    const it = items.get(c.id)
    if (!it) continue
    const len = clipEnd(c) - c.start
    if (c.transIn) {
      const prev = previousAdjacent(p, c)
      const pit = prev ? items.get(prev.id) : undefined
      const kind = c.transIn.kind
      const color = kind === "fade" ? p.settings.background : (DIP_COLOR[kind] ?? c.transIn.color)
      if (prev && pit) {
        const d = transitionLength(c.transIn, len, clipEnd(prev) - prev.start)
        const half = d / 2
        const cut = c.start
        if (isDip(kind)) {
          // Dip: the outgoing clip fades to the color, then the incoming one fades from it.
          const fades: PlanFade[] = [
            { t0: cut - half, t1: cut, from: 0, to: 1 },
            { t0: cut, t1: cut + half, from: 1, to: 0 },
          ]
          extra.push(colorItem(it, cut - half, cut + half, kind === "fade" ? p.settings.background : color, fades))
        } else {
          extendEnd(pit, half)
          extendStart(it, half)
          outgoing(pit, kind, cut - half, cut + half, color, extra, true)
          incoming(it, kind, cut - half, cut + half, color, extra)
        }
      } else {
        const d = transitionLength(c.transIn, len)
        incoming(it, kind, c.start, c.start + d, color, extra)
      }
    }
    if (c.transOut && !nextAdjacent(p, c)) {
      const kind = c.transOut.kind
      const color = kind === "fade" ? p.settings.background : (DIP_COLOR[kind] ?? c.transOut.color)
      const d = transitionLength(c.transOut, len)
      outgoing(it, kind, clipEnd(c) - d, clipEnd(c), color, extra, false)
    }
  }
  video.push(...extra)
  for (const it of video) {
    it.tScale.sort((a, b) => a.t - b.t)
    it.tX.sort((a, b) => a.t - b.t)
  }
  video.sort((a, b) => a.layer - b.layer || a.start - b.start || a.z - b.z)
  audio.sort((a, b) => a.start - b.start)
  return { width, height, fps: p.settings.fps, duration: projectDuration(p), background: p.settings.background, video, audio }
}

/** Everything that changes over time for a video item, at timeline time `t`. */
export interface ItemState {
  scale: number
  x: number
  y: number
  rotation: number
  opacity: number
  /** Visible part from the left (wipe), 0..1. */
  revealFrom: number
  revealTo: number
}

/** The state the export renders for `item` at `t` (the preview draws exactly this). */
export function itemState(item: PlanVideo, t: number): ItemState {
  const scale = animAt(item.anim.scale, t, item.scale) * animAt(item.tScale, t, 1)
  const x = animAt(item.anim.x, t, item.x) + animAt(item.tX, t, 0)
  const y = animAt(item.anim.y, t, item.y)
  const rotation = animAt(item.anim.rotation, t, item.rotation)
  let opacity = Math.min(1, Math.max(0, animAt(item.anim.opacity, t, item.opacity)))
  for (const f of item.fades) {
    if (t < f.t0) opacity *= f.from
    else if (t >= f.t1) opacity *= f.to
    else opacity *= f.from + (f.to - f.from) * ((t - f.t0) / (f.t1 - f.t0))
  }
  let revealFrom = 0
  let revealTo = 1
  if (item.wipe) {
    const u = Math.min(1, Math.max(0, (t - item.wipe.t0) / (item.wipe.t1 - item.wipe.t0)))
    if (item.wipe.mode === "in") revealTo = u
    else revealFrom = u
  }
  return { scale, x, y, rotation, opacity, revealFrom, revealTo }
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
  let g = a.gain * Math.max(0, animAt(a.gainAnim, t, 1))
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
