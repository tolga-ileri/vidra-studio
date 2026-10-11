import type { ParameterSpec, ParamValue } from "@vidra/core"

import type { I18n } from "@/i18n"

/** Display text of one parameter value: valueLabels, units ("30 s") and
    locale-aware numbers. Never translates free text or model IDs. */
export function formatParamValue(i18n: I18n, spec: ParameterSpec | undefined, value: ParamValue | null | undefined): string {
  if (value === null || value === undefined) return "—"
  if (Array.isArray(value)) return i18n.t("form.media.count", { count: value.length })
  if (typeof value === "boolean") return value ? i18n.t("form.on") : i18n.t("form.off")
  if (spec?.type === "enum") {
    const label = spec.valueLabels?.[String(value)]
    if (label) return i18n.loc(label)
  }
  const unit = spec && "unit" in spec ? spec.unit : undefined
  return withUnit(i18n, value, unit)
}

export function withUnit(i18n: I18n, value: string | number, unit: string | undefined): string {
  const n = typeof value === "number" ? value : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null
  const text = n === null ? String(value) : i18n.fmt.num(n)
  if (!unit || n === null) return text
  if (unit === "s") return i18n.t("form.seconds", { value: text })
  return `${text} ${unit}`
}

/** "30 s" for a capability duration in seconds. */
export function seconds(i18n: I18n, n: number): string {
  return i18n.t("form.seconds", { value: i18n.fmt.num(n) })
}
