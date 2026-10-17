import { useCallback, useEffect, useRef, useState } from "react"
import { useSearchParams } from "react-router"
import {
  AlertTriangle,
  Clapperboard,
  Download,
  FilePlus2,
  FolderOpen,
  History as HistoryIcon,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Save,
} from "lucide-react"
import { toast } from "sonner"
import {
  addMedia,
  clipEnd,
  deleteClips,
  duplicateClips,
  newProject,
  pasteClips,
  placeMedia,
  splitAt,
  type Aspect,
  type EditorProject,
} from "@vidra/core"

import { PageHeader } from "@/components/app/common"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useI18n } from "@/i18n"
import { api, backend } from "@/lib/backend"
import { describeError, toastError } from "@/lib/errors"
import type { EditorImportResult, EditorRecent, EditorRecovery, EditorToolStatus } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import { ExportDialog } from "./export-dialog"
import { Inspector, MediaPanel } from "./panels"
import { Preview } from "./preview"
import { docToProject, useEditor, useProject } from "./store"
import { Timeline } from "./timeline"

const AUTOSAVE_MS = 15_000
const LAYOUT_KEY = "vidra.editor.layout"

function readLayout(): { left: number; right: number; bottom: number; leftOpen: boolean; rightOpen: boolean } {
  const d = { left: 280, right: 300, bottom: 300, leftOpen: true, rightOpen: true }
  try {
    return { ...d, ...(JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as object) }
  } catch {
    return d
  }
}

/** Video Editor: an independent, general-purpose editing workspace. */
export function EditorScreen() {
  const i18n = useI18n()
  const { t } = i18n
  const project = useProject()
  const [tools, setTools] = useState<EditorToolStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [params, setParams] = useSearchParams()

  const refreshTools = useCallback(async (refresh: boolean) => {
    setChecking(true)
    try {
      setTools(await api.editorToolsStatus(refresh))
    } catch {
      setTools(null)
    } finally {
      setChecking(false)
    }
  }, [])
  useEffect(() => {
    void refreshTools(false)
  }, [refreshTools])

  // "Open in Video Editor" from the archive: ?asset=<id>
  const asset = params.get("asset")
  useEffect(() => {
    if (!asset || !tools?.available) return
    setParams({}, { replace: true })
    const st = useEditor.getState()
    const run = async () => {
      let p = st.history?.present
      if (!p) {
        p = newProject(t("editor.untitled"), "16:9")
        await api.editorBeginProject(p.id)
        st.open(p, null, true)
      }
      const r = await api.editorImportArchiveAsset(p.id, asset)
      addImported(r, true)
    }
    run().catch(toastError)
  }, [asset, tools?.available]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!tools?.available)
    return <ToolsMissing tools={tools} checking={checking} onRetry={() => void refreshTools(true)} onPick={async () => setTools((await api.editorChooseFfmpegDir().catch(toastError)) ?? tools)} />
  if (!project) return <StartScreen />
  return <Workspace project={project} tools={tools} />
}

/** Adds imported media to the open project (and to the timeline when asked). */
function addImported(r: EditorImportResult, place: boolean) {
  const st = useEditor.getState()
  if (r.media.length) {
    st.apply((p) => {
      let next = addMedia(p, r.media)
      if (place) for (const m of r.media) next = placeMedia(next, m.id).project
      return next
    })
  }
  for (const f of r.failed) toast.error(f.name, { description: f.message })
}

