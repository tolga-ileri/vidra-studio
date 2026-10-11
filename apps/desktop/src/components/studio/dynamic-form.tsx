import { useId, useMemo, useState } from "react"
import { AudioLines, ChevronDown, Clock, Dices, FileAudio, FileVideo, Images, Layers, Loader2, Plus, X } from "lucide-react"
import {
  checkRules,
  coerce,
  enumAvailability,
  numericBounds,
  ParamError,
  type ModelDefinition,
  type ParameterSpec,
  type ParamValue,
  type ParamValues,
  type RuleContext,
} from "@vidra/core"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useI18n, type I18n } from "@/i18n"
import { paramErrorMessage } from "@/lib/errors"
import type { UploadedReference } from "@/lib/ipc"
import { formatParamValue, seconds, withUnit } from "@/lib/param-format"
import { cn } from "@/lib/utils"

export type MediaSpec = Extract<ParameterSpec, { type: "media" }>

export interface DynamicFormProps {
  model: ModelDefinition
  values: ParamValues
  onChange: (values: ParamValues) => void
  /** Prompt text, for rules that reference "prompt". */
  prompt?: string
  negativePrompt?: string | null
  /** Known uploaded references by URL (for previews). */
  references: Record<string, UploadedReference>
  onPickReference: (spec: MediaSpec) => Promise<void>
  /** Key of the media slot currently uploading. */
  uploadingKey?: string | null
  errors?: Record<string, string>
  disabled?: boolean
}

/** Up to this many options render as a segmented control, more as a select. */
const SEGMENTED_MAX = 5

