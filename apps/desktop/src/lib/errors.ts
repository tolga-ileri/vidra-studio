import { toast } from "sonner"
import type { GenerationJob, ModelDefinition, ParamErrorCode } from "@vidra/core"

import { currentLanguage, messages, translate, type I18n, type MessageKey } from "@/i18n"
import { IpcError } from "./ipc"
import { useApp } from "./store"

const PARAM_CODES: ReadonlySet<string> = new Set<ParamErrorCode>([
  "unsupported_value",
  "not_number",
  "not_integer",
  "out_of_range",
  "bad_step",
  "invalid_seed",
  "not_boolean",
  "too_long",
  "missing_file",
  "too_few_files",
  "too_many_files",
  "invalid_file_url",
  "unknown_param",
  "required",
  "prompt_required",
  "prompt_too_long",
  "rule",
])

function hasKey(key: string): key is MessageKey {
  return key in messages.en
}

/** Localized label of a parameter key (falls back to the key itself). */
function paramLabel(field: string, models: ModelDefinition[], modelId?: string): string {
  const lang = currentLanguage()
  if (field === "prompt") return translate(lang, "studio.prompt")
  if (field === "negative_prompt") return translate(lang, "studio.negativePrompt")
  const pool = modelId ? models.filter((m) => m.id === modelId) : models
  for (const m of pool.length ? pool : models) {
    const spec = m.params.find((p) => p.key === field)
    if (spec) return spec.label[lang] || spec.label.en
  }
  return field
}

/** Localized validation message for a ParamError code + details. */
export function paramErrorMessage(
  code: string,
  details: Record<string, unknown>,
  label: string,
  ruleMessage?: { en: string; tr: string } | null
): string | null {
  const lang = currentLanguage()
  if (code === "rule" && ruleMessage) return ruleMessage[lang] || ruleMessage.en
  if (!PARAM_CODES.has(code)) return null
  const vars: Record<string, string | number> = { label }
  for (const k of ["min", "max", "step"] as const) {
    const v = details[k]
    if (typeof v === "number" || typeof v === "string") vars[k] = v
  }
  return translate(lang, `paramError.${code}` as MessageKey, vars)
}

/**
 * User-safe, localized title + description for any thrown value. Backend
 * messages are English; they are shown only for codes the UI does not know.
 */
export function describeError(error: unknown): { title: string; description: string } {
  const lang = currentLanguage()
  if (error instanceof IpcError) {
    const titleKey = `error.${error.code}`
    const title = hasKey(titleKey) ? translate(lang, titleKey) : translate(lang, "error.unknown")
    const details = error.details ?? {}
    if (error.code === "invalid_input" && typeof details.code === "string") {
      const field = typeof details.field === "string" ? details.field : typeof details.key === "string" ? details.key : ""
      const models = useApp.getState().models
      const modelId = typeof details.modelId === "string" ? details.modelId : undefined
      let rule: { en: string; tr: string } | null = null
      if (details.code === "rule" && typeof details.ruleId === "string")
        for (const m of models) {
          const r = m.rules.find((x) => x.id === details.ruleId && (!modelId || m.id === modelId))
          if (r) {
            rule = r.message
            break
          }
        }
      const msg = paramErrorMessage(details.code, details, paramLabel(field, models, modelId), rule)
      if (msg) return { title, description: msg }
    }
    const bodyKey = `errorBody.${error.code}`
    if (hasKey(bodyKey)) return { title, description: translate(lang, bodyKey) }
    return { title, description: error.message }
  }
  return { title: translate(lang, "error.unknown"), description: error instanceof Error ? error.message : "" }
}

/** Localized job error: by code when known, else the backend message. */
export function jobErrorText(i18n: I18n, job: GenerationJob): string {
  const key = `errorBody.${job.errorCode ?? ""}`
  if (job.errorCode && i18n.has(key)) return i18n.t(key)
  return job.errorMessage ?? i18n.t("error.unknown")
}

export function toastError(error: unknown): void {
  const { title, description } = describeError(error)
  toast.error(title, description ? { description } : undefined)
}

/** Runs an async action and reports failures as a toast. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const result = await fn()
    if (success) toast.success(success)
    return result
  } catch (error) {
    toastError(error)
    return undefined
  }
}
