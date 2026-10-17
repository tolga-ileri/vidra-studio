import { useNavigate } from "react-router"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  BookmarkPlus,
  Copy,
  Download,
  Folder,
  FolderArchive,
  FolderInput,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Heart,
  HeartOff,
  Library,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Undo2,
  X,
  Film,
} from "lucide-react"
import { toast } from "sonner"
import type { ArchiveEntry, ArchiveQuery, Id, ProviderId } from "@vidra/core"

import { ConfirmDialog, CopyButton, EmptyState, Kv, NameDialog, PageHeader, Skeleton, StateBadge } from "@/components/app/common"
import { Thumb } from "@/components/archive/thumb"
import { MediaViewer } from "@/components/archive/viewer"
import { estimateSourceLabel } from "@/components/studio/generate"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { DateField } from "@/components/app/date-field"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useLive } from "@/hooks/use-live"
import { useOpenInStudio } from "@/hooks/use-open-in-studio"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt, jobErrorText } from "@/lib/errors"
import { useApp } from "@/lib/store"
import { cn } from "@/lib/utils"

type View = { kind: "all" } | { kind: "favorites" } | { kind: "trash" } | { kind: "project"; id: Id }
const PAGE = 48

const entryKey = (e: ArchiveEntry) => e.asset?.id ?? e.job.id
const titleOf = (e: ArchiveEntry) => e.item?.customTitle || e.job.prompt.slice(0, 80) || e.job.modelName

function dayStart(value: string): number | undefined {
  if (!value) return undefined
  const [y, m, d] = value.split("-").map(Number)
  return y && m && d ? new Date(y, m - 1, d).getTime() : undefined
}

