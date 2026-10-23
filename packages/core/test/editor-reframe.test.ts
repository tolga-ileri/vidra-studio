import { describe, expect, it } from "vitest"

import {
  addMedia,
  addRegion,
  applyBlurFallback,
  applyFocus,
  applyReframe,
  aspectMismatch,
  clearReframe,
  cornerPinCss,
  cornersAt,
  deadZone,
  defaultCorners,
  estimateBytes,
  focusOffset,
  homography,
  itemState,
  jitter,
  newProject,
  parseProject,
  placeMedia,
  planRegionAt,
  project,
  recommendedKbps,
  reframeKeyframes,
  regionAt,
  removeCornerKeyframe,
  renderPlan,
  resample,
  sameAspect,
  setCornerKeyframe,
  setCorners,
  setFormat,
  setMask,
  setRegionKeyframe,
  simplify,
  smooth,
  splitAt,
  updateRegion,
  upscaleInfo,
  type EditorMedia,
  type Sample,
  type Subject,
} from "../src"

const media = (id: string, kind: EditorMedia["kind"], durationSec: number | null, w = 1920, h = 1080): EditorMedia => ({
  id,
  kind,
  name: `${id}.mp4`,
  path: `C:/media/${id}`,
  durationSec,
  width: w,
  height: h,
  fps: 30,
  hasAudio: kind !== "image",
  hasVideo: kind !== "audio",
  sizeBytes: 1000,
  available: true,
})

function vertical() {
  let p = newProject("Reframe", "9:16", 0)
  p = addMedia(p, [media("wide", "video", 10), media("tall", "video", 10, 1080, 1920), media("shot", "image", null, 1280, 800)])
  return placeMedia(p, "wide").project
}
const FRAME = { W: 1080, H: 1920, sw: 1920, sh: 1080 }

/** A subject walking from the left third to the right third over 10 s, with detector noise. */
function walking(noise = 0.02): Subject {
  const samples: Sample[] = []
  let seed = 7
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280 - 0.5) * 2
  for (let t = 0; t <= 10; t += 0.2) samples.push({ t, cx: 0.3 + 0.4 * (t / 10) + rnd() * noise, cy: 0.45 + rnd() * noise, w: 0.1, h: 0.2, conf: 0.9 })
  return { id: "s1", coverage: 1, size: 0.02, samples }
}

