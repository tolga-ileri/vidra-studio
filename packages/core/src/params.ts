import type { ModelDefinition, ParameterSpec } from "./registry"
import { checkRules } from "./rules"

/** A value the user chose for one parameter. Media values are URLs that were
    already uploaded to the provider's storage (or public https URLs). */
export type ParamValue = string | number | boolean | string[]
export type ParamValues = Record<string, ParamValue>

/** Machine-readable validation codes (localized by the UI; mirrored in Rust). */
export type ParamErrorCode =
  | "unsupported_value"
  | "not_number"
  | "not_integer"
  | "out_of_range"
  | "bad_step"
  | "invalid_seed"
  | "not_boolean"
  | "too_long"
  | "missing_file"
  | "too_few_files"
  | "too_many_files"
  | "invalid_file_url"
  | "unknown_param"
  | "required"
  | "prompt_required"
  | "prompt_too_long"
  | "rule"

export class ParamError extends Error {
  readonly key: string
  readonly code: ParamErrorCode
  readonly details: Record<string, string | number>
  constructor(key: string, message: string, code: ParamErrorCode = "unsupported_value", details: Record<string, string | number> = {}) {
    super(message)
    this.name = "ParamError"
    this.key = key
    this.code = code
    this.details = details
  }
}

export function defaultValue(spec: ParameterSpec): ParamValue | undefined {
  switch (spec.type) {
    case "enum":
    case "integer":
    case "number":
    case "boolean":
      return spec.default
    default:
      return undefined
  }
}

export function defaultValues(model: ModelDefinition): ParamValues {
  const out: ParamValues = {}
  for (const spec of model.params) {
    const value = defaultValue(spec)
    if (value !== undefined) out[spec.key] = value
  }
  return out
}

/**
 * Keeps the user's choices that are valid for the new model (same key and an
 * acceptable value) and resets everything else to the new model's defaults.
 */
export function carryOver(previous: ParamValues, next: ModelDefinition): ParamValues {
  const out = defaultValues(next)
  for (const spec of next.params) {
    const value = previous[spec.key]
    if (value === undefined) continue
    try {
      out[spec.key] = coerce(spec, value)
    } catch {
      /* incompatible: keep the default */
    }
  }
  return out
}

