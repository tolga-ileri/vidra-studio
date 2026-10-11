import {
  coerce,
  defaultValue,
  defaultValues,
  numericBounds,
  type ModelDefinition,
  type ParameterSpec,
  type ParamValue,
  type ParamValues,
} from "@vidra/core"

/** One value that could not be carried over unchanged to the new model. */
export interface ParamChange {
  key: string
  spec: ParameterSpec
  /** Spec on the previous model (for formatting the old value). */
  previousSpec: ParameterSpec | undefined
  kind: "clamped" | "reset" | "removed"
  from: ParamValue
  to: ParamValue | null
  /** Upper limit that caused a clamp (in the parameter's own unit). */
  max: number | null
  /** Rule message that caused a clamp, if any. */
  reason: { en: string; tr: string } | null
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : null

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Largest allowed value ≤ target for numeric enums / ranges, or null. */
function clampTo(spec: ParameterSpec, target: number, max: number | null): ParamValue | null {
  const limit = max === null ? target : Math.min(target, max)
  if (spec.type === "enum") {
    let best: string | number | null = null
    for (const v of spec.values) {
      const n = num(v)
      if (n !== null && n <= limit && (best === null || n > (num(best) ?? -Infinity))) best = v
    }
    return best
  }
  if (spec.type === "integer" || spec.type === "number") {
    const hi = Math.min(limit, spec.max)
    if (hi < spec.min) return null
    const step = spec.step ?? (spec.type === "integer" ? 1 : 0)
    const snapped = step ? spec.min + Math.floor((hi - spec.min) / step + 1e-9) * step : hi
    return Math.round(snapped * 1e9) / 1e9
  }
  return null
}

function maxOf(spec: ParameterSpec): number | null {
  if (spec.type === "enum") {
    const ns = spec.values.map(num).filter((n): n is number => n !== null)
    return ns.length ? Math.max(...ns) : null
  }
  if (spec.type === "integer" || spec.type === "number") return spec.max
  if (spec.type === "media") return spec.maxItems
  return null
}

/**
 * Carries the user's values to another model. Compatible values are kept;
 * anything that has to change is reported (never silently downgraded):
 * a numeric value above the new model's limit is clamped to the largest
 * allowed value, an unsupported value is reset to the default, and a
 * user-chosen value the new model does not have is reported as removed.
 */
export function carryWithChanges(
  previous: ParamValues,
  previousModel: ModelDefinition | null,
  next: ModelDefinition
): { values: ParamValues; changes: ParamChange[] } {
  const values = defaultValues(next)
  const changes: ParamChange[] = []
  const prevSpec = (key: string) => previousModel?.params.find((p) => p.key === key)
  const untouched = (key: string, v: ParamValue) => {
    const spec = prevSpec(key)
    const d = spec ? defaultValue(spec) : undefined
    return d !== undefined && same(String(d), String(v))
  }

  for (const spec of next.params) {
    const v = previous[spec.key]
    if (v === undefined) continue
    try {
      values[spec.key] = coerce(spec, v)
      continue
    } catch {
      /* not accepted as is */
    }
    const n = num(v)
    if (spec.type === "media" && Array.isArray(v) && v.length > spec.maxItems) {
      const kept = v.slice(0, spec.maxItems)
      values[spec.key] = spec.maxItems === 1 ? kept[0]! : kept
      changes.push({ key: spec.key, spec, previousSpec: prevSpec(spec.key), kind: "clamped", from: v, to: values[spec.key]!, max: spec.maxItems, reason: null })
      continue
    }
    if (n !== null && (spec.type === "enum" || spec.type === "integer" || spec.type === "number")) {
      const clamped = clampTo(spec, n, null)
      if (clamped !== null && (num(clamped) ?? Infinity) < n) {
        values[spec.key] = clamped
        changes.push({ key: spec.key, spec, previousSpec: prevSpec(spec.key), kind: "clamped", from: v, to: clamped, max: maxOf(spec), reason: null })
        continue
      }
    }
    const to = values[spec.key] ?? null
    if (!untouched(spec.key, v)) changes.push({ key: spec.key, spec, previousSpec: prevSpec(spec.key), kind: "reset", from: v, to, max: null, reason: null })
  }

  // Values that are valid alone but exceed a conditional limit (e.g. 30 s
  // carried into a 4K setting limited to 10 s) are clamped as well.
  for (const spec of next.params) {
    if (spec.type !== "enum" && spec.type !== "integer" && spec.type !== "number") continue
    const current = num(values[spec.key])
    if (current === null) continue
    const bounds = numericBounds(next, { values }, spec.key)
    if (bounds.max === null || current <= bounds.max) continue
    const clamped = clampTo(spec, current, bounds.max)
    if (clamped === null) continue
    const from = previous[spec.key] ?? values[spec.key]!
    values[spec.key] = clamped
    const existing = changes.find((c) => c.key === spec.key)
    if (existing) Object.assign(existing, { kind: "clamped", to: clamped, max: bounds.max, reason: bounds.reason })
    else changes.push({ key: spec.key, spec, previousSpec: prevSpec(spec.key), kind: "clamped", from, to: clamped, max: bounds.max, reason: bounds.reason })
  }

  for (const [key, v] of Object.entries(previous)) {
    if (next.params.some((p) => p.key === key)) continue
    const spec = prevSpec(key)
    if (!spec || untouched(key, v)) continue
    changes.push({ key, spec, previousSpec: spec, kind: "removed", from: v, to: null, max: null, reason: null })
  }
  return { values, changes }
}