function ToolsMissing({ tools, checking, onRetry, onPick }: { tools: EditorToolStatus | null; checking: boolean; onRetry: () => void; onPick: () => void }) {
  const { t } = useI18n()
  return (
    <>
      <PageHeader title={t("nav.editor")} description={t("editor.intro")} />
      <div className="max-w-2xl space-y-4 rounded-xl border bg-card p-5" data-testid="editor-no-ffmpeg">
        {checking ? (
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t("editor.tools.checking")}
          </p>
        ) : (
          <>
            <p className="flex items-center gap-2 font-medium text-warning">
              <AlertTriangle className="size-4" />
              {tools ? t("editor.tools.noH264") : t("editor.tools.missing")}
            </p>
            <p className="text-sm leading-relaxed text-muted-foreground">{t("editor.tools.explain")}</p>
            <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("editor.tools.step1")}</li>
              <li>{t("editor.tools.step2")}</li>
            </ol>
            <div className="flex gap-2">
              <Button onClick={onPick}>
                <FolderOpen />
                {t("editor.tools.pick")}
              </Button>
              <Button variant="outline" onClick={onRetry}>
                <RefreshCw />
                {t("editor.tools.retry")}
              </Button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

function StartScreen() {
  const { t, fmt } = useI18n()
  const [name, setName] = useState("")
  const [aspect, setAspect] = useState<Aspect>("16:9")
  const [recent, setRecent] = useState<EditorRecent[]>([])
  const [recoveries, setRecoveries] = useState<EditorRecovery[]>([])
  useEffect(() => {
    api.editorListRecent().then(setRecent).catch(() => undefined)
    api.editorListRecoveries().then(setRecoveries).catch(() => undefined)
  }, [])
  const create = async () => {
    const p = newProject(name.trim() || t("editor.untitled"), aspect)
    try {
      await api.editorBeginProject(p.id)
      useEditor.getState().open(p, null, true)
    } catch (e) {
      toastError(e)
    }
  }
  const load = async (fn: () => Promise<{ path: string; doc: unknown } | null>, dirty = false) => {
    try {
      const r = await fn()
      if (!r) return
      useEditor.getState().open(docToProject(r.doc), r.path || null, dirty)
    } catch (e) {
      const d = describeError(e)
      toast.error(t("editor.openFailed"), { description: d.description || d.title })
    }
  }
  return (
    <>
      <PageHeader title={t("nav.editor")} description={t("editor.intro")} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section className="space-y-4 rounded-xl border bg-card p-5" data-testid="editor-new">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <FilePlus2 className="size-4" />
            {t("editor.new.title")}
          </h2>
          <div className="space-y-1.5">
            <Label htmlFor="new-name" className="text-xs text-muted-foreground">
              {t("editor.insp.name")}
            </Label>
            <Input id="new-name" value={name} maxLength={120} placeholder={t("editor.untitled")} onChange={(e) => setName(e.target.value)} data-testid="editor-new-name" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("editor.insp.aspect")}</Label>
            <ToggleGroup type="single" variant="outline" value={aspect} onValueChange={(v) => v && setAspect(v as Aspect)} className="flex w-full">
              {(["16:9", "9:16", "1:1", "4:5"] as const).map((a) => (
                <ToggleGroupItem key={a} value={a} className="flex-1 flex-col gap-0 py-5" data-testid={`new-aspect-${a}`}>
                  <span className="text-sm">{a}</span>
                  <span className="text-[10px] text-muted-foreground">{t(`editor.aspectHint.${a}`)}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <Button onClick={() => void create()} data-testid="editor-create">
            <Clapperboard />
            {t("editor.new.create")}
          </Button>
        </section>
        <section className="space-y-3 rounded-xl border bg-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("editor.recent.title")}</h2>
            <Button size="sm" variant="outline" onClick={() => void load(() => api.editorOpenProject())} data-testid="editor-open">
              <FolderOpen />
              {t("editor.open")}
            </Button>
          </div>
          {recoveries.length > 0 && (
            <ul className="space-y-1.5" data-testid="editor-recoveries">
              {recoveries.map((r) => (
                <li key={r.projectId} className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/[0.06] p-2 text-xs">
                  <HistoryIcon className="size-4 text-warning" />
                  <span className="min-w-0 flex-1 truncate">{t("editor.recover.item", { name: r.name, time: fmt.dateTime(r.savedAt) })}</span>
                  <Button size="xs" onClick={() => void load(() => api.editorRecover(r.projectId), true)}>
                    {t("editor.recover.restore")}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void api.editorDiscardRecovery(r.projectId).then(() => setRecoveries((l) => l.filter((x) => x.projectId !== r.projectId)))}
                  >
                    {t("editor.recover.discard")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {recent.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("editor.recent.empty")}</p>
          ) : (
            <ul className="divide-y" data-testid="editor-recent">
              {recent.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={!r.exists}
                    onClick={() => void load(() => api.editorOpenRecent(r.id))}
                    className="flex w-full items-center gap-2 px-1 py-2 text-left text-sm hover:bg-white/[0.03] disabled:opacity-50"
                  >
                    <Clapperboard className="size-4 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    <span className="text-[11px] text-muted-foreground">{r.exists ? fmt.dateTime(r.openedAt) : t("editor.recent.missing")}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  )
}

function Workspace({ project, tools }: { project: EditorProject; tools: EditorToolStatus }) {
  const i18n = useI18n()
  const { t } = i18n
  const dirty = useEditor((s) => s.dirty)
  const file = useEditor((s) => s.file)
  const [layout, setLayout] = useState(readLayout)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [safeArea, setSafeArea] = useState("none")
  const projectRef = useRef(project)
  projectRef.current = project

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout))
    } catch {
      /* ignore */
    }
  }, [layout])

  const importMedia = useCallback(async () => {
    setImporting(true)
    try {
      const r = await api.editorImportMedia(projectRef.current.id)
      if (r) addImported(r, false)
    } catch (e) {
      toastError(e)
    } finally {
      setImporting(false)
    }
  }, [])

  const save = useCallback(
    async (saveAs: boolean) => {
      try {
        const r = await api.editorSaveProject(projectRef.current, saveAs)
        if (r) {
          useEditor.getState().markSaved(r.path)
          toast.success(t("editor.saved"), { description: r.path })
        }
      } catch (e) {
        toastError(e)
      }
    },
    [t]
  )

  // Autosave (recovery copy, never over the project file).
  useEffect(() => {
    const id = setInterval(() => {
      if (useEditor.getState().dirty) void api.editorAutosave(projectRef.current).catch(() => undefined)
    }, AUTOSAVE_MS)
    return () => clearInterval(id)
  }, [])

  // Files dropped on the window are imported.
  useEffect(() => {
    let off: (() => void) | undefined
    let cancelled = false
    void backend()
      .onFilesDropped(async (files) => {
        const ok = files.filter((f) => f.kind !== "unsupported")
        if (!ok.length) return
        try {
          addImported(await api.editorImportDropped(projectRef.current.id, ok.map((f) => f.token)), false)
        } catch (e) {
          toastError(e)
        }
      })
      .then((u) => (cancelled ? u() : (off = u)))
    return () => {
      cancelled = true
      off?.()
    }
  }, [])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return
      const st = useEditor.getState()
      const p = st.history?.present
      if (!p) return
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      const fps = p.settings.fps
      const handled = () => e.preventDefault()
      if (k === " ") return handled(), st.setPlaying(!st.playing)
      if (k === "escape") return handled(), st.select([])
      if (ctrl && k === "z" && !e.shiftKey) return handled(), st.undo()
      if (ctrl && (k === "y" || (k === "z" && e.shiftKey))) return handled(), st.redo()
      if (ctrl && k === "s") return handled(), void save(e.shiftKey)
      if (ctrl && k === "i") return handled(), void importMedia()
      if (ctrl && k === "c") return handled(), st.setClipboard(p.clips.filter((c) => st.selection.includes(c.id)))
      if (ctrl && k === "v") return handled(), st.apply((q) => pasteClips(q, st.clipboard, st.playhead).project)
      if (ctrl && k === "d") return handled(), st.apply((q) => duplicateClips(q, st.selection).project)
      if (ctrl && k === "a") return handled(), st.select(p.clips.map((c) => c.id))
      if (k === "s" || (ctrl && k === "b")) return handled(), st.apply((q) => splitAt(q, st.playhead, st.selection.length ? st.selection : undefined).project)
      if (k === "delete" || k === "backspace") {
        handled()
        st.apply((q) => deleteClips(q, st.selection, e.shiftKey))
        st.select([])
        return
      }
      if (k === "arrowleft") return handled(), st.setPlayhead(st.playhead - (e.shiftKey ? 1 : 1 / fps))
      if (k === "arrowright") return handled(), st.setPlayhead(st.playhead + (e.shiftKey ? 1 : 1 / fps))
      if (k === "home") return handled(), st.setPlayhead(0)
      if (k === "end") return handled(), st.setPlayhead(Math.max(0, ...p.clips.map(clipEnd)))
      if (k === "+" || k === "=") return handled(), st.setZoom(st.zoom * 1.25)
      if (k === "-") return handled(), st.setZoom(st.zoom / 1.25)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [save, importMedia])

  const close = () => {
    if (useEditor.getState().dirty && !window.confirm(t("editor.closeDirty"))) return
    useEditor.getState().close()
  }

  const resize = (key: "left" | "right" | "bottom") => (e: React.PointerEvent) => {
    e.preventDefault()
    const start = key === "bottom" ? e.clientY : e.clientX
    const base = layout[key]
    const move = (ev: PointerEvent) => {
      const d = (key === "bottom" ? ev.clientY : ev.clientX) - start
      const v = key === "left" ? base + d : base - d
      const [lo, hi] = key === "bottom" ? [160, window.innerHeight - 260] : [200, 520]
      setLayout((l) => ({ ...l, [key]: Math.round(Math.min(hi, Math.max(lo, v))) }))
    }
    const up = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  return (
    <div className="flex h-full flex-col" data-testid="editor-workspace">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <Button size="icon-sm" variant="ghost" aria-label={t("editor.panel.left")} onClick={() => setLayout((l) => ({ ...l, leftOpen: !l.leftOpen }))}>
          {layout.leftOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
        </Button>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium" data-testid="editor-title">
            {project.name}
            {dirty && <span className="text-muted-foreground"> •</span>}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">{file ?? t("editor.notSaved")}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Select value={safeArea} onValueChange={setSafeArea}>
            <SelectTrigger size="sm" className="w-40" aria-label={t("editor.safe.label")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["none", "reels", "tiktok", "shorts", "title"] as const).map((k) => (
                <SelectItem key={k} value={k}>
                  {t(`editor.safe.${k}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="ghost" onClick={close} data-testid="editor-close">
            {t("common.close")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void save(true)}>
            {t("editor.saveAs")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => void save(false)} data-testid="editor-save">
            <Save />
            {t("editor.save")}
          </Button>
          <Button size="sm" onClick={() => setExporting(true)} disabled={!project.clips.length} data-testid="editor-export">
            <Download />
            {t("editor.export.button")}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label={t("editor.panel.right")} onClick={() => setLayout((l) => ({ ...l, rightOpen: !l.rightOpen }))}>
            {layout.rightOpen ? <PanelRightClose /> : <PanelRightOpen />}
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {layout.leftOpen && (
          <>
            <aside className="shrink-0 border-r bg-card/40" style={{ width: layout.left }}>
              <MediaPanel project={project} onImport={() => void importMedia()} importing={importing} />
            </aside>
            <Splitter dir="x" onPointerDown={resize("left")} />
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            <Preview project={project} safeArea={safeArea} />
          </div>
        </main>
        {layout.rightOpen && (
          <>
            <Splitter dir="x" onPointerDown={resize("right")} />
            <aside className="shrink-0 border-l bg-card/40" style={{ width: layout.right }}>
              <Inspector project={project} />
            </aside>
          </>
        )}
      </div>
      <Splitter dir="y" onPointerDown={resize("bottom")} />
      <div className="shrink-0 bg-card/30" style={{ height: layout.bottom }}>
        <Timeline project={project} />
      </div>
      <ExportDialog project={project} open={exporting} onOpenChange={setExporting} tools={tools} />
    </div>
  )
}

function Splitter({ dir, onPointerDown }: { dir: "x" | "y"; onPointerDown: (e: React.PointerEvent) => void }) {
  return (
    <div
      role="separator"
      aria-orientation={dir === "x" ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      className={cn("shrink-0 bg-border/60 transition-colors hover:bg-white/30", dir === "x" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize")}
    />
  )
}
