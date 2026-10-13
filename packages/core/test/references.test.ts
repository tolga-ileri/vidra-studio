import { describe, expect, it } from "vitest"

import {
  acceptsReferences,
  compatibleModels,
  composePrompt,
  consistencyGuidance,
  planReferences,
  type ModelDefinition,
  type ParameterSpec,
} from "../src"

const media = (key: string, role: "start_frame" | "end_frame" | "reference", maxItems: number, required = false): ParameterSpec => ({
  key,
  apiField: key,
  label: { en: key, tr: key },
  type: "media",
  mediaKind: "image",
  role,
  minItems: 0,
  maxItems,
  shape: maxItems === 1 ? "url" : "url_array",
  required,
  advanced: false,
})

const model = (id: string, params: ParameterSpec[], extra: Partial<ModelDefinition> = {}): ModelDefinition =>
  ({
    id,
    provider: "higgsfield",
    providerModelId: id,
    displayName: id,
    family: "Seedance",
    workflow: "reference-to-video",
    output: "video",
    prompt: { apiField: "prompt", required: true, maxLength: 2000 },
    params,
    audio: true,
    request: { fixed: {} },
    outputPath: "video.url",
    pricing: { status: "unavailable", currency: "USD", adjustments: [], from: false, source: null, pricingPageUrl: null, verifiedAt: null, maxAgeDays: 120 },
    rules: [],
    capabilities: { maxDurationSec: 30, audio: true, maxOutputs: null },
    availability: "available",
    unverified: [],
    docsUrl: "https://example.com",
    lastVerified: "2026-10-13",
    ...extra,
  }) as ModelDefinition

const refToVideo = model("ref", [media("reference_images", "reference", 3)])
const imgToVideo = model("i2v", [media("start_image", "start_frame", 1, true), media("end_image", "end_frame", 1)])
const textToVideo = model("t2v", [])

const ref = (id: string, refType: Parameters<typeof planReferences>[1][number]["refType"]) => ({ id, refType, url: `https://cdn.example.com/${id}.png`, name: id })

describe("planReferences", () => {
  it("sends characters, products, styles and scenes to the reference input in order", () => {
    const plan = planReferences(refToVideo, [ref("mascot", "character"), ref("bottle", "product"), ref("look", "style")])
    expect(plan.values).toEqual({ reference_images: ["https://cdn.example.com/mascot.png", "https://cdn.example.com/bottle.png", "https://cdn.example.com/look.png"] })
    expect(plan.placed.map((p) => [p.paramKey, p.index])).toEqual([["reference_images", 0], ["reference_images", 1], ["reference_images", 2]])
    expect(plan.unplaced).toEqual([])
  })

  it("reports references that do not fit instead of dropping them", () => {
    const plan = planReferences(refToVideo, [ref("a", "character"), ref("b", "scene"), ref("c", "scene"), ref("d", "scene"), ref("first", "start_frame")])
    expect(plan.unplaced).toEqual([
      { ref: expect.objectContaining({ id: "d" }), reason: "slot_full" },
      { ref: expect.objectContaining({ id: "first" }), reason: "no_slot" },
    ])
    expect((plan.values.reference_images as string[]).length).toBe(3)
  })

  it("maps frames to the documented start and end inputs as single URLs", () => {
    const plan = planReferences(imgToVideo, [ref("first", "start_frame"), ref("last", "end_frame"), ref("mascot", "character")])
    expect(plan.values).toEqual({ start_image: "https://cdn.example.com/first.png", end_image: "https://cdn.example.com/last.png" })
    expect(plan.unplaced).toEqual([{ ref: expect.objectContaining({ id: "mascot" }), reason: "no_slot" }])
    expect(plan.imageKeys).toEqual(["start_image", "end_image"])
  })

  it("text-to-video takes no references at all", () => {
    expect(acceptsReferences(textToVideo, [])).toBe(true)
    expect(acceptsReferences(textToVideo, [ref("m", "character")])).toBe(false)
  })
})

describe("compatibleModels", () => {
  it("prefers the same provider and family, then longer durations", () => {
    const refs = [ref("m", "character")]
    const other = model("other", [media("images", "reference", 5)], { provider: "replicate", family: "Wan", capabilities: { maxDurationSec: 10, audio: false, maxOutputs: null } })
    const sibling = model("sib", [media("reference_images", "reference", 9)], { capabilities: { maxDurationSec: 15, audio: true, maxOutputs: null } })
    const list = compatibleModels([textToVideo, imgToVideo, other, sibling, refToVideo], refs, imgToVideo)
    expect(list.map((m) => m.id)).toEqual(["ref", "sib", "other"])
  })
})

describe("consistency guidance", () => {
  it("numbers references by their position in the request and skips frames", () => {
    const plan = planReferences(model("x", [media("reference_images", "reference", 5), media("start_image", "start_frame", 1)]), [
      ref("first", "start_frame"),
      { id: "m", refType: "character", url: "https://cdn.example.com/m.png", name: 'Zihin "Lab" Mascot' },
      ref("desk", "scene"),
    ])
    const text = consistencyGuidance(plan, true)
    expect(text).toContain('Reference image 1 shows the character "Zihin  Lab  Mascot"')
    expect(text).toContain('Use reference image 2 ("desk") as the setting')
    expect(text).not.toContain("first")
    expect(consistencyGuidance(plan, false)).toBe("")
  })

  it("never truncates: reports when the prompt would exceed the limit", () => {
    expect(composePrompt("A fox", "Keep it.", 100)).toEqual({ text: "A fox\n\nKeep it.", fits: true })
    expect(composePrompt("A fox", "Keep it.", 10).fits).toBe(false)
    expect(composePrompt("  ", "", 10)).toEqual({ text: "", fits: true })
  })
})
