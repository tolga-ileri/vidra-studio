import { useState } from "react"
import { AlertTriangle, BookmarkCheck, BookmarkPlus, Images, Library, Loader2, Plus, RefreshCw, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import {
  REFERENCE_TYPES,
  type ModelDefinition,
  type ProviderId,
  type ReferenceAsset,
  type ReferencePlan,
  type ReferenceType,
} from "@vidra/core"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { useLive } from "@/hooks/use-live"
import { useI18n, type I18n } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt, toastError } from "@/lib/errors"
import { cn } from "@/lib/utils"

/** A reference image in the studio: uploaded for one provider, placed by the plan. */
export interface StudioRef {
  id: string
  name: string
  refType: ReferenceType
  /** Provider URL (or Kling inline token) valid for `provider`. */
  url: string
  provider: ProviderId
  sha256: string
  previewDataUrl: string | null
  savedId: string | null
  width: number | null
  height: number | null
  sizeBytes: number
  status: "ready" | "uploading" | "error"
  error?: string
}

export const typeLabel = (i18n: I18n, t: ReferenceType) => i18n.t(`refs.type.${t}`)

interface Props {
  model: ModelDefinition | null
  refs: StudioRef[]
  plan: ReferencePlan<StudioRef>
  compatible: ModelDefinition[]
  preserveIdentity: boolean
  guidance: string
  promptProblem: string | null
  /** Validation errors for hidden image inputs (e.g. a required first frame). */
  slotErrors: string[]
  disabled?: boolean
  onAdd: () => void
  onUseSaved: (asset: ReferenceAsset) => void
  onUpdate: (id: string, patch: Partial<Pick<StudioRef, "name" | "refType">>) => void
  onRemove: (id: string) => void
  onReplace: (id: string) => void
  onRetry: (ref: StudioRef) => void
  onSave: (ref: StudioRef) => Promise<void>
  onPreserveIdentity: (v: boolean) => void
  onSwitchModel: (id: string) => void
}

