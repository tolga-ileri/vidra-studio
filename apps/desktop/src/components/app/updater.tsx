import { useEffect } from "react"
import { toast } from "sonner"

import { tNow } from "@/i18n"
import { api } from "@/lib/backend"
import { describeError } from "@/lib/errors"

/** Downloads, verifies (signature) and installs the update; the app restarts. */
export async function installUpdate() {
  const id = toast.loading(tNow("update.installing"))
  try {
    await api.installUpdate()
  } catch (e) {
    toast.error(describeError(e).title, { id })
  }
}

/** Checks GitHub Releases once at startup and offers a one-click update. */
export function AutoUpdate() {
  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const info = await api.checkForUpdates().catch(() => null)
      if (cancelled || !info?.newer) return
      toast(tNow("update.readyTitle", { version: info.latestVersion }), {
        description: tNow("update.readyBody"),
        duration: Infinity,
        action: { label: tNow("update.install"), onClick: () => void installUpdate() },
      })
    }, 4000)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [])
  return null
}
