import { z } from "zod"

/**
 * Prompt Library JSON exchange format. Exports contain prompts, categories
 * and (optionally) version history — never credentials, job data, file paths
 * or archive contents. Imports are validated strictly before anything is
 * written.
 */

const paramValue = z.union([
  z.string().max(4096),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(4096)).max(20),
])

const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,47}$/)

export const promptExportSchema = z
  .object({
    format: z.literal("vidra.prompts"),
    formatVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    categories: z
      .array(z.object({ name: z.string().trim().min(1).max(60) }).strict())
      .max(500),
    prompts: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            body: z.string().min(1).max(20000),
            category: z.string().trim().max(60).nullable(),
            tags: z.array(z.string().trim().min(1).max(40)).max(30),
            favorite: z.boolean(),
            preferredModelIds: z.array(z.string().max(200)).max(20),
            parameters: z.record(key, paramValue).refine((v) => Object.keys(v).length <= 60),
            variableDefaults: z
              .record(key, z.string().max(1000))
              .refine((v) => Object.keys(v).length <= 60),
            versions: z
              .array(
                z
                  .object({
                    version: z.number().int().positive(),
                    title: z.string().max(120),
                    body: z.string().max(20000),
                    createdAt: z.string().datetime(),
                  })
                  .strict()
              )
              .max(200)
              .optional(),
          })
          .strict()
      )
      .max(5000),
  })
  .strict()

export type PromptExport = z.infer<typeof promptExportSchema>

export const MAX_PROMPT_IMPORT_BYTES = 5 * 1024 * 1024

const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"])
function hasForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > 10) return true
  if (value === null || typeof value !== "object") return false
  for (const k of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN.has(k)) return true
    if (hasForbiddenKey((value as Record<string, unknown>)[k], depth + 1)) return true
  }
  return false
}

export function parsePromptExport(text: string): PromptExport {
  if (text.length > MAX_PROMPT_IMPORT_BYTES) throw new Error("The file is too large (max 5 MB).")
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error("The file is not valid JSON.")
  }
  if (hasForbiddenKey(raw)) throw new Error("The file contains forbidden keys.")
  const result = promptExportSchema.safeParse(raw)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`Invalid prompt file at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "invalid"}`)
  }
  return result.data
}
