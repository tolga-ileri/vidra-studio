import { create } from "zustand"
import {
  commit,
  initHistory,
  parseProject,
  redo,
  undo,
  type Clip,
  type EditorMedia,
  type Analysis,
  type EditorProject,
  type History,
} from "@vidra/core"

import { api } from "@/lib/backend"
import type { EditorProxyInfo } from "@/lib/ipc"

/** Editor session state. Edits go through `apply` so every change is undoable. */
interface EditorState {
  history: History | null
  /** Where the project was last saved (null = never saved). */
  file: string | null
  /** The present project differs from what is on disk. */
  dirty: boolean
  selection: string[]
  playhead: number
  playing: boolean
  /** Timeline zoom in pixels per second. */
  zoom: number
  clipboard: Clip[]
  /** Timeline tool: select/move, or blade (click a clip to cut it). */
  tool: "select" | "blade"
  /** In/out range for "remove range" (timeline seconds). */
  range: { a: number | null; b: number | null }
  /** Clip whose animation was copied. */
  kfClipboard: Clip | null
  thumbs: Record<string, string[]>
  waves: Record<string, { perSec: number; peaks: number[] }>
  /** Preview proxies (720p copies) of large sources: mediaId → file path. */
  proxies: Record<string, EditorProxyInfo>
  useProxies: boolean
  /** What the pointer edits on the preview. */
  editMode: "none" | "corners" | "focus" | "region"
  activeRegion: string | null
  /** Smart Reframe analyses by clip id. */
  analyses: Record<string, Analysis>
  analyzing: string | null
  inspectorTab: "edit" | "motion" | "reframe" | "overlay" | "transitions"
  /** Bumped when a panel asks the workspace to open the export dialog. */
  exportSignal: number

  open: (project: EditorProject, file: string | null, dirty?: boolean) => void
  close: () => void
  /** Applies an edit (pure function of the present project) as one undo step. */
  apply: (edit: (p: EditorProject) => EditorProject) => void
  /** Updates without a history step (e.g. dragging; commit once at the end). */
  preview: (edit: (p: EditorProject) => EditorProject) => void
  /** Ends a drag: records `before` → present as one undo step (or restores on no change). */
  commitFrom: (before: EditorProject) => void
  undo: () => void
  redo: () => void
  select: (ids: string[]) => void
  setPlayhead: (t: number) => void
  setPlaying: (v: boolean) => void
  setZoom: (z: number) => void
  setClipboard: (clips: Clip[]) => void
  setTool: (tool: "select" | "blade") => void
  setRange: (range: { a: number | null; b: number | null }) => void
  setKfClipboard: (clip: Clip | null) => void
  markSaved: (file: string) => void
  loadAssets: (media: EditorMedia) => void
  setUseProxies: (v: boolean) => void
  setEditMode: (mode: EditorState["editMode"], region?: string | null) => void
  setAnalysis: (clipId: string, a: Analysis | null) => void
  setAnalyzing: (clipId: string | null) => void
  setInspectorTab: (tab: EditorState["inspectorTab"]) => void
  requestExport: () => void
}

export const ZOOM_MIN = 8
export const ZOOM_MAX = 400

