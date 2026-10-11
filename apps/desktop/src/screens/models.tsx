import { useMemo, useState } from "react"
import { Columns3, Layers, Loader2, RefreshCw } from "lucide-react"
import { toast } from "sonner"
import {
  defaultValues,
  PROVIDER_IDS,
  WORKFLOWS,
  type CatalogEntry,
  type CatalogState,
  type CatalogSyncResult,
  type ModelDefinition,
  type ParameterSpec,
  type ProviderId,
  type Workflow,
} from "@vidra/core"

import { EmptyState, Kv, PageHeader, Section, UrlField } from "@/components/app/common"
import { pricingSummary } from "@/components/app/price"
import { mediaLimits, type MediaSpec } from "@/components/studio/dynamic-form"
import { providerName } from "@/components/studio/model-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { useLive } from "@/hooks/use-live"
import { useOpenInStudio } from "@/hooks/use-open-in-studio"
import { useI18n, type I18n } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt } from "@/lib/errors"
import { formatParamValue, seconds } from "@/lib/param-format"
import { useApp } from "@/lib/store"
import { cn } from "@/lib/utils"

const DURATION_STEPS = [5, 10, 15, 30, 60]

function paramSummary(i18n: I18n, spec: ParameterSpec): string {
  switch (spec.type) {
    case "enum":
      return spec.values.map((v) => formatParamValue(i18n, spec, v)).join(" · ")
    case "integer":
    case "number":
      return `${formatParamValue(i18n, spec, spec.min)} – ${formatParamValue(i18n, spec, spec.max)}`
    case "boolean":
      return i18n.t("models.param.boolean")
    case "seed":
      return i18n.t("models.param.seed")
    case "text":
      return i18n.t("models.param.text", { max: spec.maxLength })
    case "media":
      return `${i18n.t(`media.${spec.mediaKind}`)} · ${mediaLimits(i18n, spec)}`
  }
}

const referenceCount = (m: ModelDefinition) =>
  m.params.filter((p): p is MediaSpec => p.type === "media" && p.role === "reference").reduce((n, p) => n + p.maxItems, 0)

function resolutionsOf(m: ModelDefinition): string[] {
  const p = m.params.find((x) => x.key === "resolution")
  return p?.type === "enum" ? p.values.map(String) : []
}

const selectable = (e: CatalogEntry) => e.executable && e.state !== "update_required" && e.state !== "discontinued"

export function StateBadge({ state }: { state: CatalogState }) {
  const { t } = useI18n()
  if (state === "bundled") return null
  const tone =
    state === "new" || state === "updated"
      ? "border-success/40 text-success"
      : state === "deprecated"
        ? "border-warning/40 text-warning"
        : "border-destructive/40 text-destructive"
  return (
    <Badge variant="outline" className={cn("text-[10px]", tone)} data-catalog-state={state}>
      {t(`models.state.${state}`)}
    </Badge>
  )
}

