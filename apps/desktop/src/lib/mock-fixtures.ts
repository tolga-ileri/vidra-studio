import { parseManifest, type ModelDefinition, type ProviderId } from "@vidra/core"

/**
 * Fictional v2 models for the browser preview and tests. They exercise every
 * form/pricing feature (rules, valueLabels, long discrete lists, media limits,
 * credits, outdated and compute-time pricing) without depending on the
 * bundled manifests, which are maintained separately.
 */

const DAY = 86_400_000
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)
/** Recent enough to never be "outdated" (maxAgeDays 120). */
const FRESH = isoDay(Date.now() - 10 * DAY)
const STALE = "2025-01-15"
const L = (en: string, tr: string) => ({ en, tr })

const pricingUrl = "https://example.com/pricing"
const docsUrl = "https://example.com/docs"

const cinema = {
  id: "replicate:demo/cinema-t2v",
  provider: "replicate",
  providerModelId: "demo/cinema-t2v",
  displayName: "Demo Cinema",
  family: "Demo Cinema",
  version: "2.0",
  workflow: "text-to-video",
  output: "video",
  description: L("Long cinematic shots with optional audio.", "İsteğe bağlı sesli uzun sinematik çekimler."),
  prompt: { apiField: "prompt", required: true, maxLength: 2000 },
  negativePrompt: { apiField: "negative_prompt", maxLength: 500 },
  params: [
    {
      key: "duration",
      apiField: "duration",
      label: L("Duration", "Süre"),
      type: "enum",
      values: ["auto", 5, 10, 15, 30],
      default: 5,
      valueType: "number",
      unit: "s",
      valueLabels: { auto: L("Auto", "Otomatik") },
    },
    { key: "resolution", apiField: "resolution", label: L("Resolution", "Çözünürlük"), type: "enum", values: ["720p", "1080p", "4k"], default: "720p" },
    { key: "aspect_ratio", apiField: "aspect_ratio", label: L("Aspect ratio", "En boy oranı"), type: "enum", values: ["16:9", "9:16", "1:1"], default: "16:9" },
    { key: "audio", apiField: "generate_audio", label: L("Audio", "Ses"), type: "boolean", default: false },
    { key: "fps", apiField: "fps", label: L("Frame rate", "Kare hızı"), type: "integer", min: 12, max: 60, step: 12, default: 24, unit: "fps", advanced: true },
    { key: "seed", apiField: "seed", label: L("Seed", "Tohum"), type: "seed", advanced: true },
  ],
  rules: [
    { id: "4k-short", when: { param: "resolution", op: "eq", value: "4k" }, then: [{ op: "max", param: "duration", value: 10 }], message: L("4K is limited to 10 seconds.", "4K en fazla 10 saniye olabilir.") },
    { id: "auto-no-4k", when: { param: "duration", op: "eq", value: "auto" }, then: [{ op: "in", param: "resolution", values: ["720p", "1080p"] }], message: L("Auto duration is not available in 4K.", "Otomatik süre 4K'da kullanılamaz.") },
    { id: "audio-fps", when: { param: "audio", op: "eq", value: true }, then: [{ op: "max", param: "fps", value: 30 }], message: L("With audio the frame rate is limited to 30 fps.", "Ses açıkken kare hızı en fazla 30 fps olabilir.") },
  ],
  capabilities: { maxDurationSec: 30, audio: true, maxOutputs: 1 },
  outputPath: "output",
  pricing: {
    status: "verified",
    currency: "USD",
    formula: { kind: "per_second", rate: 0.1 },
    adjustments: [
      { when: { param: "resolution", op: "eq", value: "4k" }, rate: 0.4 },
      { when: { param: "resolution", op: "eq", value: "1080p" }, rate: 0.2 },
      { when: { param: "audio", op: "eq", value: true }, multiplier: 1.5 },
    ],
    source: pricingUrl,
    pricingPageUrl: pricingUrl,
    verifiedAt: FRESH,
  },
  docsUrl,
  lastVerified: FRESH,
}

