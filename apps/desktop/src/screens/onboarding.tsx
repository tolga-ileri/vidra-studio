import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, Check, FolderOpen } from "lucide-react"
import type { Language, ProviderId } from "@vidra/core"

import { Mark } from "@/components/app/common"
import { StorageWizard } from "@/components/app/storage"
import { CredentialsForm } from "@/components/app/credentials-form"
import { StatusPill } from "@/screens/providers"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { detectLanguage, useI18n } from "@/i18n"
import { attempt } from "@/lib/errors"
import { useApp } from "@/lib/store"
import { cn } from "@/lib/utils"

const STEPS = ["welcome", "providers", "connect", "folder", "done"] as const
const LANGUAGE_DETECTED_KEY = "vidra.language.detected"
type Step = (typeof STEPS)[number]

export function Onboarding() {
  const { t } = useI18n()
  const settings = useApp((s) => s.settings)
  const providers = useApp((s) => s.providers)
  const updateSettings = useApp((s) => s.updateSettings)
  const [step, setStep] = useState<Step>("welcome")
  const [chosen, setChosen] = useState<ProviderId[]>([])
  const [connectIndex, setConnectIndex] = useState(0)
  const [wizard, setWizard] = useState(false)
  // First run: default the language to the system language (tr* → Turkish)
  // once, and persist it; the user can switch it right below.
  const detected = useRef(false)
  useEffect(() => {
    if (detected.current || !settings) return
    detected.current = true
    let seen = false
    try {
      seen = localStorage.getItem(LANGUAGE_DETECTED_KEY) === "1"
      localStorage.setItem(LANGUAGE_DETECTED_KEY, "1")
    } catch {
      /* storage unavailable */
    }
    if (seen) return
    const lang = detectLanguage(typeof navigator !== "undefined" ? navigator.language : null)
    if (lang !== settings.language) void attempt(() => updateSettings({ language: lang }))
  }, [settings, updateSettings])
  const integrated = providers.filter((p) => p.integration === "integrated")
  const index = STEPS.indexOf(step)

  const finish = () => void attempt(() => updateSettings({ onboardingCompleted: true }))
  const go = (s: Step) => setStep(s)
  const current = providers.find((p) => p.id === chosen[connectIndex])

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-8">
      <div className="w-full max-w-xl space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Mark />
            <span className="text-sm font-semibold">Vidra Studio</span>
          </div>
          {step !== "done" && (
            <Button variant="ghost" size="sm" onClick={finish} data-testid="skip-onboarding">
              {t("onboarding.skip")}
            </Button>
          )}
        </div>
        <ol className="flex gap-1.5" aria-label={t("onboarding.progress", { step: index + 1, total: STEPS.length })}>
          {STEPS.map((s, i) => (
            <li key={s} className={cn("h-0.5 flex-1 rounded-full bg-white/10", i <= index && "bg-white/70")} />
          ))}
        </ol>

        <div className="rounded-2xl border bg-card p-8">
          {step === "welcome" && (
            <div className="space-y-5">
              <h1 className="text-2xl font-semibold tracking-tight">{t("onboarding.welcomeTitle")}</h1>
              <p className="text-sm leading-relaxed text-muted-foreground">{t("onboarding.welcomeBody")}</p>
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">{t("settings.language")}</p>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={settings?.language ?? "en"}
                  onValueChange={(v) => v && void attempt(() => updateSettings({ language: v as Language }))}
                  aria-label={t("settings.language")}
                >
                  <ToggleGroupItem value="en" className="px-3">
                    English
                  </ToggleGroupItem>
                  <ToggleGroupItem value="tr" className="px-3">
                    Türkçe
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t("about.disclaimer")}</p>
              <div className="flex justify-end">
                <Button onClick={() => go("providers")}>
                  {t("onboarding.start")}
                  <ArrowRight />
                </Button>
              </div>
            </div>
          )}

          {step === "providers" && (
            <div className="space-y-5">
              <div>
                <h1 className="text-lg font-semibold">{t("onboarding.providersTitle")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("onboarding.providersBody")}</p>
              </div>
              <ul className="space-y-2">
                {integrated.map((p) => {
                  const on = chosen.includes(p.id)
                  return (
                    <li key={p.id}>
                      <label className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3 hover:border-white/15", on && "border-white/30")}>
                        <Checkbox checked={on} onCheckedChange={(c) => setChosen((x) => (c ? [...x, p.id] : x.filter((y) => y !== p.id)))} />
                        <span className="flex-1 text-sm">{p.displayName}</span>
                        <StatusPill provider={p} />
                      </label>
                    </li>
                  )
                })}
              </ul>
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => go("welcome")}>
                  <ArrowLeft />
                  {t("common.back")}
                </Button>
                <Button
                  onClick={() => {
                    setConnectIndex(0)
                    go(chosen.length ? "connect" : "folder")
                  }}
                >
                  {chosen.length ? t("common.continue") : t("onboarding.later")}
                  <ArrowRight />
                </Button>
              </div>
            </div>
          )}

          {step === "connect" && current && (
            <div className="space-y-5">
              <div>
                <p className="text-xs text-muted-foreground">
                  {t("onboarding.connectCount", { current: connectIndex + 1, total: chosen.length })}
                </p>
                <h1 className="text-lg font-semibold">{t("providers.addTitle", { name: current.displayName })}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("providers.credentialsHint")}</p>
              </div>
              <CredentialsForm
                key={current.id}
                provider={current}
                submitLabel={t("onboarding.verify")}
                onDone={(ok) => {
                  if (!ok) return
                  if (connectIndex + 1 < chosen.length) setConnectIndex(connectIndex + 1)
                  else go("folder")
                }}
              />
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => (connectIndex ? setConnectIndex(connectIndex - 1) : go("providers"))}>
                  <ArrowLeft />
                  {t("common.back")}
                </Button>
                <Button variant="outline" onClick={() => (connectIndex + 1 < chosen.length ? setConnectIndex(connectIndex + 1) : go("folder"))}>
                  {t("onboarding.skipProvider")}
                </Button>
              </div>
            </div>
          )}

          {step === "folder" && (
            <div className="space-y-5">
              <div>
                <h1 className="text-lg font-semibold">{t("onboarding.folderTitle")}</h1>
                <p className="mt-1 text-sm text-muted-foreground">{t("onboarding.folderBody")}</p>
              </div>
              <div className="flex items-center justify-between gap-3 rounded-lg border bg-black/30 p-3">
                <span className="truncate font-mono text-xs" title={settings?.archiveRoot}>
                  {settings?.archiveRoot}
                </span>
                <Button size="sm" variant="outline" onClick={() => setWizard(true)} data-testid="onboarding-folder">
                  <FolderOpen />
                  {t("onboarding.folderChange")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">{t("onboarding.folderEmpty")}</p>
              <StorageWizard open={wizard} onOpenChange={setWizard} quickWhenEmpty />
              <div className="flex justify-between">
                <Button variant="ghost" onClick={() => go("providers")}>
                  <ArrowLeft />
                  {t("common.back")}
                </Button>
                <Button onClick={() => go("done")}>
                  {t("common.continue")}
                  <ArrowRight />
                </Button>
              </div>
            </div>
          )}

          {step === "done" && (
            <div className="space-y-5 text-center">
              <div className="mx-auto flex size-10 items-center justify-center rounded-full bg-white text-black">
                <Check className="size-5" />
              </div>
              <h1 className="text-lg font-semibold">{t("onboarding.doneTitle")}</h1>
              <p className="text-sm text-muted-foreground">{t("onboarding.doneBody")}</p>
              <Button onClick={finish}>{t("onboarding.open")}</Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
