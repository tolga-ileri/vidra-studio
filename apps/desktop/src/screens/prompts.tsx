import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react"
import {
  Check,
  Copy,
  Download,
  FolderPlus,
  History,
  LayoutGrid,
  Library,
  List,
  MoreHorizontal,
  Pencil,
  Plus,
  Sparkles,
  Star,
  Trash2,
  Upload,
} from "lucide-react"
import { toast } from "sonner"
import {
  carryOver,
  renderTemplate,
  templateVariables,
  variableLabel,
  type Id,
  type ModelDefinition,
  type ParamValues,
  type Prompt,
  type PromptCategory,
  type PromptInput,
} from "@vidra/core"

import { ConfirmDialog, EmptyState, LoadingRows, NameDialog, PageHeader } from "@/components/app/common"
import { DynamicForm } from "@/components/studio/dynamic-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useLive } from "@/hooks/use-live"
import { useOpenInStudio } from "@/hooks/use-open-in-studio"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt } from "@/lib/errors"
import { useApp } from "@/lib/store"
import { cn } from "@/lib/utils"

type Filter = { kind: "all" } | { kind: "favorites" } | { kind: "category"; id: Id }
const VIEW_KEY = "vidra.prompts.view"

const VAR = /(\{[A-Za-z][A-Za-z0-9_]{0,39}\})/g

/** Prompt text with {variables} highlighted. */
export function HighlightedBody({ body, className }: { body: string; className?: string }) {
  const parts = body.split(VAR)
  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="rounded bg-white/10 px-0.5 font-medium text-foreground">
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        )
      )}
    </span>
  )
}

