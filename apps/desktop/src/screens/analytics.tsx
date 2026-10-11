import { useEffect, useMemo, useState } from "react"
import { BarChart3, FileDown } from "lucide-react"
import {
  byModel,
  byMonth,
  byProvider,
  dailySeries,
  jobsToCsv,
  summarize,
  type MediaAsset,
} from "@vidra/core"

import { BudgetPanel } from "@/components/app/budget-panel"
import { BarList, ColumnChart } from "@/components/app/charts"
import { EmptyState, PageHeader, Section, Skeleton } from "@/components/app/common"
import { Button } from "@/components/ui/button"
import { DateField } from "@/components/app/date-field"
import { Label } from "@/components/ui/label"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLive } from "@/hooks/use-live"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { useApp } from "@/lib/store"

type Range = "7d" | "30d" | "90d" | "12m" | "custom"

function rangeBounds(range: Range, from: string, to: string, now: number): { from: number; to: number } {
  const day = 86400000
  const end = new Date(now)
  end.setHours(23, 59, 59, 999)
  const start = (days: number) => {
    const d = new Date(now - (days - 1) * day)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  switch (range) {
    case "7d":
      return { from: start(7), to: end.getTime() }
    case "30d":
      return { from: start(30), to: end.getTime() }
    case "90d":
      return { from: start(90), to: end.getTime() }
    case "12m": {
      const d = new Date(now)
      return { from: new Date(d.getFullYear() - 1, d.getMonth() + 1, 1).getTime(), to: end.getTime() }
    }
    case "custom": {
      const parse = (v: string, endOfDay: boolean) => {
        const [y, m, dd] = v.split("-").map(Number)
        if (!y || !m || !dd) return null
        return endOfDay ? new Date(y, m - 1, dd, 23, 59, 59, 999).getTime() : new Date(y, m - 1, dd).getTime()
      }
      return { from: parse(from, false) ?? start(30), to: parse(to, true) ?? end.getTime() }
    }
  }
}

export function AnalyticsScreen() {
  const { t, fmt, locale, model: mn } = useI18n()
  const models = useApp((s) => s.models)
  const providers = useApp((s) => s.providers)
  const [range, setRange] = useState<Range>("30d")
  const [customFrom, setCustomFrom] = useState("")
  const [customTo, setCustomTo] = useState("")
  const [now] = useState(() => Date.now())
  const bounds = rangeBounds(range, customFrom, customTo, now)

  const jobs = useLive(() => api.listJobs(bounds), JSON.stringify(bounds), ["jobs-changed"])
  const allJobs = useLive(() => api.listJobs(), "all-jobs", ["jobs-changed"])
  const assets = useLive(
    async () => {
      const [live, trashed] = await Promise.all([api.listArchive({}), api.listArchive({ trashed: true })])
      return [...live, ...trashed].map((e) => e.asset).filter((a): a is MediaAsset => a !== null)
    },
    "assets",
    ["archive-changed"]
  )

  useEffect(() => {
    if (location.hash.includes("budget")) document.getElementById("budget")?.scrollIntoView()
  }, [])

  const list = useMemo(() => jobs.data ?? [], [jobs.data])
  const summary = useMemo(() => summarize(list, assets.data ?? []), [list, assets.data])
  const empty = list.length === 0
  const monthFmt = new Intl.DateTimeFormat(locale, { month: "short", year: "numeric" })
  const dayFmt = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" })
  const modelName = (id: string) => mn(models.find((m) => m.id === id)?.displayName ?? list.find((j) => j.modelId === id)?.modelName ?? id)
  const providerName = (id: string) => providers.find((p) => p.id === id)?.displayName ?? id

  const exportCsv = () => {
    const csv = "﻿" + jobsToCsv(list, assets.data ?? [])
    void api.saveTextFile(`vidra-generations-${new Date(now).toISOString().slice(0, 10)}.csv`, csv, "csv")
  }

  const kpis: Array<[string, string, string?]> = [
    [t("analytics.total"), fmt.num(summary.total)],
    [t("analytics.succeeded"), empty ? "—" : fmt.num(summary.succeeded), empty ? undefined : t("analytics.failedCount", { count: summary.failed })],
    [t("analytics.successRate"), summary.successRate == null ? "—" : fmt.pct(summary.successRate)],
    [t("analytics.outputDuration"), empty ? "—" : fmt.duration(summary.outputDurationSec)],
    [t("analytics.estimatedSpend"), empty ? "—" : fmt.usd(summary.estimatedUsd), t("analytics.estimateNote")],
    [t("analytics.confirmedSpend"), empty ? "—" : fmt.usd(summary.confirmedUsd), t("analytics.confirmedNote")],
    [t("analytics.unknownCost"), empty ? "—" : fmt.num(summary.unknownCostCount), t("analytics.unknownNote")],
    [t("analytics.averageEstimate"), summary.averageEstimatedUsd == null ? "—" : fmt.usd(summary.averageEstimatedUsd)],
  ]

  return (
    <>
      <PageHeader
        title={t("nav.analytics")}
        description={t("analytics.subtitle")}
        actions={
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={empty} data-testid="export-csv">
            <FileDown />
            {t("analytics.exportCsv")}
          </Button>
        }
      />
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <ToggleGroup type="single" variant="outline" size="sm" value={range} onValueChange={(v) => v && setRange(v as Range)} aria-label={t("analytics.range")}>
          {(["7d", "30d", "90d", "12m", "custom"] as const).map((r) => (
            <ToggleGroupItem key={r} value={r} className="px-3 text-xs">
              {t(`analytics.range.${r}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {range === "custom" && (
          <div className="flex items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="an-from" className="text-[11px] text-muted-foreground">
                {t("archive.from")}
              </Label>
              <DateField id="an-from" value={customFrom} onChange={setCustomFrom} className="h-8 w-36" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="an-to" className="text-[11px] text-muted-foreground">
                {t("archive.to")}
              </Label>
              <DateField id="an-to" value={customTo} onChange={setCustomTo} className="h-8 w-36" />
            </div>
          </div>
        )}
        <span className="text-xs text-muted-foreground">
          {fmt.date(bounds.from)} – {fmt.date(bounds.to)}
        </span>
      </div>

      {jobs.loading && !jobs.data ? (
        <div className="grid grid-cols-4 gap-3">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-4 gap-3 max-[1100px]:grid-cols-2" data-testid="kpis">
            {kpis.map(([label, value, note]) => (
              <div key={label} className="rounded-xl border bg-card p-4" data-kpi={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</dd>
                {note && <dd className="mt-0.5 text-[11px] text-muted-foreground">{note}</dd>}
              </div>
            ))}
          </dl>
          {summary.unconfirmedFailedEstimateUsd > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("analytics.failedEstimates", { amount: fmt.usd(summary.unconfirmedFailedEstimateUsd) })}
            </p>
          )}

          {empty ? (
            <EmptyState icon={<BarChart3 />} title={t("analytics.empty")} description={t("analytics.emptyBody")} />
          ) : (
            <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
              <Section title={t("analytics.monthlySpend")}>
                <ColumnChart
                  ariaLabel={t("analytics.monthlySpend")}
                  format={(n) => fmt.usd(n)}
                  data={byMonth(list).map((b) => {
                    const [y, m] = b.key.split("-").map(Number)
                    return { key: b.key, label: monthFmt.format(new Date(y ?? 0, (m ?? 1) - 1, 1)), value: b.estimatedUsd }
                  })}
                />
              </Section>
              <Section title={t("analytics.dailyActivity")}>
                <ColumnChart
                  ariaLabel={t("analytics.dailyActivity")}
                  format={(n) => fmt.num(n)}
                  legend={[t("analytics.legendJobs"), t("analytics.legendFailed")]}
                  data={dailySeries(list, bounds.from, Math.min(bounds.to, now)).map((b) => {
                    const [y, m, d] = b.key.split("-").map(Number)
                    return { key: b.key, label: dayFmt.format(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1)), value: b.total - b.failed, value2: b.failed }
                  })}
                />
              </Section>
              <Section title={t("analytics.byModel")}>
                <BarList
                  ariaLabel={t("analytics.byModel")}
                  format={(n) => fmt.usd(n)}
                  data={byModel(list)
                    .slice(0, 8)
                    .map((b) => ({ key: b.key, label: `${modelName(b.key)}${b.unknownCostCount ? ` (${t("analytics.unknownShort", { count: b.unknownCostCount })})` : ""}`, value: b.estimatedUsd }))}
                />
              </Section>
              <Section title={t("analytics.byProvider")}>
                <BarList
                  ariaLabel={t("analytics.byProvider")}
                  format={(n) => fmt.usd(n)}
                  data={byProvider(list).map((b) => ({ key: b.key, label: providerName(b.key), value: b.estimatedUsd }))}
                />
              </Section>
              <Section title={t("analytics.outcomes")} className="col-span-2 max-[1100px]:col-span-1">
                <BarList
                  ariaLabel={t("analytics.outcomes")}
                  format={(n) => fmt.num(n)}
                  data={[
                    { key: "ok", label: t("job.completed"), value: summary.succeeded },
                    { key: "failed", label: t("job.failed"), value: summary.failed },
                    { key: "canceled", label: t("job.canceled"), value: summary.canceled },
                    { key: "progress", label: t("analytics.inProgress"), value: summary.inProgress },
                  ]}
                />
              </Section>
            </div>
          )}

          <div id="budget">
            <Section title={t("budget.title")}>
              <BudgetPanel jobs={allJobs.data} />
            </Section>
          </div>
        </div>
      )}
    </>
  )
}
