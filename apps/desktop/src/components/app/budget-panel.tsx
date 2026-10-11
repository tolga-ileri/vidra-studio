import { useEffect, useState } from "react"
import { checkBudget, type BudgetSettings, type GenerationJob } from "@vidra/core"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/i18n"
import { attempt } from "@/lib/errors"
import { useApp } from "@/lib/store"

function parseLimit(v: string): number | null | "invalid" {
  if (!v.trim()) return null
  const n = Number(v.replace(",", "."))
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000 ? n : "invalid"
}

/** Application-level budget settings with current usage from local records. */
export function BudgetPanel({ jobs }: { jobs: GenerationJob[] | undefined }) {
  const { t, fmt } = useI18n()
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const budget = settings?.budget
  const [daily, setDaily] = useState("")
  const [monthly, setMonthly] = useState("")
  const [warn, setWarn] = useState(80)
  const [confirm, setConfirm] = useState(true)

  useEffect(() => {
    if (!budget) return
    setDaily(budget.dailyLimitUsd == null ? "" : String(budget.dailyLimitUsd))
    setMonthly(budget.monthlyLimitUsd == null ? "" : String(budget.monthlyLimitUsd))
    setWarn(budget.warnAtPercent)
    setConfirm(budget.confirmBeforeGenerate)
  }, [budget])

  if (!budget) return null
  const d = parseLimit(daily)
  const m = parseLimit(monthly)
  const invalid = d === "invalid" || m === "invalid"
  const usage = jobs ? checkBudget(jobs, null, budget) : null
  const next: BudgetSettings = {
    dailyLimitUsd: d === "invalid" ? null : d,
    monthlyLimitUsd: m === "invalid" ? null : m,
    warnAtPercent: warn,
    confirmBeforeGenerate: confirm,
  }
  const dirty = JSON.stringify(next) !== JSON.stringify(budget)

  const meter = (label: string, used: number, limit: number | null, unknown: number) => (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {limit == null ? t("budget.spentNoLimit", { spent: fmt.usd(used) }) : t("budget.projectedOfLimit", { projected: fmt.usd(used), limit: fmt.usd(limit) })}
        </span>
      </div>
      {limit != null && limit > 0 && <Progress value={Math.min(100, (used / limit) * 100)} className="h-1" aria-label={label} />}
      {unknown > 0 && <p className="text-[11px] text-muted-foreground">{t("budget.unknownJobs", { count: unknown })}</p>}
    </div>
  )

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault()
        if (!invalid) void attempt(() => updateSettings({ budget: next }), t("budget.saved"))
      }}
    >
      {usage && (
        <div className="grid grid-cols-2 gap-4">
          {meter(t("budget.today"), usage.daily.estimatedUsd, budget.dailyLimitUsd, usage.daily.unknownCount)}
          {meter(t("budget.thisMonth"), usage.monthly.estimatedUsd, budget.monthlyLimitUsd, usage.monthly.unknownCount)}
        </div>
      )}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="budget-daily">{t("budget.daily")}</Label>
          <Input id="budget-daily" inputMode="decimal" placeholder={t("budget.noLimit")} value={daily} onChange={(e) => setDaily(e.target.value)} aria-invalid={d === "invalid"} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="budget-monthly">{t("budget.monthly")}</Label>
          <Input id="budget-monthly" inputMode="decimal" placeholder={t("budget.noLimit")} value={monthly} onChange={(e) => setMonthly(e.target.value)} aria-invalid={m === "invalid"} />
        </div>
      </div>
      {invalid && <p className="text-xs text-destructive">{t("budget.invalid")}</p>}
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <Label>{t("budget.warnAt")}</Label>
          <span className="tabular-nums text-muted-foreground">{warn}%</span>
        </div>
        <Slider min={10} max={100} step={5} value={[warn]} onValueChange={([v]) => v !== undefined && setWarn(v)} aria-label={t("budget.warnAt")} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Label htmlFor="budget-confirm">{t("budget.confirm")}</Label>
          <p className="text-xs text-muted-foreground">{t("budget.confirmHint")}</p>
        </div>
        <Switch id="budget-confirm" checked={confirm} onCheckedChange={setConfirm} />
      </div>
      <p className="rounded-md border bg-black/30 p-3 text-xs leading-relaxed text-muted-foreground">{t("budget.disclaimer")}</p>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={!dirty || invalid}>
          {t("common.save")}
        </Button>
      </div>
    </form>
  )
}
