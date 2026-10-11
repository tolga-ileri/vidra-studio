import { useState } from "react"
import { Loader2, ShieldCheck } from "lucide-react"
import { toast } from "sonner"
import type { ProviderStatus } from "@vidra/core"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { describeError } from "@/lib/errors"

const CREDENTIAL_KEYS = {
  "credential.key_id": true,
  "credential.key_secret": true,
  "credential.api_key": true,
  "credential.api_token": true,
} as const

/**
 * Collects provider credentials. Values go straight to the OS credential store
 * through the backend and are never read back or displayed.
 */
export function CredentialsForm({
  provider,
  onDone,
  submitLabel,
}: {
  provider: ProviderStatus
  onDone?: (verified: boolean) => void
  submitLabel?: string
}) {
  const { t } = useI18n()
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Field labels come from the native side in English; localize known keys.
  const credentialLabel = (key: string, fallback: string) => {
    const k = `credential.${key}`
    return k in CREDENTIAL_KEYS ? t(k as keyof typeof CREDENTIAL_KEYS) : fallback
  }
  const complete = provider.credentialFields.every((f) => values[f.key]?.trim())

  return (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!complete) return
        setBusy(true)
        setError(null)
        try {
          await api.setProviderCredentials(provider.id, values)
          setValues({})
          let verified = false
          if (provider.capabilities.validateCredentials) {
            const status = await api.verifyProvider(provider.id)
            verified = status.verification === "ok"
            if (!verified) setError(t("providers.verifyFailed"))
            else toast.success(t("providers.verifiedToast", { name: provider.displayName }))
          } else toast.success(t("providers.savedToast", { name: provider.displayName }))
          onDone?.(verified)
        } catch (err) {
          const d = describeError(err)
          setError(d.description || d.title)
        } finally {
          setBusy(false)
        }
      }}
    >
      {provider.credentialFields.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={`cred-${provider.id}-${f.key}`}>{credentialLabel(f.key, f.label)}</Label>
          <Input
            id={`cred-${provider.id}-${f.key}`}
            type={f.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={values[f.key] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            placeholder={provider.configured ? t("providers.replacePlaceholder") : ""}
          />
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">{t("providers.storageNote")}</p>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" size="sm" disabled={!complete || busy}>
        {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
        {submitLabel ?? t("providers.saveVerify")}
      </Button>
    </form>
  )
}