const motion = {
  id: "replicate:demo/motion-i2v",
  provider: "replicate",
  providerModelId: "demo/motion-i2v",
  displayName: "Demo Motion",
  family: "Demo Motion",
  workflow: "image-to-video",
  output: "video",
  prompt: { apiField: "prompt", required: false, maxLength: 1000 },
  params: [
    { key: "duration", apiField: "duration", label: L("Duration", "Süre"), type: "enum", values: [4, 5, 6, 8, 10, 12, 15, 20, 30], default: 5, valueType: "number", unit: "s" },
    { key: "image", apiField: "image", label: L("Start frame", "Başlangıç karesi"), type: "media", mediaKind: "image", role: "start_frame", maxItems: 1, formats: ["jpg", "png", "webp"], maxSizeMb: 10 },
    {
      key: "reference_images",
      apiField: "reference_images",
      label: L("Reference images", "Referans görseller"),
      type: "media",
      mediaKind: "image",
      role: "reference",
      minItems: 0,
      maxItems: 4,
      shape: "url_array",
      formats: ["jpg", "png", "webp"],
      maxSizeMb: 10,
    },
  ],
  rules: [
    { id: "needs-input", then: [{ op: "anyOf", params: ["image", "reference_images"] }], message: L("Add a start frame or a reference.", "Bir başlangıç karesi veya referans ekleyin.") },
    { id: "frames-xor-refs", when: { param: "image", op: "present" }, then: [{ op: "forbidden", param: "reference_images" }], message: L("Use either a start frame or references.", "Ya başlangıç karesi ya da referans kullanın.") },
  ],
  capabilities: { maxDurationSec: 30, audio: false, maxOutputs: 1 },
  outputPath: "output",
  pricing: {
    status: "verified",
    currency: "USD",
    formula: { kind: "per_second", rate: 0.05 },
    from: true,
    source: pricingUrl,
    pricingPageUrl: pricingUrl,
    verifiedAt: FRESH,
  },
  docsUrl,
  lastVerified: FRESH,
}

const archived = {
  id: "replicate:demo/archive-t2v",
  provider: "replicate",
  providerModelId: "demo/archive-t2v",
  displayName: "Demo Archive Cut",
  family: "Demo Archive",
  workflow: "text-to-video",
  output: "video",
  prompt: { apiField: "prompt", required: true, maxLength: 1000 },
  params: [{ key: "duration", apiField: "duration", label: L("Duration", "Süre"), type: "enum", values: [5, 10], default: 5, valueType: "number", unit: "s" }],
  capabilities: { maxDurationSec: 10, audio: false, maxOutputs: 1 },
  outputPath: "output",
  pricing: {
    status: "verified",
    currency: "USD",
    formula: { kind: "per_second", rate: 0.08 },
    source: pricingUrl,
    pricingPageUrl: pricingUrl,
    verifiedAt: STALE,
  },
  docsUrl,
  lastVerified: STALE,
}

const units = {
  id: "kling:demo/units-t2v",
  provider: "kling",
  providerModelId: "demo/units-t2v",
  displayName: "Demo Units",
  family: "Demo Units",
  workflow: "text-to-video",
  output: "video",
  prompt: { apiField: "prompt", required: true, maxLength: 2500 },
  params: [
    { key: "duration", apiField: "duration", label: L("Duration", "Süre"), type: "enum", values: [5, 10], default: 5, valueType: "string", unit: "s" },
    { key: "mode", apiField: "mode", label: L("Mode", "Mod"), type: "enum", values: ["std", "pro"], default: "std", valueLabels: { std: L("Standard", "Standart"), pro: L("Professional", "Profesyonel") } },
  ],
  capabilities: { maxDurationSec: 10, audio: false, maxOutputs: 1 },
  outputPath: "data.task_result.videos[].url",
  pricing: {
    status: "verified",
    currency: "credits",
    unitName: "Kling units",
    formula: { kind: "per_second", rate: 1 },
    adjustments: [{ when: { param: "mode", op: "eq", value: "pro" }, multiplier: 1.75 }],
    source: pricingUrl,
    pricingPageUrl: pricingUrl,
    verifiedAt: FRESH,
  },
  docsUrl,
  lastVerified: FRESH,
}

