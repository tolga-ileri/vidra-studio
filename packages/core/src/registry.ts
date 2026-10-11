import { z } from "zod"

/**
 * Normalized model registry (manifest format v2).
 *
 * Each provider ships a versioned JSON manifest
 * (packages/core/manifests/<provider>.json) that BOTH the TypeScript UI and
 * the Rust backend read:
 *   - the UI renders forms only from `params` and `rules` (never invents fields);
 *   - Rust re-validates every value and every rule, and builds the provider
 *     request body from `apiField` + `request.fixed`.
 * Conditional rules and pricing formulas are data, evaluated by two
 * independent implementations (core/src/rules.ts, core/src/pricing.ts and
 * src-tauri/src/manifest.rs) that are checked against shared test vectors
 * (packages/core/test/vectors/*.json).
 *
 * Remote catalog updates (signed registry) use exactly this format; nothing
 * in a manifest is ever executed.
 */

export const MANIFEST_FORMAT_VERSION = 2

/** Providers with a native adapter in this build. fal.ai is intentionally not
    listed: its integration is excluded pending provider authorization. */
export const PROVIDER_IDS = ["higgsfield", "replicate", "kling"] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export const WORKFLOWS = [
  "text-to-video",
  "image-to-video",
  "reference-to-video",
  "video-to-video",
  "video-edit",
  "video-extend",
  "text-to-image",
  "image-to-image",
  "image-edit",
] as const
export type Workflow = (typeof WORKFLOWS)[number]

export const localized = z.object({ en: z.string().min(1), tr: z.string().min(1) })
export type Localized = z.infer<typeof localized>

const paramKey = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/)
/** Provider request field names (camelCase/snake_case, dotted for nesting). */
const apiField = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/)
const scalar = z.union([z.string().max(200), z.number().finite(), z.boolean()])

const base = {
  key: paramKey,
  apiField,
  label: localized,
  /** Short capability description shown under the control. */
  help: localized.optional(),
  required: z.boolean().default(false),
  advanced: z.boolean().default(false),
}

export const parameterSpecSchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("enum"),
    values: z.array(z.union([z.string().max(100), z.number().finite()])).min(1).max(200),
    default: z.union([z.string(), z.number()]).optional(),
    /** Send the value as a number even if it is stored as text. */
    valueType: z.enum(["string", "number"]).default("string"),
    /** Optional display labels per value, e.g. {"auto": {en:"Auto", tr:"Otomatik"}}. */
    valueLabels: z.record(z.string(), localized).optional(),
    /** Unit suffix for display ("s", "fps"…). */
    unit: z.string().max(8).optional(),
  }),
  z.object({
    ...base,
    type: z.enum(["integer", "number"]),
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().positive().optional(),
    default: z.number().finite().optional(),
    unit: z.string().max(8).optional(),
  }),
  z.object({
    ...base,
    type: z.literal("boolean"),
    default: z.boolean().optional(),
    /** Some APIs expect strings (e.g. ["native","off"]) instead of booleans. */
    encode: z.tuple([z.string(), z.string()]).optional(),
  }),
  z.object({
    ...base,
    type: z.literal("seed"),
    min: z.number().int().default(0),
    max: z.number().int().default(2147483647),
  }),
  z.object({
    ...base,
    type: z.literal("text"),
    maxLength: z.number().int().positive().max(20000),
    multiline: z.boolean().default(false),
  }),
  z.object({
    ...base,
    type: z.literal("media"),
    mediaKind: z.enum(["image", "video", "audio"]),
    role: z.enum(["start_frame", "end_frame", "reference", "source_video", "audio", "mask"]),
    minItems: z.number().int().min(0).max(50).default(0),
    maxItems: z.number().int().min(1).max(50).default(1),
    shape: z.enum(["url", "url_array"]).default("url"),
    /** Documented input limits, for display and native validation. */
    maxSizeMb: z.number().positive().max(2048).optional(),
    formats: z.array(z.string().regex(/^[a-z0-9]{2,5}$/)).max(12).optional(),
    maxDurationSec: z.number().positive().optional(),
  }),
])
export type ParameterSpec = z.infer<typeof parameterSpecSchema>

