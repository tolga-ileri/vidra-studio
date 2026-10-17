import { describe, expect, it } from "vitest"

import {
  activeVideo,
  addMedia,
  clipEnd,
  commit,
  deleteClips,
  duplicateClips,
  exportSize,
  frameSize,
  gainAt,
  initHistory,
  moveClips,
  newProject,
  parseProject,
  pasteClips,
  placeMedia,
  placement,
  projectDuration,
  redo,
  renderPlan,
  setFormat,
  snapTime,
  splitAt,
  trimClip,
  undo,
  updateClip,
  updateTrack,
  type EditorMedia,
  type EditorProject,
} from "../src"

const media = (id: string, kind: EditorMedia["kind"], durationSec: number | null, extra: Partial<EditorMedia> = {}): EditorMedia => ({
  id,
  kind,
  name: `${id}.${kind === "audio" ? "mp3" : kind === "image" ? "png" : "mp4"}`,
  path: `C:/media/${id}`,
  durationSec,
  width: kind === "audio" ? null : 1920,
  height: kind === "audio" ? null : 1080,
  fps: kind === "video" ? 30 : null,
  hasAudio: kind !== "image",
  hasVideo: kind !== "audio",
  sizeBytes: 1000,
  available: true,
  ...extra,
})

function project(): EditorProject {
  let p = newProject("Test", "16:9", 0)
  p = addMedia(p, [media("a", "video", 10), media("b", "video", 6), media("c", "video", 8), media("music", "audio", 60), media("logo", "image", null)])
  return p
}

const v1 = (p: EditorProject) => p.tracks.filter((t) => t.kind === "video").at(-1)!.id
const v2 = (p: EditorProject) => p.tracks.find((t) => t.kind === "video")!.id
const a1 = (p: EditorProject) => p.tracks.find((t) => t.kind === "audio")!.id

describe("formats", () => {
  it("uses the preset as the short side", () => {
    expect(frameSize("16:9", "1080p")).toEqual({ width: 1920, height: 1080 })
    expect(frameSize("9:16", "1080p")).toEqual({ width: 1080, height: 1920 })
    expect(frameSize("1:1", "720p")).toEqual({ width: 720, height: 720 })
    expect(frameSize("4:5", "1080p")).toEqual({ width: 1080, height: 1350 })
    expect(frameSize("9:16", "2160p")).toEqual({ width: 2160, height: 3840 })
    expect(frameSize("custom", "720p", { width: 1000, height: 500 })).toEqual({ width: 1440, height: 720 })
  })

  it("changing the aspect keeps every edit", () => {
    let p = placeMedia(project(), "a").project
    p = setFormat(p, "9:16")
    expect(p.settings).toMatchObject({ aspect: "9:16", width: 1080, height: 1920 })
    expect(p.clips).toHaveLength(1)
    expect(exportSize(p.settings, "720p")).toEqual({ width: 720, height: 1280 })
  })
})