const quote = {
  id: "higgsfield:demo/quote-t2v",
  provider: "higgsfield",
  providerModelId: "demo/quote-t2v",
  displayName: "Demo Quote",
  family: "Demo Quote",
  workflow: "text-to-video",
  output: "video",
  prompt: { apiField: "prompt", required: true, maxLength: 1500 },
  params: [{ key: "duration", apiField: "duration", label: L("Duration", "Süre"), type: "integer", min: 3, max: 12, step: 1, default: 5, unit: "s" }],
  capabilities: { maxDurationSec: 12, audio: false, maxOutputs: 1 },
  outputPath: "output",
  pricing: { status: "provider_estimate", currency: "USD", source: null, pricingPageUrl: pricingUrl, verifiedAt: null },
  docsUrl,
  lastVerified: FRESH,
}

const still = {
  id: "replicate:demo/still-t2i",
  provider: "replicate",
  providerModelId: "demo/still-t2i",
  displayName: "Demo Still",
  family: "Demo Still",
  workflow: "text-to-image",
  output: "image",
  prompt: { apiField: "prompt", required: true, maxLength: 2000 },
  params: [
    { key: "num_outputs", apiField: "num_outputs", label: L("Images", "Görsel sayısı"), type: "integer", min: 1, max: 4, step: 1, default: 1 },
    { key: "width", apiField: "width", label: L("Width", "Genişlik"), type: "integer", min: 256, max: 2048, step: 64, default: 1024, unit: "px" },
    { key: "height", apiField: "height", label: L("Height", "Yükseklik"), type: "integer", min: 256, max: 2048, step: 64, default: 1024, unit: "px" },
  ],
  rules: [{ id: "pixels", then: [{ op: "maxProduct", params: ["width", "height"], value: 2097152 }], message: L("At most 2 megapixels.", "En fazla 2 megapiksel.") }],
  capabilities: { maxDurationSec: null, audio: false, maxOutputs: 4 },
  outputPath: "output[]",
  pricing: {
    status: "verified",
    currency: "USD",
    formula: { kind: "per_megapixel", rate: 0.03, widthParam: "width", heightParam: "height", countParam: "num_outputs" },
    source: pricingUrl,
    pricingPageUrl: pricingUrl,
    verifiedAt: FRESH,
  },
  docsUrl,
  lastVerified: FRESH,
}

const retouch = {
  id: "replicate:demo/retouch-edit",
  provider: "replicate",
  providerModelId: "demo/retouch-edit",
  displayName: "Demo Retouch",
  family: "Demo Retouch",
  workflow: "image-edit",
  output: "image",
  prompt: { apiField: "prompt", required: true, maxLength: 1000 },
  params: [
    { key: "image", apiField: "image", label: L("Source image", "Kaynak görsel"), type: "media", mediaKind: "image", role: "reference", required: true, maxItems: 1, formats: ["jpg", "png"], maxSizeMb: 20 },
  ],
  capabilities: { maxDurationSec: null, audio: false, maxOutputs: 1 },
  outputPath: "output",
  pricing: {
    status: "verified",
    currency: "USD",
    formula: { kind: "compute_time", ratePerSecond: 0.001, hardware: "GPU" },
    source: pricingUrl,
    pricingPageUrl: pricingUrl,
    verifiedAt: FRESH,
  },
  docsUrl,
  lastVerified: FRESH,
}

/** Known to the registry, but needs a newer app version (never executable). */
const future = {
  ...cinema,
  id: "replicate:demo/future-t2v",
  providerModelId: "demo/future-t2v",
  displayName: "Demo Future",
  family: "Demo Future",
}

function build(raw: Array<Record<string, unknown>>): ModelDefinition[] {
  const byProvider = new Map<ProviderId, Array<Record<string, unknown>>>()
  for (const m of raw) {
    const p = m.provider as ProviderId
    byProvider.set(p, [...(byProvider.get(p) ?? []), m])
  }
  const out: ModelDefinition[] = []
  for (const [provider, models] of byProvider)
    out.push(
      ...parseManifest({ format: "vidra.models", formatVersion: 2, provider, version: "2026.10.01", source: "manifest", models }).models
    )
  return out
}

export const FIXTURE_MODELS: ModelDefinition[] = build([cinema, motion, archived, units, quote, still, retouch])
export const FIXTURE_FUTURE_MODEL: ModelDefinition = build([future])[0]!
export const FIXTURE_IDS = {
  cinema: cinema.id,
  motion: motion.id,
  archived: archived.id,
  units: units.id,
  quote: quote.id,
  still: still.id,
  retouch: retouch.id,
  future: future.id,
} as const