describe("reframe math", () => {
  it("resamples with gap filling and smooths with a dead zone", () => {
    const rs = resample([{ t: 0, cx: 0, cy: 0, w: 0, h: 0, conf: 1 }, { t: 2, cx: 1, cy: 1, w: 0, h: 0, conf: 1 }], 0, 2, 0.5)
    expect(rs.map((r) => r.cx)).toEqual([0, 0.25, 0.5, 0.75, 1])
    const noisy = Array.from({ length: 50 }, (_, i) => 0.5 + (i % 2 ? 0.05 : -0.05))
    expect(jitter(smooth(noisy, 3))).toBeLessThan(jitter(noisy) / 10)
    const dz = deadZone([0, 0.01, 0.02, 0.03, 0.2, 0.2], 0.05)
    expect(dz.slice(0, 4)).toEqual([0, 0, 0, 0])
    expect(dz[4]).toBeCloseTo(0.15, 9)
    expect(dz[5]).toBeCloseTo(0.15, 9)
    expect(simplify([{ t: 0, v: 0 }, { t: 1, v: 0.5 }, { t: 2, v: 1 }, { t: 3, v: 0 }], 0.01).map((p) => p.t)).toEqual([0, 2, 3])
  })

  it("keeps the subject centered and never shows the edge", () => {
    expect(focusOffset(0.5, 0.5, FRAME)).toEqual({ x: 0, y: 0 })
    const left = focusOffset(0.1, 0.5, FRAME)
    // A fill of 16:9 into 9:16 is 3414 px wide; at most (3414-1080)/2 can be panned.
    expect(left.x).toBeCloseTo((3414 - 1080) / 2 / 1080, 3)
    expect(focusOffset(0.9, 0.5, FRAME).x).toBeCloseTo(-left.x, 3)
    expect(focusOffset(0.3, 0.5, FRAME).x).toBeCloseTo((0.2 * 3414) / 1080, 3)
    expect(sameAspect({ W: 1080, H: 1920, sw: 1080, sh: 1920 })).toBe(true)
    expect(sameAspect(FRAME)).toBe(false)
  })

  it("test C logic: a walking subject yields smooth, sparse keyframes that follow it", () => {
    const p = vertical()
    const clip = p.clips[0]!
    const { x, path } = reframeKeyframes(clip, walking(), FRAME)
    expect(x.length).toBeGreaterThan(1)
    expect(x.length).toBeLessThan(40)
    // Follows left → right: the picture moves from a positive to a negative offset.
    expect(x[0]!.v).toBeGreaterThan(0.3)
    expect(x[x.length - 1]!.v).toBeLessThan(-0.3)
    // Smooth: per-sample motion is small and monotone-ish.
    expect(jitter(path.map((q) => q.x))).toBeLessThan(0.02)
    const noisyPath = reframeKeyframes(clip, walking(0.08), FRAME).path
    expect(jitter(noisyPath.map((q) => q.x))).toBeLessThan(0.025)
    // All keyframes stay on the clip's source range.
    for (const k of x) expect(k.s).toBeGreaterThanOrEqual(clip.in - 1e-9)
  })

  it("applies auto, manual and blur modes and clears them", () => {
    let p = vertical()
    const id = p.clips[0]!.id
    p = applyReframe(p, id, walking(), FRAME, { method: "face" })
    let c = p.clips[0]!
    expect(c.fit).toBe("fill")
    expect(c.reframe).toMatchObject({ mode: "auto", subject: "s1", status: "ok", method: "face" })
    expect(c.keyframes.x!.length).toBeGreaterThan(1)
    // The plan animates x over the clip.
    const plan = renderPlan(p)
    const s0 = itemState(plan.video[0]!, 0.5)
    const s9 = itemState(plan.video[0]!, 9.5)
    expect(s0.x).toBeGreaterThan(s9.x)
    // Weak coverage is reported honestly.
    const weak = applyReframe(p, id, { ...walking(), coverage: 0.5 }, FRAME, { method: "motion" })
    expect(weak.clips[0]!.reframe.status).toBe("weak")
    p = applyFocus(p, id, 0.8, 0.5, FRAME)
    c = p.clips[0]!
    expect(c.reframe.mode).toBe("manual")
    expect(c.keyframes.x).toBeUndefined()
    expect(c.x).toBeLessThan(0)
    p = applyBlurFallback(p, id)
    expect(p.clips[0]!.fit).toBe("blur")
    p = clearReframe(p, id)
    expect(p.clips[0]!).toMatchObject({ fit: "fit", x: 0, y: 0, reframe: { mode: "off" } })
  })

  it("test D logic: a vertical source in a vertical project is not cropped or scaled", () => {
    let p = vertical()
    p = placeMedia(p, "tall", { start: 10 }).project
    const plan = renderPlan(p)
    const tall = plan.video.find((v) => v.mediaId === "tall")!
    expect(tall.fit).toBe("fit")
    expect(tall.scale).toBe(1)
    expect(sameAspect({ W: 1080, H: 1920, sw: 1080, sh: 1920 })).toBe(true)
  })
})

