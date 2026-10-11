import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Link, useNavigate } from "react-router"
import {
  BookOpen,
  Info,
  Clapperboard,
  FolderOpen,
  ImageIcon,
  Loader2,
  RotateCcw,
  Sparkles,
  Unlink,
  X,
} from "lucide-react"
import { toast } from "sonner"
import {
  carryOver,
  checkRules,
  defaultValues,
  ParamError,
  renderTemplate,
  templateVariables,
  TERMINAL_JOB_STATUSES,
  validateParams,
  validatePrompt,
  variableLabel,
  type GenerationJob,
  type ModelDefinition,
  type ParamValues,
  type Prompt,
} from "@vidra/core"

import { EmptyState, JobStatusBadge, PageHeader } from "@/components/app/common"
import { PriceDisplay } from "@/components/app/price"
import { addReference, CapabilityBar, DynamicForm, formatAccepted, slotFor, type MediaSpec } from "@/components/studio/dynamic-form"
import { useGenerator } from "@/components/studio/generate"
import { ModelPicker, providerName } from "@/components/studio/model-picker"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useDebounced, useLive } from "@/hooks/use-live"
import { useI18n, type I18n } from "@/i18n"
import { api, backend } from "@/lib/backend"
import { attempt, jobErrorText, paramErrorMessage, toastError } from "@/lib/errors"
import { carryWithChanges, type ParamChange } from "@/lib/model-switch"
import { formatParamValue } from "@/lib/param-format"
import type { Estimate, GenerationInput, UploadedReference } from "@/lib/ipc"
import { useApp, useDraft, type StudioDraft } from "@/lib/store"
import { cn } from "@/lib/utils"

const LAST_MODEL_KEY = (output: string) => `vidra.studio.${output}.model`

function readLastModel(output: string): string | null {
  try {
    return localStorage.getItem(LAST_MODEL_KEY(output))
  } catch {
    return null
  }
}

function initialModel(models: ModelDefinition[], configured: Set<string>, output: string, draft: StudioDraft | null) {
  if (draft?.modelId && models.some((m) => m.id === draft.modelId)) return draft.modelId
  const last = readLastModel(output)
  if (last && models.some((m) => m.id === last)) return last
  return (models.find((m) => configured.has(m.provider)) ?? models[0])?.id ?? null
}

