import { describe, expect, it } from "vitest"

import {
  carryOver,
  deriveArchiveState,
  parseManifest,
  parsePromptExport,
  renderTemplate,
  requestedDuration,
  templateVariables,
  validateParams,
  variableLabel,
  type ModelDefinition,
} from "../src"
import { job } from "./fixtures"

const model = (overrides: Partial<ModelDefinition> = {}): ModelDefinition =>
  ({
    id: "replicate:test/video",
    provider: "replicate",
    providerModelId: "test/video",
    displayName: "Test",
    family: "Test",
    workflow: "image-to-video",
    output: "video",
    prompt: { apiField: "prompt", required: true, maxLength: 100 },
    params: [
      { key: "duration", apiField: "duration", label: { en: "Duration", tr: "Süre" }, type: "enum", values: ["5", "10"], default: "5", valueType: "number", required: false, advanced: false },
      { key: "seed", apiField: "seed", label: { en: "Seed", tr: "Tohum" }, type: "seed", min: 0, max: 100, required: false, advanced: true },
      { key: "image", apiField: "image_url", label: { en: "Image", tr: "Görsel" }, type: "media", mediaKind: "image", role: "start_frame", maxItems: 1, shape: "url", required: true, advanced: false },
      { key: "audio", apiField: "generate_audio", label: { en: "Audio", tr: "Ses" }, type: "boolean", default: false, required: false, advanced: false },
    ],
    audio: true,
    request: { fixed: {} },
    outputPath: "video.url",
    pricing: { status: "unavailable", currency: "USD", adjustments: [], from: false, source: null, pricingPageUrl: null, verifiedAt: null, maxAgeDays: 120 },
    rules: [],
    capabilities: { maxDurationSec: null, audio: true, maxOutputs: null },
    availability: "available",
    unverified: [],
    docsUrl: "https://example.com/docs",
    lastVerified: "2026-10-11",
    ...overrides,
  }) as ModelDefinition

describe("prompt templates", () => {
  const body = "A cinematic shot of {subject} in {location}, with {lighting}, {subject} again {{literal}}"

  it("lists unique variables in order", () => {
    expect(templateVariables(body)).toEqual(["subject", "location", "lighting"])
  })

  it("substitutes values, keeps missing ones visible and escapes braces", () => {
    const r = renderTemplate(body, { subject: "a fox", location: "  snow " })
    expect(r.text).toBe("A cinematic shot of a fox in snow, with {lighting}, a fox again {literal}")
    expect(r.missing).toEqual(["lighting"])
  })

  it("does not re-expand placeholders inside values", () => {
    expect(renderTemplate("{a} {b}", { a: "{b}", b: "x" }).text).toBe("{b} x")
  })

  it("ignores invalid placeholder names", () => {
    expect(templateVariables("{1bad} {bad-name} {ok_1}")).toEqual(["ok_1"])
    expect(variableLabel("camera_movement")).toBe("Camera movement")
  })
})

describe("prompt import/export validation", () => {
  const valid = {
    format: "vidra.prompts",
    formatVersion: 1,
    exportedAt: "2026-10-11T10:00:00.000Z",
    categories: [{ name: "Sports" }],
    prompts: [
      {
        title: "Goal",
        body: "A {player} scores",
        category: "Sports",
        tags: ["football"],
        favorite: true,
        preferredModelIds: ["fal:test/video"],
        parameters: { duration: "5" },
        variableDefaults: { player: "striker" },
      },
    ],
  }

  it("accepts a valid export", () => {
    expect(parsePromptExport(JSON.stringify(valid)).prompts).toHaveLength(1)
  })

  it.each([
    ["wrong format", { ...valid, format: "other" }],
    ["unknown top-level key", { ...valid, apiKey: "sk-123" }],
    ["unknown prompt key", { ...valid, prompts: [{ ...valid.prompts[0], secret: "x" }] }],
    ["oversized title", { ...valid, prompts: [{ ...valid.prompts[0], title: "x".repeat(200) }] }],
    ["bad parameter key", { ...valid, prompts: [{ ...valid.prompts[0], parameters: { "bad key": 1 } }] }],
  ])("rejects %s", (_name, data) => {
    expect(() => parsePromptExport(JSON.stringify(data))).toThrow()
  })

  it("rejects prototype pollution, invalid JSON and huge files", () => {
    expect(() =>
      parsePromptExport(JSON.stringify(valid).replace('"categories"', '"__proto__":{"x":1},"categories"'))
    ).toThrow(/forbidden/)
    expect(() => parsePromptExport("{not json")).toThrow(/valid JSON/)
    expect(() => parsePromptExport("x".repeat(6 * 1024 * 1024))).toThrow(/too large/)
  })
})