/** Renders inputs strictly from `model.params` and `model.rules`. */
export function DynamicForm(props: DynamicFormProps) {
  const { model, values, prompt, negativePrompt } = props
  const i18n = useI18n()
  const { t, loc } = i18n
  const [showAdvanced, setShowAdvanced] = useState(false)
  const media = model.params.filter((p) => p.type === "media")
  const basic = model.params.filter((p) => p.type !== "media" && !p.advanced)
  const advanced = model.params.filter((p) => p.type !== "media" && p.advanced)

  const ctx = useMemo<RuleContext>(() => ({ values, prompt, negativePrompt }), [values, prompt, negativePrompt])
  // Rule violations, attached to the first rendered parameter they mention.
  const { byKey, general } = useMemo(() => {
    const keys = new Set(model.params.map((p) => p.key))
    const map: Record<string, string[]> = {}
    const rest: string[] = []
    for (const v of checkRules(model, ctx)) {
      const text = loc(v.message)
      const key = v.params.find((p) => keys.has(p))
      if (key) map[key] = [...new Set([...(map[key] ?? []), text])]
      else if (!rest.includes(text)) rest.push(text)
    }
    return { byKey: map, general: rest }
  }, [model, ctx, loc])

  const fieldProps = { ...props, ctx, ruleErrors: byKey }
  const advancedHasIssue = advanced.some((p) => byKey[p.key] || props.errors?.[p.key])

  return (
    <div className="space-y-5" data-testid="dynamic-form">
      {media.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {media.map((spec) => (
            <MediaField key={spec.key} spec={spec as MediaSpec} {...fieldProps} />
          ))}
        </div>
      )}
      {basic.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-4">
          {basic.map((spec) => (
            <Field key={spec.key} spec={spec} {...fieldProps} />
          ))}
        </div>
      )}
      {advanced.length > 0 && (
        <div>
          <button
            type="button"
            className={cn(
              "flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground",
              advancedHasIssue && "text-warning"
            )}
            aria-expanded={showAdvanced || advancedHasIssue}
            onClick={() => setShowAdvanced((s) => !s)}
          >
            <ChevronDown className={cn("size-3.5 transition-transform", (showAdvanced || advancedHasIssue) && "rotate-180")} />
            {t("studio.advanced", { count: advanced.length })}
          </button>
          {(showAdvanced || advancedHasIssue) && (
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4">
              {advanced.map((spec) => (
                <Field key={spec.key} spec={spec} {...fieldProps} />
              ))}
            </div>
          )}
        </div>
      )}
      {general.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/[0.05] p-2.5 text-xs text-warning" role="alert" data-testid="rule-errors">
          <p className="mb-1 font-medium">{t("form.rules")}</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {general.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

type FieldProps = DynamicFormProps & { spec: ParameterSpec; ctx: RuleContext; ruleErrors: Record<string, string[]> }

function set(values: ParamValues, key: string, value: ParamValue | undefined): ParamValues {
  const next = { ...values }
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) delete next[key]
  else next[key] = value
  return next
}

/** Localized validation message for one value, or null when valid. */
function valueError(i18n: I18n, spec: ParameterSpec, value: ParamValue | undefined): string | null {
  if (value === undefined || spec.type === "media" || spec.type === "enum") return null
  try {
    coerce(spec, value)
    return null
  } catch (e) {
    if (e instanceof ParamError) return paramErrorMessage(e.code, e.details, i18n.loc(spec.label))
    return null
  }
}

function Messages({ items, tone = "destructive" }: { items: Array<string | null | undefined>; tone?: "destructive" | "warning" }) {
  const list = [...new Set(items.filter((x): x is string => !!x))]
  if (!list.length) return null
  return (
    <div className={cn("space-y-0.5 text-xs", tone === "destructive" ? "text-destructive" : "text-warning")} role="alert">
      {list.map((m) => (
        <p key={m}>{m}</p>
      ))}
    </div>
  )
}

function Field({ spec, values, onChange, errors, disabled, model, ctx, ruleErrors }: FieldProps) {
  const i18n = useI18n()
  const { t, loc } = i18n
  const id = useId()
  const value = values[spec.key]
  const label = loc(spec.label)
  const help = spec.help ? loc(spec.help) : null
  const notes: string[] = []
  let wide = spec.type === "text"

  let control
  switch (spec.type) {
    case "enum": {
      const current = value === undefined ? undefined : String(value)
      const availability = enumAvailability(model, ctx, spec.key)
      const pick = (s: string) => onChange(set(values, spec.key, spec.values.find((v) => String(v) === s)))
      const options = spec.values.map((v) => {
        const a = availability.get(String(v))
        return {
          value: String(v),
          text: formatParamValue(i18n, spec, v),
          disabled: a ? !a.allowed && String(v) !== current : false,
          reason: a?.reason ? loc(a.reason) : null,
        }
      })
      for (const o of options) if (o.disabled && o.reason && !notes.includes(o.reason)) notes.push(o.reason)
      const segmented = spec.values.length <= SEGMENTED_MAX
      wide = !segmented || options.some((o) => o.text.length > 9) || spec.values.length > 3
      control = segmented ? (
        <ToggleGroup
          id={id}
          type="single"
          variant="outline"
          size="sm"
          value={current ?? ""}
          onValueChange={(v) => v && pick(v)}
          disabled={disabled}
          aria-label={label}
          className="w-full"
        >
          {options.map((o) => (
            <ToggleGroupItem
              key={o.value}
              value={o.value}
              disabled={o.disabled}
              title={o.disabled && o.reason ? t("form.unavailableBecause", { reason: o.reason }) : undefined}
              data-option={o.value}
              className="flex-1 text-xs"
            >
              {o.text}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <Select value={current} onValueChange={pick} disabled={disabled}>
          <SelectTrigger id={id} size="sm" className="w-full" aria-label={label}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value} disabled={o.disabled} data-option={o.value}>
                {o.text}
                {o.disabled && o.reason && <span className="ml-2 text-[11px] text-muted-foreground">— {o.reason}</span>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )
      break
    }
    case "integer":
    case "number": {
      const bounds = numericBounds(model, ctx, spec.key)
      const min = Math.max(spec.min, bounds.min ?? spec.min)
      const max = Math.min(spec.max, bounds.max ?? spec.max)
      const step = spec.step ?? (spec.type === "integer" ? 1 : (spec.max - spec.min) / 100)
      const n = typeof value === "number" ? value : (spec.default ?? spec.min)
      if (bounds.reason && (min > spec.min || max < spec.max))
        notes.push(
          t("form.limitedBy", { min: withUnit(i18n, min, spec.unit), max: withUnit(i18n, max, spec.unit), reason: loc(bounds.reason) })
        )
      control = (
        <div className="flex items-center gap-3">
          <Slider
            aria-label={label}
            min={spec.min}
            max={max >= spec.min ? max : spec.max}
            step={step}
            value={[Math.min(Math.max(n, spec.min), max >= spec.min ? max : spec.max)]}
            disabled={disabled}
            onValueChange={([v]) => v !== undefined && onChange(set(values, spec.key, v))}
            className="flex-1"
          />
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            className="h-8 w-24 text-right tabular-nums"
            min={min}
            max={max}
            step={step}
            value={typeof value === "number" ? value : ""}
            placeholder={String(n)}
            disabled={disabled}
            aria-invalid={!!valueError(i18n, spec, value)}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === "") return onChange(set(values, spec.key, undefined))
              const parsed = Number.parseFloat(raw)
              if (Number.isFinite(parsed)) onChange(set(values, spec.key, parsed))
            }}
          />
          {spec.unit && <span className="text-xs text-muted-foreground">{spec.unit === "s" ? t("form.seconds", { value: "" }).trim() : spec.unit}</span>}
        </div>
      )
      break
    }
    case "boolean":
      control = (
        <div className="flex h-8 items-center gap-2">
          <Switch
            id={id}
            checked={value === true}
            disabled={disabled}
            aria-label={label}
            onCheckedChange={(c) => onChange(set(values, spec.key, c))}
          />
          <span className="text-xs text-muted-foreground">{value === true ? t("form.on") : t("form.off")}</span>
        </div>
      )
      break
    case "seed":
      control = (
        <div className="flex items-center gap-1.5">
          <Input
            id={id}
            type="number"
            className="h-8 tabular-nums"
            min={spec.min}
            max={spec.max}
            value={typeof value === "number" ? value : ""}
            placeholder="—"
            disabled={disabled}
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10)
              onChange(set(values, spec.key, Number.isFinite(parsed) ? parsed : undefined))
            }}
          />
          <RandomSeed spec={spec} onPick={(n) => onChange(set(values, spec.key, n))} disabled={disabled} />
        </div>
      )
      break
    case "text":
      control = spec.multiline ? (
        <Textarea
          id={id}
          rows={3}
          maxLength={spec.maxLength}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(set(values, spec.key, e.target.value))}
        />
      ) : (
        <Input
          id={id}
          className="h-8"
          maxLength={spec.maxLength}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(e) => onChange(set(values, spec.key, e.target.value))}
        />
      )
      break
    case "media":
      return null
  }

  return (
    <div className={cn("space-y-1.5", wide && "col-span-2")} data-param-key={spec.key}>
      <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
        {spec.required && <span className="text-foreground"> *</span>}
      </Label>
      {control}
      {help && <p className="text-[11px] text-muted-foreground">{help}</p>}
      {notes.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-muted-foreground" data-testid={`notes-${spec.key}`}>
          {notes.map((n) => (
            <li key={n}>{spec.type === "enum" ? t("form.unavailableBecause", { reason: n }) : n}</li>
          ))}
        </ul>
      )}
      <Messages items={[errors?.[spec.key], valueError(i18n, spec, value)]} />
      <Messages items={ruleErrors[spec.key] ?? []} tone="warning" />
    </div>
  )
}

