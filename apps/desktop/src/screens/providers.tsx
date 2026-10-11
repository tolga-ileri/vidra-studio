import { useState } from "react"
import { KeyRound, Loader2, ShieldCheck, Trash2 } from "lucide-react"
import { toast } from "sonner"
import type { ProviderCapabilities, ProviderStatus } from "@vidra/core"

import { ConfirmDialog, PageHeader, UrlField } from "@/components/app/common"
import { CredentialsForm } from "@/components/app/credentials-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt } from "@/lib/errors"
import { useApp } from "@/lib/store"
import { cn } from "@/lib/utils"

/** Listed for transparency only; not implemented in this version. */
const PLANNED: Array<{ name: string; docsUrl: string | null; pendingAuthorization?: boolean }> = [
  // Integration excluded until the provider authorizes it (plain text, no logo).
  { name: "fal.ai", docsUrl: null, pendingAuthorization: true },
  { name: "Runway", docsUrl: "https://docs.dev.runwayml.com" },
  { name: "Luma", docsUrl: "https://docs.lumalabs.ai" },
  { name: "Google Veo", docsUrl: "https://ai.google.dev/gemini-api/docs/video" },
]

const CAPS: Array<keyof ProviderCapabilities> = ["validateCredentials", "modelDiscovery", "estimateCost", "uploadReferences", "cancel", "idempotentSubmit"]

export function StatusPill({ provider }: { provider: ProviderStatus }) {
  const { t } = useI18n()
  const [label, tone] = !provider.configured
    ? [t("providers.notConfigured"), "text-muted-foreground"]
    : provider.verification === "ok"
      ? [t("providers.verification.ok"), "text-success"]
      : provider.verification === "failed"
        ? [t("providers.verification.failed"), "text-destructive"]
        : [t("providers.verification.unknown"), "text-warning"]
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tone)} data-testid={`status-${provider.id}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {label}
    </span>
  )
}

export function ProvidersScreen() {
  const { t, fmt } = useI18n()
  const providers = useApp((s) => s.providers)
  const models = useApp((s) => s.models)
  const [editing, setEditing] = useState<ProviderStatus | null>(null)
  const [removing, setRemoving] = useState<ProviderStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const integrated = providers.filter((p) => p.integration === "integrated")
  const plannedFromBackend = providers.filter((p) => p.integration === "planned")
  const planned = [
    ...plannedFromBackend.map((p) => ({ name: p.displayName, docsUrl: p.docsUrl as string | null, pendingAuthorization: false })),
    ...PLANNED.filter((x) => !plannedFromBackend.some((p) => p.displayName === x.name)),
  ]

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    await attempt(fn)
    setBusy(null)
  }

  return (
    <>
      <PageHeader title={t("nav.providers")} description={t("providers.subtitle")} />
      <ul className="space-y-3">
        {integrated.map((p) => {
          const count = models.filter((m) => m.provider === p.id).length
          return (
            <li key={p.id} className="rounded-xl border bg-card p-4" data-provider={p.id}>
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold">{p.displayName}</h2>
                    <StatusPill provider={p} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("providers.modelCount", { count })}
                    {p.lastVerifiedAt && ` · ${t("providers.lastVerified", { date: fmt.dateTime(p.lastVerifiedAt) })}`}
                  </p>
                  {p.verification === "failed" && <p className="text-xs text-destructive">{t("providers.verifyFailed")}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    {t("providers.enabled")}
                    <Switch
                      checked={p.enabled}
                      aria-label={t("providers.enableFor", { name: p.displayName })}
                      onCheckedChange={(c) => void attempt(() => api.setProviderEnabled(p.id, c))}
                    />
                  </label>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-1">
                {CAPS.filter((c) => p.capabilities[c]).map((c) => (
                  <Badge key={c} variant="secondary" className="text-[10px]">
                    {t(`caps.${c}`)}
                  </Badge>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <div className="w-80 max-w-full">
                  <UrlField url={p.docsUrl} />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant={p.configured ? "outline" : "default"} onClick={() => setEditing(p)}>
                    <KeyRound />
                    {p.configured ? t("providers.replace") : t("providers.add")}
                  </Button>
                  {p.configured && p.capabilities.validateCredentials && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy === `v-${p.id}`}
                      onClick={() =>
                        void run(`v-${p.id}`, async () => {
                          const s = await api.verifyProvider(p.id)
                          if (s.verification === "ok") toast.success(t("providers.verifiedToast", { name: p.displayName }))
                          else toast.error(t("providers.verifyFailed"))
                        })
                      }
                    >
                      {busy === `v-${p.id}` ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                      {t("providers.verify")}
                    </Button>
                  )}
                  {p.configured && (
                    <Button size="sm" variant="ghost" onClick={() => setRemoving(p)}>
                      <Trash2 />
                      {t("providers.remove")}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <h2 className="mt-8 mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("providers.planned")}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t("providers.plannedBody")}</p>
      <ul className="grid grid-cols-3 gap-3 max-[1100px]:grid-cols-2" data-testid="planned">
        {planned.map((p) => (
          <li key={p.name} className="space-y-2 rounded-xl border border-dashed p-4 opacity-80" data-planned={p.name}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium">{p.name}</span>
              <Badge variant="outline" className="text-[10px]">
                {p.pendingAuthorization ? t("providers.pendingAuthorization") : t("providers.notAvailable")}
              </Badge>
            </div>
            {p.pendingAuthorization ? (
              <p className="text-xs text-muted-foreground">{t("providers.pendingAuthorization")}</p>
            ) : (
              p.docsUrl && <UrlField url={p.docsUrl} />
            )}
          </li>
        ))}
      </ul>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          {editing && (
            <>
              <DialogHeader>
                <DialogTitle>{editing.configured ? t("providers.replaceTitle", { name: editing.displayName }) : t("providers.addTitle", { name: editing.displayName })}</DialogTitle>
                <DialogDescription>{t("providers.credentialsHint")}</DialogDescription>
              </DialogHeader>
              <CredentialsForm provider={editing} onDone={(ok) => ok && setEditing(null)} />
            </>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={t("providers.removeTitle", { name: removing?.displayName ?? "" })}
        description={t("providers.removeBody")}
        confirmLabel={t("providers.remove")}
        destructive
        onConfirm={async () => {
          if (removing) await attempt(() => api.removeProviderCredentials(removing.id), t("providers.removed"))
          setRemoving(null)
        }}
      />
    </>
  )
}
