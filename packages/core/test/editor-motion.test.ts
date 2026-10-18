import { describe, expect, it } from "vitest"

import {
  addMarker,
  addMedia,
  animAt,
  applyMotion,
  clipEnd,
  clipValueAt,
  deleteClips,
  ease,
  frameRound,
  itemState,
  joinClips,
  motionDefaults,
  moveKeyframe,
  newProject,
  parseProject,
  pasteKeyframes,
  placeMedia,
  projectDuration,
  removeKeyframe,
  removeRange,
  renderPlan,
  setKeyframe,
  setTransition,
  snapTime,
  splitAt,
  trimToPlayhead,
  type EditorMedia,
  type EditorProject,
} from "../src"

const media = (id: string, durationSec: number | null, kind: EditorMedia["kind"] = "video"): EditorMedia => ({
  id,
  kind,
  name: `${id}.mp4`,
  path: `C:/m/${id}`,
  durationSec,
  width: 1920,
  height: 1080,
  fps: 30,
  hasAudio: kind !== "image",
  hasVideo: true,
  sizeBytes: 1,
  available: true,
})

function oneClip(len = 20): EditorProject {
  const p = addMedia(newProject("T", "16:9", 0), [media("v", len), media("w", 10), media("img", null, "image")])
  return placeMedia(p, "v").project
}
const sorted = (p: EditorProject) => [...p.clips].sort((a, b) => a.start - b.start)
const FRAME = { W: 1920, H: 1080, sw: 1920, sh: 1080 }

describe("cutting (Test A logic)", () => {
  it("split at 7 and 12, ripple-delete the middle → 15 s without a gap", () => {
    let p = oneClip(20)
    p = splitAt(p, 7).project
    p = splitAt(p, 12).project
    const [, mid] = sorted(p)
    expect(mid).toMatchObject({ start: 7, in: 7, out: 12 })
    p = deleteClips(p, [mid!.id], true)
    expect(projectDuration(p)).toBe(15)
    const [a, b] = sorted(p)
    expect([a!.start, clipEnd(a!), b!.start, b!.in]).toEqual([0, 7, 7, 12])
  })

  it("normal delete keeps the gap", () => {
    let p = splitAt(splitAt(oneClip(20), 7).project, 12).project
    p = deleteClips(p, [sorted(p)[1]!.id], false)
    expect(projectDuration(p)).toBe(20)
  })

  it("removes a selected range on all tracks and closes the gap", () => {
    let p = oneClip(20)
    p = placeMedia(p, "w", { trackId: p.tracks.find((t) => t.name === "V2")!.id, start: 5 }).project
    p = addMarker(p, 13)
    p = removeRange(p, 7, 12)
    expect(projectDuration(p)).toBe(15)
    const v2 = p.clips.find((c) => c.mediaId === "w")!
    expect([v2.start, v2.in, v2.out]).toEqual([5, 0, 2])
    expect(p.markers.map((m) => m.t)).toEqual([8])
  })

  it("trims to the playhead and joins split halves back together", () => {
    let p = trimToPlayhead(oneClip(20), 3, "start")
    expect(sorted(p)[0]).toMatchObject({ start: 3, in: 3 })
    p = trimToPlayhead(p, 15, "end")
    expect(clipEnd(sorted(p)[0]!)).toBe(15)
    const split = splitAt(p, 9).project
    expect(split.clips).toHaveLength(2)
    const joined = joinClips(split, split.clips.map((c) => c.id))
    expect(joined.clips).toHaveLength(1)
    expect(joined.clips[0]).toMatchObject({ start: 3, in: 3, out: 15 })
  })

  it("snaps to markers and rounds to frames", () => {
    const p = addMarker(oneClip(), 4.5)
    expect(snapTime(p, 4.55, 0.1, new Set())).toBe(4.5)
    expect(frameRound(1.016, 30)).toBeCloseTo(1, 6)
    expect(frameRound(1.02, 30)).toBeCloseTo(31 / 30, 6)
  })
})