describe("corner pin, masks and regions", () => {
  it("default corners equal the fitted placement; keyframes interpolate", () => {
    let p = vertical()
    const id = p.clips[0]!.id
    const q = defaultCorners(p.clips[0]!, FRAME)
    // 16:9 fitted into 9:16: full width, 608 px tall, centered.
    expect(q[0]).toBeCloseTo(0, 5)
    expect(q[2]).toBeCloseTo(1, 5)
    expect(q[1]).toBeCloseTo(656 / 1920, 5)
    p = setCorners(p, id, q)
    const moved = q.map((v, i) => (i % 2 ? v : v + 0.1)) as typeof q
    p = setCornerKeyframe(p, id, 0, q)
    p = setCornerKeyframe(p, id, 10, moved)
    const mid = cornersAt(p.clips[0]!, 5)!
    expect(mid[0]).toBeCloseTo(0.05, 5)
    const plan = renderPlan(p)
    expect(itemState(plan.video[0]!, 5).corners![0]).toBeCloseTo(0.05, 5)
    // Splitting keeps keyframes on their source frames.
    const { project: sp } = splitAt(p, 4)
    const right = sp.clips.find((c) => c.start === 4)!
    expect(cornersAt(right, 5)![0]).toBeCloseTo(0.05, 5)
    p = removeCornerKeyframe(p, id, 1)
    expect(p.clips[0]!.cornerKeyframes).toHaveLength(1)
    p = setCorners(p, id, null)
    expect(p.clips[0]!).toMatchObject({ corners: null, cornerKeyframes: [] })
  })

  it("homography maps the unit square onto the quad (CSS matrix3d)", () => {
    const src: [number, number][] = [
      [0, 0],
      [100, 0],
      [0, 50],
      [100, 50],
    ]
    const dst: [number, number][] = [
      [10, 5],
      [90, 12],
      [15, 45],
      [85, 40],
    ]
    const H = homography(src, dst)
    for (let i = 0; i < 4; i++) {
      const [x, y] = project(H, ...src[i]!)
      expect(x).toBeCloseTo(dst[i]![0], 6)
      expect(y).toBeCloseTo(dst[i]![1], 6)
    }
    expect(cornerPinCss(100, 50, [10, 5, 90, 12, 15, 45, 85, 40])).toMatch(/^matrix3d\(/)
    // Identity quad gives (nearly) the identity matrix.
    expect(cornerPinCss(100, 50, [0, 0, 100, 0, 0, 50, 100, 50])).toBe("matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)")
  })

  it("masks and regions survive the plan and animate", () => {
    let p = vertical()
    const id = p.clips[0]!.id
    p = setMask(p, id, { shape: "ellipse", feather: 0.1 })
    const { project: q, region } = addRegion(p, id, { kind: "color", color: "#ff0000", x: 0.1, y: 0.2, w: 0.3, h: 0.2 })
    p = updateRegion(q, id, region.id, { shape: "ellipse" })
    p = setRegionKeyframe(p, id, region.id, 0, 0.1, 0.2)
    p = setRegionKeyframe(p, id, region.id, 10, 0.5, 0.2)
    expect(regionAt(p.clips[0]!, p.clips[0]!.regions[0]!, 5).x).toBeCloseTo(0.3, 5)
    const plan = renderPlan(p)
    const it = plan.video[0]!
    expect(it.mask).toMatchObject({ shape: "ellipse", feather: 0.1 })
    expect(it.regions[0]).toMatchObject({ kind: "color", shape: "ellipse", color: "#ff0000" })
    expect(planRegionAt(it.regions[0]!, 5).x).toBeCloseTo(0.3, 5)
    // Round trip through JSON keeps everything; a v2 project without the new fields still parses.
    expect(parseProject(JSON.parse(JSON.stringify(p)))).toEqual(p)
    const stripped = JSON.parse(JSON.stringify(p)) as { clips: Record<string, unknown>[] }
    for (const c of stripped.clips) for (const k of ["motionBlur", "corners", "cornerKeyframes", "mask", "regions", "reframe"]) Reflect.deleteProperty(c, k)
    expect(parseProject(stripped).clips[0]!.reframe.mode).toBe("off")
  })
})

describe("export presets", () => {
  it("recommends bitrates, estimates sizes and flags upscaling", () => {
    expect(recommendedKbps({ width: 1920, height: 1080 }, 30, "high")).toBe(7500)
    expect(recommendedKbps({ width: 3840, height: 2160 }, 30, "high")).toBe(29900)
    expect(recommendedKbps({ width: 3840, height: 2160 }, 60, "high")).toBe(59700)
    expect(estimateBytes(12000, 192, 60)).toBe(91_440_000)
    const p = vertical()
    expect(upscaleInfo(p, { width: 1080, height: 1920 }).upscaled).toBe(false)
    expect(upscaleInfo(p, { width: 2160, height: 3840 })).toMatchObject({ upscaled: true, maxShort: 1080, exportShort: 2160 })
    expect(aspectMismatch(p, "reels")).toBeNull()
    expect(aspectMismatch(p, "youtube")).toBe("16:9")
    expect(aspectMismatch(setFormat(p, "16:9"), "reels")).toBe("9:16")
    expect(aspectMismatch(p, "custom")).toBeNull()
  })
})