export function PromptsScreen() {
  const { t, fmt } = useI18n()
  const models = useApp((s) => s.models)
  const openInStudio = useOpenInStudio()
  const [filter, setFilter] = useState<Filter>({ kind: "all" })
  const [search, setSearch] = useState("")
  const [tag, setTag] = useState<string>("all")
  const [layout, setLayout] = useState<"list" | "grid">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "grid" ? "grid" : "list"
    } catch {
      return "list"
    }
  })
  const [editing, setEditing] = useState<Prompt | "new" | null>(null)
  const [versionsOf, setVersionsOf] = useState<Prompt | null>(null)
  const [deleting, setDeleting] = useState<Prompt | null>(null)
  const [categoryDialog, setCategoryDialog] = useState<{ mode: "create" } | { mode: "rename"; cat: PromptCategory } | null>(null)
  const [deletingCategory, setDeletingCategory] = useState<PromptCategory | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, layout)
    } catch {
      /* ignore */
    }
  }, [layout])

  const query = {
    search: search.trim() || undefined,
    categoryId: filter.kind === "category" ? filter.id : undefined,
    favorite: filter.kind === "favorites" || undefined,
    tag: tag === "all" ? undefined : tag,
  }
  const prompts = useLive(() => api.listPrompts(query), JSON.stringify(query), ["prompts-changed"])
  const all = useLive(() => api.listPrompts(), "all-prompts", ["prompts-changed"])
  const categories = useLive(() => api.listCategories(), "categories", ["prompts-changed"])
  const tags = useMemo(() => [...new Set((all.data ?? []).flatMap((p) => p.tags))].sort(), [all.data])
  const catName = (id: Id | null) => categories.data?.find((c) => c.id === id)?.name

  const startInStudio = (p: Prompt) => {
    const model = models.find((m) => p.preferredModelIds.includes(m.id)) ?? null
    const vars = templateVariables(p.body)
    openInStudio(
      {
        modelId: model?.id ?? null,
        prompt: vars.length ? renderTemplate(p.body, p.variableDefaults).text : p.body,
        negativePrompt: null,
        params: p.parameters,
        promptId: p.id,
        template: vars.length ? { body: p.body, defaults: p.variableDefaults } : undefined,
      },
      model?.output ?? "video"
    )
  }

  const side = (f: Filter, label: string, extra?: ReactNode, count?: number) => {
    const active = JSON.stringify(f) === JSON.stringify(filter)
    return (
      <div key={label + JSON.stringify(f)} className={cn("group flex items-center rounded-md", active && "bg-white/[0.07]")}>
        <button
          type="button"
          onClick={() => setFilter(f)}
          aria-current={active ? "page" : undefined}
          className={cn("flex h-8 min-w-0 flex-1 items-center justify-between gap-2 px-2.5 text-left text-[13px] text-muted-foreground hover:text-foreground", active && "text-foreground")}
        >
          <span className="truncate">{label}</span>
          {count != null && <span className="text-[11px] tabular-nums">{count}</span>}
        </button>
        {extra}
      </div>
    )
  }

  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of all.data ?? []) if (p.categoryId) m.set(p.categoryId, (m.get(p.categoryId) ?? 0) + 1)
    return m
  }, [all.data])

  const list = prompts.data ?? []

  return (
    <>
      <PageHeader
        title={t("nav.prompts")}
        description={t("prompts.subtitle")}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void attempt(async () => {
                  const r = await api.importPrompts()
                  if (r) toast.success(t("prompts.imported", { imported: r.imported, skipped: r.skipped }))
                })
              }
            >
              <Upload />
              {t("prompts.import")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void attempt(async () => {
                  if (await api.exportPrompts(null)) toast.success(t("prompts.exported"))
                })
              }
            >
              <Download />
              {t("prompts.exportAll")}
            </Button>
            <Button size="sm" onClick={() => setEditing("new")} data-testid="new-prompt">
              <Plus />
              {t("prompts.new")}
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[210px_minmax(0,1fr)] gap-6">
        <aside className="space-y-4" aria-label={t("prompts.categories")}>
          <div className="space-y-0.5">
            {side({ kind: "all" }, t("prompts.all"), undefined, all.data?.length)}
            {side({ kind: "favorites" }, t("prompts.favorites"), undefined, all.data?.filter((p) => p.favorite).length)}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("prompts.categories")}</span>
              <Button variant="ghost" size="icon-xs" aria-label={t("prompts.newCategory")} onClick={() => setCategoryDialog({ mode: "create" })}>
                <FolderPlus />
              </Button>
            </div>
            <div className="space-y-0.5">
              {(categories.data ?? []).map((c) =>
                side(
                  { kind: "category", id: c.id },
                  c.name,
                  !c.builtIn && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-xs" className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t("prompts.categoryActions", { name: c.name })}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => setCategoryDialog({ mode: "rename", cat: c })}>
                          <Pencil />
                          {t("archive.rename")}
                        </DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeletingCategory(c)}>
                          <Trash2 />
                          {t("common.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ),
                  counts.get(c.id) ?? 0
                )
              )}
            </div>
          </div>
        </aside>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-page-search
              type="search"
              placeholder={t("prompts.search")}
              aria-label={t("prompts.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-64"
            />
            <Select value={tag} onValueChange={setTag}>
              <SelectTrigger size="sm" className="w-40" aria-label={t("prompts.tag")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("prompts.allTags")}</SelectItem>
                {tags.map((x) => (
                  <SelectItem key={x} value={x}>
                    #{x}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={layout}
              onValueChange={(v) => v && setLayout(v as typeof layout)}
              className="ml-auto"
              aria-label={t("prompts.layout")}
            >
              <ToggleGroupItem value="list" aria-label={t("prompts.listView")}>
                <List />
              </ToggleGroupItem>
              <ToggleGroupItem value="grid" aria-label={t("prompts.gridView")}>
                <LayoutGrid />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>

          {prompts.loading && !prompts.data ? (
            <LoadingRows rows={5} />
          ) : list.length === 0 ? (
            <EmptyState
              icon={<Library />}
              title={search || tag !== "all" ? t("prompts.noMatch") : t("prompts.empty")}
              action={
                <Button size="sm" onClick={() => setEditing("new")}>
                  <Plus />
                  {t("prompts.new")}
                </Button>
              }
            />
          ) : (
            <ul className={cn(layout === "grid" ? "grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3" : "divide-y rounded-xl border bg-card")} data-testid="prompt-list">
              {list.map((p) => (
                <li
                  key={p.id}
                  data-prompt-title={p.title}
                  className={cn("group flex gap-3", layout === "grid" ? "flex-col rounded-xl border bg-card p-4" : "items-start px-4 py-3")}
                >
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="truncate text-left text-sm font-medium hover:underline"
                        onClick={() => setEditing(p)}
                      >
                        {p.title}
                      </button>
                      {p.version > 1 && <span className="text-[10px] text-muted-foreground">v{p.version}</span>}
                    </div>
                    <p className={cn("text-xs text-muted-foreground", layout === "grid" ? "line-clamp-4" : "line-clamp-2")}>
                      <HighlightedBody body={p.body} />
                    </p>
                    <div className="flex flex-wrap items-center gap-1">
                      {catName(p.categoryId) && (
                        <Badge variant="outline" className="text-[10px]">
                          {catName(p.categoryId)}
                        </Badge>
                      )}
                      {p.tags.map((x) => (
                        <Badge key={x} variant="secondary" className="text-[10px]">
                          #{x}
                        </Badge>
                      ))}
                      <span className="ml-auto text-[10px] text-muted-foreground">{fmt.date(p.updatedAt)}</span>
                    </div>
                  </div>
                  <div className={cn("flex items-center gap-1", layout === "grid" && "justify-end")}>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-pressed={p.favorite}
                      aria-label={p.favorite ? t("prompts.unfavorite") : t("prompts.favorite")}
                      onClick={() => void attempt(() => api.setPromptFavorite(p.id, !p.favorite))}
                    >
                      <Star className={cn(p.favorite && "fill-current")} />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => startInStudio(p)}>
                      <Sparkles />
                      {t("prompts.useInStudio")}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon-sm" aria-label={t("prompts.actionsFor", { title: p.title })}>
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setEditing(p)}>
                          <Pencil />
                          {t("common.edit")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void attempt(() => api.duplicatePrompt(p.id), t("prompts.duplicated"))}>
                          <Copy />
                          {t("prompts.duplicate")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setVersionsOf(p)}>
                          <History />
                          {t("prompts.versions")}
                        </DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => void attempt(async () => (await api.exportPrompts([p.id])) && toast.success(t("prompts.exported")))}>
                          <Download />
                          {t("prompts.export")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(p)}>
                          <Trash2 />
                          {t("common.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <PromptEditor
        prompt={editing}
        categories={categories.data ?? []}
        defaultCategory={filter.kind === "category" ? filter.id : null}
        models={models}
        onClose={() => setEditing(null)}
      />
      <VersionsSheet prompt={versionsOf} onClose={() => setVersionsOf(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t("prompts.deleteTitle", { title: deleting?.title ?? "" })}
        description={t("prompts.deleteBody")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={async () => {
          if (deleting) await attempt(() => api.deletePrompt(deleting.id), t("prompts.deleted"))
          setDeleting(null)
        }}
      />
      <NameDialog
        open={!!categoryDialog}
        onOpenChange={(o) => !o && setCategoryDialog(null)}
        title={categoryDialog?.mode === "rename" ? t("prompts.renameCategory") : t("prompts.newCategory")}
        label={t("prompts.categoryName")}
        initial={categoryDialog?.mode === "rename" ? categoryDialog.cat.name : ""}
        confirmLabel={categoryDialog?.mode === "rename" ? t("common.save") : t("common.create")}
        onSubmit={async (name) => {
          const d = categoryDialog
          if (!d) return
          const r = await attempt(() => (d.mode === "rename" ? api.renameCategory(d.cat.id, name) : api.createCategory(name).then(() => undefined)))
          return r !== undefined || false
        }}
      />
      <ConfirmDialog
        open={!!deletingCategory}
        onOpenChange={(o) => !o && setDeletingCategory(null)}
        title={t("prompts.deleteCategoryTitle", { name: deletingCategory?.name ?? "" })}
        description={t("prompts.deleteCategoryBody")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={async () => {
          if (!deletingCategory) return
          await attempt(() => api.deleteCategory(deletingCategory.id))
          if (filter.kind === "category" && filter.id === deletingCategory.id) setFilter({ kind: "all" })
          setDeletingCategory(null)
        }}
      />
    </>
  )
}

function PromptEditor({
  prompt,
  categories,
  defaultCategory,
  models,
  onClose,
}: {
  prompt: Prompt | "new" | null
  categories: PromptCategory[]
  defaultCategory: Id | null
  models: ModelDefinition[]
  onClose: () => void
}) {
  const { t, model: mn } = useI18n()
  const existing = prompt && prompt !== "new" ? prompt : null
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [categoryId, setCategoryId] = useState<Id | null>(null)
  const [tags, setTags] = useState("")
  const [favorite, setFavorite] = useState(false)
  const [preferred, setPreferred] = useState<string[]>([])
  const [presetModel, setPresetModel] = useState<string | null>(null)
  const [parameters, setParameters] = useState<ParamValues>({})
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!prompt) return
    const p = prompt === "new" ? null : prompt
    setTitle(p?.title ?? "")
    setBody(p?.body ?? "")
    setCategoryId(p ? p.categoryId : defaultCategory)
    setTags(p?.tags.join(", ") ?? "")
    setFavorite(p?.favorite ?? false)
    setPreferred(p?.preferredModelIds ?? [])
    setPresetModel(p?.preferredModelIds[0] ?? null)
    setParameters(p?.parameters ?? {})
    setDefaults(p?.variableDefaults ?? {})
  }, [prompt, defaultCategory])

  const variables = templateVariables(body)
  const preview = renderTemplate(body, defaults)
  const preset = models.find((m) => m.id === presetModel)
  const presetForm = preset ? { ...preset, params: preset.params.filter((p) => p.type !== "media") } : null

  const save = async () => {
    const input: PromptInput = {
      title,
      body,
      categoryId,
      tags: tags
        .split(",")
        .map((x) => x.trim().replace(/^#/, ""))
        .filter(Boolean),
      favorite,
      preferredModelIds: preferred,
      parameters,
      variableDefaults: Object.fromEntries(Object.entries(defaults).filter(([k, v]) => variables.includes(k) && v.trim())),
    }
    setBusy(true)
    const r = await attempt(() => (existing ? api.updatePrompt(existing.id, input) : api.createPrompt(input)), t("prompts.saved"))
    setBusy(false)
    if (r) onClose()
  }

  return (
    <Dialog open={!!prompt} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{existing ? t("prompts.edit") : t("prompts.new")}</DialogTitle>
          <DialogDescription>{t("prompts.editorHint")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="grid grid-cols-[1fr_200px] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="prompt-title">{t("prompts.titleField")}</Label>
              <Input id="prompt-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prompt-category">{t("prompts.category")}</Label>
              <Select value={categoryId ?? "none"} onValueChange={(v) => setCategoryId(v === "none" ? null : v)}>
                <SelectTrigger id="prompt-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("prompts.uncategorized")}</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="prompt-body">{t("prompts.body")}</Label>
            <Textarea id="prompt-body" rows={5} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} required />
            <p className="text-[11px] text-muted-foreground">{t("prompts.variablesHint")}</p>
          </div>
          {variables.length > 0 && (
            <div className="space-y-3 rounded-lg border bg-black/25 p-3">
              <p className="text-xs font-medium text-muted-foreground">{t("prompts.variableDefaults")}</p>
              <div className="grid grid-cols-2 gap-3">
                {variables.map((v) => (
                  <div key={v} className="space-y-1">
                    <Label htmlFor={`def-${v}`} className="text-[11px] text-muted-foreground">
                      {variableLabel(v)}
                    </Label>
                    <Input id={`def-${v}`} className="h-8" value={defaults[v] ?? ""} onChange={(e) => setDefaults({ ...defaults, [v]: e.target.value })} />
                  </div>
                ))}
              </div>
              <div>
                <p className="mb-1 text-[11px] text-muted-foreground">{t("prompts.preview")}</p>
                <p className="rounded-md border bg-black/30 p-2 text-xs" data-testid="prompt-preview">
                  <HighlightedBody body={preview.text} />
                </p>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="prompt-tags">{t("archive.tags")}</Label>
              <Input id="prompt-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("prompts.tagsPlaceholder")} />
            </div>
            <div className="space-y-1.5">
              <Label>{t("prompts.preferredModels")}</Label>
              <ModelMultiSelect models={models} value={preferred} onChange={setPreferred} />
            </div>
          </div>
          <div className="space-y-3 rounded-lg border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium">{t("prompts.parameterPreset")}</p>
                <p className="text-[11px] text-muted-foreground">{t("prompts.parameterPresetHint")}</p>
              </div>
              <Select
                value={presetModel ?? "none"}
                onValueChange={(v) => {
                  const m = models.find((x) => x.id === v)
                  setPresetModel(m ? m.id : null)
                  setParameters(m ? carryOver(parameters, { ...m, params: m.params.filter((p) => p.type !== "media") }) : {})
                }}
              >
                <SelectTrigger size="sm" className="w-56" aria-label={t("prompts.presetModel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("prompts.noPreset")}</SelectItem>
                  {models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {mn(m.displayName)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {presetForm && presetForm.params.length > 0 && (
              <DynamicForm model={presetForm} values={parameters} onChange={setParameters} references={{}} onPickReference={async () => undefined} />
            )}
            {!presetForm && Object.keys(parameters).length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                {Object.entries(parameters)
                  .map(([k, v]) => `${k}: ${String(v)}`)
                  .join(" · ")}
              </p>
            )}
            {presetForm && presetForm.params.length === 0 && <p className="text-[11px] text-muted-foreground">{t("prompts.noPresetParams")}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={busy || !title.trim() || !body.trim()} data-testid="save-prompt">
              {t("common.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ModelMultiSelect({ models, value, onChange }: { models: ModelDefinition[]; value: string[]; onChange: (v: string[]) => void }) {
  const { t, model: mn } = useI18n()
  const [open, setOpen] = useState(false)
  const names = value.map((id) => models.find((m) => m.id === id)?.displayName ?? id).map(mn)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full justify-start font-normal" aria-label={t("prompts.preferredModels")}>
          <span className="truncate">{names.length ? names.join(", ") : t("prompts.anyModel")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder={t("studio.searchModels")} />
          <CommandList className="max-h-64">
            <CommandEmpty>{t("studio.noModelMatch")}</CommandEmpty>
            {models.map((m) => {
              const on = value.includes(m.id)
              return (
                <CommandItem
                  key={m.id}
                  value={`${m.displayName} ${m.provider}`}
                  onSelect={() => onChange(on ? value.filter((x) => x !== m.id) : [...value, m.id].slice(0, 20))}
                >
                  <Check className={cn(on ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{mn(m.displayName)}</span>
                  <span className="ml-auto text-[10px] text-muted-foreground">{m.provider}</span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function VersionsSheet({ prompt, onClose }: { prompt: Prompt | null; onClose: () => void }) {
  const { t, fmt } = useI18n()
  const versions = useLive(() => (prompt ? api.listPromptVersions(prompt.id) : Promise.resolve([])), prompt?.id ?? "none", ["prompts-changed"])
  const current = useLive(() => (prompt ? api.getPrompt(prompt.id) : Promise.resolve(null)), `cur-${prompt?.id}`, ["prompts-changed"])
  return (
    <Sheet open={!!prompt} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-[440px] overflow-y-auto sm:max-w-[440px]">
        <SheetHeader>
          <SheetTitle>{t("prompts.versions")}</SheetTitle>
          <SheetDescription>{prompt?.title}</SheetDescription>
        </SheetHeader>
        <ol className="space-y-3 px-4 pb-6" data-testid="versions">
          {(versions.data ?? []).map((v) => {
            const isCurrent = current.data?.version === v.version
            return (
              <li key={v.id} className="space-y-2 rounded-lg border bg-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    v{v.version} {isCurrent && <span className="text-xs text-muted-foreground">· {t("prompts.current")}</span>}
                  </span>
                  <span className="text-[11px] text-muted-foreground">{fmt.dateTime(v.createdAt)}</span>
                </div>
                <p className="text-xs font-medium">{v.title}</p>
                <p className="line-clamp-4 text-xs text-muted-foreground">
                  <HighlightedBody body={v.body} />
                </p>
                {!isCurrent && prompt && (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void attempt(() => api.restorePromptVersion(prompt.id, v.version), t("prompts.restored", { version: v.version }))}
                  >
                    <History />
                    {t("prompts.restore")}
                  </Button>
                )}
              </li>
            )
          })}
        </ol>
      </SheetContent>
    </Sheet>
  )
}
