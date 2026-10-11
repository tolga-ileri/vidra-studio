import { useEffect, useRef, useState } from "react"
import { Link } from "react-router"
import { CheckCircle2, FolderOpen, HardDrive, Loader2, Network, RefreshCw, TriangleAlert, Usb } from "lucide-react"
import { toast } from "sonner"
import type { ArchiveMovePlan, ArchiveMoveResult, StorageStatus } from "@vidra/core"

import { Kv } from "@/components/app/common"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Progress } from "@/components/ui/progress"
import { useLive } from "@/hooks/use-live"
import { subscribeStore } from "@/lib/events"
import { useI18n, type I18n } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt, toastError } from "@/lib/errors"
import { useApp } from "@/lib/store"
import { cn } from "@/lib/utils"

export function useStorageStatus() {
  return useLive(() => api.storageStatus(), "storage-status", ["settings-changed", "archive-changed"])
}

function warningText(i18n: I18n, code: string): string {
  const key = `wizard.warning.${code}`
  return i18n.has(key) ? i18n.t(key) : i18n.t("wizard.warning.other", { code })
}

type Step = "planning" | "plan" | "copying" | "result" | "confirm"

/**
 * Archive move wizard: plan → copy & verify → result → explicit choice about
 * the old copies → finalize. Cancel is available at every step and calls
 * cancelArchiveMove so nothing changes.
 */