describe("placing, moving and trimming", () => {
  it("appends clips after each other on the main video track", () => {
    let p = project()
    p = placeMedia(p, "a").project
    p = placeMedia(p, "b").project
    p = placeMedia(p, "c").project
    const [x, y, z] = [...p.clips].sort((m, n) => m.start - n.start)
    expect([x!.start, y!.start, z!.start]).toEqual([0, 10, 16])
    expect(projectDuration(p)).toBe(24)
    expect(new Set(p.clips.map((c) => c.trackId))).toEqual(new Set([v1(p)]))
  })

  it("routes audio files to audio tracks and refuses invalid placements", () => {
    let p = project()
    const r = placeMedia(p, "music")
    expect(r.clip.trackId).toBe(a1(p))
    p = r.project
    expect(() => placeMedia(p, "music", { trackId: v1(p) })).toThrow(/audio tracks/)
    expect(() => placeMedia(p, "logo", { trackId: a1(p) })).toThrow(/no audio/)
    expect(placeMedia(p, "logo", { trackId: v2(p), start: 1 }).clip).toMatchObject({ start: 1, in: 0, out: 5 })
  })

  it("never lets clips overlap on a track", () => {
    let p = placeMedia(project(), "a").project
    p = placeMedia(p, "b").project
    const [first, second] = [...p.clips].sort((m, n) => m.start - n.start)
    // Moving the second clip onto the first is refused.
    expect(moveClips(p, [second!.id], -5)).toBe(p)
    // Moving both together is fine; moving past 0 is refused.
    expect(moveClips(p, [first!.id, second!.id], 2).clips.find((c) => c.id === first!.id)!.start).toBe(2)
    expect(moveClips(p, [first!.id], -1)).toBe(p)
    // Reorder: move the second clip to the end then the first after it.
    const moved = moveClips(p, [second!.id], 20)
    expect(moved.clips.find((c) => c.id === second!.id)!.start).toBe(30)
  })

  it("trims within the source length and the neighbours", () => {
    let p = placeMedia(project(), "a").project
    p = placeMedia(p, "b").project
    const a = p.clips.find((c) => c.mediaId === "a")!
    let q = trimClip(p, a.id, "start", 3)
    expect(q.clips.find((c) => c.id === a.id)).toMatchObject({ start: 3, in: 3, out: 10 })
    q = trimClip(q, a.id, "start", -5)
    expect(q.clips.find((c) => c.id === a.id)).toMatchObject({ start: 0, in: 0 })
    // End cannot run into the next clip (starts at 10) nor past the source.
    q = trimClip(p, a.id, "end", 12)
    expect(clipEnd(q.clips.find((c) => c.id === a.id)!)).toBe(10)
    q = trimClip(p, a.id, "end", 4)
    expect(q.clips.find((c) => c.id === a.id)!.out).toBe(4)
  })

  it("splits at the playhead into two exact halves", () => {
    let p = placeMedia(project(), "a").project
    p = updateClip(p, p.clips[0]!.id, { in: 1, out: 9, fadeIn: 1, fadeOut: 1 })
    const { project: q, created } = splitAt(p, 3)
    expect(created).toHaveLength(1)
    const [l, r] = [...q.clips].sort((m, n) => m.start - n.start)
    expect(l).toMatchObject({ start: 0, in: 1, out: 4, fadeIn: 1, fadeOut: 0 })
    expect(r).toMatchObject({ start: 3, in: 4, out: 9, fadeIn: 0, fadeOut: 1 })
    expect(splitAt(q, 0).created).toHaveLength(0)
  })

  it("respects speed for duration, trims and splits", () => {
    let p = placeMedia(project(), "a").project
    const id = p.clips[0]!.id
    p = updateClip(p, id, { speed: 2 })
    expect(clipEnd(p.clips[0]!)).toBe(5)
    const { project: q } = splitAt(p, 2)
    const [l, r] = [...q.clips].sort((m, n) => m.start - n.start)
    expect(l!.out).toBe(4)
    expect(r).toMatchObject({ start: 2, in: 4, out: 10 })
  })

  it("deletes, ripple-deletes, duplicates and pastes", () => {
    let p = placeMedia(project(), "a").project
    p = placeMedia(p, "b").project
    p = placeMedia(p, "c").project
    const [x, y, z] = [...p.clips].sort((m, n) => m.start - n.start)
    expect(deleteClips(p, [y!.id]).clips.find((c) => c.id === z!.id)!.start).toBe(16)
    expect(deleteClips(p, [y!.id], true).clips.find((c) => c.id === z!.id)!.start).toBe(10)
    const d = duplicateClips(p, [x!.id])
    expect(d.project.clips.find((c) => c.id === d.created[0])!.start).toBe(24)
    const pasted = pasteClips(p, [x!], 100)
    expect(pasted.project.clips.find((c) => c.id === pasted.created[0])!.start).toBe(100)
  })

  it("snaps to clip edges and the playhead", () => {
    const p = placeMedia(project(), "a").project
    expect(snapTime(p, 10.1, 0.2, new Set())).toBe(10)
    expect(snapTime(p, 4.95, 0.2, new Set(), [5])).toBe(5)
    expect(snapTime(p, 7, 0.2, new Set())).toBe(7)
  })
})

describe("history", () => {
  it("undoes and redoes", () => {
    const p0 = project()
    const p1 = placeMedia(p0, "a").project
    let h = commit(initHistory(p0), p1)
    h = undo(h)
    expect(h.present).toBe(p0)
    h = redo(h)
    expect(h.present).toBe(p1)
    expect(commit(h, h.present)).toBe(h)
  })
})

describe("render plan", () => {
  it("layers video tracks, carries clip audio, skips hidden and muted", () => {
    let p = placeMedia(project(), "a").project
    p = placeMedia(p, "logo", { trackId: v2(p), start: 0 }).project
    p = placeMedia(p, "music").project
    const music = p.clips.find((c) => c.mediaId === "music")!
    p = updateClip(p, music.id, { volume: 0.4, fadeIn: 2, fadeOut: 100 })
    p = updateTrack(p, a1(p), { volume: 0.5 })
    const plan = renderPlan(p)
    expect(plan.video.map((v) => [v.mediaId, v.layer])).toEqual([["a", 0], ["logo", 1]])
    const m = plan.audio.find((x) => x.mediaId === "music")!
    expect(m.gain).toBeCloseTo(0.2)
    expect(m.fadeOut).toBe(60)
    expect(plan.audio.find((x) => x.mediaId === "a")!.gain).toBe(1)
    expect(activeVideo(plan, 4).map((v) => v.mediaId)).toEqual(["a", "logo"])
    expect(activeVideo(plan, 6).map((v) => v.mediaId)).toEqual(["a"])
    expect(gainAt(m, 1)).toBeCloseTo(0.1)

    const hidden = renderPlan(updateTrack(p, v2(p), { hidden: true }))
    expect(hidden.video.map((v) => v.mediaId)).toEqual(["a"])
    const muted = renderPlan(updateTrack(p, a1(p), { muted: true }))
    expect(muted.audio.map((x) => x.mediaId)).toEqual(["a"])
  })

  it("computes fit / fill placement inside the frame", () => {
    expect(placement("fit", 1920, 1080, 1080, 1920)).toEqual({ w: 1080, h: 608, left: 0, top: 656 })
    expect(placement("fill", 1920, 1080, 1080, 1920)).toEqual({ w: 3414, h: 1920, left: -1167, top: 0 })
    expect(placement("fit", 500, 500, 1080, 1920, 0.2, 0.3, -0.4)).toEqual({ w: 216, h: 216, left: 756, top: 84 })
  })
})

describe("project files", () => {
  it("round-trips through JSON and rejects broken references", () => {
    const p = placeMedia(project(), "a").project
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    const broken = { ...p, clips: [{ ...p.clips[0]!, mediaId: "zzz" }] }
    expect(() => parseProject(broken)).toThrow(/missing media/)
    expect(() => parseProject({ ...p, formatVersion: 99 })).toThrow()
  })
})