export function StudioScreen({ output }: { output: "video" | "image" }) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const navigate = useNavigate()
  const allModels = useApp((s) => s.models)
  const providers = useApp((s) => s.providers)
  const models = useMemo(() => allModels.filter((m) => m.output === output), [allModels, output])
  const configured = useMemo(
    () => new Set(providers.filter((p) => p.configured && p.enabled).map((p) => p.id as string)),
    [providers]
  )

  const [draft] = useState(() => useDraft.getState().draft)
  useEffect(() => {
    if (draft) useDraft.getState().take()
  }, [draft])

  const [modelId, setModelId] = useState<string | null>(() => initialModel(models, configured, output, draft))
  const model = models.find((m) => m.id === modelId) ?? null
  const [params, setParams] = useState<ParamValues>(() => {
    const m = models.find((x) => x.id === modelId)
    return m ? carryOver(draft?.params ?? {}, m) : {}
  })
  const [prompt, setPrompt] = useState(draft?.prompt ?? "")
  const [negativePrompt, setNegativePrompt] = useState(draft?.negativePrompt ?? "")
  const [promptId, setPromptId] = useState<string | null>(draft?.promptId ?? null)
  const [template, setTemplate] = useState<{ body: string; values: Record<string, string> } | null>(() =>
    draft?.template ? { body: draft.template.body, values: { ...draft.template.defaults } } : null
  )
  const [projectId, setProjectId] = useState<string | null>(null)
  const [references, setReferences] = useState<Record<string, UploadedReference>>({})
  const [uploadingKey, setUploadingKey] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notice, setNotice] = useState<{ model: string; changes: ParamChange[] } | null>(null)

  // Keep a valid model selected when the list changes (e.g. after sync).
  useEffect(() => {
    if (!model && models.length) {
      const next = initialModel(models, configured, output, null)
      setModelId(next)
      const m = models.find((x) => x.id === next)
      if (m) setParams(defaultValues(m))
    }
  }, [model, models, configured, output])

  const switchModel = (id: string) => {
    const next = models.find((m) => m.id === id)
    if (!next) return
    const { values, changes } = carryWithChanges(params, model, next)
    setModelId(id)
    setParams(values)
    setNotice(changes.length ? { model: next.displayName, changes } : null)
    setErrors({})
    try {
      localStorage.setItem(LAST_MODEL_KEY(output), id)
    } catch {
      /* ignore */
    }
  }

  /* Template editing */
  const rendered = template ? renderTemplate(template.body, template.values) : null
  useEffect(() => {
    if (rendered) setPrompt(rendered.text)
  }, [rendered?.text]) // eslint-disable-line react-hooks/exhaustive-deps

  const applyPrompt = (p: Prompt) => {
    let target = model
    if (target && p.preferredModelIds.length && !p.preferredModelIds.includes(target.id)) {
      const preferred = models.find((m) => p.preferredModelIds.includes(m.id))
      if (preferred) target = preferred
    }
    if (target) {
      if (target.id !== modelId) setModelId(target.id)
      setParams((prev) => carryOver({ ...prev, ...p.parameters }, target))
    }
    setPromptId(p.id)
    if (templateVariables(p.body).length) {
      setTemplate({ body: p.body, values: { ...p.variableDefaults } })
    } else {
      setTemplate(null)
      setPrompt(p.body)
    }
    toast.success(t("studio.presetApplied"), { description: p.title })
  }

  /* References */
  const pickReference = async (spec: MediaSpec) => {
    if (!model) return
    setUploadingKey(spec.key)
    try {
      const ref = await api.pickReference(model.provider, spec.mediaKind)
      if (ref) {
        const next = addReference(paramsRef.current, spec, ref.url)
        if (!next) {
          toast.error(t("studio.dropNoSlot", { name: ref.name }))
          return
        }
        setReferences((r) => ({ ...r, [ref.url]: ref }))
        paramsRef.current = next
        setParams(next)
      }
    } catch (e) {
      toastError(e)
    } finally {
      setUploadingKey(null)
    }
  }

  const modelRef = useRef(model)
  modelRef.current = model
  const paramsRef = useRef(params)
  paramsRef.current = params
  useEffect(() => {
    let off: (() => void) | undefined
    let cancelled = false
    void backend()
      .onFilesDropped(async (files) => {
        for (const file of files) {
          const m = modelRef.current
          if (!m) return
          if (file.kind === "unsupported") {
            toast.error(t("studio.dropUnsupported", { name: file.name }))
            continue
          }
          const spec = slotFor(m, paramsRef.current, file.kind)
          if (!spec) {
            toast.error(t("studio.dropNoSlot", { name: file.name }))
            continue
          }
          if (!formatAccepted(spec, file.name)) {
            toast.error(t("studio.dropBadFormat", { name: file.name, list: (spec.formats ?? []).map((f) => f.toUpperCase()).join(", ") }))
            continue
          }
          setUploadingKey(spec.key)
          try {
            const ref = await api.uploadDroppedReference(m.provider, file.token)
            const next = addReference(paramsRef.current, spec, ref.url)
            if (!next) {
              toast.error(t("studio.dropNoSlot", { name: file.name }))
              continue
            }
            setReferences((r) => ({ ...r, [ref.url]: ref }))
            paramsRef.current = next
            setParams(next)
          } catch (e) {
            toastError(e)
          } finally {
            setUploadingKey(null)
          }
        }
      })
      .then((u) => {
        if (cancelled) u()
        else off = u
      })
    return () => {
      cancelled = true
      off?.()
    }
  }, [t])

  /* Estimate */
  const input = useMemo<GenerationInput | null>(
    () =>
      model
        ? { modelId: model.id, prompt, negativePrompt: model.negativePrompt && negativePrompt.trim() ? negativePrompt : null, params }
        : null,
    [model, prompt, negativePrompt, params]
  )
  const debouncedKey = useDebounced(JSON.stringify(input), 400)
  const [estimate, setEstimate] = useState<{ loading: boolean; value: Estimate | null; failed: boolean }>({
    loading: false,
    value: null,
    failed: false,
  })
  useEffect(() => {
    const parsed = JSON.parse(debouncedKey) as GenerationInput | null
    if (!parsed) return
    let live = true
    setEstimate((e) => ({ ...e, loading: true }))
    api
      .estimateGeneration(parsed)
      .then((value) => live && setEstimate({ loading: false, value, failed: false }))
      .catch(() => live && setEstimate({ loading: false, value: null, failed: true }))
    return () => {
      live = false
    }
  }, [debouncedKey])

  /* Jobs */
  const jobs = useLive(() => api.listJobs(), "jobs", ["jobs-changed"])
  const recent = (jobs.data ?? []).filter((j) => j.output === output).slice(0, 6)
  const projects = useLive(() => api.listProjects(), "projects", ["archive-changed"])

  const { generate, busy, dialogs } = useGenerator()

  const onGenerate = useCallback(() => {
    if (!model || !input) return
    const next: Record<string, string> = {}
    const label = (key: string) => {
      const spec = model.params.find((p) => p.key === key)
      return spec ? i18n.loc(spec.label) : key
    }
    try {
      validatePrompt(model, prompt)
    } catch (e) {
      if (e instanceof ParamError) next.prompt = paramErrorMessage(e.code, e.details, t("studio.prompt")) ?? e.message
    }
    if (rendered?.missing.length) next.prompt = t("studio.fillVariables", { names: rendered.missing.join(", ") })
    try {
      validateParams(model, params)
    } catch (e) {
      if (e instanceof ParamError) next[e.key] = paramErrorMessage(e.code, e.details, label(e.key)) ?? e.message
    }
    const violations = checkRules(model, { values: params, prompt, negativePrompt })
    if (violations.length && !Object.keys(next).length) {
      toast.error(t("studio.fixErrors"), { description: i18n.loc(violations[0]!.message) })
      return
    }
    setErrors(next)
    if (Object.keys(next).length) {
      toast.error(t("studio.fixErrors"))
      return
    }
    void generate(input, { promptId, projectId, modelName: model.displayName })
  }, [model, input, prompt, negativePrompt, params, rendered, promptId, projectId, generate, t, i18n])

  const generateRef = useRef(onGenerate)
  generateRef.current = onGenerate
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault()
        generateRef.current()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const retry = (job: GenerationJob) => {
    const m = models.find((x) => x.id === job.modelId)
    if (!m) return toast.error(t("studio.modelUnavailable"))
    void generate(
      { modelId: job.modelId, prompt: job.prompt, negativePrompt: job.negativePrompt, params: job.params },
      { promptId: job.promptId, projectId: job.projectId, modelName: m.displayName }
    )
  }

  const title = output === "video" ? t("nav.video") : t("nav.image")
  if (!models.length)
    return (
      <>
        <PageHeader title={title} />
        <EmptyState
          icon={output === "video" ? <Clapperboard /> : <ImageIcon />}
          title={t("studio.noModels")}
          description={t("studio.noModelsBody")}
          action={
            <Button asChild size="sm">
              <Link to="/providers">{t("nav.providers")}</Link>
            </Button>
          }
        />
      </>
    )

  const providerReady = model ? configured.has(model.provider) : false
  const maxLength = model?.prompt.maxLength ?? 0

  return (
    <>
      <PageHeader title={title} description={output === "video" ? t("studio.videoIntro") : t("studio.imageIntro")} />
      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-6 max-[1100px]:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-5">
          <div className="rounded-xl border bg-card p-4">
            <Label className="mb-2 block text-xs font-medium text-muted-foreground">{t("studio.model")}</Label>
            <ModelPicker models={models} providers={providers} value={modelId} onChange={switchModel} />
            {model && <CapabilityBar model={model} />}
            {notice && (
              <div className="mt-3 rounded-md border border-warning/30 bg-warning/[0.05] p-2.5 text-xs" role="status" data-testid="switch-notice">
                <div className="flex items-start justify-between gap-2">
                  <p className="flex items-center gap-1.5 font-medium text-warning">
                    <Info className="size-3.5" />
                    {t("switch.title", { model: notice.model })}
                  </p>
                  <Button variant="ghost" size="xs" onClick={() => setNotice(null)}>
                    {t("switch.dismiss")}
                  </Button>
                </div>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
                  {notice.changes.map((c) => (
                    <li key={c.key}>{describeChange(i18n, c)}</li>
                  ))}
                </ul>
              </div>
            )}
            {model && !providerReady && (
              <p className="mt-2 text-xs text-warning" role="status">
                {t("studio.providerNotReady", { provider: providerName(providers, model.provider) })}{" "}
                <Link to="/providers" className="underline underline-offset-2">
                  {t("nav.providers")}
                </Link>
              </p>
            )}
          </div>

          {model && (
            <div className="space-y-4 rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="studio-prompt" className="text-xs font-medium text-muted-foreground">
                  {t("studio.prompt")}
                  {model.prompt.required && <span className="text-foreground"> *</span>}
                </Label>
                <div className="flex items-center gap-1">
                  {template && (
                    <Button variant="ghost" size="xs" onClick={() => setTemplate(null)}>
                      <Unlink />
                      {t("studio.detachTemplate")}
                    </Button>
                  )}
                  <PresetPicker onPick={applyPrompt} />
                </div>
              </div>
              {template && (
                <div className="space-y-3 rounded-lg border bg-black/25 p-3" data-testid="template-fields">
                  <div className="grid grid-cols-2 gap-3">
                    {templateVariables(template.body).map((name) => (
                      <div key={name} className="space-y-1">
                        <Label htmlFor={`var-${name}`} className="text-[11px] text-muted-foreground">
                          {variableLabel(name)}
                        </Label>
                        <Input
                          id={`var-${name}`}
                          className={cn("h-8", rendered?.missing.includes(name) && "border-warning/50")}
                          value={template.values[name] ?? ""}
                          onChange={(e) => setTemplate({ ...template, values: { ...template.values, [name]: e.target.value } })}
                        />
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-muted-foreground">{t("studio.templatePreview")}</p>
                </div>
              )}
              <Textarea
                id="studio-prompt"
                rows={template ? 4 : 6}
                value={prompt}
                readOnly={!!template}
                maxLength={maxLength}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  if (errors.prompt) setErrors(({ prompt: _p, ...rest }) => rest)
                }}
                placeholder={t("studio.promptPlaceholder")}
                aria-invalid={!!errors.prompt}
                className={cn("resize-y", template && "text-muted-foreground")}
                data-testid="prompt-input"
              />
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span className="text-destructive" role={errors.prompt ? "alert" : undefined}>
                  {errors.prompt}
                </span>
                <span className={cn("tabular-nums", prompt.length > maxLength * 0.95 && "text-warning")}>
                  {fmt.num(prompt.length)} / {fmt.num(maxLength)}
                </span>
              </div>
              {model.negativePrompt && (
                <div className="space-y-1.5">
                  <Label htmlFor="studio-negative" className="text-xs font-medium text-muted-foreground">
                    {t("studio.negativePrompt")}
                  </Label>
                  <Textarea
                    id="studio-negative"
                    rows={2}
                    maxLength={model.negativePrompt.maxLength}
                    value={negativePrompt}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                    placeholder={t("studio.negativePlaceholder")}
                  />
                </div>
              )}
            </div>
          )}

          {model && model.params.length > 0 && (
            <div className="rounded-xl border bg-card p-4">
              <h2 className="mb-4 text-xs font-medium text-muted-foreground">{t("studio.settings")}</h2>
              <DynamicForm
                model={model}
                values={params}
                prompt={prompt}
                negativePrompt={negativePrompt}
                onChange={(v) => {
                  setParams(v)
                  if (Object.keys(errors).length) setErrors({})
                }}
                references={references}
                onPickReference={pickReference}
                uploadingKey={uploadingKey}
                errors={errors}
              />
            </div>
          )}
        </div>

        <aside className="space-y-4">
          <div className="sticky top-0 space-y-4">
            <div className="space-y-4 rounded-xl border bg-card p-4">
              <div>
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-muted-foreground">{t("estimate.label")}</span>
                  {estimate.loading && <Loader2 className="size-3 animate-spin text-muted-foreground" aria-label={t("common.loading")} />}
                </div>
                <div className="mt-1" data-testid="studio-estimate">
                  <PriceDisplay estimate={estimate.value} failed={estimate.failed} size="lg" />
                </div>
                {estimate.value && estimate.value.budget.exceeded.length > 0 && (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {t("budget.wouldExceed")}
                  </p>
                )}
                {estimate.value && !estimate.value.budget.exceeded.length && estimate.value.budget.warnings.length > 0 && (
                  <p className="mt-2 text-xs text-warning" role="status">
                    {t("budget.nearLimit")}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground" htmlFor="studio-project">
                  {t("archive.project")}
                </Label>
                <Select value={projectId ?? "none"} onValueChange={(v) => setProjectId(v === "none" ? null : v)}>
                  <SelectTrigger id="studio-project" size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("archive.noProject")}</SelectItem>
                    {(projects.data ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button className="w-full" size="lg" disabled={!model || busy} onClick={onGenerate} data-testid="generate-button">
                {busy ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {t("studio.generate")}
                <kbd className="ml-auto rounded bg-black/10 px-1 font-mono text-[10px]">Ctrl ↵</kbd>
              </Button>
              <p className="text-[11px] leading-relaxed text-muted-foreground">{t("estimate.note")}</p>
            </div>

            <div className="rounded-xl border bg-card">
              <div className="flex items-center justify-between border-b px-4 py-2.5">
                <h2 className="text-xs font-medium text-muted-foreground">{t("studio.jobs")}</h2>
                <Button variant="ghost" size="xs" asChild>
                  <Link to="/generations">{t("common.viewAll")}</Link>
                </Button>
              </div>
              <ul className="divide-y" data-testid="studio-jobs">
                {recent.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted-foreground">{t("studio.noJobs")}</li>}
                {recent.map((job) => (
                  <JobRow key={job.id} job={job} onRetry={() => retry(job)} onOpen={() => void navigate("/archive")} />
                ))}
              </ul>
            </div>
          </div>
        </aside>
      </div>
      {dialogs}
    </>
  )
}

function describeChange(i18n: I18n, c: ParamChange): string {
  const label = i18n.loc(c.spec.label)
  const from = formatParamValue(i18n, c.previousSpec ?? c.spec, c.from)
  if (c.kind === "removed") return i18n.t("switch.removed", { label })
  const to = formatParamValue(i18n, c.spec, c.to)
  if (c.kind === "clamped") {
    const max = c.max == null ? to : formatParamValue(i18n, c.spec, c.max)
    const text = i18n.t("switch.clamped", { label, from, to, max })
    return c.reason ? `${text} — ${i18n.loc(c.reason)}` : text
  }
  return i18n.t("switch.reset", { label, from, to })
}

function JobRow({ job, onRetry, onOpen }: { job: GenerationJob; onRetry: () => void; onOpen: () => void }) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const providers = useApp((s) => s.providers)
  const canCancel = providers.find((p) => p.id === job.provider)?.capabilities.cancel ?? false
  const terminal = TERMINAL_JOB_STATUSES.includes(job.status)
  return (
    <li className="space-y-2 px-4 py-3" data-job-status={job.status}>
      <div className="flex items-center justify-between gap-2">
        <JobStatusBadge status={job.status} />
        <span className="text-[11px] text-muted-foreground tabular-nums">{fmt.usd(job.estimatedCostUsd)}</span>
      </div>
      <p className="line-clamp-2 text-xs">{job.prompt || job.modelName}</p>
      {!terminal && <Progress value={job.status === "generating" ? 60 : 15} className="h-0.5" aria-label={t(`job.${job.status}`)} />}
      {(job.errorCode || job.errorMessage) && <p className="text-[11px] text-destructive">{jobErrorText(i18n, job)}</p>}
      {job.errorCode === "submit_uncertain" && <p className="text-[11px] text-warning">{t("generate.uncertainBody")}</p>}
      <div className="flex gap-1">
        {!terminal && canCancel && (
          <Button variant="ghost" size="xs" onClick={() => void attempt(() => api.cancelGeneration(job.id), t("studio.canceled"))}>
            <X />
            {t("common.cancel")}
          </Button>
        )}
        {(job.status === "failed" || job.status === "canceled" || job.status === "blocked") && (
          <Button variant="ghost" size="xs" onClick={onRetry}>
            <RotateCcw />
            {t("common.retry")}
          </Button>
        )}
        {job.status === "completed" && (
          <Button variant="ghost" size="xs" onClick={onOpen}>
            <FolderOpen />
            {t("studio.openInArchive")}
          </Button>
        )}
      </div>
    </li>
  )
}

function PresetPicker({ onPick }: { onPick: (p: Prompt) => void }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<Prompt[] | null>(null)
  useEffect(() => {
    if (!open) return
    let live = true
    api
      .listPrompts()
      .then((p) => live && setList(p))
      .catch(toastError)
    return () => {
      live = false
    }
  }, [open])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" data-testid="preset-picker">
          <BookOpen />
          {t("studio.fromLibrary")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="end">
        <Command>
          <CommandInput placeholder={t("prompts.search")} />
          <CommandList className="max-h-72">
            <CommandEmpty>{list ? t("prompts.noMatch") : t("common.loading")}</CommandEmpty>
            {(list ?? []).map((p) => (
              <CommandItem
                key={p.id}
                value={`${p.title} ${p.tags.join(" ")} ${p.id}`}
                onSelect={() => {
                  setOpen(false)
                  onPick(p)
                }}
              >
                <div className="min-w-0">
                  <div className="truncate">{p.title}</div>
                  <div className="truncate text-xs text-muted-foreground">{p.body}</div>
                </div>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
