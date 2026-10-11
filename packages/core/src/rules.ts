import type { Condition, Constraint, ModelDefinition, Rule } from "./registry"
import type { ParamValue, ParamValues } from "./params"

/**
 * Conditional capability rules. Semantics (mirrored exactly by
 * src-tauri/src/rules.rs and checked by packages/core/test/vectors/rules.json):
 *
 * Value lookup: `values[param]`; the pseudo-params "prompt" and
 * "negative_prompt" come from the text fields.
 * A value is PRESENT when it is a non-empty string, a non-empty array, a
 * finite number or a boolean.
 * Comparison: numbers compare numerically when both sides are numeric,
 * otherwise as strings; booleans compare by identity.
 *
 * Conditions: eq / neq (neq is true when absent), in (requires presence),
 * notIn (true when absent), present, absent, all, any.
 * Constraints (only checked when the rule's `when` holds or is omitted):
 *   required / forbidden — presence;
 *   in — absent OR value ∈ values;
 *   max / min — absent, non-numeric (e.g. "auto"), OR number (item count
 *     for media arrays) within bounds;
 *   anyOf — at least one listed param present;
 *   maxTotalItems — total media items across params ≤ value;
 *   maxProduct — when all params are numeric, their product ≤ value.
 */

export interface RuleContext {
  values: ParamValues
  prompt?: string
  negativePrompt?: string | null
}

export interface RuleViolation {
  ruleId: string
  params: string[]
  message: { en: string; tr: string }
}

type Lookup = ParamValue | undefined

function lookup(ctx: RuleContext, param: string): Lookup {
  if (param === "prompt") return ctx.prompt?.trim() ? ctx.prompt : undefined
  if (param === "negative_prompt") return ctx.negativePrompt?.trim() ? ctx.negativePrompt : undefined
  return ctx.values[param]
}

export function isPresent(v: Lookup): boolean {
  if (v === undefined) return false
  if (typeof v === "string") return v.length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === "number") return Number.isFinite(v)
  return typeof v === "boolean"
}

function numeric(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v)
  return null
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (typeof a === "boolean" || typeof b === "boolean") return a === b
  const na = numeric(a)
  const nb = numeric(b)
  if (na !== null && nb !== null) return na === nb
  return String(a) === String(b)
}

function magnitude(v: Lookup): number | null {
  if (Array.isArray(v)) return v.length
  return numeric(v)
}

export function evaluate(c: Condition, ctx: RuleContext): boolean {
  if ("all" in c) return c.all.every((x) => evaluate(x, ctx))
  if ("any" in c) return c.any.some((x) => evaluate(x, ctx))
  const v = lookup(ctx, c.param)
  switch (c.op) {
    case "present":
      return isPresent(v)
    case "absent":
      return !isPresent(v)
    case "eq":
      return isPresent(v) && sameValue(v, c.value)
    case "neq":
      return !(isPresent(v) && sameValue(v, c.value))
    case "in":
      return isPresent(v) && c.values.some((x) => sameValue(v, x))
    case "notIn":
      return !(isPresent(v) && c.values.some((x) => sameValue(v, x)))
  }
}

function satisfied(k: Constraint, ctx: RuleContext): boolean {
  switch (k.op) {
    case "required":
      return isPresent(lookup(ctx, k.param))
    case "forbidden":
      return !isPresent(lookup(ctx, k.param))
    case "in": {
      const v = lookup(ctx, k.param)
      return !isPresent(v) || k.values.some((x) => sameValue(v, x))
    }
    case "max":
    case "min": {
      const v = lookup(ctx, k.param)
      if (!isPresent(v)) return true
      const m = magnitude(v)
      if (m === null) return true
      return k.op === "max" ? m <= k.value : m >= k.value
    }
    case "anyOf":
      return k.params.some((p) => isPresent(lookup(ctx, p)))
    case "maxTotalItems": {
      let total = 0
      for (const p of k.params) {
        const v = lookup(ctx, p)
        total += Array.isArray(v) ? v.length : isPresent(v) ? 1 : 0
      }
      return total <= k.value
    }
    case "maxProduct": {
      let product = 1
      for (const p of k.params) {
        const n = numeric(lookup(ctx, p))
        if (n === null) return true
        product *= n
      }
      return product <= k.value
    }
  }
}

function constraintParams(k: Constraint): string[] {
  return "params" in k ? k.params : [k.param]
}

export function activeRules(model: ModelDefinition, ctx: RuleContext): Rule[] {
  return model.rules.filter((r) => !r.when || evaluate(r.when, ctx))
}

export function checkRules(model: ModelDefinition, ctx: RuleContext): RuleViolation[] {
  const out: RuleViolation[] = []
  for (const rule of activeRules(model, ctx))
    for (const k of rule.then)
      if (!satisfied(k, ctx)) out.push({ ruleId: rule.id, params: constraintParams(k), message: rule.message })
  return out
}

/** For the UI: which enum values of `key` are allowed under the currently
    active rules, and why others are disabled. Values are tested one by one
    with all other values unchanged. */
export function enumAvailability(
  model: ModelDefinition,
  ctx: RuleContext,
  key: string
): Map<string, { allowed: boolean; reason: { en: string; tr: string } | null }> {
  const spec = model.params.find((p) => p.key === key)
  const result = new Map<string, { allowed: boolean; reason: { en: string; tr: string } | null }>()
  if (!spec || spec.type !== "enum") return result
  // A value is unavailable when choosing it would introduce a violation that
  // does not exist with the current choice (e.g. 4K violating "duration ≤ 10").
  const sig = (v: RuleViolation) => `${v.ruleId}|${v.params.join(",")}`
  const baseline = new Set(checkRules(model, ctx).map(sig))
  for (const value of spec.values) {
    const probe: RuleContext = { ...ctx, values: { ...ctx.values, [key]: value } }
    const introduced = checkRules(model, probe).find((v) => !baseline.has(sig(v)))
    result.set(String(value), { allowed: !introduced, reason: introduced?.message ?? null })
  }
  return result
}

/** Effective numeric bounds for `key` after active max/min rules. */
export function numericBounds(model: ModelDefinition, ctx: RuleContext, key: string): { min: number | null; max: number | null; reason: { en: string; tr: string } | null } {
  const spec = model.params.find((p) => p.key === key)
  let min = spec && (spec.type === "integer" || spec.type === "number") ? spec.min : null
  let max = spec && (spec.type === "integer" || spec.type === "number") ? spec.max : null
  let reason: { en: string; tr: string } | null = null
  for (const rule of activeRules(model, ctx))
    for (const k of rule.then) {
      if (k.op === "max" && k.param === key && (max === null || k.value < max)) {
        max = k.value
        reason = rule.message
      }
      if (k.op === "min" && k.param === key && (min === null || k.value > min)) {
        min = k.value
        reason = rule.message
      }
    }
  return { min, max, reason }
}
