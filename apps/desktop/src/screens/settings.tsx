import { useState, type ReactNode } from "react"
import { Archive, Loader2, RefreshCw, Upload } from "lucide-react"
import { toast } from "sonner"
import type { ImportPreview, Language } from "@vidra/core"

import { BudgetPanel } from "@/components/app/budget-panel"
import { Kv, PageHeader, Section } from "@/components/app/common"
import { StorageSection } from "@/components/app/storage"
import { installUpdate } from "@/components/app/updater"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLive } from "@/hooks/use-live"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt } from "@/lib/errors"
import type { UpdateInfo } from "@/lib/ipc"
import { useApp } from "@/lib/store"

export const DISCLAIMER_KEY = "about.disclaimer"

function Row({ label, hint, htmlFor, children }: { label: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 py-3">
      <div className="min-w-0">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function SettingsScreen() {
  const { t, fmt } = useI18n()
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const info = useLive(() => api.appInfo(), "info", [])
  const storage = useLive(() => api.storageStats(), "storage", ["archive-changed", "settings-changed"])
  const jobs = useLive(() => api.listJobs(), "jobs", ["jobs-changed"])
  const [update, setUpdate] = useState<UpdateInfo | null | "none">(null)
  const [checking, setChecking] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [importing, setImporting] = useState(false)
  if (!settings) return null

  const patch = (p: Parameters<typeof updateSettings>[0]) => void attempt(() => updateSettings(p))

  return (
    <>
      <PageHeader title={t("nav.settings")} />
      <div className="grid max-w-4xl gap-4">
        <Section title={t("settings.general")}>
          <div className="divide-y">
            <Row label={t("settings.language")} htmlFor="set-lang">
              <Select value={settings.language} onValueChange={(v) => patch({ language: v as Language })}>
                <SelectTrigger id="set-lang" size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">English</SelectItem>
                  <SelectItem value="tr">Türkçe</SelectItem>
                </SelectContent>
              </Select>
            </Row>
            <Row label={t("settings.autoSave")} hint={t("settings.autoSaveHint")} htmlFor="set-autosave">
              <Switch id="set-autosave" checked={settings.autoSave} onCheckedChange={(c) => patch({ autoSave: c })} />
            </Row>
            <Row label={t("settings.concurrency")} hint={t("settings.concurrencyHint")}>
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={String(settings.downloadConcurrency)}
                onValueChange={(v) => v && patch({ downloadConcurrency: Number(v) })}
                aria-label={t("settings.concurrency")}
              >
                {[1, 2, 3, 4].map((n) => (
                  <ToggleGroupItem key={n} value={String(n)} className="w-9">
                    {n}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Row>
            <Row label={t("settings.trashRetention")} hint={t("settings.trashRetentionHint")} htmlFor="set-trash">
              <Select value={String(settings.trashRetentionDays)} onValueChange={(v) => patch({ trashRetentionDays: Number(v) })}>
                <SelectTrigger id="set-trash" size="sm" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[7, 14, 30, 60, 90].map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {t("settings.days", { count: d })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          </div>
        </Section>

        <Section title={t("storage.title")}>
          <StorageSection />
          <div className="divide-y">
            {storage.data && (
              <Row
                label={t("settings.diskUsage")}
                hint={`${t("archive.storageUsed", { used: fmt.bytes(storage.data.usedBytes), count: fmt.num(storage.data.savedCount) })}${storage.data.freeBytes != null ? ` · ${t("archive.storageFree", { free: fmt.bytes(storage.data.freeBytes) })}` : ""}`}
              >
                <span className="text-xs text-muted-foreground">{t("settings.inTrash", { count: storage.data.trashedCount })}</span>
              </Row>
            )}
          </div>
        </Section>

        <Section title={t("budget.title")}>
          <BudgetPanel jobs={jobs.data} />
        </Section>

        <Section title={t("settings.backup")}>
          <p className="mb-3 text-xs text-muted-foreground">{t("settings.backupHint")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void attempt(async () => {
                  const path = await api.exportArchive()
                  if (path) toast.success(t("settings.exported"), { description: path })
                })
              }
            >
              <Archive />
              {t("settings.exportArchive")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void attempt(async () => setPreview(await api.previewImport()))}>
              <Upload />
              {t("settings.importArchive")}
            </Button>
          </div>
        </Section>

        <Section title={t("settings.updates")}>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={checking}
              onClick={async () => {
                setChecking(true)
                const r = await attempt(() => api.checkForUpdates())
                setChecking(false)
                if (r !== undefined) setUpdate(r ?? "none")
              }}
            >
              {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {t("settings.checkUpdates")}
            </Button>
            <span className="text-xs text-muted-foreground">{t("update.auto")}</span>
            {update === "none" && <span className="text-sm text-muted-foreground">{t("settings.updateUnknown")}</span>}
            {update && update !== "none" && (
              <div className="space-y-1 text-sm" role="status">
                <p className={update.newer ? "text-success" : "text-muted-foreground"}>
                  {update.newer ? t("settings.updateAvailable", { version: update.latestVersion }) : t("settings.upToDate", { version: update.currentVersion })}
                </p>
                {update.newer && (
                  <Button size="sm" onClick={() => void installUpdate()}>
                    {t("update.install")}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Section>

        <Section title={t("settings.about")}>
          <dl className="divide-y">
            <Kv label={t("settings.version")}>{info.data?.version ?? "—"}</Kv>
            <Kv label={t("settings.platform")}>{info.data?.platform ?? "—"}</Kv>
            <Kv label={t("settings.dataDir")}>
              <span className="font-mono text-xs break-all">{info.data?.dataDir ?? "—"}</span>
            </Kv>
            <Kv label={t("settings.license")}>MIT</Kv>
            <Kv label={t("settings.author")}>Tolga İleri</Kv>
          </dl>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="disclaimer">
            {t(DISCLAIMER_KEY)}
          </p>
        </Section>
      </div>

      <Dialog
        open={!!preview}
        onOpenChange={(o) => {
          if (!o && preview) {
            void api.cancelImport(preview.token).catch(() => undefined)
            setPreview(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle>{t("settings.importPreview")}</DialogTitle>
                <DialogDescription>{t("settings.importCreated", { date: fmt.dateTime(preview.createdAt) })}</DialogDescription>
              </DialogHeader>
              <dl className="divide-y">
                <Kv label={t("settings.importJobs")}>{fmt.num(preview.jobCount)}</Kv>
                <Kv label={t("settings.importAssets")}>{fmt.num(preview.assetCount)}</Kv>
                <Kv label={t("settings.importPrompts")}>{fmt.num(preview.promptCount)}</Kv>
                <Kv label={t("archive.size")}>{fmt.bytes(preview.totalBytes)}</Kv>
                <Kv label={t("settings.importDuplicates")}>{fmt.num(preview.duplicateCount)}</Kv>
              </dl>
              {preview.warnings.length > 0 && (
                <ul className="space-y-1 rounded-md border border-warning/30 p-2.5 text-xs text-warning">
                  {preview.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
              <DialogFooter>
                <Button
                  variant="ghost"
                  onClick={() => {
                    void attempt(() => api.cancelImport(preview.token))
                    setPreview(null)
                  }}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  disabled={importing}
                  onClick={async () => {
                    setImporting(true)
                    const r = await attempt(() => api.confirmImport(preview.token))
                    setImporting(false)
                    if (r) {
                      toast.success(t("settings.imported"), {
                        description: t("settings.importResult", {
                          jobs: r.importedJobs,
                          assets: r.importedAssets,
                          prompts: r.importedPrompts,
                          skipped: r.skippedDuplicates,
                        }),
                      })
                      setPreview(null)
                    }
                  }}
                >
                  {importing && <Loader2 className="animate-spin" />}
                  {t("settings.confirmImport")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