describe("easing and keyframes", () => {
  it("cubic curves hit the ends and are monotonic", () => {
    for (const k of ["linear", "in", "out", "inOut"] as const) {
      expect(ease(k, 0)).toBe(0)
      expect(ease(k, 1)).toBe(1)
      let prev = -1
      for (let i = 0; i <= 20; i++) {
        const v = ease(k, i / 20)
        expect(v).toBeGreaterThanOrEqual(prev)
        prev = v
      }
    }
    expect(ease("inOut", 0.5)).toBeCloseTo(0.5)
    expect(ease("hold", 0.99)).toBe(0)
  })

  it("interpolates and holds outside the keyframes", () => {
    const a = [
      { t: 2, v: 1, ease: "linear" as const },
      { t: 4, v: 2, ease: "linear" as const },
    ]
    expect(animAt(a, 0, 9)).toBe(1)
    expect(animAt(a, 3, 9)).toBe(1.5)
    expect(animAt(a, 10, 9)).toBe(2)
    expect(animAt(undefined, 3, 9)).toBe(9)
  })

  it("keyframes follow the source frame when the clip is trimmed or split", () => {
    let p = oneClip(20)
    const id = p.clips[0]!.id
    p = setKeyframe(p, id, "opacity", 10, 0.5)
    expect(p.clips[0]!.keyframes.opacity).toEqual([{ s: 10, v: 0.5, ease: "linear" }])
    // Moving the clip moves the keyframe with it.
    p = { ...p, clips: [{ ...p.clips[0]!, start: 5 }] }
    expect(clipValueAt(p.clips[0]!, "opacity", 15)).toBe(0.5)
    p = moveKeyframe(p, id, "opacity", 0, 7)
    expect(p.clips[0]!.keyframes.opacity![0]!.s).toBe(2)
    p = removeKeyframe(p, id, "opacity", 0)
    expect(p.clips[0]!.keyframes.opacity).toBeUndefined()
  })

  it("copies animation to another clip relative to its start", () => {
    let p = oneClip(20)
    p = placeMedia(p, "w").project
    const [a, b] = sorted(p)
    p = setKeyframe(p, a!.id, "scale", 1, 1.2)
    p = pasteKeyframes(p, p.clips.find((c) => c.id === a!.id)!, [b!.id])
    const pb = p.clips.find((c) => c.id === b!.id)!
    expect(pb.keyframes.scale).toEqual([{ s: 1, v: 1.2, ease: "linear" }])
  })
})

describe("motion presets (Test B logic)", () => {
  it("zoom in 2→4 s then zoom out 6→8 s chain into one smooth curve", () => {
    let p = oneClip(10)
    const c = () => p.clips[0]!
    p = applyMotion(p, c().id, { ...motionDefaults(c(), "zoomIn", 2, 4) }, FRAME)
    p = applyMotion(p, c().id, { ...motionDefaults(c(), "zoomOut", 6, 8) }, FRAME)
    const s = (t: number) => clipValueAt(c(), "scale", t)
    expect(s(1)).toBe(1)
    expect(s(2)).toBe(1)
    expect(s(3)).toBeGreaterThan(1)
    expect(s(3)).toBeLessThan(1.25)
    expect(s(4)).toBeCloseTo(1.25)
    expect(s(5)).toBeCloseTo(1.25)
    expect(s(7)).toBeLessThan(1.25)
    expect(s(8)).toBeCloseTo(1)
    expect(s(9.9)).toBeCloseTo(1)
    // Smooth: strictly increasing through the zoom-in.
    let prev = 0
    for (let t = 2; t <= 4.0001; t += 1 / 30) {
      expect(s(t)).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = s(t)
    }
  })

  it("keeps the focal point fixed while zooming", () => {
    let p = oneClip(10)
    const c = () => p.clips[0]!
    p = applyMotion(p, c().id, { ...motionDefaults(c(), "zoomIn", 0, 2), endScale: 2, cx: 0.75, cy: 0.25 }, FRAME)
    // Focal point at 0.75/0.25 of the picture: its canvas position must not move.
    const focal = (t: number) => {
      const s = clipValueAt(c(), "scale", t)
      return [0.5 + clipValueAt(c(), "x", t) + 0.25 * s, 0.5 + clipValueAt(c(), "y", t) - 0.25 * s]
    }
    const [x0, y0] = focal(0)
    for (const t of [0.5, 1, 2]) {
      const [x, y] = focal(t)
      expect(x).toBeCloseTo(x0!, 6)
      expect(y).toBeCloseTo(y0!, 6)
    }
  })

  it("feeds the render plan and the preview state", () => {
    let p = oneClip(10)
    const c = () => p.clips[0]!
    p = applyMotion(p, c().id, motionDefaults(c(), "zoomIn", 2, 4), FRAME)
    const item = renderPlan(p).video[0]!
    expect(item.anim.scale?.map((a) => [a.t, a.v])).toEqual([[2, 1], [4, 1.25]])
    expect(itemState(item, 3).scale).toBeCloseTo(1.125)
  })
})

