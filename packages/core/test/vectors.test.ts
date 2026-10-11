import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import {
  enumAvailability,
  estimatePrice,
  modelDefinitionSchema,
  numericBounds,
  ParamError,
  validateGeneration,
  type ModelDefinition,
  type ParamValues,
} from "../src"

/** Shared parity vectors — the Rust backend runs the same file. */
const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./vectors/capabilities.json", import.meta.url)), "utf8")
) as {
  now: string
  model: unknown
  validation: Array<{ name: string; params: ParamValues; negativePrompt?: string; ok: boolean; code?: string; rule?: string }>
  pricing: Array<{
    name: string
    params: ParamValues
    pricingOverride?: Record<string, unknown>
    extraParams?: unknown[]
    expect: Record<string, unknown>
  }>
}

const model = modelDefinitionSchema.parse(vectors.model)
const now = Date.parse(vectors.now)

describe("validation vectors", () => {
  it.each(vectors.validation.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const run = () => validateGeneration(model, { prompt: "", negativePrompt: v.negativePrompt ?? null, params: v.params })
    if (v.ok) {
      expect(run).not.toThrow()
      return
    }
    try {
      run()
      expect.fail("expected a validation error")
    } catch (e) {
      expect(e).toBeInstanceOf(ParamError)
      expect((e as ParamError).code).toBe(v.code)
      if (v.rule) expect((e as ParamError).details.ruleId).toBe(v.rule)
    }
  })
})

describe("pricing vectors", () => {
  it.each(vectors.pricing.map((v) => [v.name, v] as const))("%s", (_name, v) => {
    const m: ModelDefinition = modelDefinitionSchema.parse({
      ...(vectors.model as object),
      params: [...(vectors.model as { params: unknown[] }).params, ...(v.extraParams ?? [])],
      pricing: { ...(vectors.model as { pricing: object }).pricing, ...(v.pricingOverride ?? {}) },
    })
    const result = estimatePrice(m, v.params, now)
    for (const [k, value] of Object.entries(v.expect))
      if (k === "amount") expect((result as { amount: number }).amount).toBeCloseTo(value as number, 6)
      else expect((result as Record<string, unknown>)[k]).toBe(value)
  })
})

describe("UI helpers derived from rules", () => {
  it("disables 4K for durations above 10 s and explains why", () => {
    const a = enumAvailability(model, { values: { duration: 15, image: ["https://cdn.example.com/a.png"] } }, "resolution")
    expect(a.get("4k")).toMatchObject({ allowed: false })
    expect(a.get("4k")?.reason?.tr).toContain("4K")
    expect(a.get("1080p")?.allowed).toBe(true)
  })

  it("reports effective numeric bounds", () => {
    expect(numericBounds(model, { values: {} }, "fps")).toMatchObject({ min: 12, max: 60 })
  })
})