export function ReferencePanel(p: Props) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const { refs, plan, model } = p
  const placedIds = new Set(plan.placed.map((x) => x.ref.id))
  const anyUploading = refs.some((r) => r.status === "uploading")
  const hasCharacter = refs.some((r) => r.refType === "character" || r.refType === "product")
  return (
    <section className="space-y-4 rounded-xl border bg-card p-4" data-testid="refs-panel" aria-labelledby="refs-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="refs-title" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Images className="size-3.5" />
            {t("refs.title")}
          </h2>
          <p className="mt-1 text-[11px] text-muted-foreground">{t("refs.intro")}</p>
        </div>
        <div className="flex items-center gap-1">
          <LibraryPicker onUse={p.onUseSaved} inUse={new Set(refs.map((r) => r.savedId).filter(Boolean) as string[])} disabled={p.disabled} />
          <Button size="sm" variant="outline" onClick={p.onAdd} disabled={p.disabled || anyUploading} data-testid="refs-add">
            {anyUploading ? <Loader2 className="animate-spin" /> : <Plus />}
            {anyUploading ? t("refs.uploading") : t("refs.add")}
          </Button>
        </div>
      </div>

      {refs.length === 0 ? (
        <button
          type="button"
          onClick={p.onAdd}
          disabled={p.disabled}
          className="flex w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed px-4 py-8 text-center text-xs text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground disabled:opacity-50"
          data-testid="refs-dropzone"
        >
          <Images className="size-5" />
          <span>
            {t("refs.drop")} <span className="underline underline-offset-2">{t("refs.add")}</span>
          </span>
        </button>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2" data-testid="refs-list">
          {refs.map((ref) => (
            <RefTile
              key={ref.id}
              ref_={ref}
              placed={placedIds.has(ref.id)}
              disabled={p.disabled}
              onUpdate={(patch) => p.onUpdate(ref.id, patch)}
              onRemove={() => p.onRemove(ref.id)}
              onReplace={() => p.onReplace(ref.id)}
              onRetry={() => p.onRetry(ref)}
              onSave={() => p.onSave(ref)}
            />
          ))}
        </ul>
      )}
      {refs.length > 0 && <p className="text-[11px] text-muted-foreground">{t("refs.drop")} <button type="button" className="underline underline-offset-2" onClick={p.onAdd} disabled={p.disabled}>{t("refs.add")}</button></p>}

      {p.slotErrors.length > 0 && (
        <ul className="space-y-0.5 text-xs text-destructive" role="alert" data-testid="refs-slot-errors">
          {p.slotErrors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {plan.unplaced.length > 0 && model && (
        <div className="space-y-2 rounded-md border border-warning/30 bg-warning/[0.05] p-3 text-xs" role="alert" data-testid="refs-unsupported">
          <p className="flex items-center gap-1.5 font-medium text-warning">
            <AlertTriangle className="size-3.5" />
            {t("refs.unsupportedTitle", { model: i18n.model(model.displayName) })}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {plan.unplaced.map(({ ref, reason }) => (
              <li key={ref.id}>{t(`refs.unsupported.${reason}`, { name: ref.name, type: typeLabel(i18n, ref.refType) })}</li>
            ))}
          </ul>
          <p className="text-muted-foreground">{t("refs.keptNote")}</p>
          {p.compatible.length ? (
            <div className="flex flex-wrap gap-1.5">
              {p.compatible.slice(0, 3).map((m) => (
                <Button key={m.id} size="xs" variant="outline" onClick={() => p.onSwitchModel(m.id)} data-testid={`refs-switch-${m.id}`}>
                  {t("refs.switchTo", { model: i18n.model(m.displayName) })}
                </Button>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">{t("refs.noCompatible")}</p>
          )}
        </div>
      )}

      {refs.length > 0 && (
        <div className="space-y-2 rounded-lg border bg-black/25 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="refs-consistency" className="text-xs font-medium">
                {t("refs.consistency")}
              </Label>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t("refs.consistencyBody")}</p>
            </div>
            <Switch
              id="refs-consistency"
              checked={p.preserveIdentity}
              onCheckedChange={p.onPreserveIdentity}
              disabled={p.disabled || !hasCharacter}
              data-testid="refs-consistency"
            />
          </div>
          {p.guidance && (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer select-none">{t("refs.guidancePreview")}</summary>
              <p className="mt-1 whitespace-pre-wrap rounded bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed" data-testid="refs-guidance">
                {p.guidance}
              </p>
            </details>
          )}
          {p.promptProblem && (
            <p className="text-xs text-destructive" role="alert">
              {p.promptProblem}
            </p>
          )}
        </div>
      )}

      {plan.placed.length > 0 && (
        <p className="text-[11px] text-muted-foreground" data-testid="refs-in-request">
          {t("refs.inRequest", { count: plan.placed.length })}
          {plan.placed.some((x) => x.ref.sizeBytes) && ""}
        </p>
      )}
      {refs.length > 0 && !model?.params.some((x) => x.type === "media" && x.mediaKind === "image" && x.role !== "reference") && (
        <p className="text-[11px] text-muted-foreground">{t("refs.firstFrameHint")}</p>
      )}
      <span className="sr-only">{fmt.num(refs.length)}</span>
    </section>
  )
}

function RefTile({
  ref_: ref,
  placed,
  disabled,
  onUpdate,
  onRemove,
  onReplace,
  onRetry,
  onSave,
}: {
  ref_: StudioRef
  placed: boolean
  disabled?: boolean
  onUpdate: (patch: Partial<Pick<StudioRef, "name" | "refType">>) => void
  onRemove: () => void
  onReplace: () => void
  onRetry: () => void
  onSave: () => Promise<void>
}) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const [saving, setSaving] = useState(false)
  return (
    <li
      className={cn("flex gap-3 rounded-lg border bg-black/25 p-2", ref.status === "error" && "border-destructive/50")}
      data-testid="refs-tile"
      data-status={ref.status}
      data-ref-type={ref.refType}
      data-placed={placed}
    >
      <div className="relative size-24 shrink-0 overflow-hidden rounded-md border bg-black/40">
        {ref.previewDataUrl ? (
          <img src={ref.previewDataUrl} alt={ref.name} className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center text-muted-foreground">
            <Images className="size-5" />
          </div>
        )}
        {ref.status === "uploading" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60" role="status" aria-label={t("refs.uploading")}>
            <Loader2 className="size-5 animate-spin" />
          </div>
        )}
        {ref.savedId && (
          <Badge variant="secondary" className="absolute bottom-1 left-1 gap-1 px-1.5 text-[10px]">
            <BookmarkCheck className="size-3" />
            {t("refs.saved")}
          </Badge>
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-start gap-1">
          <Input
            aria-label={t("refs.name")}
            value={ref.name}
            maxLength={120}
            placeholder={t("refs.namePlaceholder")}
            onChange={(e) => onUpdate({ name: e.target.value })}
            disabled={disabled}
            className="h-8 text-xs"
            data-testid="refs-name"
          />
          <Button variant="ghost" size="icon-xs" aria-label={t("refs.remove", { name: ref.name })} onClick={onRemove} disabled={disabled} data-testid="refs-remove">
            <X />
          </Button>
        </div>
        <Select value={ref.refType} onValueChange={(v) => v && onUpdate({ refType: v as ReferenceType })} disabled={disabled}>
          <SelectTrigger size="sm" className="h-8 w-full text-xs" aria-label={t("refs.type")} data-testid="refs-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REFERENCE_TYPES.map((rt) => (
              <SelectItem key={rt} value={rt}>
                {typeLabel(i18n, rt)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] text-muted-foreground">
          {ref.width && ref.height && (
            <span className="tabular-nums">
              {ref.width}×{ref.height} · {fmt.bytes(ref.sizeBytes)}
            </span>
          )}
          {ref.status === "error" && (
            <span className="text-destructive" role="alert">
              {t("refs.uploadFailed")}
              {ref.error ? `: ${ref.error}` : ""}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {ref.status === "error" ? (
            <Button size="xs" variant="outline" onClick={onRetry} disabled={disabled}>
              <RefreshCw />
              {t("refs.retry")}
            </Button>
          ) : (
            !ref.savedId && (
              <Button
                size="xs"
                variant="outline"
                disabled={disabled || saving || ref.status !== "ready" || !ref.name.trim()}
                onClick={async () => {
                  setSaving(true)
                  try {
                    await onSave()
                  } finally {
                    setSaving(false)
                  }
                }}
                data-testid="refs-save"
              >
                {saving ? <Loader2 className="animate-spin" /> : <BookmarkPlus />}
                {t("refs.save")}
              </Button>
            )
          )}
          <Button size="xs" variant="ghost" onClick={onReplace} disabled={disabled || ref.status === "uploading"}>
            {t("refs.replace")}
          </Button>
        </div>
      </div>
    </li>
  )
}

/** Picker over the saved reference library, with per-item delete. */
function LibraryPicker({ onUse, inUse, disabled }: { onUse: (a: ReferenceAsset) => void; inUse: Set<string>; disabled?: boolean }) {
  const i18n = useI18n()
  const { t } = i18n
  const [open, setOpen] = useState(false)
  const list = useLive(() => api.listReferences(), "references", ["references-changed"])
  const [pendingDelete, setPendingDelete] = useState<ReferenceAsset | null>(null)
  const items = list.data ?? []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" disabled={disabled} data-testid="refs-library">
          <Library />
          {t("refs.fromLibrary")}
          {items.length > 0 && <span className="tabular-nums text-muted-foreground">({items.length})</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] max-w-[calc(100vw-2rem)] p-0" align="end">
        <Command>
          <CommandInput placeholder={t("prompts.search")} />
          <CommandList className="max-h-80">
            <CommandEmpty>{list.data ? t("refs.libraryEmpty") : t("common.loading")}</CommandEmpty>
            {items.map((a) => {
              const used = inUse.has(a.id)
              return (
                <CommandItem key={a.id} value={`${a.name} ${typeLabel(i18n, a.refType)} ${a.id}`} className="gap-3" data-testid="refs-library-item">
                  {a.previewDataUrl ? (
                    <img src={a.previewDataUrl} alt="" className="size-12 shrink-0 rounded border object-cover" />
                  ) : (
                    <div className="flex size-12 shrink-0 items-center justify-center rounded border text-muted-foreground">
                      <Images className="size-4" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{a.name}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {typeLabel(i18n, a.refType)}
                      {a.useCount > 0 && ` · ${t("refs.usedTimes", { count: a.useCount })}`}
                    </div>
                  </div>
                  {pendingDelete?.id === a.id ? (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={async () => {
                          const r = await attempt(() => api.deleteReference(a.id), t("refs.deleted"))
                          if (r !== undefined) setPendingDelete(null)
                        }}
                        data-testid="refs-library-delete-confirm"
                      >
                        {t("refs.delete")}
                      </Button>
                      <Button size="xs" variant="ghost" onClick={() => setPendingDelete(null)}>
                        {t("common.cancel")}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="xs"
                        variant={used ? "ghost" : "outline"}
                        disabled={used}
                        onClick={() => {
                          setOpen(false)
                          try {
                            onUse(a)
                          } catch (e) {
                            toastError(e)
                          }
                        }}
                        data-testid="refs-library-use"
                      >
                        {used ? t("refs.inUse") : t("refs.use")}
                      </Button>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={t("refs.delete")}
                        onClick={() => {
                          setPendingDelete(a)
                          toast.message(t("refs.deleteConfirm", { name: a.name }))
                        }}
                        data-testid="refs-library-delete"
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  )}
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