describe("transitions in the render plan", () => {
  function two(kind: Parameters<typeof setTransition>[3] extends infer T ? (T extends { kind: infer K } ? K : never) : never) {
    let p = addMedia(newProject("T", "16:9", 0), [media("a", 6), media("b", 6)])
    p = placeMedia(p, "a").project
    p = placeMedia(p, "b").project
    const b = sorted(p)[1]!
    p = { ...p, clips: p.clips.map((c) => (c.mediaId === "a" ? { ...c, out: 5 } : c.mediaId === "b" ? { ...c, start: 5, in: 0.5, out: 6 } : c)) }
    return setTransition(p, b.id, "in", { kind, duration: 1, color: "#123456" })
  }

  it("dissolve overlaps the clips around the cut and fades the incoming one in", () => {
    const plan = renderPlan(two("dissolve"))
    const [a, b] = plan.video
    expect([a!.end, a!.srcOut, a!.holdEnd]).toEqual([5.5, 5.5, 0])
    expect([b!.start, b!.srcIn, b!.holdStart]).toEqual([4.5, 0, 0])
    expect(b!.fades).toEqual([{ t0: 4.5, t1: 5.5, from: 0, to: 1 }])
    expect(itemState(b!, 5).opacity).toBeCloseTo(0.5)
    expect(plan.duration).toBe(10.5)
  })

  it("holds frames instead of showing black when the source has no spare frames", () => {
    let p = two("dissolve")
    p = { ...p, clips: p.clips.map((c) => (c.mediaId === "a" ? { ...c, out: 6 } : c.mediaId === "b" ? { ...c, start: 6, in: 0 } : c)) }
    const [a, b] = renderPlan(p).video
    expect([a!.srcOut, a!.holdEnd]).toEqual([6, 0.5])
    expect([b!.srcIn, b!.holdStart]).toEqual([0, 0.5])
  })

  it("dip to a color adds a color layer that peaks at the cut", () => {
    const plan = renderPlan(two("dipColor"))
    const dip = plan.video.find((v) => v.kind === "color")!
    expect([dip.start, dip.end, dip.color]).toEqual([4.5, 5.5, "#123456"])
    expect(itemState(dip, 5).opacity).toBeCloseTo(1)
    expect(itemState(dip, 4.75).opacity).toBeCloseTo(0.5)
    expect(plan.video.indexOf(dip)).toBe(plan.video.length - 1)
  })

  it("slides and wipes animate position and reveal", () => {
    const slide = renderPlan(two("slideLeft")).video
    expect(itemState(slide[1]!, 4.5).x).toBeCloseTo(1)
    expect(itemState(slide[1]!, 5.5).x).toBeCloseTo(0)
    expect(itemState(slide[0]!, 5.5).x).toBeCloseTo(-1)
    const wipe = renderPlan(two("wipe")).video
    expect(itemState(wipe[1]!, 5).revealTo).toBeCloseTo(0.5)
  })

  it("fade out at the end of the last clip", () => {
    let p = oneClip(10)
    p = setTransition(p, p.clips[0]!.id, "out", { kind: "fade", duration: 2, color: "#000000" })
    const it = renderPlan(p).video[0]!
    expect(itemState(it, 9).opacity).toBeCloseTo(0.5)
  })
})

describe("project format v2", () => {
  it("opens v1 (0.3.0) projects and fills the new fields", () => {
    const v1 = JSON.parse(JSON.stringify(oneClip(5))) as Record<string, unknown> & { clips: Array<Record<string, unknown>> }
    v1.formatVersion = 1
    delete v1.markers
    const v2Only = new Set(["rotation", "crop", "keyframes", "transIn", "transOut"])
    v1.clips = v1.clips.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => !v2Only.has(k))))
    const p = parseProject(v1)
    expect(p.formatVersion).toBe(2)
    expect(p.markers).toEqual([])
    expect(p.clips[0]).toMatchObject({ rotation: 0, crop: { l: 0, t: 0, r: 0, b: 0 }, keyframes: {}, transIn: null, transOut: null })
    expect(renderPlan(p).video).toHaveLength(1)
  })
})
