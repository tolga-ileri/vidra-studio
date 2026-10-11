import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

import { parseManifest, PROVIDER_IDS, templateVariables, validateParams, defaultValues, type ModelManifest, type ParamValues } from "../src"

const root = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url))
const readJson = (rel: string): unknown => JSON.parse(readFileSync(root(rel), "utf8"))

const manifests: ModelManifest[] = PROVIDER_IDS.map((provider) => parseManifest(readJson(`manifests/${provider}.json`)))
const allIds = new Set(manifests.flatMap((m) => m.models.map((model) => model.id)))

interface SeedPrompts {
  format: string
  formatVersion: number
  categories: { slug: string; name: { en: string; tr: string } }[]
  prompts: {
    slug: string
    category: string
    title: { en: string; tr: string }
    body: string
    tags: string[]
    variableDefaults: Record<string, string>
    preferredModelIds: string[]
  }[]
}
const seed = readJson("seed/prompts.json") as SeedPrompts

describe("bundled manifests", () => {
  it.each(manifests.map((m) => [m.provider, m] as const))("%s has video and image models", (provider, manifest) => {
    expect(manifest.provider).toBe(provider)
    expect(manifest.models.some((m) => m.output === "video")).toBe(true)
    expect(manifest.models.some((m) => m.output === "image")).toBe(true)
  })

  it("defaults validate when required media is supplied", () => {
    for (const manifest of manifests)
      for (const model of manifest.models) {
        const values: ParamValues = defaultValues(model)
        for (const spec of model.params)
          if (spec.type === "media" && spec.required) values[spec.key] = ["https://example.com/input.bin"]
        expect(() => validateParams(model, values), model.id).not.toThrow()
      }
  })
})

describe("seed prompts", () => {
  const categories = new Set(seed.categories.map((c) => c.slug))

  it("has a valid header and at least 3 prompts per category", () => {
    expect(seed.format).toBe("vidra.seed-prompts")
    expect(seed.formatVersion).toBe(1)
    for (const slug of categories) expect(seed.prompts.filter((p) => p.category === slug).length).toBeGreaterThanOrEqual(3)
  })

  it("references existing categories and models, with unique slugs", () => {
    expect(new Set(seed.prompts.map((p) => p.slug)).size).toBe(seed.prompts.length)
    for (const prompt of seed.prompts) {
      expect(categories.has(prompt.category), prompt.slug).toBe(true)
      for (const id of prompt.preferredModelIds) expect(allIds.has(id), `${prompt.slug} -> ${id}`).toBe(true)
    }
  })

  it("has defaults for every template variable", () => {
    for (const prompt of seed.prompts)
      for (const name of templateVariables(prompt.body))
        expect(prompt.variableDefaults[name]?.trim(), `${prompt.slug}: {${name}}`).toBeTruthy()
  })
})