/* ── Conditional capability rules ──────────────────────────────────────── */

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { param: string; op: "eq" | "neq"; value: string | number | boolean }
  | { param: string; op: "in" | "notIn"; values: Array<string | number> }
  | { param: string; op: "present" | "absent" }

export const conditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionSchema).min(1).max(10) }).strict(),
    z.object({ any: z.array(conditionSchema).min(1).max(10) }).strict(),
    z.object({ param: paramKey, op: z.enum(["eq", "neq"]), value: scalar }).strict(),
    z
      .object({ param: paramKey, op: z.enum(["in", "notIn"]), values: z.array(z.union([z.string(), z.number()])).min(1) })
      .strict(),
    z.object({ param: paramKey, op: z.enum(["present", "absent"]) }).strict(),
  ])
)

export const constraintSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("required"), param: paramKey }).strict(),
  z.object({ op: z.literal("forbidden"), param: paramKey }).strict(),
  z.object({ op: z.literal("in"), param: paramKey, values: z.array(z.union([z.string(), z.number()])).min(1) }).strict(),
  z.object({ op: z.literal("max"), param: paramKey, value: z.number().finite() }).strict(),
  z.object({ op: z.literal("min"), param: paramKey, value: z.number().finite() }).strict(),
  /** At least one of the parameters (or the prompt, key "prompt") is present. */
  z.object({ op: z.literal("anyOf"), params: z.array(z.string()).min(2) }).strict(),
  /** Total number of media items across the parameters is ≤ value. */
  z.object({ op: z.literal("maxTotalItems"), params: z.array(paramKey).min(2), value: z.number().int().positive() }).strict(),
  /** Product of numeric parameters (e.g. width × height) is ≤ value. */
  z.object({ op: z.literal("maxProduct"), params: z.array(paramKey).min(2), value: z.number().positive() }).strict(),
])
export type Constraint = z.infer<typeof constraintSchema>

export const ruleSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,48}$/),
    /** Omitted = always applies. */
    when: conditionSchema.optional(),
    then: z.array(constraintSchema).min(1).max(10),
    message: localized,
  })
  .strict()
export type Rule = z.infer<typeof ruleSchema>

/* ── Pricing ────────────────────────────────────────────────────────────── */

export const pricingFormulaSchema = z.discriminatedUnion("kind", [
  /** rate × seconds (from the duration parameter or `fixedSeconds`). */
  z.object({ kind: z.literal("per_second"), rate: z.number().nonnegative(), durationParam: paramKey.optional(), fixedSeconds: z.number().positive().optional() }).strict(),
  /** rate × number of outputs (count parameter, default 1). */
  z.object({ kind: z.literal("per_output"), rate: z.number().nonnegative(), countParam: paramKey.optional() }).strict(),
  /** rate × megapixels × outputs; dimensions from parameters. */
  z
    .object({
      kind: z.literal("per_megapixel"),
      rate: z.number().nonnegative(),
      widthParam: paramKey,
      heightParam: paramKey,
      countParam: paramKey.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("per_request"), rate: z.number().nonnegative() }).strict(),
  /** Billed by hardware time: no reliable pre-run estimate exists. */
  z.object({ kind: z.literal("compute_time"), ratePerSecond: z.number().nonnegative(), hardware: z.string().max(60) }).strict(),
])
export type PricingFormula = z.infer<typeof pricingFormulaSchema>