export function ModelsScreen() {
  const i18n = useI18n()
  const { t, loc, fmt, model: mn } = i18n
  const models = useApp((s) => s.models)
  const providers = useApp((s) => s.providers)
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const openInStudio = useOpenInStudio()
  const catalog = useLive(() => api.listCatalog(), "catalog", ["providers-changed", "catalog-changed"])
  const status = useLive(() => api.catalogStatus(), "catalog-status", ["providers-changed", "settings-changed", "catalog-changed"])
  const [search, setSearch] = useState("")
  const [provider, setProvider] = useState<ProviderId | "all">("all")
  const [workflow, setWorkflow] = useState<Workflow | "all">("all")
  const [output, setOutput] = useState<"all" | "video" | "image">("all")
  const [minDuration, setMinDuration] = useState<number | 0>(0)
  const [resolution, setResolution] = useState<string>("all")
  const [audioOnly, setAudioOnly] = useState(false)
  const [refsOnly, setRefsOnly] = useState(false)
  const [pricedOnly, setPricedOnly] = useState(false)
  const [compare, setCompare] = useState<string[]>([])
  const [comparing, setComparing] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<CatalogSyncResult | null>(null)

  const entries = useMemo<CatalogEntry[]>(
    () =>
      catalog.data ??
      models.map((model) => ({ model, state: "bundled" as const, executable: true, reason: null, registryVersion: null })),
    [catalog.data, models]
  )
  const workflows = useMemo(() => WORKFLOWS.filter((w) => entries.some((e) => e.model.workflow === w)), [entries])
  const resolutions = useMemo(() => [...new Set(entries.flatMap((e) => resolutionsOf(e.model)))], [entries])
  const q = search.trim().toLowerCase()
  const list = entries.filter(({ model: m }) => {
    const max = m.capabilities.maxDurationSec
    return (
      (provider === "all" || m.provider === provider) &&
      (workflow === "all" || m.workflow === workflow) &&
      (output === "all" || m.output === output) &&
      (!minDuration || (max != null && max >= minDuration)) &&
      (resolution === "all" || resolutionsOf(m).includes(resolution)) &&
      (!audioOnly || m.capabilities.audio) &&
      (!refsOnly || referenceCount(m) > 0) &&
      (!pricedOnly || pricingSummary(i18n, m).available) &&
      (!q || `${m.displayName} ${m.family} ${m.providerModelId}`.toLowerCase().includes(q))
    )
  })
  const open = entries.find((e) => e.model.id === openId) ?? null
  const compared = entries.filter((e) => compare.includes(e.model.id))

  const sync = async () => {
    setSyncing(true)
    const r = await attempt(() => api.syncCatalog())
    setSyncing(false)
    if (!r) return
    setSyncResult(r)
    catalog.reload()
    status.reload()
    await useApp.getState().refreshModels().catch(() => undefined)
    if (r.outcome === "failed") toast.error(t("catalog.result.failed"))
    else toast.success(t(`catalog.result.${r.outcome}`))
  }

  const toggle = (id: string) => setCompare((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]))
  const toggleClass = (on: boolean) =>
    cn(
      "h-8 rounded-md border px-2.5 text-xs text-muted-foreground hover:text-foreground",
      on && "border-white/30 bg-white/[0.06] text-foreground"
    )

  return (
    <>
      <PageHeader title={t("nav.models")} description={t("models.subtitleCatalog", { count: models.length })} />

      <Section title={t("catalog.title")} className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3" data-testid="catalog-section">
          <div className="space-y-0.5 text-xs text-muted-foreground">
            {status.data && (
              <p>
                {t("catalog.version", { version: status.data.version, source: t(`catalog.source.${status.data.source}`) })}
              </p>
            )}
            <p data-testid="catalog-last-checked">
              {status.data?.lastCheckedAt != null
                ? t("catalog.lastChecked", { date: fmt.dateTime(status.data.lastCheckedAt) })
                : t("catalog.neverChecked")}
            </p>
            {status.data?.lastError && <CatalogError code={status.data.lastError} />}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground" title={t("catalog.autoSyncHint")}>
              {t("catalog.autoSync")}
              <Switch
                checked={settings?.catalogAutoSync ?? false}
                aria-label={t("catalog.autoSync")}
                onCheckedChange={(c) => void attempt(() => updateSettings({ catalogAutoSync: c }))}
                data-testid="catalog-autosync"
              />
            </label>
            <Button size="sm" variant="outline" disabled={syncing} onClick={() => void sync()} data-testid="catalog-sync">
              {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("catalog.check")}
            </Button>
          </div>
        </div>
        {syncResult && <SyncSummary result={syncResult} />}
      </Section>

      <div className="mb-4 flex flex-wrap gap-2" data-testid="model-filters">
        <Input
          data-page-search
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("studio.searchModels")}
          aria-label={t("studio.searchModels")}
          className="h-8 w-56"
        />
        <Select value={provider} onValueChange={(v) => setProvider(v as ProviderId | "all")}>
          <SelectTrigger size="sm" className="w-40" aria-label={t("models.provider")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("archive.allProviders")}</SelectItem>
            {PROVIDER_IDS.map((p) => (
              <SelectItem key={p} value={p}>
                {providerName(providers, p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={workflow} onValueChange={(v) => setWorkflow(v as Workflow | "all")}>
          <SelectTrigger size="sm" className="w-44" aria-label={t("models.workflow")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("models.allWorkflows")}</SelectItem>
            {workflows.map((w) => (
              <SelectItem key={w} value={w}>
                {t(`workflow.${w}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={output} onValueChange={(v) => setOutput(v as typeof output)}>
          <SelectTrigger size="sm" className="w-32" aria-label={t("models.output")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("archive.allTypes")}</SelectItem>
            <SelectItem value="video">{t("output.video")}</SelectItem>
            <SelectItem value="image">{t("output.image")}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={String(minDuration)} onValueChange={(v) => setMinDuration(Number(v))}>
          <SelectTrigger size="sm" className="w-40" aria-label={t("models.filters.maxDuration")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="0">{t("models.filters.anyDuration")}</SelectItem>
            {DURATION_STEPS.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {t("models.filters.atLeast", { value: seconds(i18n, d) })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {resolutions.length > 0 && (
          <Select value={resolution} onValueChange={setResolution}>
            <SelectTrigger size="sm" className="w-40" aria-label={t("models.filters.resolution")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("models.filters.anyResolution")}</SelectItem>
              {resolutions.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <button type="button" aria-pressed={audioOnly} className={toggleClass(audioOnly)} onClick={() => setAudioOnly((x) => !x)}>
          {t("models.filters.audio")}
        </button>
        <button type="button" aria-pressed={refsOnly} className={toggleClass(refsOnly)} onClick={() => setRefsOnly((x) => !x)}>
          {t("models.filters.references")}
        </button>
        <button type="button" aria-pressed={pricedOnly} className={toggleClass(pricedOnly)} onClick={() => setPricedOnly((x) => !x)}>
          {t("models.filters.priced")}
        </button>
        {compare.length > 0 && (
          <div className="ml-auto flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setCompare([])}>
              {t("models.compareClear")}
            </Button>
            <Button size="sm" disabled={compare.length < 2} onClick={() => setComparing(true)} data-testid="compare-open">
              <Columns3 />
              {t("models.compareSelected", { count: compare.length })}
            </Button>
          </div>
        )}
      </div>

      {list.length === 0 ? (
        <EmptyState icon={<Layers />} title={t("studio.noModelMatch")} />
      ) : (
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3" data-testid="model-grid">
          {list.map((e) => {
            const m = e.model
            const price = pricingSummary(i18n, m)
            return (
              <li key={m.id} className="relative" data-model-id={m.id} data-catalog-state={e.state}>
                <button
                  type="button"
                  onClick={() => setOpenId(m.id)}
                  className={cn(
                    "flex h-full w-full flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-colors outline-none hover:border-white/15 focus-visible:ring-2 focus-visible:ring-ring/50",
                    !selectable(e) && "opacity-70"
                  )}
                >
                  <div className="flex items-start justify-between gap-2 pr-7">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{mn(m.displayName)}</p>
                      <p className="truncate text-xs text-muted-foreground">{providerName(providers, m.provider)}</p>
                    </div>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {t(`output.${m.output}`)}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <StateBadge state={e.state} />
                    <Badge variant="secondary" className="text-[10px]">
                      {t(`workflow.${m.workflow}`)}
                    </Badge>
                    {m.capabilities.maxDurationSec != null && (
                      <Badge variant="secondary" className="text-[10px]">
                        {seconds(i18n, m.capabilities.maxDurationSec)}
                      </Badge>
                    )}
                    {m.capabilities.audio && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("models.audio")}
                      </Badge>
                    )}
                  </div>
                  {!selectable(e) && <p className="text-[11px] text-destructive">{t("models.notSelectable")}</p>}
                  <p className={cn("mt-auto text-xs", price.available ? "text-muted-foreground" : "text-warning")}>{price.text}</p>
                </button>
                <input
                  type="checkbox"
                  className="absolute top-4 right-4 size-4 accent-white"
                  checked={compare.includes(m.id)}
                  onChange={() => toggle(m.id)}
                  aria-label={t("models.selectForCompare", { name: m.displayName })}
                />
              </li>
            )
          })}
        </ul>
      )}

      <Dialog open={comparing} onOpenChange={setComparing}>
        <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t("models.compareTitle")}</DialogTitle>
            <DialogDescription>{compared.map((e) => mn(e.model.displayName)).join(" · ")}</DialogDescription>
          </DialogHeader>
          <CompareTable entries={compared} />
        </DialogContent>
      </Dialog>

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="w-[460px] overflow-y-auto sm:max-w-[460px]">
          {open && (
            <>
              <SheetHeader>
                <SheetTitle>{mn(open.model.displayName)}</SheetTitle>
                <SheetDescription>
                  {providerName(providers, open.model.provider)} · {t(`workflow.${open.model.workflow}`)}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-6">
                {open.state !== "bundled" && (
                  <div className="flex items-start gap-2 text-xs">
                    <StateBadge state={open.state} />
                    <StateBody state={open.state} />
                  </div>
                )}
                <Button
                  className="w-full"
                  disabled={!selectable(open)}
                  onClick={() =>
                    openInStudio(
                      { modelId: open.model.id, prompt: "", negativePrompt: null, params: defaultValues(open.model), promptId: null },
                      open.model.output
                    )
                  }
                >
                  {selectable(open) ? t("models.useInStudio") : t("models.notSelectable")}
                </Button>
                <dl className="divide-y">
                  <Kv label={t("models.family")}>{open.model.family}</Kv>
                  <Kv label={t("models.providerId")}>
                    <span className="font-mono text-xs break-all">{open.model.providerModelId}</span>
                  </Kv>
                  {open.model.capabilities.maxDurationSec != null && (
                    <Kv label={t("models.maxDuration")}>{seconds(i18n, open.model.capabilities.maxDurationSec)}</Kv>
                  )}
                  <Kv label={t("models.pricing")}>
                    {pricingSummary(i18n, open.model).text}
                    {open.model.pricing.verifiedAt && (
                      <span className="block text-xs text-muted-foreground">
                        {t("pricing.verified", { date: fmt.date(Date.parse(`${open.model.pricing.verifiedAt}T00:00:00Z`)) })}
                      </span>
                    )}
                  </Kv>
                  <Kv label={t("models.promptLimit")}>{t("models.chars", { count: open.model.prompt.maxLength })}</Kv>
                  <Kv label={t("models.negative")}>{open.model.negativePrompt ? t("common.yes") : t("common.no")}</Kv>
                  <Kv label={t("models.lastVerified")}>{fmt.date(Date.parse(`${open.model.lastVerified}T00:00:00Z`))}</Kv>
                </dl>
                {open.model.pricing.pricingPageUrl && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">{t("models.pricingSource")}</p>
                    <UrlField url={open.model.pricing.pricingPageUrl} />
                  </div>
                )}
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">{t("models.docs")}</p>
                  <UrlField url={open.model.docsUrl} />
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t("models.parameters", { count: open.model.params.length })}</h3>
                  <ul className="divide-y rounded-lg border">
                    {open.model.params.map((p) => (
                      <li key={p.key} className="px-3 py-2">
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span>{loc(p.label)}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {p.required ? t("models.required") : p.advanced ? t("models.advanced") : ""}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{paramSummary(i18n, p)}</p>
                      </li>
                    ))}
                  </ul>
                </div>
                <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                  <RefreshCw className="mt-0.5 size-3 shrink-0" />
                  {t("models.pricingDisclaimer")}
                </p>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  )
}

function CatalogError({ code }: { code: string }) {
  const i18n = useI18n()
  const key = `catalog.error.${code}`
  return <span className="block text-destructive">{i18n.has(key) ? i18n.t(key) : i18n.t("catalog.result.failed")}</span>
}

function StateBody({ state }: { state: CatalogState }) {
  const i18n = useI18n()
  const key = `models.stateBody.${state}`
  return i18n.has(key) ? <span className="text-muted-foreground">{i18n.t(key)}</span> : null
}

function SyncSummary({ result }: { result: CatalogSyncResult }) {
  const { t, fmt } = useI18n()
  const parts = (
    [
      ["catalog.added", result.added],
      ["catalog.updated", result.updated],
      ["catalog.deprecated", result.deprecated],
      ["catalog.discontinued", result.discontinued],
      ["catalog.updateRequired", result.updateRequired],
    ] as const
  ).filter(([, ids]) => ids.length > 0)
  return (
    <div className="mt-3 rounded-md border bg-black/20 p-2.5 text-xs" role="status" data-testid="catalog-result" data-outcome={result.outcome}>
      <p className={cn("font-medium", result.outcome === "failed" && "text-destructive")}>
        {t(`catalog.result.${result.outcome}`)}
        <span className="ml-2 font-normal text-muted-foreground">{fmt.dateTime(result.checkedAt)}</span>
      </p>
      {result.error && (
        <CatalogError code={result.error} />
      )}
      {parts.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
          {parts.map(([key, ids]) => (
            <li key={key}>{t(key, { count: ids.length })}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CompareTable({ entries }: { entries: CatalogEntry[] }) {
  const i18n = useI18n()
  const { t, model: mn } = i18n
  const providers = useApp((s) => s.providers)
  const rows: Array<[string, (e: CatalogEntry) => string]> = [
    [t("models.provider"), (e) => providerName(providers, e.model.provider)],
    [t("models.workflow"), (e) => t(`workflow.${e.model.workflow}`)],
    [t("models.availability"), (e) => t(`models.state.${e.state}`)],
    [t("models.maxDuration"), (e) => (e.model.capabilities.maxDurationSec != null ? seconds(i18n, e.model.capabilities.maxDurationSec) : "—")],
    [t("models.audio"), (e) => (e.model.capabilities.audio ? t("common.yes") : t("common.no"))],
    [t("models.maxOutputs"), (e) => (e.model.capabilities.maxOutputs != null ? i18n.fmt.num(e.model.capabilities.maxOutputs) : "—")],
    [t("models.references"), (e) => (referenceCount(e.model) ? i18n.fmt.num(referenceCount(e.model)) : "—")],
    [t("models.resolutions"), (e) => resolutionsOf(e.model).join(", ") || "—"],
    [t("models.pricing"), (e) => pricingSummary(i18n, e.model).text],
  ]
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs" data-testid="compare-table">
        <thead>
          <tr className="border-b">
            <th className="py-2 pr-3 font-medium text-muted-foreground" />
            {entries.map((e) => (
              <th key={e.model.id} className="py-2 pr-3 font-medium">
                {mn(e.model.displayName)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(([label, value]) => (
            <tr key={label}>
              <th scope="row" className="py-2 pr-3 font-normal text-muted-foreground">
                {label}
              </th>
              {entries.map((e) => (
                <td key={e.model.id} className="py-2 pr-3">
                  {value(e)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