const PUBLIC_HTTPS = /^https:\/\/[^\s/?#@]+\.[^\s/?#@]+(\/[^\s]*)?$/i
/** Opaque token for a reference file held natively and sent inline (base64)
    to providers without an upload API (Kling). Resolved only in Rust. */
export const INLINE_REF = /^vidra-ref:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Validates one value against its spec and returns the normalized value. */
export function coerce(spec: ParameterSpec, value: ParamValue): ParamValue {
  switch (spec.type) {
    case "enum": {
      const match = spec.values.find((allowed) => String(allowed) === String(value))
      if (match === undefined) throw new ParamError(spec.key, `${spec.label.en}: unsupported value`, "unsupported_value")
      return match
    }
    case "integer":
    case "number": {
      const n = typeof value === "number" ? value : Number.NaN
      if (!Number.isFinite(n)) throw new ParamError(spec.key, `${spec.label.en}: must be a number`, "not_number")
      if (spec.type === "integer" && !Number.isInteger(n))
        throw new ParamError(spec.key, `${spec.label.en}: must be a whole number`, "not_integer")
      if (spec.step !== undefined) {
        const steps = (n - spec.min) / spec.step
        if (Math.abs(steps - Math.round(steps)) > 1e-9)
          throw new ParamError(spec.key, `${spec.label.en}: must be in steps of ${spec.step}`, "bad_step", { step: spec.step })
      }
      if (n < spec.min || n > spec.max)
        throw new ParamError(spec.key, `${spec.label.en}: must be between ${spec.min} and ${spec.max}`, "out_of_range", { min: spec.min, max: spec.max })
      return n
    }
    case "seed": {
      if (typeof value !== "number" || !Number.isInteger(value) || value < spec.min || value > spec.max)
        throw new ParamError(spec.key, `${spec.label.en}: invalid seed`, "invalid_seed", { min: spec.min, max: spec.max })
      return value
    }
    case "boolean":
      if (typeof value !== "boolean") throw new ParamError(spec.key, `${spec.label.en}: must be on or off`, "not_boolean")
      return value
    case "text":
      if (typeof value !== "string" || value.length > spec.maxLength)
        throw new ParamError(spec.key, `${spec.label.en}: too long`, "too_long", { max: spec.maxLength })
      return value
    case "media": {
      const urls = Array.isArray(value) ? value : typeof value === "string" ? [value] : null
      if (!urls || urls.length === 0) throw new ParamError(spec.key, `${spec.label.en}: missing file`, "missing_file")
      if (urls.length > spec.maxItems)
        throw new ParamError(spec.key, `${spec.label.en}: at most ${spec.maxItems} files`, "too_many_files", { max: spec.maxItems })
      for (const url of urls)
        if (typeof url !== "string" || url.length > 4096 || !(PUBLIC_HTTPS.test(url) || INLINE_REF.test(url)))
          throw new ParamError(spec.key, `${spec.label.en}: invalid file URL`, "invalid_file_url")
      if (urls.length < spec.minItems)
        throw new ParamError(spec.key, `${spec.label.en}: at least ${spec.minItems} files`, "too_few_files", { min: spec.minItems })
      return urls
    }
  }
}

/** Validates a full set of values: unknown keys rejected, required present. */
export function validateParams(model: ModelDefinition, values: ParamValues): ParamValues {
  const specs = new Map(model.params.map((spec) => [spec.key, spec]))
  for (const key of Object.keys(values))
    if (!specs.has(key)) throw new ParamError(key, `Unknown parameter "${key}" for ${model.displayName}`, "unknown_param")
  const out: ParamValues = {}
  for (const spec of model.params) {
    const raw = values[spec.key]
    if (raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
      if (spec.required) throw new ParamError(spec.key, `${spec.label.en} is required`, "required")
      continue
    }
    out[spec.key] = coerce(spec, raw)
  }
  return out
}

export function validatePrompt(model: ModelDefinition, prompt: string): string {
  const text = prompt.trim()
  if (model.prompt.required && !text) throw new ParamError("prompt", "A prompt is required", "prompt_required")
  if (text.length > model.prompt.maxLength)
    throw new ParamError("prompt", `Prompts are limited to ${model.prompt.maxLength} characters`, "prompt_too_long", { max: model.prompt.maxLength })
  return text
}

/** Requested duration in seconds, when the model has a duration parameter. */
export function requestedDuration(model: ModelDefinition, values: ParamValues): number | null {
  const spec = model.params.find((p) => p.key === "duration")
  if (!spec) return null
  const value = values.duration ?? defaultValue(spec)
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN
  return Number.isFinite(n) ? n : null
}

export interface GenerationValues {
  prompt: string
  negativePrompt: string | null
  params: ParamValues
}

/** Full validation used before estimate/submit: prompt, negative prompt,
    every parameter and every conditional rule. Rust repeats all of it. */
export function validateGeneration(model: ModelDefinition, input: GenerationValues): GenerationValues {
  const prompt = validatePrompt(model, input.prompt)
  let negativePrompt: string | null = null
  if (input.negativePrompt?.trim()) {
    if (!model.negativePrompt) throw new ParamError("negative_prompt", "This model has no negative prompt", "unknown_param")
    if (input.negativePrompt.length > model.negativePrompt.maxLength)
      throw new ParamError("negative_prompt", "Negative prompt is too long", "too_long", { max: model.negativePrompt.maxLength })
    negativePrompt = input.negativePrompt.trim()
  }
  const params = validateParams(model, input.params)
  const violation = checkRules(model, { values: params, prompt, negativePrompt })[0]
  if (violation)
    throw new ParamError(violation.params[0] ?? "", violation.message.en, "rule", { ruleId: violation.ruleId })
  return { prompt, negativePrompt, params }
}
