import { useEffect, useState } from "react"
import { Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { tNow, useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { describeError } from "@/lib/errors"
import { IpcError } from "@/lib/ipc"

const OFFER_EVENT = "vidra:update-offer"

/** Opens the update approval dialog for `version` (used by Settings too). */
export function offerUpdate(version: string) {
  window.dispatchEvent(new CustomEvent<string>(OFFER_EVENT, { detail: version }))
}

type Active = { jobs: number; downloads: number }

/**
 * Checks GitHub Releases once at startup. Nothing is downloaded or installed
 * without explicit approval in the dialog; if generations or downloads are in
 * progress, the user must confirm a second time knowing what will restart.
 */
export function AutoUpdate() {
  const { t } = useI18n()
  const [version, setVersion] = useState<string | null>(null)
  const [active, setActive] = useState<Active | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onOffer = (e: Event) => {
      setActive(null)
      setVersion((e as CustomEvent<string>).detail)
    }
    window.addEventListener(OFFER_EVENT, onOffer)
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const info = await api.checkForUpdates().catch(() => null)
      if (cancelled || !info?.newer) return
      toast(tNow("update.readyTitle", { version: info.latestVersion }), {
        description: tNow("update.readyBody"),
        duration: Infinity,
        action: { label: tNow("update.review"), onClick: () => offerUpdate(info.latestVersion) },
      })
    }, 4000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.removeEventListener(OFFER_EVENT, onOffer)
    }
  }, [])

  const install = async (acknowledgeActive: boolean) => {
    setBusy(true)
    try {
      await api.installUpdate(acknowledgeActive)
      // On success the app restarts; nothing else runs after this.
    } catch (e) {
      if (e instanceof IpcError && e.code === "confirmation_required") {
        const d = (e.details ?? {}) as { activeJobs?: number; activeDownloads?: number }
        setActive({ jobs: d.activeJobs ?? 0, downloads: d.activeDownloads ?? 0 })
      } else {
        const err = describeError(e)
        toast.error(t("update.failed"), { description: err.description || err.title })
        setVersion(null)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={version !== null} onOpenChange={(o) => !o && !busy && setVersion(null)}>
      <DialogContent data-testid="update-dialog">
        <DialogHeader>
          <DialogTitle>{t("update.readyTitle", { version: version ?? "" })}</DialogTitle>
          <DialogDescription>{t("update.readyBody")}</DialogDescription>
        </DialogHeader>
        {active && (
          <div role="alert" data-testid="update-active-warning" className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>{t("update.activeWarning", { jobs: active.jobs, downloads: active.downloads })}</p>
          </div>
        )}
        {busy && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            {t("update.installing")}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => setVersion(null)}>
            {t("update.later")}
          </Button>
          <Button disabled={busy} onClick={() => void install(active !== null)} data-testid="update-install">
            {active ? t("update.installAnyway") : t("update.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