export const useEditor = create<EditorState>((set, get) => ({
  history: null,
  file: null,
  dirty: false,
  selection: [],
  playhead: 0,
  playing: false,
  zoom: 60,
  clipboard: [],
  tool: "select",
  range: { a: null, b: null },
  kfClipboard: null,
  thumbs: {},
  waves: {},
  proxies: {},
  useProxies: true,
  editMode: "none",
  activeRegion: null,
  analyses: {},
  analyzing: null,
  inspectorTab: "edit",
  exportSignal: 0,

  open: (project, file, dirty = false) =>
    set({
      history: initHistory(project),
      file,
      dirty,
      selection: [],
      playhead: 0,
      playing: false,
      tool: "select",
      range: { a: null, b: null },
      kfClipboard: null,
      thumbs: {},
      waves: {},
      proxies: {},
      editMode: "none",
      activeRegion: null,
      analyses: {},
      analyzing: null,
      inspectorTab: "edit",
    }),
  close: () => set({ history: null, file: null, dirty: false, selection: [], playhead: 0, playing: false }),
  apply: (edit) => {
    const h = get().history
    if (!h) return
    const next = edit(h.present)
    if (next === h.present) return
    set({ history: commit(h, next), dirty: true })
  },
  preview: (edit) => {
    const h = get().history
    if (!h) return
    set({ history: { ...h, present: edit(h.present) } })
  },
  commitFrom: (before) => {
    const h = get().history
    if (!h || h.present === before) return
    set({ history: { past: [...h.past, before].slice(-200), present: h.present, future: [] }, dirty: true })
  },
  undo: () => {
    const h = get().history
    if (h?.past.length) set({ history: undo(h), dirty: true, selection: [] })
  },
  redo: () => {
    const h = get().history
    if (h?.future.length) set({ history: redo(h), dirty: true, selection: [] })
  },
  select: (ids) => set((s) => ({ selection: ids, editMode: ids.length === 1 && ids[0] === s.selection[0] ? s.editMode : "none", activeRegion: null })),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (v) => set({ playing: v }),
  setZoom: (z) => set({ zoom: Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) }),
  setClipboard: (clips) => set({ clipboard: clips }),
  setTool: (tool) => set({ tool }),
  setRange: (range) => set({ range }),
  setKfClipboard: (clip) => set({ kfClipboard: clip }),
  markSaved: (file) => set({ file, dirty: false }),
  setUseProxies: (v) => set({ useProxies: v }),
  setEditMode: (mode, region = null) => set({ editMode: mode, activeRegion: region }),
  setAnalysis: (clipId, a) =>
    set((s) => {
      const analyses = { ...s.analyses }
      if (a) analyses[clipId] = a
      else delete analyses[clipId]
      return { analyses }
    }),
  setAnalyzing: (clipId) => set({ analyzing: clipId }),
  setInspectorTab: (tab) => set({ inspectorTab: tab }),
  requestExport: () => set((s) => ({ exportSignal: s.exportSignal + 1 })),
  loadAssets: (media) => {
    const h = get().history
    if (!h) return
    const projectId = h.present.id
    if (media.kind !== "audio" && !get().thumbs[media.id] && media.available) {
      set((s) => ({ thumbs: { ...s.thumbs, [media.id]: [] } }))
      void api
        .editorThumbnails(projectId, media.id, media.kind === "image" ? 1 : 6)
        .then((list) => set((s) => ({ thumbs: { ...s.thumbs, [media.id]: list } })))
        .catch(() => undefined)
    }
    if (media.kind === "video" && media.available && !get().proxies[media.id] && Math.max(media.width ?? 0, media.height ?? 0) > 1920) {
      set((s) => ({ proxies: { ...s.proxies, [media.id]: { mediaId: media.id, path: null, width: 0, height: 0 } } }))
      void api
        .editorProxy(projectId, media.id)
        .then((p) => set((s) => ({ proxies: { ...s.proxies, [media.id]: p } })))
        .catch(() => set((s) => ({ proxies: { ...s.proxies, [media.id]: { mediaId: media.id, path: null, width: -1, height: -1 } } })))
    }
    if (media.hasAudio && !get().waves[media.id] && media.available) {
      set((s) => ({ waves: { ...s.waves, [media.id]: { perSec: 0, peaks: [] } } }))
      void api
        .editorWaveform(projectId, media.id)
        .then((w) => set((s) => ({ waves: { ...s.waves, [media.id]: w } })))
        .catch(() => undefined)
    }
  },
}))

export const useProject = () => useEditor((s) => s.history?.present ?? null)

/** Parses a document from the native side into a project (throws on a bad file). */
export function docToProject(doc: unknown): EditorProject {
  return parseProject(doc)
}