export function ArchiveScreen() {
  const i18n = useI18n()
  const { t, fmt, model: mn } = i18n
  const providers = useApp((s) => s.providers)
  const models = useApp((s) => s.models)
  const openInStudio = useOpenInStudio()
  const navigate = useNavigate()

  const [view, setView] = useState<View>({ kind: "all" })
  const [search, setSearch] = useState("")
  const [provider, setProvider] = useState<ProviderId | "all">("all")
  const [output, setOutput] = useState<"all" | "video" | "image">("all")
  const [modelId, setModelId] = useState<string>("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [sort, setSort] = useState<NonNullable<ArchiveQuery["sort"]>>("date")
  const [direction, setDirection] = useState<"asc" | "desc">("desc")
  const [selected, setSelected] = useState<Set<Id>>(new Set())
  const [detailKey, setDetailKey] = useState<string | null>(null)
  const [viewer, setViewer] = useState<ArchiveEntry | null>(null)
  const [limit, setLimit] = useState(PAGE)

  const [renaming, setRenaming] = useState<ArchiveEntry | null>(null)
  const [savingPrompt, setSavingPrompt] = useState<ArchiveEntry | null>(null)
  const [projectDialog, setProjectDialog] = useState<{ mode: "create" } | { mode: "rename"; id: Id; name: string } | null>(null)
  const [deleteProject, setDeleteProject] = useState<{ id: Id; name: string } | null>(null)
  const [deleteForever, setDeleteForever] = useState<Id[] | null>(null)

  const query: ArchiveQuery = {
    search: search.trim() || undefined,
    provider: provider === "all" ? undefined : provider,
    output: output === "all" ? undefined : output,
    modelId: modelId === "all" ? undefined : modelId,
    from: dayStart(from),
    to: to ? (dayStart(to) ?? 0) + 86400000 - 1 : undefined,
    favorite: view.kind === "favorites" || undefined,
    projectId: view.kind === "project" ? view.id : undefined,
    trashed: view.kind === "trash",
    sort,
    direction,
  }
  const key = JSON.stringify(query)
  const archive = useLive(() => api.listArchive(query), key, ["archive-changed", "jobs-changed"])
  const projects = useLive(() => api.listProjects(), "projects", ["archive-changed"])
  const storage = useLive(() => api.storageStats(), "storage", ["archive-changed"])
  const entries = useMemo(() => archive.data ?? [], [archive.data])

  useEffect(() => {
    setSelected(new Set())
    setLimit(PAGE)
  }, [key])

  // Drop selections that disappeared.
  useEffect(() => {
    setSelected((s) => {
      const ids = new Set(entries.map((e) => e.item?.id).filter(Boolean) as Id[])
      const next = new Set([...s].filter((id) => ids.has(id)))
      return next.size === s.size ? s : next
    })
  }, [entries])

  const sentinel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !sentinel.current) return
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setLimit((l) => l + PAGE))
    io.observe(sentinel.current)
    return () => io.disconnect()
  }, [entries.length])

  const detail = entries.find((e) => entryKey(e) === detailKey) ?? null
  const selectedIds = [...selected]
  const allSelectable = entries.filter((e) => e.item).map((e) => e.item!.id)
  const projectName = (id: Id | null | undefined) => projects.data?.find((p) => p.id === id)?.name

  const toggle = (id: Id) =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  const actions = {
    favorite: (ids: Id[], fav: boolean) => attempt(() => api.setFavorite(ids, fav)),
    move: (ids: Id[], project: Id | null) => attempt(() => api.moveToProject(ids, project), t("archive.moved")),
    trash: (ids: Id[]) =>
      attempt(async () => {
        await api.trashItems(ids)
        toast.success(t("archive.trashed", { count: ids.length }), {
          action: { label: t("common.undo"), onClick: () => void attempt(() => api.restoreItems(ids)) },
        })
      }),
    restore: (ids: Id[]) => attempt(() => api.restoreItems(ids), t("archive.restored")),
    export: (e: ArchiveEntry) =>
      e.asset &&
      attempt(async () => {
        const ok = await api.exportMedia(e.asset!.id, titleOf(e).replace(/[^\w\- ]+/g, "").slice(0, 60) || "vidra")
        if (ok) toast.success(t("archive.exported"))
      }),
    regenerate: (e: ArchiveEntry) =>
      openInStudio(
        {
          modelId: e.job.modelId,
          prompt: e.job.prompt,
          negativePrompt: e.job.negativePrompt,
          params: e.job.params,
          promptId: e.job.promptId,
          references: e.job.references,
          preserveIdentity: e.job.preserveIdentity,
        },
        e.job.output
      ),
    openInEditor: (e: ArchiveEntry) => e.asset && void navigate(`/editor?asset=${encodeURIComponent(e.asset.id)}`),
    copyPrompt: (e: ArchiveEntry) =>
      void navigator.clipboard?.writeText(e.job.prompt).then(() => toast.success(t("common.copied")), () => undefined),
    reveal: (e: ArchiveEntry) => e.asset && attempt(() => api.openFileLocation(e.asset!.id)),
    retryDownload: (e: ArchiveEntry) => e.asset && attempt(() => api.retryDownload(e.asset!.id), t("downloads.retrying")),
  }

  const menu = (e: ArchiveEntry) => {
    const item = e.item
    const saved = e.state === "saved"
    const inTrash = e.state === "trashed"
    return (
      <DropdownMenuContent align="end" className="w-52">
        {saved && (
          <DropdownMenuItem onSelect={() => setViewer(e)}>
            <Play />
            {e.job.output === "video" ? t("archive.play") : t("archive.view")}
          </DropdownMenuItem>
        )}
        {saved && (
          <DropdownMenuItem onSelect={() => void actions.export(e)}>
            <Download />
            {t("archive.export")}
          </DropdownMenuItem>
        )}
        {item && !inTrash && (
          <DropdownMenuItem onSelect={() => void actions.favorite([item.id], !item.favorite)}>
            {item.favorite ? <HeartOff /> : <Heart />}
            {item.favorite ? t("archive.unfavorite") : t("archive.favorite")}
          </DropdownMenuItem>
        )}
        {item && !inTrash && (
          <DropdownMenuItem onSelect={() => setRenaming(e)}>
            <Pencil />
            {t("archive.rename")}
          </DropdownMenuItem>
        )}
        {item && !inTrash && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <FolderInput />
              {t("archive.moveTo")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => void actions.move([item.id], null)}>{t("archive.noProject")}</DropdownMenuItem>
              {(projects.data ?? []).map((p) => (
                <DropdownMenuItem key={p.id} onSelect={() => void actions.move([item.id], p.id)}>
                  {p.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuItem onSelect={() => actions.regenerate(e)}>
          <RefreshCw />
          {t("archive.regenerate")}
        </DropdownMenuItem>
        {e.state === "saved" && e.job.output === "video" && (
          <DropdownMenuItem onSelect={() => actions.openInEditor(e)} data-testid="archive-open-editor">
            <Film />
            {t("archive.openInEditor")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => actions.copyPrompt(e)}>
          <Copy />
          {t("archive.copyPrompt")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setSavingPrompt(e)}>
          <BookmarkPlus />
          {t("archive.savePrompt")}
        </DropdownMenuItem>
        {(e.state === "download_failed" || e.state === "missing") && (
          <DropdownMenuItem onSelect={() => void actions.retryDownload(e)}>
            <RotateCcw />
            {t("downloads.retry")}
          </DropdownMenuItem>
        )}
        {saved && (
          <DropdownMenuItem onSelect={() => void actions.reveal(e)}>
            <FolderOpen />
            {t("archive.reveal")}
          </DropdownMenuItem>
        )}
        {item && (
          <>
            <DropdownMenuSeparator />
            {inTrash ? (
              <>
                <DropdownMenuItem onSelect={() => void actions.restore([item.id])}>
                  <Undo2 />
                  {t("archive.restore")}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setDeleteForever([item.id])}>
                  <Trash2 />
                  {t("archive.deleteForever")}
                </DropdownMenuItem>
              </>
            ) : (
              <DropdownMenuItem variant="destructive" onSelect={() => void actions.trash([item.id])}>
                <Trash2 />
                {t("archive.moveToTrash")}
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    )
  }

  const navItem = (v: View, label: string, Icon: typeof Folder, extra?: ReactNode) => {
    const active = JSON.stringify(v) === JSON.stringify(view)
    return (
      <div key={JSON.stringify(v)} className={cn("group flex items-center rounded-md", active && "bg-white/[0.07]")}>
        <button
          type="button"
          onClick={() => setView(v)}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-2 px-2.5 text-left text-[13px] text-muted-foreground hover:text-foreground",
            active && "text-foreground"
          )}
        >
          <Icon className="size-4 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
        {extra}
      </div>
    )
  }

  const usedPct = storage.data?.freeBytes ? storage.data.usedBytes / (storage.data.usedBytes + storage.data.freeBytes) : null

  return (
    <>
      <PageHeader
        title={t("nav.archive")}
        description={t("archive.subtitle")}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void attempt(async () => {
                const missing = await api.verifyFiles()
                toast.success(missing ? t("archive.verifyMissing", { count: missing }) : t("archive.verifyOk"))
              })
            }
          >
            <ShieldCheck />
            {t("archive.verify")}
          </Button>
        }
      />
      <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-6">
        <aside className="space-y-5" aria-label={t("archive.collections")}>
          <div className="space-y-0.5">
            {navItem({ kind: "all" }, t("archive.all"), FolderArchive)}
            {navItem({ kind: "favorites" }, t("archive.favorites"), Heart)}
            {navItem({ kind: "trash" }, t("archive.trash"), Trash2)}
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between px-2.5">
              <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("archive.projects")}</span>
              <Button variant="ghost" size="icon-xs" aria-label={t("archive.newProject")} onClick={() => setProjectDialog({ mode: "create" })}>
                <FolderPlus />
              </Button>
            </div>
            <div className="space-y-0.5">
              {(projects.data ?? []).length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{t("archive.noProjects")}</p>}
              {(projects.data ?? []).map((p) =>
                navItem(
                  { kind: "project", id: p.id },
                  p.name,
                  Folder,
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" className="mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" aria-label={t("archive.projectActions", { name: p.name })}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setProjectDialog({ mode: "rename", id: p.id, name: p.name })}>
                        <Pencil />
                        {t("archive.rename")}
                      </DropdownMenuItem>
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleteProject({ id: p.id, name: p.name })}>
                        <Trash2 />
                        {t("common.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )
              )}
            </div>
          </div>
          {storage.data && (
            <div className="space-y-2 rounded-lg border bg-card p-3 text-xs" data-testid="storage">
              <div className="flex items-center gap-1.5 font-medium">
                <HardDrive className="size-3.5" />
                {t("archive.storage")}
              </div>
              {usedPct != null && <Progress value={Math.max(1, usedPct * 100)} className="h-1" aria-label={t("archive.storage")} />}
              <p className="text-muted-foreground">
                {t("archive.storageUsed", { used: fmt.bytes(storage.data.usedBytes), count: fmt.num(storage.data.savedCount) })}
              </p>
              {storage.data.freeBytes != null && <p className="text-muted-foreground">{t("archive.storageFree", { free: fmt.bytes(storage.data.freeBytes) })}</p>}
              {storage.data.missingCount > 0 && <p className="text-warning">{t("archive.storageMissing", { count: storage.data.missingCount })}</p>}
              <p className="truncate font-mono text-[10px] text-muted-foreground" title={storage.data.archiveRoot}>
                {storage.data.archiveRoot}
              </p>
            </div>
          )}
        </aside>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              data-page-search
              type="search"
              placeholder={t("archive.search")}
              aria-label={t("archive.search")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-56"
            />
            <Select value={provider} onValueChange={(v) => setProvider(v as ProviderId | "all")}>
              <SelectTrigger size="sm" aria-label={t("archive.filterProvider")} className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("archive.allProviders")}</SelectItem>
                {providers.filter((p) => p.integration === "integrated").map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={output} onValueChange={(v) => setOutput(v as typeof output)}>
              <SelectTrigger size="sm" aria-label={t("archive.filterOutput")} className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("archive.allTypes")}</SelectItem>
                <SelectItem value="video">{t("output.video")}</SelectItem>
                <SelectItem value="image">{t("output.image")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={modelId} onValueChange={setModelId}>
              <SelectTrigger size="sm" aria-label={t("archive.filterModel")} className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("archive.allModels")}</SelectItem>
                {models
                  .filter((m) => (provider === "all" || m.provider === provider) && (output === "all" || m.output === output))
                  .map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {mn(m.displayName)}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <Label htmlFor="archive-from" className="sr-only">
                {t("archive.from")}
              </Label>
              <DateField id="archive-from" value={from} onChange={setFrom} className="h-8 w-36" />
              <span className="text-muted-foreground">–</span>
              <Label htmlFor="archive-to" className="sr-only">
                {t("archive.to")}
              </Label>
              <DateField id="archive-to" value={to} onChange={setTo} className="h-8 w-36" />
            </div>
            <div className="ml-auto flex items-center gap-1">
              <Select value={sort} onValueChange={(v) => setSort(v as typeof sort)}>
                <SelectTrigger size="sm" aria-label={t("archive.sort")} className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date">{t("archive.sortDate")}</SelectItem>
                  <SelectItem value="size">{t("archive.sortSize")}</SelectItem>
                  <SelectItem value="duration">{t("archive.sortDuration")}</SelectItem>
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={direction === "desc" ? t("archive.descending") : t("archive.ascending")}
                onClick={() => setDirection((d) => (d === "desc" ? "asc" : "desc"))}
              >
                {direction === "desc" ? <ArrowDownWideNarrow /> : <ArrowUpNarrowWide />}
              </Button>
            </div>
          </div>

          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2" role="toolbar" aria-label={t("archive.selection")}>
              <span className="text-sm tabular-nums">{t("archive.selected", { count: selected.size })}</span>
              <Button variant="ghost" size="xs" onClick={() => setSelected(new Set(allSelectable))}>
                {t("archive.selectAll")}
              </Button>
              <div className="ml-auto flex flex-wrap gap-1">
                {view.kind === "trash" ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void actions.restore(selectedIds)}>
                      <Undo2 />
                      {t("archive.restore")}
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => setDeleteForever(selectedIds)}>
                      <Trash2 />
                      {t("archive.deleteForever")}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void actions.favorite(selectedIds, true)}>
                      <Heart />
                      {t("archive.favorite")}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => void actions.favorite(selectedIds, false)}>
                      <HeartOff />
                      {t("archive.unfavorite")}
                    </Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="sm" variant="outline">
                          <FolderInput />
                          {t("archive.moveTo")}
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent>
                        <DropdownMenuItem onSelect={() => void actions.move(selectedIds, null)}>{t("archive.noProject")}</DropdownMenuItem>
                        {(projects.data ?? []).map((p) => (
                          <DropdownMenuItem key={p.id} onSelect={() => void actions.move(selectedIds, p.id)}>
                            {p.name}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <Button size="sm" variant="outline" onClick={() => void actions.trash(selectedIds)}>
                      <Trash2 />
                      {t("archive.moveToTrash")}
                    </Button>
                  </>
                )}
                <Button size="icon-sm" variant="ghost" aria-label={t("archive.clearSelection")} onClick={() => setSelected(new Set())}>
                  <X />
                </Button>
              </div>
            </div>
          )}

          {archive.loading && !archive.data ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="aspect-[4/3]" />
              ))}
            </div>
          ) : entries.length === 0 ? (
            <EmptyState
              icon={view.kind === "trash" ? <Trash2 /> : <FolderArchive />}
              title={view.kind === "trash" ? t("archive.trashEmpty") : t("archive.empty")}
              description={view.kind === "trash" ? undefined : t("archive.emptyBody")}
            />
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3" data-testid="archive-grid">
              {entries.slice(0, limit).map((e) => {
                const item = e.item
                const isSel = !!item && selected.has(item.id)
                return (
                  <li
                    key={entryKey(e)}
                    data-state={e.state}
                    className={cn(
                      "group relative overflow-hidden rounded-lg border bg-card transition-colors hover:border-white/15",
                      isSel && "border-white/40"
                    )}
                  >
                    <button
                      type="button"
                      className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      onClick={() => setDetailKey(entryKey(e))}
                      onDoubleClick={() => e.state === "saved" && setViewer(e)}
                      aria-label={titleOf(e)}
                    >
                      <Thumb entry={e} className="aspect-video" />
                      <div className="space-y-0.5 px-2.5 py-2">
                        <p className="truncate text-xs font-medium">{titleOf(e)}</p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {mn(e.job.modelName)} · {fmt.date(e.asset?.createdAt ?? e.job.createdAt)}
                        </p>
                      </div>
                    </button>
                    <StateBadge state={e.state} className="absolute top-2 left-2" />
                    {e.state === "downloading" && e.task?.totalBytes ? (
                      <Progress value={(e.task.bytesDownloaded / e.task.totalBytes) * 100} className="absolute inset-x-0 top-[calc(56.25%-2px)] h-0.5 rounded-none" />
                    ) : null}
                    <div className="absolute top-2 right-2 flex items-center gap-1">
                      {item?.favorite && <Heart className="size-3.5 fill-current text-white" aria-label={t("archive.favorite")} />}
                      {item && (
                        <Checkbox
                          checked={isSel}
                          onCheckedChange={() => toggle(item.id)}
                          aria-label={t("archive.select", { title: titleOf(e) })}
                          className={cn("bg-black/60 opacity-0 group-hover:opacity-100 focus-visible:opacity-100", (isSel || selected.size > 0) && "opacity-100")}
                        />
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs" className="bg-black/60" aria-label={t("archive.actionsFor", { title: titleOf(e) })}>
                            <MoreHorizontal />
                          </Button>
                        </DropdownMenuTrigger>
                        {menu(e)}
                      </DropdownMenu>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {entries.length > limit && (
            <div ref={sentinel} className="flex justify-center py-4">
              <Button variant="ghost" size="sm" onClick={() => setLimit((l) => l + PAGE)}>
                {t("common.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Sheet open={!!detail} onOpenChange={(o) => !o && setDetailKey(null)}>
        <SheetContent className="w-[440px] overflow-y-auto sm:max-w-[440px]">
          {detail && (
            <>
              <SheetHeader>
                <SheetTitle className="pr-6">{titleOf(detail)}</SheetTitle>
                <SheetDescription>
                  <StateBadge state={detail.state} />
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-5 px-4 pb-6">
                <button type="button" className="block w-full overflow-hidden rounded-lg border" onClick={() => detail.state === "saved" && setViewer(detail)} aria-label={t("archive.play")}>
                  <Thumb entry={detail} className="aspect-video" />
                </button>
                <div className="flex flex-wrap gap-1.5">
                  {detail.state === "saved" && (
                    <Button size="sm" onClick={() => setViewer(detail)}>
                      <Play />
                      {detail.job.output === "video" ? t("archive.play") : t("archive.view")}
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => actions.regenerate(detail)}>
                    <RefreshCw />
                    {t("archive.regenerate")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setSavingPrompt(detail)}>
                    <Library />
                    {t("archive.savePrompt")}
                  </Button>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <h3 className="text-xs font-medium text-muted-foreground">{t("studio.prompt")}</h3>
                    <CopyButton value={detail.job.prompt} label={t("archive.copyPrompt")} />
                  </div>
                  <p className="rounded-md border bg-black/30 p-2.5 text-sm whitespace-pre-wrap">{detail.job.prompt || "—"}</p>
                  {detail.job.negativePrompt && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("studio.negativePrompt")}: {detail.job.negativePrompt}
                    </p>
                  )}
                </div>
                <dl className="divide-y">
                  <Kv label={t("models.model")}>{mn(detail.job.modelName)}</Kv>
                  <Kv label={t("models.provider")}>{providers.find((p) => p.id === detail.job.provider)?.displayName ?? detail.job.provider}</Kv>
                  <Kv label={t("archive.requestId")}>
                    <span className="font-mono text-xs">{detail.job.providerRequestId ?? "—"}</span>
                  </Kv>
                  <Kv label={t("archive.status")}>{t(`job.${detail.job.status}`)}</Kv>
                  <Kv label={t("estimate.label")}>
                    {fmt.usd(detail.job.estimatedCostUsd)}{" "}
                    <span className="text-xs text-muted-foreground">({estimateSourceLabel(i18n, detail.job.estimateSource)})</span>
                  </Kv>
                  <Kv label={t("analytics.confirmed")}>{detail.job.confirmedCostUsd != null ? fmt.usd(detail.job.confirmedCostUsd) : t("archive.notReported")}</Kv>
                  {detail.asset && (
                    <>
                      <Kv label={t("archive.duration")}>{fmt.duration(detail.asset.durationSec)}</Kv>
                      <Kv label={t("archive.resolution")}>
                        {detail.asset.width && detail.asset.height ? `${detail.asset.width}×${detail.asset.height}` : "—"}
                      </Kv>
                      <Kv label={t("archive.size")}>{fmt.bytes(detail.asset.sizeBytes)}</Kv>
                      <Kv label="SHA-256">
                        {detail.asset.sha256 ? (
                          <span className="inline-flex items-center gap-1 font-mono text-xs">
                            {detail.asset.sha256.slice(0, 12)}…
                            <CopyButton value={detail.asset.sha256} />
                          </span>
                        ) : (
                          "—"
                        )}
                      </Kv>
                    </>
                  )}
                  <Kv label={t("archive.created")}>{fmt.dateTime(detail.job.createdAt)}</Kv>
                  <Kv label={t("archive.project")}>{projectName(detail.item?.projectId) ?? t("archive.noProject")}</Kv>
                </dl>
                {(detail.job.errorCode || detail.job.errorMessage) && (
                  <p className="rounded-md border border-destructive/30 p-2.5 text-xs text-destructive">{jobErrorText(i18n, detail.job)}</p>
                )}
                {detail.task?.lastError && <p className="rounded-md border border-destructive/30 p-2.5 text-xs text-destructive">{detail.task.lastError}</p>}
                {detail.item && <TagsEditor itemId={detail.item.id} tags={detail.item.tags} />}
                <div>
                  <h3 className="mb-1 text-xs font-medium text-muted-foreground">{t("archive.history")}</h3>
                  <ol className="space-y-1 border-l pl-3 text-xs text-muted-foreground">
                    <li>
                      {t("archive.historySubmitted")} · {fmt.dateTime(detail.job.createdAt)}
                    </li>
                    {detail.job.completedAt && (
                      <li>
                        {t(`job.${detail.job.status}`)} · {fmt.dateTime(detail.job.completedAt)}
                      </li>
                    )}
                    {detail.asset?.downloadStatus === "saved" && <li>{t("state.saved")}</li>}
                  </ol>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-muted-foreground">{t("archive.parameters")}</summary>
                    <pre className="mt-1 max-h-48 overflow-auto rounded-md border bg-black/30 p-2 font-mono text-[11px]">
                      {JSON.stringify(detail.job.params, null, 2)}
                    </pre>
                  </details>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <MediaViewer asset={viewer?.asset ?? null} title={viewer ? titleOf(viewer) : ""} onClose={() => setViewer(null)} />

      <NameDialog
        open={!!renaming}
        onOpenChange={(o) => !o && setRenaming(null)}
        title={t("archive.rename")}
        label={t("archive.title")}
        initial={renaming ? titleOf(renaming) : ""}
        confirmLabel={t("common.save")}
        onSubmit={async (v) => {
          if (!renaming?.item) return
          return (await attempt(() => api.renameItem(renaming.item!.id, v))) !== undefined
        }}
      />
      <NameDialog
        open={!!savingPrompt}
        onOpenChange={(o) => !o && setSavingPrompt(null)}
        title={t("archive.savePrompt")}
        label={t("prompts.titleField")}
        initial={savingPrompt ? savingPrompt.job.prompt.slice(0, 60) : ""}
        confirmLabel={t("common.save")}
        onSubmit={async (v) => {
          if (!savingPrompt) return
          return (await attempt(() => api.savePromptFromJob(savingPrompt.job.id, v), t("archive.promptSaved"))) !== undefined
        }}
      />
      <NameDialog
        open={!!projectDialog}
        onOpenChange={(o) => !o && setProjectDialog(null)}
        title={projectDialog?.mode === "rename" ? t("archive.renameProject") : t("archive.newProject")}
        label={t("archive.projectName")}
        initial={projectDialog?.mode === "rename" ? projectDialog.name : ""}
        confirmLabel={projectDialog?.mode === "rename" ? t("common.save") : t("common.create")}
        onSubmit={async (name) => {
          if (!projectDialog) return
          const d = projectDialog
          const res = await attempt(() => (d.mode === "rename" ? api.renameProject(d.id, name) : api.createProject(name).then(() => undefined)))
          return res !== undefined || false
        }}
      />
      <ConfirmDialog
        open={!!deleteProject}
        onOpenChange={(o) => !o && setDeleteProject(null)}
        title={t("archive.deleteProjectTitle", { name: deleteProject?.name ?? "" })}
        description={t("archive.deleteProjectBody")}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={async () => {
          if (!deleteProject) return
          await attempt(() => api.deleteProject(deleteProject.id))
          if (view.kind === "project" && view.id === deleteProject.id) setView({ kind: "all" })
          setDeleteProject(null)
        }}
      />
      <ConfirmDialog
        open={!!deleteForever}
        onOpenChange={(o) => !o && setDeleteForever(null)}
        title={t("archive.deleteForeverTitle", { count: deleteForever?.length ?? 0 })}
        description={t("archive.deleteForeverBody")}
        confirmLabel={t("archive.deleteForever")}
        destructive
        onConfirm={async () => {
          if (!deleteForever) return
          await attempt(() => api.deletePermanently(deleteForever), t("archive.deleted"))
          setDeleteForever(null)
        }}
      />
    </>
  )
}

function TagsEditor({ itemId, tags }: { itemId: Id; tags: string[] }) {
  const { t } = useI18n()
  const [value, setValue] = useState("")
  const save = (next: string[]) => void attempt(() => api.setTags(itemId, next))
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-medium text-muted-foreground">{t("archive.tags")}</h3>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((tag) => (
          <Badge key={tag} variant="secondary" className="gap-1">
            {tag}
            <button type="button" aria-label={t("archive.removeTag", { tag })} onClick={() => save(tags.filter((x) => x !== tag))}>
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <Input
          aria-label={t("archive.addTag")}
          placeholder={t("archive.addTag")}
          value={value}
          maxLength={40}
          className="h-7 w-32 text-xs"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              e.preventDefault()
              if (!tags.includes(value.trim())) save([...tags, value.trim()])
              setValue("")
            }
          }}
        />
      </div>
    </div>
  )
}