export const pricingSchema = z
  .object({
    /** "verified": rates below were read from `source` on `verifiedAt`.
        "provider_estimate": the provider's own estimate API is authoritative.
        "unavailable": no verifiable price (shown as "Pricing unavailable"). */
    status: z.enum(["verified", "provider_estimate", "unavailable"]),
    /** ISO currency code, or "credits" for provider-specific units (never
        converted to money by Vidra). */
    currency: z.union([z.literal("USD"), z.literal("credits")]),
    /** Display name of non-monetary units, e.g. "Kling units". */
    unitName: z.string().max(40).optional(),
    formula: pricingFormulaSchema.optional(),
    /** Ordered modifiers: the first matching `rate` override replaces the
        base rate; every matching `multiplier` is applied. */
    adjustments: z
      .array(
        z
          .object({
            when: conditionSchema,
            rate: z.number().nonnegative().optional(),
            multiplier: z.number().positive().optional(),
            note: z.string().max(200).optional(),
          })
          .strict()
      )
      .max(40)
      .default([]),
    /** The published figure is a starting ("from") price. */
    from: z.boolean().default(false),
    source: z.string().url().nullable(),
    pricingPageUrl: z.string().url().nullable(),
    verifiedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    /** Prices older than this are treated as unavailable ("outdated"). */
    maxAgeDays: z.number().int().positive().max(365).default(120),
    notes: z.string().max(500).optional(),
  })
  .strict()
export type Pricing = z.infer<typeof pricingSchema>

/* ── Model ──────────────────────────────────────────────────────────────── */