describe("parameters", () => {
  it("validates against the manifest and rejects unknown keys", () => {
    const m = model()
    expect(validateParams(m, { duration: "10", image: "https://cdn.example.com/a.png" })).toEqual({
      duration: "10",
      image: ["https://cdn.example.com/a.png"],
    })
    expect(() => validateParams(m, { image: "https://cdn.example.com/a.png", webhook: "x" })).toThrow(/Unknown/)
    expect(() => validateParams(m, { duration: "7", image: "https://cdn.example.com/a.png" })).toThrow()
    expect(() => validateParams(m, { duration: "5" })).toThrow(/required/)
  })

  it.each(["http://cdn.example.com/a.png", "file:///etc/passwd", "javascript:alert(1)", "https://localhost/a"])(
    "rejects media URL %s",
    (url) => {
      expect(() => validateParams(model(), { image: url })).toThrow()
    }
  )

  it("rejects out-of-range seeds and non-booleans", () => {
    const image = "https://cdn.example.com/a.png"
    expect(() => validateParams(model(), { image, seed: 101 })).toThrow()
    expect(() => validateParams(model(), { image, seed: 1.5 })).toThrow()
    expect(() => validateParams(model(), { image, audio: "yes" as unknown as boolean })).toThrow()
  })

  it("carries compatible values when switching models", () => {
    const next = model({ params: [model().params[0]!] })
    expect(carryOver({ duration: "10", seed: 4 }, next)).toEqual({ duration: "10" })
    expect(carryOver({ duration: "99" }, next)).toEqual({ duration: "5" })
    expect(requestedDuration(next, { duration: "10" })).toBe(10)
  })
})

describe("manifest validation", () => {
  const manifest = (models: ModelDefinition[]) => ({
    format: "vidra.models",
    formatVersion: 2,
    provider: "replicate",
    version: "2026.10.11",
    source: "manifest",
    models,
  })

  it("accepts a consistent manifest", () => {
    expect(parseManifest(manifest([model()])).models).toHaveLength(1)
  })

  it("rejects duplicate ids, provider mismatch and duplicated api fields", () => {
    expect(() => parseManifest(manifest([model(), model()]))).toThrow(/duplicate/)
    expect(() => parseManifest(manifest([model({ provider: "kling", id: "kling:x" })]))).toThrow()
    const dup = model()
    dup.params = [...dup.params, { ...dup.params[3]!, key: "audio2" }]
    expect(() => parseManifest(manifest([dup]))).toThrow(/apiField/)
  })

  it("requires a media input for image-to-video models", () => {
    expect(() => parseManifest(manifest([model({ params: [] })]))).toThrow(/media/)
  })
})

describe("archive state", () => {
  it("never reports saved without a persisted file", () => {
    const j = job()
    const asset = {
      id: "a", jobId: j.id, outputIndex: 0, kind: "video" as const, originalUrl: "", localPath: null,
      filename: "", mimeType: null, sizeBytes: null, sha256: null, durationSec: null, width: null,
      height: null, thumbnailPath: null, downloadStatus: "saved" as const, duplicateOfAssetId: null, createdAt: 0,
    }
    expect(deriveArchiveState(j, asset, null, null)).toBe("missing")
    expect(deriveArchiveState(j, { ...asset, localPath: "media/a.mp4" }, null, null)).toBe("saved")
    expect(deriveArchiveState(job({ status: "generating" }), null, null, null)).toBe("generating")
    expect(deriveArchiveState(j, { ...asset, downloadStatus: "failed" }, null, null)).toBe("download_failed")
    expect(
      deriveArchiveState(j, asset, { id: "i", assetId: "a", projectId: null, customTitle: null, favorite: false, tags: [], deletedAt: 1 }, null)
    ).toBe("trashed")
  })
})