export function StorageWizard({
  open,
  onOpenChange,
  quickWhenEmpty = false,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** First run: an empty archive is switched without the review steps. */
  quickWhenEmpty?: boolean
}) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const [step, setStep] = useState<Step>("planning")
  const [plan, setPlan] = useState<ArchiveMovePlan | null>(null)
  const [result, setResult] = useState<ArchiveMoveResult | null>(null)
  const [removeOld, setRemoveOld] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ processed: number; total: number } | null>(null)
  const tokenRef = useRef<string | null>(null)

  useEffect(
    () =>
      subscribeStore((e) => {
        if (e.type === "archive-move-progress" && e.token === tokenRef.current) setProgress({ processed: e.processed, total: e.total })
      }),
    []
  )

  const reset = () => {
    setStep("planning")
    setPlan(null)
    setResult(null)
    setRemoveOld(null)
    setProgress(null)
    tokenRef.current = null
  }

  const finalize = async (token: string, remove: boolean) => {
    setBusy(true)
    try {
      const settings = await api.finalizeArchiveMove(token, remove)
      tokenRef.current = null
      useApp.setState({ settings })
      toast.success(t("wizard.done", { path: settings.archiveRoot }))
      onOpenChange(false)
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  const start = async (p: ArchiveMovePlan) => {
    setStep("copying")
    try {
      const r = await api.startArchiveMove(p.token)
      setResult(r)
      setStep("result")
      return r
    } catch (e) {
      toastError(e)
      setStep("plan")
      return null
    }
  }

  useEffect(() => {
    if (!open) return
    reset()
    let live = true
    api
      .planArchiveMove()
      .then(async (p) => {
        if (!live) return
        if (!p) {
          onOpenChange(false)
          return
        }
        tokenRef.current = p.token
        setPlan(p)
        if (quickWhenEmpty && p.fileCount === 0 && p.warnings.length === 0) {
          const r = await start(p)
          if (r && live) await finalize(p.token, false)
          return
        }
        setStep("plan")
      })
      .catch((e: unknown) => {
        toastError(e)
        onOpenChange(false)
      })
    return () => {
      live = false
    }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const cancel = () => {
    const token = tokenRef.current
    tokenRef.current = null
    if (token) {
      void api.cancelArchiveMove(token).catch(() => undefined)
      toast(t("wizard.canceled"))
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : cancel())}>
      <DialogContent className="sm:max-w-lg" data-testid="storage-wizard" data-step={step}>
        <DialogHeader>
          <DialogTitle>
            {step === "result" ? t("wizard.resultTitle") : step === "confirm" ? t("wizard.confirmTitle") : step === "plan" ? t("wizard.planTitle") : t("wizard.title")}
          </DialogTitle>
          <DialogDescription>{t("wizard.safety")}</DialogDescription>
        </DialogHeader>

        {step === "planning" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            {t("wizard.planning")}
          </p>
        )}

        {plan && step === "plan" && (
          <div className="space-y-3">
            <dl className="divide-y rounded-lg border px-3">
              <Kv label={t("wizard.from")}>
                <span className="font-mono text-xs break-all">{plan.from}</span>
              </Kv>
              <Kv label={t("wizard.to")}>
                <span className="font-mono text-xs break-all" data-testid="wizard-to">
                  {plan.to}
                </span>
              </Kv>
              <Kv label={t("wizard.files")}>{fmt.num(plan.fileCount)}</Kv>
              <Kv label={t("wizard.size")}>{fmt.bytes(plan.totalBytes)}</Kv>
              <Kv label={t("wizard.freeAtTarget")}>{fmt.bytes(plan.freeBytes)}</Kv>
            </dl>
            {plan.warnings.length > 0 && (
              <ul className="space-y-1 rounded-md border border-warning/30 bg-warning/[0.05] p-2.5 text-xs text-warning" role="alert">
                {plan.warnings.map((w) => (
                  <li key={w} className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                    {warningText(i18n, w)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {step === "copying" && (
          <div className="space-y-2" role="status">
            <p className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              {t("wizard.copying")}
            </p>
            <Progress
              value={progress && progress.total ? (progress.processed / progress.total) * 100 : null}
              className="h-1"
              aria-label={t("wizard.copying")}
            />
            {progress && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {fmt.num(progress.processed)} / {fmt.num(progress.total)}
              </p>
            )}
          </div>
        )}

        {result && step === "result" && (
          <div className="space-y-3" data-testid="wizard-result">
            <dl className="grid grid-cols-3 gap-2 text-center">
              {(
                [
                  ["wizard.copied", result.copied, ""],
                  ["wizard.verified", result.verified, "text-success"],
                  ["wizard.failed", result.failed, result.failed ? "text-destructive" : ""],
                ] as const
              ).map(([label, n, tone]) => (
                <div key={label} className="rounded-lg border p-2">
                  <dt className="text-[11px] text-muted-foreground">{t(label)}</dt>
                  <dd className={cn("text-lg font-semibold tabular-nums", tone)}>{fmt.num(n)}</dd>
                </div>
              ))}
            </dl>
            {result.failures.length > 0 && (
              <div className="rounded-md border border-destructive/30 p-2.5 text-xs">
                <p className="mb-1 text-destructive">{t("wizard.failures")}</p>
                <ul className="max-h-32 space-y-0.5 overflow-y-auto font-mono text-muted-foreground" data-testid="wizard-failures">
                  {result.failures.map((f) => (
                    <li key={f} className="break-all">
                      {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {result && step === "confirm" && (
          <div className="space-y-2" role="radiogroup" aria-label={t("wizard.confirmTitle")}>
            {(
              [
                [false, "wizard.keep", "wizard.keepHint"],
                [true, "wizard.remove", "wizard.removeHint"],
              ] as const
            ).map(([value, label, hint]) => (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={removeOld === value}
                disabled={value && (result.verified === 0 || result.failed > 0)}
                onClick={() => setRemoveOld(value)}
                className={cn(
                  "w-full rounded-lg border p-3 text-left transition-colors hover:border-white/20 disabled:opacity-50",
                  removeOld === value && "border-white/40 bg-white/[0.04]"
                )}
              >
                <span className="block text-sm font-medium">{t(label)}</span>
                <span className="block text-xs text-muted-foreground">{t(hint)}</span>
              </button>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {t("wizard.cancel")}
          </Button>
          {plan && step === "plan" && (
            <Button onClick={() => void start(plan)} data-testid="wizard-start">
              {t("wizard.start")}
            </Button>
          )}
          {step === "result" && (
            <Button onClick={() => setStep("confirm")} data-testid="wizard-next">
              {t("wizard.next")}
            </Button>
          )}
          {plan && step === "confirm" && (
            <Button disabled={removeOld === null || busy} onClick={() => void finalize(plan.token, removeOld === true)} data-testid="wizard-finish">
              {busy && <Loader2 className="animate-spin" />}
              {t("wizard.finish")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** App-wide banner while the archive folder cannot be reached. */
export function StorageBanner() {
  const { t } = useI18n()
  const status = useStorageStatus()
  const [wizard, setWizard] = useState(false)
  const [busy, setBusy] = useState(false)
  const s = status.data
  if (!s || s.available) return wizard ? <StorageWizard open={wizard} onOpenChange={setWizard} /> : null
  return (
    <>
      <div
        role="alert"
        data-testid="storage-banner"
        className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-destructive/30 bg-destructive/[0.08] px-4 py-2 text-xs"
      >
        <TriangleAlert className="size-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-destructive">{t("storage.bannerTitle")}</p>
          <p className="text-muted-foreground">{t("storage.bannerBody", { path: s.archiveRoot })}</p>
        </div>
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const r = await attempt(() => api.reconnectArchiveRoot())
            setBusy(false)
            if (r === undefined || r === null) return
            status.reload()
            if (r.available) toast.success(t("storage.reconnected"))
            else toast.error(t("storage.stillUnavailable"))
          }}
          data-testid="storage-reconnect"
        >
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("storage.reconnect")}
        </Button>
        <Button size="xs" variant="outline" onClick={() => setWizard(true)} data-testid="storage-choose-new">
          <FolderOpen />
          {t("storage.chooseNew")}
        </Button>
      </div>
      <StorageWizard open={wizard} onOpenChange={setWizard} />
    </>
  )
}

/** Sidebar indicator linking to Settings → Storage and archive. */
export function StorageIndicator({ collapsed }: { collapsed: boolean }) {
  const { t } = useI18n()
  const status = useStorageStatus()
  const ok = status.data?.available ?? true
  const label = ok ? t("storage.indicatorOk") : t("storage.indicatorDown")
  return (
    <Link
      to="/settings#storage"
      aria-label={label}
      title={label}
      data-testid="storage-indicator"
      data-available={ok}
      className={cn(
        "mx-2 mb-1 flex h-7 items-center gap-2 rounded-md px-2 text-[11px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
        collapsed && "justify-center px-0",
        !ok && "text-destructive"
      )}
    >
      <HardDrive className="size-3.5 shrink-0" />
      {!collapsed && <span className="truncate">{label}</span>}
      <span className={cn("ml-auto size-1.5 shrink-0 rounded-full", ok ? "bg-success" : "bg-destructive", collapsed && "ml-0")} aria-hidden />
    </Link>
  )
}

/** Settings → Storage and archive. */
export function StorageSection() {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const status = useStorageStatus()
  const [wizard, setWizard] = useState(false)
  const s: StorageStatus | undefined = status.data
  return (
    <div className="space-y-3" id="storage" data-testid="storage-section">
      {s && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">{t("storage.location")}</p>
              <p className="font-mono text-xs break-all text-muted-foreground" data-testid="archive-root">
                {s.archiveRoot}
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Badge variant={s.available ? "secondary" : "destructive"} className="gap-1 text-[10px]" data-testid="storage-availability">
                  {s.available ? <CheckCircle2 className="size-3" /> : <TriangleAlert className="size-3" />}
                  {s.available ? t("storage.available") : t("storage.unavailable")}
                </Badge>
                {s.isNetwork && (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Network className="size-3" />
                    {t("storage.network")}
                  </Badge>
                )}
                {s.isRemovable && (
                  <Badge variant="outline" className="gap-1 text-[10px]">
                    <Usb className="size-3" />
                    {t("storage.removable")}
                  </Badge>
                )}
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={() => setWizard(true)} data-testid="storage-change">
              <FolderOpen />
              {t("storage.change")}
            </Button>
          </div>
          {(s.isNetwork || s.isRemovable) && (
            <ul className="space-y-1 text-xs text-warning">
              {s.isNetwork && <li>{t("storage.networkWarning")}</li>}
              {s.isRemovable && <li>{t("storage.removableWarning")}</li>}
            </ul>
          )}
          {!s.available && <p className="text-xs text-destructive">{t("errorBody.storage_unavailable")}</p>}
          <dl className="divide-y border-t">
            <Kv label={t("storage.space")}>
              <span className="text-xs">
                {t("storage.used", { used: fmt.bytes(s.usedBytes) })}
                {s.freeBytes != null && ` · ${t("storage.free", { free: fmt.bytes(s.freeBytes) })}`}
              </span>
            </Kv>
            <Kv label={t("storage.exportDir")}>
              <span className="flex items-center justify-end gap-2">
                <span className="font-mono text-xs break-all text-muted-foreground" data-testid="export-dir">
                  {s.exportDir ?? t("storage.exportDirDefault")}
                </span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={async () => {
                    const r = await attempt(() => api.chooseExportDir())
                    if (r) {
                      useApp.setState({ settings: r })
                      status.reload()
                      toast.success(t("storage.exportDirSaved"))
                    }
                  }}
                >
                  {t("settings.choose")}
                </Button>
              </span>
            </Kv>
          </dl>
          <p className="text-[11px] text-muted-foreground">{t("storage.exportDirHint")}</p>
        </>
      )}
      <StorageWizard open={wizard} onOpenChange={setWizard} />
    </div>
  )
}