function RandomSeed({ spec, onPick, disabled }: { spec: { min: number; max: number }; onPick: (n: number) => void; disabled?: boolean }) {
  const { t } = useI18n()
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={t("studio.randomSeed")}
      disabled={disabled}
      onClick={() => {
        const span = Math.min(spec.max - spec.min, 2 ** 31 - 2)
        const buf = new Uint32Array(1)
        crypto.getRandomValues(buf)
        onPick(spec.min + ((buf[0] ?? 0) % (span + 1)))
      }}
    >
      <Dices />
    </Button>
  )
}

export function urlsOf(value: ParamValue | undefined): string[] {
  if (Array.isArray(value)) return value
  return typeof value === "string" && value ? [value] : []
}

/** "Up to 4 files · at least 1 · Formats: JPG, PNG · max 10 MB each". */
export function mediaLimits(i18n: I18n, spec: MediaSpec): string {
  const parts = [i18n.t("form.media.count", { count: spec.maxItems })]
  if (spec.minItems > 0) parts.push(i18n.t("form.media.min", { count: spec.minItems }))
  if (spec.formats?.length) parts.push(i18n.t("form.media.formats", { list: spec.formats.map((f) => f.toUpperCase()).join(", ") }))
  if (spec.maxSizeMb) parts.push(i18n.t("form.media.size", { size: i18n.fmt.num(spec.maxSizeMb) }))
  if (spec.maxDurationSec) parts.push(i18n.t("form.media.duration", { value: seconds(i18n, spec.maxDurationSec) }))
  return parts.join(" · ")
}

