import { ExternalLink, TriangleAlert } from "lucide-react"
import { isPricingOutdated, type ModelDefinition } from "@vidra/core"

import { Button } from "@/components/ui/button"
import { useI18n, type I18n } from "@/i18n"
import { api } from "@/lib/backend"
import { toastError } from "@/lib/errors"
import type { Estimate } from "@/lib/ipc"
import { cn } from "@/lib/utils"

/** Unknown cost or provider units: the user must explicitly acknowledge. */
export function needsCostAck(estimate: Estimate | null): boolean {
  return !estimate || estimate.status === "unavailable" || estimate.currency === "credits"
}

const parseDay = (d: string) => Date.parse(`${d}T00:00:00Z`)

/** "$1.50", "from $0.25" or "≈ 10 Kling units" (credits never converted). */
export function estimateAmount(i18n: I18n, e: Estimate | null): string | null {
  if (!e || e.status !== "estimated" || e.amount == null) return null
  const base =
    e.currency === "credits"
      ? i18n.t("price.credits", { amount: i18n.fmt.num(e.amount), unit: e.unitName ?? "" }).trim()
      : i18n.fmt.usd(e.amount)
  return e.lowerBound ? i18n.t("price.from", { amount: base }) : base
}

export function estimateSourceText(i18n: I18n, e: Estimate | null): string | null {
  if (!e || e.status !== "estimated") return null
  if (e.source === "provider") return i18n.t("price.source.provider")
  if (e.source === "published_rate")
    return e.verifiedAt
      ? i18n.t("price.source.published", { date: i18n.fmt.date(parseDay(e.verifiedAt)) })
      : i18n.t("price.source.publishedNoDate")
  return null
}

export function reasonText(i18n: I18n, reason: string | null): string | null {
  if (!reason) return null
  const key = `price.reason.${reason}`
  return i18n.has(key) ? i18n.t(key) : null
}

/** Shows an estimate, or the exact "Pricing unavailable" notice + reason. */
export function PriceDisplay({
  estimate,
  failed = false,
  size = "md",
}: {
  estimate: Estimate | null
  failed?: boolean
  size?: "md" | "lg"
}) {
  const i18n = useI18n()
  const { t } = i18n
  const amount = estimateAmount(i18n, estimate)
  if (amount && estimate) {
    const source = estimateSourceText(i18n, estimate)
    return (
      <div data-testid="price" data-price-status="estimated">
        <div className={cn("font-semibold tracking-tight tabular-nums", size === "lg" ? "text-2xl" : "text-sm")} data-testid="price-amount">
          {amount}
        </div>
        {source && <div className="text-[11px] text-muted-foreground">{source}</div>}
        {estimate.lowerBound && <div className="text-[11px] text-muted-foreground">{t("price.lowerBound")}</div>}
        {estimate.currency === "credits" && <div className="text-[11px] text-muted-foreground">{t("price.creditsNote")}</div>}
      </div>
    )
  }
  if (!estimate && !failed) return <div className="text-sm text-muted-foreground">—</div>
  const reason = reasonText(i18n, estimate?.reason ?? null)
  const url = estimate?.pricingPageUrl
  return (
    <div className="space-y-1.5" data-testid="price" data-price-status="unavailable" data-price-reason={estimate?.reason ?? ""}>
      <p className="flex items-start gap-1.5 text-sm font-medium text-warning" role="status">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
        <span data-testid="price-unavailable">{t("price.unavailable")}</span>
      </p>
      {reason && <p className="text-xs text-muted-foreground">{reason}</p>}
      {url && (
        <Button type="button" variant="outline" size="xs" onClick={() => void api.openExternalUrl(url).catch(toastError)}>
          <ExternalLink />
          {t("price.openPricing")}
        </Button>
      )}
    </div>
  )
}

/** Static pricing summary for model lists (from the manifest, no inputs). */
export function pricingSummary(i18n: I18n, model: ModelDefinition, now = Date.now()): { text: string; available: boolean } {
  const { t, fmt } = i18n
  const p = model.pricing
  if (p.status === "provider_estimate") return { text: t("pricing.providerEstimate"), available: true }
  if (p.status === "unavailable" || !p.formula) return { text: t("pricing.notPublished"), available: false }
  if (isPricingOutdated(p, now)) return { text: t("pricing.outdated"), available: false }
  const f = p.formula
  if (f.kind === "compute_time") return { text: t("pricing.computeTime"), available: false }
  const amount = p.currency === "credits" ? t("price.credits", { amount: fmt.num(f.rate), unit: p.unitName ?? "" }).trim() : fmt.usd(f.rate)
  const text = t(`pricing.rate.${f.kind}`, { amount })
  return { text: p.from ? `${t("pricing.from")} ${text}` : text, available: true }
}
