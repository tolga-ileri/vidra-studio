import {
  parseManifest,
  type ModelDefinition,
  type ParamValues,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderStatus,
} from "@vidra/core"

import { FIXTURE_MODELS } from "./mock-fixtures"

/**
 * Static inputs for the in-memory browser-preview backend. Models come from the
 * real bundled manifests; fictional v2 fixtures are used only if none parse.
 */

const manifestModules = import.meta.glob("../../../../packages/core/manifests/*.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>

const seedModules = import.meta.glob("../../../../packages/core/seed/prompts.json", {
  eager: true,
  import: "default",
}) as Record<string, unknown>

export function loadManifestModels(): ModelDefinition[] {
  const models: ModelDefinition[] = []
  for (const raw of Object.values(manifestModules)) {
    try {
      models.push(...parseManifest(raw).models)
    } catch (error) {
      console.warn("Skipping invalid manifest in browser preview", error)
    }
  }
  return models.length ? models : FIXTURE_MODELS
}

export interface SeedCategory {
  slug: string
  name: { en: string; tr: string }
}
export interface SeedPrompt {
  slug: string
  category: string
  title: { en: string; tr: string }
  body: string
  tags: string[]
  variableDefaults: Record<string, string>
  preferredModelIds: string[]
  parameters?: ParamValues
}

export function loadSeed(): { categories: SeedCategory[]; prompts: SeedPrompt[] } {
  const raw = Object.values(seedModules)[0] as { categories?: SeedCategory[]; prompts?: SeedPrompt[] } | undefined
  return { categories: raw?.categories ?? [], prompts: raw?.prompts ?? [] }
}

const caps = (c: Partial<ProviderCapabilities>): ProviderCapabilities => ({
  validateCredentials: true,
  modelDiscovery: false,
  estimateCost: true,
  uploadReferences: true,
  cancel: false,
  idempotentSubmit: false,
  ...c,
})

export const PROVIDERS: Array<Omit<ProviderStatus, "configured" | "verification" | "lastVerifiedAt" | "lastError">> = [
  {
    id: "higgsfield",
    displayName: "Higgsfield",
    enabled: true,
    capabilities: caps({ cancel: true, idempotentSubmit: true }),
    credentialFields: [
      { key: "key_id", label: "API key ID", secret: false },
      { key: "key_secret", label: "API key secret", secret: true },
    ],
    docsUrl: "https://docs.higgsfield.ai",
    integration: "integrated",
  },
  {
    id: "replicate",
    displayName: "Replicate",
    enabled: true,
    capabilities: caps({ modelDiscovery: true, cancel: true }),
    credentialFields: [{ key: "api_token", label: "API token", secret: true }],
    docsUrl: "https://replicate.com/docs",
    integration: "integrated",
  },
  {
    id: "kling",
    displayName: "Kling AI",
    enabled: true,
    capabilities: caps({ idempotentSubmit: true }),
    credentialFields: [{ key: "api_key", label: "API key", secret: true }],
    docsUrl: "https://app.klingai.com/global/dev/document-api",
    integration: "integrated",
  },
]

const PALETTE = ["#1b1f2a", "#241b22", "#1a2420", "#221f17", "#1d1a26", "#16202a"]

/** A clearly labeled placeholder frame for browser-preview media. */
export function demoFrame(label: string, seed: number, width = 640, height = 360): string {
  const a = PALETTE[seed % PALETTE.length] ?? "#1b1f2a"
  const b = PALETTE[(seed + 3) % PALETTE.length] ?? "#16202a"
  const safe = label.replace(/[<>&"']/g, " ").slice(0, 48)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width * 0.72}" cy="${height * 0.38}" r="${height * 0.22}" fill="#ffffff" fill-opacity="0.05"/><text x="24" y="${height - 48}" fill="#ffffff" fill-opacity="0.85" font-family="Segoe UI, sans-serif" font-size="20">${safe}</text><text x="24" y="${height - 22}" fill="#ffffff" fill-opacity="0.45" font-family="Segoe UI, sans-serif" font-size="13">Demo data — browser preview</text></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

export type { ProviderId }