function MediaField({
  spec,
  values,
  onChange,
  references,
  onPickReference,
  uploadingKey,
  errors,
  disabled,
  ruleErrors,
}: DynamicFormProps & { spec: MediaSpec; ruleErrors: Record<string, string[]> }) {
  const i18n = useI18n()
  const { t, loc } = i18n
  const urls = urlsOf(values[spec.key])
  const full = urls.length >= spec.maxItems
  const uploading = uploadingKey === spec.key
  const remove = (url: string) => {
    const rest = urls.filter((u) => u !== url)
    const next = { ...values }
    if (!rest.length) delete next[spec.key]
    else next[spec.key] = spec.shape === "url" && spec.maxItems === 1 ? rest[0]! : rest
    onChange(next)
  }
  const KindIcon = spec.mediaKind === "video" ? FileVideo : FileAudio
  return (
    <div
      className={cn("space-y-1.5", spec.maxItems > 1 && "col-span-2")}
      data-param-key={spec.key}
      data-media-kind={spec.mediaKind}
    >
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <span>
          {loc(spec.label)}
          {spec.required && <span className="text-foreground"> *</span>}
        </span>
        {spec.maxItems > 1 && (
          <span className="tabular-nums" data-testid={`count-${spec.key}`}>
            {urls.length}/{spec.maxItems}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {urls.map((url) => {
          const ref = references[url]
          return (
            <div key={url} className="group relative size-24 overflow-hidden rounded-lg border bg-black/40" data-testid="reference-tile">
              {ref?.previewDataUrl ? (
                <img src={ref.previewDataUrl} alt={ref.name} className="size-full object-cover" />
              ) : (
                <div className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center text-[10px] text-muted-foreground">
                  <KindIcon className="size-5" />
                  <span className="line-clamp-2 break-all">{ref?.name ?? t("studio.reference")}</span>
                </div>
              )}
              <button
                type="button"
                aria-label={t("studio.removeReference", { name: ref?.name ?? "" })}
                onClick={() => remove(url)}
                disabled={disabled}
                className="absolute top-1 right-1 rounded-full bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <X className="size-3" />
              </button>
            </div>
          )
        })}
        {!full && (
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => void onPickReference(spec)}
            data-testid={`add-${spec.key}`}
            className="flex size-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-[11px] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground disabled:opacity-50"
          >
            {uploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            {uploading ? t("studio.uploading") : t(`studio.add.${spec.mediaKind}`)}
          </button>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid={`limits-${spec.key}`}>
        {mediaLimits(i18n, spec)}
      </p>
      {!full && <p className="text-[11px] text-muted-foreground">{t("studio.dropHint")}</p>}
      <Messages items={[errors?.[spec.key]]} />
      <Messages items={ruleErrors[spec.key] ?? []} tone="warning" />
    </div>
  )
}

/** Max duration (prominent) and capability badges for the selected model. */
export function CapabilityBar({ model }: { model: ModelDefinition }) {
  const i18n = useI18n()
  const { t } = i18n
  const refs = model.params
    .filter((p): p is MediaSpec => p.type === "media" && p.role === "reference")
    .reduce((n, p) => n + p.maxItems, 0)
  const outputs = model.capabilities.maxOutputs
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="capabilities">
      {model.capabilities.maxDurationSec != null && (
        <span className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm font-medium" data-testid="max-duration">
          <Clock className="size-3.5 text-muted-foreground" />
          {t("form.maxDuration", { value: seconds(i18n, model.capabilities.maxDurationSec) })}
        </span>
      )}
      {model.capabilities.audio && (
        <Badge variant="secondary" className="gap-1 text-[11px]">
          <AudioLines className="size-3" />
          {t("form.badge.audio")}
        </Badge>
      )}
      {outputs != null && outputs > 1 && (
        <Badge variant="secondary" className="gap-1 text-[11px]" data-testid="max-outputs">
          <Layers className="size-3" />
          {t("form.badge.maxOutputs", { count: outputs })}
        </Badge>
      )}
      {refs > 0 && (
        <Badge variant="secondary" className="gap-1 text-[11px]">
          <Images className="size-3" />
          {t("form.badge.references", { count: refs })}
        </Badge>
      )}
    </div>
  )
}

/** Adds an uploaded reference to the right slot value; null when full. */
export function addReference(values: ParamValues, spec: MediaSpec, url: string): ParamValues | null {
  const urls = urlsOf(values[spec.key])
  if (urls.length >= spec.maxItems) return null
  const next = [...urls, url]
  return { ...values, [spec.key]: spec.shape === "url" && spec.maxItems === 1 ? url : next }
}

/** First media slot that accepts this kind and still has room. */
export function slotFor(model: ModelDefinition, values: ParamValues, kind: "image" | "video" | "audio"): MediaSpec | null {
  for (const spec of model.params)
    if (spec.type === "media" && spec.mediaKind === kind && urlsOf(values[spec.key]).length < spec.maxItems) return spec
  return null
}

/** Whether a dropped file's extension is accepted by the slot. */
export function formatAccepted(spec: MediaSpec, name: string): boolean {
  if (!spec.formats?.length) return true
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase()
  if (!ext) return false
  const alias: Record<string, string> = { jpeg: "jpg", jpg: "jpeg" }
  return spec.formats.includes(ext) || (alias[ext] !== undefined && spec.formats.includes(alias[ext]))
}