export const modelDefinitionSchema = z.object({
  /** Globally unique: "<provider>:<providerModelId>[#variant]". */
  id: z.string().regex(/^[a-z]+:[A-Za-z0-9._/#:-]{1,160}$/),
  provider: z.enum(PROVIDER_IDS),
  providerModelId: z.string().min(1).max(160),
  displayName: z.string().min(1).max(80),
  family: z.string().min(1).max(60),
  /** Exact model version as named by the provider (e.g. "2.0", "v3.0"). */
  version: z.string().max(40).optional(),
  workflow: z.enum(WORKFLOWS),
  output: z.enum(["video", "image"]),
  description: localized.optional(),
  /** "available" | "deprecated" (still callable, scheduled for removal) |
      "discontinued" (not callable). */
  availability: z.enum(["available", "deprecated", "discontinued"]).default("available"),
  prompt: z.object({ apiField, required: z.boolean(), maxLength: z.number().int().positive().max(20000) }),
  negativePrompt: z.object({ apiField, maxLength: z.number().int().positive() }).optional(),
  params: z.array(parameterSpecSchema),
  rules: z.array(ruleSchema).max(60).default([]),
  /** Facts for comparison/filtering; must agree with params (checked). */
  capabilities: z
    .object({
      maxDurationSec: z.number().positive().nullable().default(null),
      audio: z.boolean().default(false),
      maxOutputs: z.number().int().positive().nullable().default(null),
    })
    .default({ maxDurationSec: null, audio: false, maxOutputs: null }),
  request: z
    .object({
      path: z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/i).optional(),
      fixed: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
    })
    .default({ fixed: {} }),
  outputPath: z.string().regex(/^[a-z_][a-z0-9_]*(\[\])?(\.[a-z_][a-z0-9_]*(\[\])?)*$/i),
  pricing: pricingSchema,
  docsUrl: z.string().url(),
  /** Version of the provider's input schema this entry was verified against. */
  schemaVersion: z.string().max(80).optional(),
  lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Capabilities documented but deliberately not exposed (with reason). */
  unverified: z.array(z.string().max(200)).max(30).default([]),
})
export type ModelDefinition = z.infer<typeof modelDefinitionSchema>

export const manifestSchema = z.object({
  format: z.literal("vidra.models"),
  formatVersion: z.literal(MANIFEST_FORMAT_VERSION),
  provider: z.enum(PROVIDER_IDS),
  version: z.string().regex(/^\d{4}\.\d{2}\.\d{2}(\.\d+)?$/),
  source: z.enum(["manifest", "registry", "api"]),
  models: z.array(modelDefinitionSchema),
})
export type ModelManifest = z.infer<typeof manifestSchema>

const MEDIA_WORKFLOWS: Workflow[] = [
  "image-to-video",
  "reference-to-video",
  "video-to-video",
  "video-edit",
  "video-extend",
  "image-to-image",
  "image-edit",
]

function conditionParams(c: Condition, out: Set<string>): void {
  if ("all" in c) c.all.forEach((x) => conditionParams(x, out))
  else if ("any" in c) c.any.forEach((x) => conditionParams(x, out))
  else out.add(c.param)
}

/** Parses and cross-checks a manifest; throws with a precise message. */
export function parseManifest(raw: unknown): ModelManifest {
  const manifest = manifestSchema.parse(raw)
  const ids = new Set<string>()
  for (const model of manifest.models) {
    const where = model.id
    if (model.provider !== manifest.provider) throw new Error(`${where}: provider does not match manifest`)
    if (!model.id.startsWith(`${model.provider}:`)) throw new Error(`${where}: id must start with "${model.provider}:"`)
    if (ids.has(model.id)) throw new Error(`${where}: duplicate model id`)
    ids.add(model.id)

    const keys = new Set<string>()
    const fields = new Set<string>([model.prompt.apiField])
    if (model.negativePrompt) fields.add(model.negativePrompt.apiField)
    for (const field of Object.keys(model.request.fixed)) fields.add(field)
    for (const p of model.params) {
      if (keys.has(p.key)) throw new Error(`${where}: duplicate param ${p.key}`)
      keys.add(p.key)
      if (fields.has(p.apiField)) throw new Error(`${where}: apiField ${p.apiField} used twice`)
      fields.add(p.apiField)
      if (p.type === "enum" && p.default !== undefined && !p.values.some((v) => String(v) === String(p.default)))
        throw new Error(`${where}: default for ${p.key} not in values`)
      if ((p.type === "integer" || p.type === "number") && p.min > p.max) throw new Error(`${where}: ${p.key} min > max`)
      if ((p.type === "integer" || p.type === "number") && p.default !== undefined && (p.default < p.min || p.default > p.max))
        throw new Error(`${where}: default for ${p.key} out of range`)
      if (p.type === "media" && p.minItems > p.maxItems) throw new Error(`${where}: ${p.key} minItems > maxItems`)
    }
    const known = new Set([...keys, "prompt", "negative_prompt"])
    for (const rule of model.rules) {
      const used = new Set<string>()
      if (rule.when) conditionParams(rule.when, used)
      for (const c of rule.then) {
        if ("param" in c) used.add(c.param)
        if ("params" in c) c.params.forEach((x) => used.add(x))
      }
      for (const k of used) if (!known.has(k)) throw new Error(`${where}: rule ${rule.id} references unknown param ${k}`)
    }
    if (MEDIA_WORKFLOWS.includes(model.workflow)) {
      const media = model.params.filter((p) => p.type === "media")
      const anyOf = model.rules.some((r) => !r.when && r.then.some((c) => c.op === "anyOf"))
      if (!media.some((p) => p.required) && !(media.length && anyOf))
        throw new Error(`${where}: ${model.workflow} requires a required media parameter or an anyOf rule`)
    }
    // Capability facts must match the parameters.
    const duration = model.params.find((p) => p.key === "duration")
    if (model.capabilities.maxDurationSec != null) {
      const max =
        duration?.type === "enum"
          ? Math.max(...duration.values.map(Number).filter(Number.isFinite))
          : duration && (duration.type === "integer" || duration.type === "number")
            ? duration.max
            : null
      if (max !== model.capabilities.maxDurationSec)
        throw new Error(`${where}: capabilities.maxDurationSec (${model.capabilities.maxDurationSec}) != duration param max (${max})`)
    }
    const p = model.pricing
    if (p.status === "verified" && (!p.formula || !p.source || !p.verifiedAt))
      throw new Error(`${where}: verified pricing needs formula, source and verifiedAt`)
    if (p.formula?.kind === "per_second" && !p.formula.fixedSeconds && !keys.has(p.formula.durationParam ?? "duration"))
      throw new Error(`${where}: per_second pricing needs a duration parameter or fixedSeconds`)
    if (p.formula?.kind === "per_megapixel" && (!keys.has(p.formula.widthParam) || !keys.has(p.formula.heightParam)))
      throw new Error(`${where}: per_megapixel pricing references unknown dimension params`)
    if (p.currency === "credits" && !p.unitName) throw new Error(`${where}: credit pricing needs unitName`)
  }
  return manifest
}
