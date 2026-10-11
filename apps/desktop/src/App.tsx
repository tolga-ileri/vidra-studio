import { useEffect } from "react"
import { HashRouter, Navigate, Route, Routes } from "react-router"

import { AppShell, DemoBanner } from "@/components/app/shell"
import { StorageBanner } from "@/components/app/storage"
import { AutoUpdate } from "@/components/app/updater"
import { ErrorBoundary, Mark } from "@/components/app/common"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useI18n } from "@/i18n"
import { describeError } from "@/lib/errors"
import { startEventBridge } from "@/lib/events"
import { bindAppStore, useApp } from "@/lib/store"
import { AnalyticsScreen } from "@/screens/analytics"
import { ArchiveScreen } from "@/screens/archive"
import { DownloadsScreen } from "@/screens/downloads"
import { GenerationsScreen } from "@/screens/generations"
import { HomeScreen } from "@/screens/home"
import { ModelsScreen } from "@/screens/models"
import { Onboarding } from "@/screens/onboarding"
import { PromptsScreen } from "@/screens/prompts"
import { ProvidersScreen } from "@/screens/providers"
import { SettingsScreen } from "@/screens/settings"
import { StudioScreen } from "@/screens/studio"

export default function App() {
  const ready = useApp((s) => s.ready)
  const loadError = useApp((s) => s.loadError)
  const onboarded = useApp((s) => s.settings?.onboardingCompleted ?? false)
  const load = useApp((s) => s.load)
  const { t, lang } = useI18n()

  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void startEventBridge().then((s) => {
      if (cancelled) s()
      else stop = s
    })
    const unbind = bindAppStore()
    void load()
    return () => {
      cancelled = true
      stop?.()
      unbind()
    }
  }, [load])

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  let body
  if (loadError) {
    const { title, description } = describeError(loadError)
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center" role="alert">
        <Mark className="size-10" />
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        <Button size="sm" onClick={() => void load()}>
          {t("common.tryAgain")}
        </Button>
      </div>
    )
  } else if (!ready) {
    body = (
      <div className="flex h-full items-center justify-center" role="status" aria-label={t("common.loading")}>
        <Mark className="size-10 animate-pulse" />
      </div>
    )
  } else if (!onboarded) {
    body = <Onboarding />
  } else {
    body = (
      <HashRouter>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<HomeScreen />} />
            <Route path="video" element={<StudioScreen output="video" key="video" />} />
            <Route path="image" element={<StudioScreen output="image" key="image" />} />
            <Route path="models" element={<ModelsScreen />} />
            <Route path="archive" element={<ArchiveScreen />} />
            <Route path="generations" element={<GenerationsScreen />} />
            <Route path="downloads" element={<DownloadsScreen />} />
            <Route path="prompts" element={<PromptsScreen />} />
            <Route path="analytics" element={<AnalyticsScreen />} />
            <Route path="providers" element={<ProvidersScreen />} />
            <Route path="settings" element={<SettingsScreen />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
    )
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col">
        <DemoBanner />
        {ready && onboarded && <StorageBanner />}
        {ready && onboarded && <AutoUpdate />}
        <div className="min-h-0 flex-1">
          <ErrorBoundary>{body}</ErrorBoundary>
        </div>
      </div>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
