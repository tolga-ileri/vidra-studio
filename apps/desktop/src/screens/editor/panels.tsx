import { useEffect, useState } from "react"
import {
  AlertTriangle,
  ClipboardCopy,
  ClipboardPaste,
  Crosshair,
  Diamond,
  Download,
  Film,
  Focus,
  ImageIcon,
  ImagePlus,
  Link2,
  Loader2,
  Music,
  Plus,
  RotateCcw,
  Scan,
  Scissors,
  Trash2,
  Upload,
  Wand2,
  ZoomIn,
} from "lucide-react"
import { toast } from "sonner"
import {
  addMedia,
  addRegion,
  addTrack,
  applyBlurFallback,
  applyMotion,
  applyReframe,
  ASPECTS,
  clearKeyframes,
  clearReframe,
  clipDuration,
  clipEnd,
  clipValueAt,
  cornersAt,
  defaultCorners,
  EASES,
  formatTimecode,
  kfTimeline,
  MASK_SHAPES,
  motionDefaults,
  MOTION_PRESETS,
  nextAdjacent,
  pasteKeyframes,
  placeMedia,
  previousAdjacent,
  REGION_KINDS,
  REGION_SHAPES,
  removeCornerKeyframe,
  removeKeyframe,
  removeRegion,
  sameAspect,
  setCornerKeyframe,
  setCorners,
  setFormat,
  setKeyframe,
  setKeyframeEase,
  setMask,
  setRegionKeyframe,
  setTransition,
  splitAt,
  TRANSITIONS,
  updateClip,
  updateRegion,
  type Analysis,
  type Aspect,
  type Clip,
  type Ease,
  type EditorMedia,
  type EditorProject,
  type FitMode,
  type KfProp,
  type MaskShape,
  type MotionParams,
  type MotionPreset,
  type Region,
  type Subject,
  type Transition,
  type TransitionKind,
} from "@vidra/core"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useI18n } from "@/i18n"
import { api, fileSrc } from "@/lib/backend"
import { toastError } from "@/lib/errors"
import { cn } from "@/lib/utils"
import { useEditor } from "./store"
import { editorError, MEDIA_DRAG_TYPE, TRANSITION_DRAG_TYPE } from "./timeline"

/* ── Media library ─────────────────────────────────────────────────────── */

export function MediaPanel({ project, onImport, importing }: { project: EditorProject; onImport: () => void; importing: boolean }) {
  const i18n = useI18n()
  const { t, fmt } = i18n
  const { apply, loadAssets } = useEditor.getState()
  const thumbs = useEditor((s) => s.thumbs)
  useEffect(() => {
    for (const m of project.media) loadAssets(m)
  }, [project.media, loadAssets])

  const add = (m: EditorMedia) => {
    try {
      apply((p) => placeMedia(p, m.id).project)
    } catch (e) {
      toast.error(e instanceof Error ? editorError(i18n.t, e.message) : String(e))
    }
  }
  const relink = async (m: EditorMedia) => {
    try {
      const next = await api.editorRelinkMedia(project.id, m.id)
      if (next) apply((p) => ({ ...p, media: p.media.map((x) => (x.id === m.id ? { ...next, available: true } : x)) }))
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="editor-media">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-xs font-medium text-muted-foreground">{t("editor.media.title")}</h2>
        <Button size="xs" onClick={onImport} disabled={importing} data-testid="editor-import">
          <Upload />
          {t("editor.media.import")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {project.media.length === 0 ? (
          <button
            type="button"
            onClick={onImport}
            className="flex w-full flex-col items-center gap-2 rounded-lg border border-dashed px-3 py-10 text-center text-xs text-muted-foreground hover:border-white/20 hover:text-foreground"
          >
            <Upload className="size-5" />
            {t("editor.media.empty")}
          </button>
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {project.media.map((m) => {
              const Icon = m.kind === "audio" ? Music : m.kind === "image" ? ImageIcon : Film
              const thumb = thumbs[m.id]?.[0]
              return (
                <li
                  key={m.id}
                  className={cn("group overflow-hidden rounded-md border bg-black/30", !m.available && "border-destructive/60")}
                  draggable={m.available}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id)
                    e.dataTransfer.effectAllowed = "copy"
                  }}
                  data-testid="editor-media-item"
                  data-media-id={m.id}
                  data-kind={m.kind}
                  title={m.name}
                >
                  <div className="relative flex aspect-video items-center justify-center bg-black/40">
                    {thumb ? <img src={fileSrc(thumb)} alt="" className="size-full object-cover" /> : <Icon className="size-6 text-muted-foreground" />}
                    {m.durationSec != null && (
                      <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px]">{formatTimecode(m.durationSec, 30).replace(/:\d\d$/, "")}</span>
                    )}
                    {m.available && (
                      <Button
                        size="icon-xs"
                        className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={t("editor.media.add", { name: m.name })}
                        onClick={() => add(m)}
                        data-testid="editor-media-add"
                      >
                        <Plus />
                      </Button>
                    )}
                  </div>
                  <div className="space-y-0.5 p-1.5">
                    <p className="truncate text-[11px]">{m.name}</p>
                    <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
                      <Icon className="size-3" />
                      {m.width && m.height ? `${m.width}×${m.height}` : t(`editor.kind.${m.kind}`)}
                      {" · "}
                      {fmt.bytes(m.sizeBytes)}
                    </p>
                    {!m.available && (
                      <Button size="xs" variant="outline" className="w-full" onClick={() => void relink(m)}>
                        <Link2 />
                        {t("editor.media.relink")}
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <p className="mt-3 px-1 text-[11px] leading-relaxed text-muted-foreground">{t("editor.media.hint")}</p>
        <ProxyToggle project={project} />
        <TransitionLibrary />
      </div>
    </div>
  )
}

/* ── Inspector ─────────────────────────────────────────────────────────── */

function Row({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-[11px] text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

function Num({
  id,
  value,
  onCommit,
  min,
  max,
  step,
  suffix,
}: {
  id: string
  value: number
  onCommit: (v: number) => void
  min: number
  max: number
  step: number
  suffix?: string
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(Math.round(value * 1000) / 1000)), [value])
  const commit = () => {
    const n = Number(text.replace(",", "."))
    if (Number.isFinite(n)) onCommit(Math.min(max, Math.max(min, n)))
    else setText(String(value))
  }
  return (
    <div className="flex items-center gap-1">
      <Input
        id={id}
        className="h-7 text-xs tabular-nums"
        inputMode="decimal"
        value={text}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {suffix && <span className="text-[11px] text-muted-foreground">{suffix}</span>}
    </div>
  )
}

export function Inspector({ project }: { project: EditorProject }) {
  const selection = useEditor((s) => s.selection)
  const clip = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined
  return (
    <div className="h-full min-h-0 overflow-y-auto p-3" data-testid="editor-inspector">
      {clip ? <ClipInspector project={project} clip={clip} /> : <ProjectInspector project={project} count={selection.length} />}
    </div>
  )
}

function ProjectInspector({ project, count }: { project: EditorProject; count: number }) {
  const { t } = useI18n()
  const { apply } = useEditor.getState()
  const s = project.settings
  return (
    <div className="space-y-4">
      <h2 className="text-xs font-medium text-muted-foreground">{count > 1 ? t("editor.insp.multi", { count }) : t("editor.insp.project")}</h2>
      <Row label={t("editor.insp.name")} htmlFor="prj-name">
        <Input
          id="prj-name"
          className="h-8 text-xs"
          defaultValue={project.name}
          maxLength={120}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v && v !== project.name) apply((p) => ({ ...p, name: v }))
          }}
          data-testid="editor-project-name"
        />
      </Row>
      <Row label={t("editor.insp.aspect")}>
        <ToggleGroup
          type="single"
          value={s.aspect}
          onValueChange={(v) => v && apply((p) => setFormat(p, v as Aspect, { width: s.width, height: s.height }))}
          className="flex w-full flex-wrap justify-start"
          variant="outline"
          size="sm"
        >
          {ASPECTS.filter((a) => a !== "custom").map((a) => (
            <ToggleGroupItem key={a} value={a} className="flex-1 text-xs" data-testid={`aspect-${a}`}>
              {a}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <p className="text-[11px] text-muted-foreground" data-testid="editor-frame-size">
          {s.width}×{s.height} · {t(`editor.aspectHint.${s.aspect}`)}
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("editor.format.hint")}</p>
      </Row>
      <Row label={t("editor.insp.custom")}>
        <div className="grid grid-cols-2 gap-2">
          <Num id="prj-w" value={s.width} min={16} max={7680} step={2} onCommit={(w) => apply((p) => setFormat(p, "custom", { width: w, height: s.height }))} />
          <Num id="prj-h" value={s.height} min={16} max={7680} step={2} onCommit={(h) => apply((p) => setFormat(p, "custom", { width: s.width, height: h }))} />
        </div>
      </Row>
      <Row label={t("editor.insp.fps")}>
        <Select value={String(s.fps)} onValueChange={(v) => apply((p) => ({ ...p, settings: { ...p.settings, fps: Number(v) } }))}>
          <SelectTrigger size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[24, 25, 30, 50, 60].map((f) => (
              <SelectItem key={f} value={String(f)}>
                {f} fps
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t("editor.insp.background")} htmlFor="prj-bg">
        <input
          id="prj-bg"
          type="color"
          value={s.background}
          onChange={(e) => apply((p) => ({ ...p, settings: { ...p.settings, background: e.target.value } }))}
          className="h-8 w-16 cursor-pointer rounded border bg-transparent"
        />
      </Row>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("editor.insp.selectHint")}</p>
    </div>
  )
}

function ClipInspector({ project, clip }: { project: EditorProject; clip: Clip }) {
  const { t } = useI18n()
  const { apply } = useEditor.getState()
  const media = project.media.find((m) => m.id === clip.mediaId)
  const track = project.tracks.find((x) => x.id === clip.trackId)
  const set = (patch: Partial<Clip>) => apply((p) => updateClip(p, clip.id, patch))
  const visual = track?.kind === "video"
  const hasAudio = !!media?.hasAudio
  const len = clipDuration(clip)
  const wantTab = useEditor((s) => s.inspectorTab)
  const tab = !visual && wantTab !== "motion" ? "edit" : wantTab
  const setTab = useEditor.getState().setInspectorTab
  return (
    <div className="space-y-4" data-testid="clip-inspector">
      <div>
        <h2 className="truncate text-xs font-medium">{media?.name}</h2>
        <p className="text-[11px] text-muted-foreground tabular-nums">
          {t("editor.insp.timing", {
            start: formatTimecode(clip.start, project.settings.fps),
            length: formatTimecode(len, project.settings.fps),
            src: `${clip.in.toFixed(2)}–${clip.out.toFixed(2)} s`,
          })}
        </p>
      </div>
      {visual && media && <QuickActions project={project} clip={clip} media={media} />}
      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="flex w-full flex-wrap">
          <TabsTrigger value="edit" className="flex-1 text-xs" data-testid="tab-edit">
            {t("editor.tab.edit")}
          </TabsTrigger>
          <TabsTrigger value="motion" className="flex-1 text-xs" data-testid="tab-motion">
            {t("editor.tab.motion")}
          </TabsTrigger>
          {visual && (
            <>
              <TabsTrigger value="reframe" className="flex-1 text-xs" data-testid="tab-reframe">
                {t("editor.tab.reframe")}
              </TabsTrigger>
              <TabsTrigger value="overlay" className="flex-1 text-xs" data-testid="tab-overlay">
                {t("editor.tab.overlay")}
              </TabsTrigger>
              <TabsTrigger value="transitions" className="flex-1 text-xs" data-testid="tab-transitions">
                {t("editor.tab.transitions")}
              </TabsTrigger>
            </>
          )}
        </TabsList>
        <TabsContent value="edit" className="space-y-4 pt-3">
      {hasAudio && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.insp.audio")}</legend>
          <Row label={t("editor.insp.volume", { value: Math.round(clip.volume * 100) })}>
            <Slider
              aria-label={t("editor.insp.volumeLabel")}
              min={0}
              max={200}
              step={1}
              value={[Math.round(clip.volume * 100)]}
              onValueChange={([v]) => v !== undefined && slideTo(clip.id, { volume: v / 100 })}
              onValueCommit={slideEnd}
              data-testid="clip-volume"
            />
          </Row>
          <div className="flex items-center justify-between">
            <Label htmlFor="clip-mute" className="text-[11px] text-muted-foreground">
              {t("editor.insp.mute")}
            </Label>
            <Switch id="clip-mute" checked={clip.muted} onCheckedChange={(v) => set({ muted: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Row label={t("editor.insp.fadeIn")} htmlFor="clip-fi">
              <Num id="clip-fi" value={clip.fadeIn} min={0} max={Math.min(60, len)} step={0.1} suffix="s" onCommit={(v) => set({ fadeIn: v })} />
            </Row>
            <Row label={t("editor.insp.fadeOut")} htmlFor="clip-fo">
              <Num id="clip-fo" value={clip.fadeOut} min={0} max={Math.min(60, len)} step={0.1} suffix="s" onCommit={(v) => set({ fadeOut: v })} />
            </Row>
          </div>
        </fieldset>
      )}
      {media?.kind !== "image" && (
        <Row label={t("editor.insp.speed")} htmlFor="clip-speed">
          <Select value={String(clip.speed)} onValueChange={(v) => setSpeed(project, clip, Number(v), t("editor.err.speedOverlap"))}>
            <SelectTrigger id="clip-speed" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => (
                <SelectItem key={v} value={String(v)}>
                  {v}×
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      )}
      {visual && (
        <fieldset className="space-y-3">
          <legend className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.insp.picture")}</legend>
          <Row label={t("editor.insp.fit")}>
            <ToggleGroup type="single" variant="outline" size="sm" value={clip.fit} onValueChange={(v) => v && set({ fit: v as FitMode })} className="flex w-full">
              {(["fit", "fill", "blur"] as const).map((f) => (
                <ToggleGroupItem key={f} value={f} className="flex-1 text-xs" data-testid={`fit-${f}`}>
                  {t(`editor.fit.${f}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Row>
          <Row label={t("editor.insp.opacity", { value: Math.round(clip.opacity * 100) })}>
            <Slider
              aria-label={t("editor.insp.opacityLabel")}
              min={0}
              max={100}
              step={1}
              value={[Math.round(clip.opacity * 100)]}
              onValueChange={([v]) => v !== undefined && slideTo(clip.id, { opacity: v / 100 })}
              onValueCommit={slideEnd}
            />
          </Row>
          <div className="grid grid-cols-3 gap-2">
            <Row label={t("editor.insp.scale")} htmlFor="clip-scale">
              <Num id="clip-scale" value={Math.round(clip.scale * 100)} min={5} max={1000} step={1} suffix="%" onCommit={(v) => set({ scale: v / 100 })} />
            </Row>
            <Row label="X" htmlFor="clip-x">
              <Num id="clip-x" value={Math.round(clip.x * 100)} min={-200} max={200} step={1} suffix="%" onCommit={(v) => set({ x: v / 100 })} />
            </Row>
            <Row label="Y" htmlFor="clip-y">
              <Num id="clip-y" value={Math.round(clip.y * 100)} min={-200} max={200} step={1} suffix="%" onCommit={(v) => set({ y: v / 100 })} />
            </Row>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Row label={t("editor.insp.rotation")} htmlFor="clip-rot">
              <Num id="clip-rot" value={clip.rotation} min={-3600} max={3600} step={1} suffix="°" onCommit={(v) => set({ rotation: v })} />
            </Row>
          </div>
          <Row label={t("editor.insp.crop")}>
            <div className="grid grid-cols-4 gap-1">
              {(["l", "t", "r", "b"] as const).map((k) => (
                <Num
                  key={k}
                  id={`clip-crop-${k}`}
                  value={Math.round(clip.crop[k] * 100)}
                  min={0}
                  max={45}
                  step={1}
                  onCommit={(v) => set({ crop: { ...clip.crop, [k]: v / 100 } })}
                />
              ))}
            </div>
          </Row>
          <div className="grid grid-cols-3 gap-1">
            {(
              [
                ["tl", -0.4, -0.4],
                ["tr", 0.4, -0.4],
                ["c", 0, 0],
                ["bl", -0.4, 0.4],
                ["br", 0.4, 0.4],
              ] as const
            ).map(([k, x, y]) => (
              <Button key={k} size="xs" variant="outline" onClick={() => set({ x, y, scale: k === "c" ? 1 : Math.min(clip.scale, 0.25) })}>
                {t(`editor.pos.${k}`)}
              </Button>
            ))}
          </div>
        </fieldset>
      )}
        </TabsContent>
        <TabsContent value="motion" className="space-y-4 pt-3">
      {visual && media && <MotionSection project={project} clip={clip} media={media} />}
      <KeyframeSection project={project} clip={clip} props={[...(visual ? (["scale", "x", "y", "rotation", "opacity"] as const) : []), ...(hasAudio ? (["gain"] as const) : [])]} />
        </TabsContent>
        {visual && media && (
          <TabsContent value="reframe" className="space-y-4 pt-3">
            <ReframeSection project={project} clip={clip} media={media} />
          </TabsContent>
        )}
        {visual && media && (
          <TabsContent value="overlay" className="space-y-4 pt-3">
            <OverlaySection project={project} clip={clip} media={media} />
          </TabsContent>
        )}
        <TabsContent value="transitions" className="space-y-4 pt-3">
      {visual && <TransitionSection project={project} clip={clip} />}
        </TabsContent>
      </Tabs>
      {media && !media.available && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="size-3.5" />
          {t("editor.media.missing")}
        </p>
      )}
    </div>
  )
}

/** Slider drags preview live; the release records one undo step. */
let sliderBefore: EditorProject | null = null
function slideTo(clipId: string, patch: Partial<Clip>) {
  const st = useEditor.getState()
  sliderBefore ??= st.history?.present ?? null
  st.preview((p) => updateClip(p, clipId, patch))
}
function slideEnd() {
  if (sliderBefore) useEditor.getState().commitFrom(sliderBefore)
  sliderBefore = null
}

/** Changing speed keeps the start and refuses to overlap the next clip. */
function setSpeed(project: EditorProject, clip: Clip, speed: number, message: string) {
  const next = { ...clip, speed }
  const end = next.start + clipDuration(next)
  const blocked = project.clips.some((c) => c.trackId === clip.trackId && c.id !== clip.id && c.start >= clip.start && c.start < end - 1e-6)
  if (blocked) {
    toast.error(message)
    return
  }
  useEditor.getState().apply((p) => updateClip(p, clip.id, { speed }))
}

/* ── Transitions ───────────────────────────────────────────────────────── */

function TransitionLibrary() {
  const { t } = useI18n()
  const addToSelected = (kind: TransitionKind) => {
    const st = useEditor.getState()
    const id = st.selection[0]
    if (st.selection.length !== 1 || !id) return toast.info(t("editor.tr.selectFirst"))
    st.apply((p) => setTransition(p, id, "out", { kind, duration: 1, color: "#000000" }))
  }
  return (
    <section className="mt-4 space-y-2 border-t pt-3" data-testid="editor-transitions">
      <h3 className="px-1 text-xs font-medium text-muted-foreground">{t("editor.tr.title")}</h3>
      <ul className="grid grid-cols-2 gap-1.5">
        {TRANSITIONS.map((k) => (
          <li key={k}>
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(TRANSITION_DRAG_TYPE, k)
                e.dataTransfer.effectAllowed = "copy"
              }}
              onClick={() => addToSelected(k)}
              className="w-full cursor-grab truncate rounded-md border bg-black/30 px-2 py-1.5 text-left text-[11px] hover:border-white/25"
              data-testid={`transition-${k}`}
            >
              {t(`editor.tr.k.${k}`)}
            </button>
          </li>
        ))}
      </ul>
      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">{t("editor.tr.dragHint")}</p>
    </section>
  )
}

/** Source footage available beyond a clip's edge, in timeline seconds (Infinity for stills). */
function handle(project: EditorProject, c: Clip, edge: "before" | "after"): number {
  const m = project.media.find((x) => x.id === c.mediaId)
  if (!m || m.kind === "image" || m.durationSec == null) return Infinity
  return (edge === "before" ? c.in : m.durationSec - c.out) / c.speed
}

function TransitionSection({ project, clip }: { project: EditorProject; clip: Clip }) {
  const { t } = useI18n()
  const { apply } = useEditor.getState()
  const prev = previousAdjacent(project, clip)
  const next = nextAdjacent(project, clip)
  // A transition between two clips is stored on the later clip.
  const edges: { edge: "in" | "out"; value: Transition | null; holds: boolean }[] = [
    {
      edge: "in",
      value: clip.transIn,
      holds: !!clip.transIn && !!prev && Math.min(handle(project, prev, "after"), handle(project, clip, "before")) < clip.transIn.duration / 2 - 1e-3,
    },
    {
      edge: "out",
      value: next ? next.transIn : clip.transOut,
      holds: !!next?.transIn && Math.min(handle(project, clip, "after"), handle(project, next, "before")) < next.transIn.duration / 2 - 1e-3,
    },
  ]
  const put = (edge: "in" | "out", v: Transition | null) =>
    apply((p) => (edge === "out" && next && !v ? setTransition(p, next.id, "in", null) : setTransition(p, clip.id, edge, v)))
  return (
    <fieldset className="space-y-3" data-testid="clip-transitions">
      <legend className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.tr.title")}</legend>
      {edges.map(({ edge, value, holds }) => (
        <div key={edge} className="space-y-1.5">
          <Row label={t(edge === "in" ? "editor.tr.in" : "editor.tr.out")}>
            <Select
              value={value?.kind ?? "none"}
              onValueChange={(k) => put(edge, k === "none" ? null : { kind: k as TransitionKind, duration: value?.duration ?? 1, color: value?.color ?? "#000000" })}
            >
              <SelectTrigger size="sm" className="w-full" data-testid={`clip-trans-${edge}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("editor.tr.none")}</SelectItem>
                {TRANSITIONS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`editor.tr.k.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>
          {value && (
            <div className="grid grid-cols-2 gap-2">
              <Row label={t("editor.tr.duration")} htmlFor={`trans-${edge}-d`}>
                <Num id={`trans-${edge}-d`} value={value.duration} min={0.1} max={5} step={0.1} suffix="s" onCommit={(d) => put(edge, { ...value, duration: d })} />
              </Row>
              {value.kind === "dipColor" && (
                <Row label={t("editor.tr.color")} htmlFor={`trans-${edge}-c`}>
                  <input
                    id={`trans-${edge}-c`}
                    type="color"
                    value={value.color}
                    onChange={(e) => put(edge, { ...value, color: e.target.value })}
                    className="h-7 w-14 cursor-pointer rounded border bg-transparent"
                  />
                </Row>
              )}
            </div>
          )}
          {holds && <p className="text-[11px] leading-relaxed text-warning" data-testid="trans-holds">{t("editor.tr.holds")}</p>}
        </div>
      ))}
    </fieldset>
  )
}

/* ── Motion presets ────────────────────────────────────────────────────── */

function MotionSection({ project, clip, media }: { project: EditorProject; clip: Clip; media: EditorMedia }) {
  const { t } = useI18n()
  const { apply } = useEditor.getState()
  const [preset, setPreset] = useState<MotionPreset>("zoomIn")
  const [m, setM] = useState<MotionParams>(() => motionDefaults(clip, "zoomIn"))
  // New defaults when another clip is selected.
  useEffect(() => {
    setM(motionDefaults(clip, preset))
  }, [clip.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const len = clipEnd(clip) - clip.start
  const patch = (x: Partial<MotionParams>) => {
    setPreset("custom")
    setM((cur) => ({ ...cur, ...x }))
  }
  const pick = (v: MotionPreset) => {
    setPreset(v)
    setM(motionDefaults(clip, v))
  }
  const go = () => {
    const sw = (media.width ?? project.settings.width) * (1 - clip.crop.l - clip.crop.r)
    const sh = (media.height ?? project.settings.height) * (1 - clip.crop.t - clip.crop.b)
    apply((p) => applyMotion(p, clip.id, m, { W: project.settings.width, H: project.settings.height, sw, sh }))
  }
  return (
    <fieldset className="space-y-3" data-testid="clip-motion">
      <legend className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.motion.title")}</legend>
      <Row label={t("editor.motion.preset")}>
        <Select value={preset} onValueChange={(v) => pick(v as MotionPreset)}>
          <SelectTrigger size="sm" className="w-full" data-testid="motion-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MOTION_PRESETS.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`editor.motion.p.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <div className="grid grid-cols-2 gap-2">
        <Row label={t("editor.motion.from")} htmlFor="mo-from">
          <Num id="mo-from" value={round(m.from - clip.start)} min={0} max={len} step={0.1} onCommit={(v) => patch({ from: clip.start + v })} />
        </Row>
        <Row label={t("editor.motion.to")} htmlFor="mo-to">
          <Num id="mo-to" value={round(m.to - clip.start)} min={0} max={len} step={0.1} onCommit={(v) => patch({ to: clip.start + v })} />
        </Row>
        <Row label={t("editor.motion.startScale")} htmlFor="mo-s0">
          <Num id="mo-s0" value={Math.round(m.startScale * 100)} min={5} max={1000} step={1} onCommit={(v) => patch({ startScale: v / 100 })} />
        </Row>
        <Row label={t("editor.motion.endScale")} htmlFor="mo-s1">
          <Num id="mo-s1" value={Math.round(m.endScale * 100)} min={5} max={1000} step={1} onCommit={(v) => patch({ endScale: v / 100 })} />
        </Row>
      </div>
      <Row label={t("editor.motion.center")}>
        <div className="grid grid-cols-2 gap-2">
          <Num id="mo-cx" value={Math.round(m.cx * 100)} min={0} max={100} step={1} onCommit={(v) => patch({ cx: v / 100 })} />
          <Num id="mo-cy" value={Math.round(m.cy * 100)} min={0} max={100} step={1} onCommit={(v) => patch({ cy: v / 100 })} />
        </div>
      </Row>
      <Row label={t("editor.motion.pan")}>
        <div className="grid grid-cols-2 gap-2">
          <Num id="mo-px" value={Math.round(m.panX * 100)} min={-100} max={100} step={1} onCommit={(v) => patch({ panX: v / 100 })} />
          <Num id="mo-py" value={Math.round(m.panY * 100)} min={-100} max={100} step={1} onCommit={(v) => patch({ panY: v / 100 })} />
        </div>
      </Row>
      <Row label={t("editor.motion.ease")}>
        <EaseSelect value={m.ease} onChange={(e) => patch({ ease: e })} testId="motion-ease" />
      </Row>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={go} data-testid="motion-apply">
          <Wand2 />
          {t("editor.motion.apply")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => apply((p) => clearKeyframes(p, clip.id, ["scale", "x", "y"]))} data-testid="motion-reset">
          <RotateCcw />
          {t("editor.motion.reset")}
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("editor.motion.hint")}</p>
    </fieldset>
  )
}

const round = (n: number) => Math.round(n * 1000) / 1000

function EaseSelect({ value, onChange, testId }: { value: Ease; onChange: (e: Ease) => void; testId?: string }) {
  const { t } = useI18n()
  return (
    <Select value={value} onValueChange={(v) => onChange(v as Ease)}>
      <SelectTrigger size="sm" className="w-full" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {EASES.map((e) => (
          <SelectItem key={e} value={e}>
            {t(`editor.ease.${e}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/* ── Keyframes ─────────────────────────────────────────────────────────── */

/** Display factor of each property (stored as fractions, shown as % or degrees). */
const KF_UNIT: Record<KfProp, { k: number; min: number; max: number }> = {
  scale: { k: 100, min: 5, max: 1000 },
  x: { k: 100, min: -200, max: 200 },
  y: { k: 100, min: -200, max: 200 },
  rotation: { k: 1, min: -3600, max: 3600 },
  opacity: { k: 100, min: 0, max: 100 },
  gain: { k: 100, min: 0, max: 400 },
}

function KeyframeSection({ project, clip, props }: { project: EditorProject; clip: Clip; props: KfProp[] }) {
  const { t } = useI18n()
  const { apply, setKfClipboard } = useEditor.getState()
  const playhead = useEditor((s) => s.playhead)
  const copied = useEditor((s) => s.kfClipboard)
  const fps = project.settings.fps
  const inside = playhead >= clip.start - 1e-6 && playhead <= clipEnd(clip) + 1e-6
  const hasAny = props.some((k) => clip.keyframes[k]?.length)
  if (!props.length) return null
  return (
    <fieldset className="space-y-3" data-testid="clip-keyframes">
      <legend className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.kf.title")}</legend>
      {!inside && <p className="text-[11px] text-muted-foreground">{t("editor.kf.outside")}</p>}
      {props.map((prop) => {
        const u = KF_UNIT[prop]
        const list = clip.keyframes[prop] ?? []
        const at = list.findIndex((k) => Math.abs(kfTimeline(clip, k.s) - playhead) < 0.5 / fps)
        const value = clipValueAt(clip, prop, Math.min(Math.max(playhead, clip.start), clipEnd(clip)))
        const commit = (v: number) => {
          const real = v / u.k
          // Animated properties (and volume, which has no static value here) get a keyframe.
          if (list.length || prop === "gain") {
            if (inside) apply((p) => setKeyframe(p, clip.id, prop, playhead, real))
          } else if (prop === "opacity") apply((p) => updateClip(p, clip.id, { opacity: real }))
          else apply((p) => updateClip(p, clip.id, { [prop]: real }))
        }
        return (
          <div key={prop} className="space-y-1" data-testid={`kf-${prop}`}>
            <div className="flex items-end gap-1.5">
              <div className="flex-1">
                <Row label={t(`editor.kf.prop.${prop}`)} htmlFor={`kf-${prop}-v`}>
                  <Num id={`kf-${prop}-v`} value={round(value * u.k)} min={u.min} max={u.max} step={1} onCommit={commit} />
                </Row>
              </div>
              <Button
                size="icon-sm"
                variant={at >= 0 ? "secondary" : "ghost"}
                aria-label={t("editor.kf.toggle")}
                title={t("editor.kf.toggle")}
                aria-pressed={at >= 0}
                disabled={!inside}
                onClick={() => apply((p) => (at >= 0 ? removeKeyframe(p, clip.id, prop, at) : setKeyframe(p, clip.id, prop, playhead, value)))}
                data-testid={`kf-${prop}-toggle`}
              >
                <Diamond className={cn(at >= 0 && "fill-amber-300 text-amber-300")} />
              </Button>
            </div>
            {list.length > 0 && (
              <ul className="space-y-1 rounded-md border bg-black/20 p-1.5">
                {list.map((k, i) => (
                  <li key={`${k.s}-${i}`} className="flex items-center gap-1.5 text-[11px] tabular-nums">
                    <button
                      type="button"
                      className="w-20 text-left font-mono hover:underline"
                      onClick={() => useEditor.getState().setPlayhead(kfTimeline(clip, k.s))}
                    >
                      {formatTimecode(kfTimeline(clip, k.s), fps)}
                    </button>
                    <span className="w-12 text-right">{round(k.v * u.k)}</span>
                    <div className="min-w-0 flex-1">
                      <EaseSelect value={k.ease} onChange={(e) => apply((p) => setKeyframeEase(p, clip.id, prop, i, e))} />
                    </div>
                    <Button size="icon-xs" variant="ghost" aria-label={t("editor.kf.delete")} onClick={() => apply((p) => removeKeyframe(p, clip.id, prop, i))}>
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant="outline" disabled={!hasAny} onClick={() => setKfClipboard(clip)} data-testid="kf-copy">
          <ClipboardCopy />
          {t("editor.kf.copy")}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={!copied || copied.id === clip.id}
          onClick={() => copied && apply((p) => pasteKeyframes(p, copied, useEditor.getState().selection))}
          data-testid="kf-paste"
        >
          <ClipboardPaste />
          {t("editor.kf.paste")}
        </Button>
        <Button size="xs" variant="ghost" disabled={!hasAny} onClick={() => apply((p) => clearKeyframes(p, clip.id, props))} data-testid="kf-clear">
          <Trash2 />
          {t("editor.kf.clear")}
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("editor.kf.hint")}</p>
    </fieldset>
  )
}

/* ── Proxies ───────────────────────────────────────────────────────────── */

function ProxyToggle({ project }: { project: EditorProject }) {
  const { t } = useI18n()
  const useProxies = useEditor((s) => s.useProxies)
  const proxies = useEditor((s) => s.proxies)
  const setUseProxies = useEditor.getState().setUseProxies
  const large = project.media.filter((m) => m.kind === "video" && Math.max(m.width ?? 0, m.height ?? 0) > 1920)
  if (!large.length) return null
  return (
    <div className="mt-3 space-y-1.5 rounded-md border bg-black/20 p-2" data-testid="proxy-panel">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="use-proxies" className="text-[11px] leading-snug text-muted-foreground">
          {t("editor.proxy.on")}
        </Label>
        <Switch id="use-proxies" checked={useProxies} onCheckedChange={setUseProxies} data-testid="proxy-toggle" />
      </div>
      {large.map((m) => {
        const px = proxies[m.id]
        const ready = !!px?.path
        return (
          <p key={m.id} className="flex items-center gap-1 text-[10px] text-muted-foreground" data-testid="proxy-status" data-media-id={m.id} data-ready={ready}>
            {!ready && px && px.width >= 0 && <Loader2 className="size-3 animate-spin" />}
            {ready ? t("editor.proxy.ready", { name: m.name }) : t("editor.proxy.making", { name: m.name })}
          </p>
        )
      })}
    </div>
  )
}

/* ── Quick actions ─────────────────────────────────────────────────────── */

/** The video track directly above the clip's track (created when there is none). */
function trackAbove(p: EditorProject, clip: Clip): { project: EditorProject; trackId: string } {
  const videos = p.tracks.filter((t) => t.kind === "video")
  const i = videos.findIndex((t) => t.id === clip.trackId)
  const above = videos[i - 1]
  if (above) return { project: p, trackId: above.id }
  const next = addTrack(p, "video")
  const created = next.tracks.find((t) => t.kind === "video" && !p.tracks.some((o) => o.id === t.id))
  if (!created) return { project: p, trackId: clip.trackId }
  // Keep the new track above the clip's track in draw order.
  const tracks = next.tracks.filter((t) => t.id !== created.id)
  const at = tracks.findIndex((t) => t.id === clip.trackId)
  tracks.splice(at, 0, created)
  return { project: { ...next, tracks }, trackId: created.id }
}

/** Imports a file and places it over the clip at the playhead (overlay / picture-in-picture). */
async function importOverlay(project: EditorProject, clip: Clip, kind: "image" | "video", pin: boolean, t: (k: never, v?: Record<string, string | number>) => string) {
  const st = useEditor.getState()
  const tr = t as (k: string) => string
  try {
    const r = await api.editorImportMedia(project.id)
    if (!r) return
    for (const f of r.failed) toast.error(f.name, { description: f.message })
    const picked = r.media.find((m) => (kind === "image" ? m.kind === "image" : m.kind === "video")) ?? r.media.find((m) => m.kind !== "audio")
    if (!picked) return
    let createdId = ""
    st.apply((p) => {
      let next = addMedia(p, r.media)
      const { project: q, trackId } = trackAbove(next, clip)
      next = q
      const start = Math.min(Math.max(st.playhead, clip.start), clipEnd(clip) - 0.1)
      const placed = placeMedia(next, picked.id, { trackId, start })
      createdId = placed.clip.id
      next = placed.project
      if (pin) {
        const m = picked
        const W = next.settings.width
        const H = next.settings.height
        const sw = m.width ?? W
        const sh = m.height ?? H
        next = setCorners(next, createdId, defaultCorners(placed.clip, { W, H, sw, sh }))
      }
      return next
    })
    if (createdId) {
      st.select([createdId])
      st.setInspectorTab("overlay")
      if (pin) {
        st.setEditMode("corners")
        toast.info(tr("editor.quick.fixScreenHint"))
      }
    }
  } catch (e) {
    toastError(e)
  }
}

function QuickActions({ project, clip, media }: { project: EditorProject; clip: Clip; media: EditorMedia }) {
  const { t } = useI18n()
  const st = useEditor.getState()
  const isOverlay = project.tracks.filter((x) => x.kind === "video").findIndex((x) => x.id === clip.trackId) > 0
  const Btn = ({ icon, label, onClick, testId }: { icon: React.ReactNode; label: string; onClick: () => void; testId: string }) => (
    <Button size="sm" variant="outline" className="h-auto flex-col gap-1 px-1 py-1.5 text-[10px] leading-tight" onClick={onClick} data-testid={testId} title={label}>
      {icon}
      <span className="truncate">{label}</span>
    </Button>
  )
  return (
    <div className="space-y-1.5" data-testid="quick-actions">
      <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.quick.title")}</p>
      <div className="grid grid-cols-4 gap-1">
        {media.kind === "video" && <Btn icon={<Scan />} label={t("editor.quick.reframe")} onClick={() => st.setInspectorTab("reframe")} testId="qa-reframe" />}
        <Btn icon={<ZoomIn />} label={t("editor.quick.zoom")} onClick={() => st.setInspectorTab("motion")} testId="qa-zoom" />
        <Btn icon={<Scissors />} label={t("editor.quick.cut")} onClick={() => st.apply((p) => splitAt(p, st.playhead, [clip.id]).project)} testId="qa-cut" />
        <Btn icon={<Download />} label={t("editor.quick.export")} onClick={() => st.requestExport()} testId="qa-export" />
        <Btn icon={<ImagePlus />} label={t("editor.quick.addImage")} onClick={() => void importOverlay(project, clip, "image", false, t)} testId="qa-add-image" />
        <Btn icon={<Film />} label={t("editor.quick.addVideo")} onClick={() => void importOverlay(project, clip, "video", false, t)} testId="qa-add-video" />
        <Btn icon={<Crosshair />} label={t("editor.quick.fixScreen")} onClick={() => void importOverlay(project, clip, "image", true, t)} testId="qa-fix-screen" />
        <Btn
          icon={<Focus />}
          label={t("editor.quick.blur")}
          onClick={() => {
            let id = ""
            st.apply((p) => {
              const r = addRegion(p, clip.id, { kind: "blur" })
              id = r.region.id
              return r.project
            })
            st.setInspectorTab("overlay")
            st.setEditMode("region", id)
          }}
          testId="qa-blur"
        />
        {isOverlay && (
          <Btn
            icon={<Crosshair />}
            label={t("editor.quick.align")}
            onClick={() => {
              if (!clip.corners) {
                const W = project.settings.width
                const H = project.settings.height
                st.apply((p) => setCorners(p, clip.id, defaultCorners(clip, { W, H, sw: media.width ?? W, sh: media.height ?? H })))
              }
              st.setInspectorTab("overlay")
              st.setEditMode("corners")
            }}
            testId="qa-align"
          />
        )}
      </div>
    </div>
  )
}

/* ── Smart Reframe ─────────────────────────────────────────────────────── */

function ReframeSection({ project, clip, media }: { project: EditorProject; clip: Clip; media: EditorMedia }) {
  const { t } = useI18n()
  const { apply, setAnalysis, setAnalyzing, setEditMode } = useEditor.getState()
  const analysis = useEditor((s) => s.analyses[clip.id])
  const analyzing = useEditor((s) => s.analyzing === clip.id)
  const editMode = useEditor((s) => s.editMode)
  const W = project.settings.width
  const H = project.settings.height
  const sw = (media.width ?? W) * (1 - clip.crop.l - clip.crop.r)
  const sh = (media.height ?? H) * (1 - clip.crop.t - clip.crop.b)
  const frame = { W, H, sw, sh }
  const same = sameAspect(frame)
  const run = async () => {
    setAnalyzing(clip.id)
    try {
      const a = await api.editorAnalyzeSubjects(project.id, media.id, clip.in, clip.out)
      setAnalysis(clip.id, a)
      for (const w of a.warnings) toast.warning(w)
    } catch (e) {
      toastError(e)
    } finally {
      setAnalyzing(null)
    }
  }
  const follow = (s: Subject, a: Analysis) => apply((p) => applyReframe(p, clip.id, s, frame, a))
  const mode = clip.reframe.mode
  return (
    <fieldset className="space-y-3" data-testid="reframe-section">
      <legend className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.reframe.title")}</legend>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("editor.reframe.intro")}</p>
      {media.kind !== "video" && <p className="text-[11px] text-muted-foreground">{t("editor.reframe.notVideo")}</p>}
      {same && <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-2 text-[11px] leading-relaxed" data-testid="reframe-same-aspect">{t("editor.reframe.sameAspect")}</p>}
      {mode !== "off" && (
        <div className="space-y-1 rounded-md border bg-black/20 p-2 text-[11px]" data-testid="reframe-status" data-mode={mode} data-status={clip.reframe.status ?? ""}>
          <p className="font-medium">{t(`editor.reframe.mode.${mode}`)}</p>
          {mode === "auto" && clip.reframe.status && <p className={cn("leading-relaxed", clip.reframe.status === "ok" ? "text-muted-foreground" : "text-warning")}>{t(`editor.reframe.status.${clip.reframe.status}`)}</p>}
          {mode === "auto" && clip.reframe.method && <p className="text-muted-foreground">{t(`editor.reframe.method.${clip.reframe.method}`)}</p>}
          {mode === "auto" && <p className="text-muted-foreground">{t("editor.reframe.editHint")}</p>}
        </div>
      )}
      {media.kind === "video" && !same && (
        <Button size="sm" className="w-full" onClick={() => void run()} disabled={analyzing} data-testid="reframe-analyze">
          {analyzing ? <Loader2 className="animate-spin" /> : <Scan />}
          {analyzing ? t("editor.reframe.analyzing") : t("editor.reframe.analyze")}
        </Button>
      )}
      {analysis && !same && (
        <div className="space-y-2" data-testid="reframe-result" data-method={analysis.method}>
          <p className={cn("text-[11px] leading-relaxed", analysis.method === "none" ? "text-warning" : "text-muted-foreground")}>{t(`editor.reframe.method.${analysis.method as "face" | "motion" | "none"}`)}</p>
          {analysis.subjects.length > 0 && <p className="text-[11px] font-medium">{t("editor.reframe.subjects")}</p>}
          {analysis.subjects.map((s, i) => (
            <div key={s.id} className={cn("flex items-center gap-2 rounded-md border p-1.5 text-[11px]", clip.reframe.subject === s.id && "border-sky-400/60 bg-sky-500/10")} data-testid="reframe-subject">
              <span className="min-w-0 flex-1 truncate">{t("editor.reframe.subject", { n: i + 1, pct: Math.round(s.coverage * 100) })}</span>
              <Button size="xs" onClick={() => follow(s, analysis)} data-testid="reframe-follow">
                {t("editor.reframe.apply")}
              </Button>
            </div>
          ))}
        </div>
      )}
      {!same && (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium">{t("editor.reframe.fallbacks")}</p>
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" variant={editMode === "focus" ? "secondary" : "outline"} onClick={() => setEditMode(editMode === "focus" ? "none" : "focus")} data-testid="reframe-focus">
              <Crosshair />
              {t("editor.reframe.focus")}
            </Button>
            <Button size="xs" variant="outline" onClick={() => apply((p) => applyBlurFallback(p, clip.id))} data-testid="reframe-blur">
              {t("editor.reframe.blur")}
            </Button>
            {mode !== "off" && (
              <Button size="xs" variant="ghost" onClick={() => apply((p) => clearReframe(p, clip.id))} data-testid="reframe-clear">
                <RotateCcw />
                {t("editor.reframe.clear")}
              </Button>
            )}
          </div>
          {editMode === "focus" && <p className="text-[11px] text-muted-foreground">{t("editor.reframe.focusHint")}</p>}
        </div>
      )}
    </fieldset>
  )
}

/* ── Overlay: corner pin, masks, region fixes ──────────────────────────── */

function OverlaySection({ project, clip, media }: { project: EditorProject; clip: Clip; media: EditorMedia }) {
  const { t } = useI18n()
  const { apply, setEditMode } = useEditor.getState()
  const editMode = useEditor((s) => s.editMode)
  const activeRegion = useEditor((s) => s.activeRegion)
  const playhead = useEditor((s) => s.playhead)
  const fps = project.settings.fps
  const W = project.settings.width
  const H = project.settings.height
  const frame = { W, H, sw: (media.width ?? W) * (1 - clip.crop.l - clip.crop.r), sh: (media.height ?? H) * (1 - clip.crop.t - clip.crop.b) }
  const quad = cornersAt(clip, playhead)
  const pinned = !!clip.corners
  const addRgn = (kind: "blur" | "color") => {
    let id = ""
    apply((p) => {
      const r = addRegion(p, clip.id, { kind })
      id = r.region.id
      return r.project
    })
    setEditMode("region", id)
  }
  return (
    <div className="space-y-4" data-testid="overlay-section">
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("editor.overlay.intro")}</p>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.overlay.pin")}</legend>
        <div className="flex items-center justify-between">
          <Label htmlFor="pin-on" className="text-[11px] text-muted-foreground">
            {pinned ? t("editor.overlay.pinOff") : t("editor.overlay.pinOn")}
          </Label>
          <Switch
            id="pin-on"
            checked={pinned}
            onCheckedChange={(v) => {
              apply((p) => setCorners(p, clip.id, v ? defaultCorners(clip, frame) : null))
              if (!v && editMode === "corners") setEditMode("none")
            }}
            data-testid="pin-toggle"
          />
        </div>
        {pinned && quad && (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Button size="xs" variant={editMode === "corners" ? "secondary" : "outline"} onClick={() => setEditMode(editMode === "corners" ? "none" : "corners")} data-testid="pin-edit">
                <Crosshair />
                {editMode === "corners" ? t("editor.overlay.pinDone") : t("editor.overlay.pinEdit")}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => apply((p) => setCorners(p, clip.id, defaultCorners(clip, frame)))} data-testid="pin-reset">
                <RotateCcw />
                {t("editor.overlay.pinReset")}
              </Button>
              <Button size="xs" variant="outline" onClick={() => apply((p) => setCornerKeyframe(p, clip.id, playhead, quad))} data-testid="pin-keyframe">
                <Diamond />
                {t("editor.overlay.pinKf")}
              </Button>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="space-y-0.5">
                  <p className="text-[10px] text-muted-foreground">{t("editor.overlay.corner", { n: i + 1 })}</p>
                  {[0, 1].map((k) => (
                    <Num
                      key={k}
                      id={`corner-${i}-${k}`}
                      value={Math.round((quad[i * 2 + k] ?? 0) * 1000) / 10}
                      min={-300}
                      max={400}
                      step={0.1}
                      onCommit={(v) => {
                        const next = [...quad] as typeof quad
                        next[i * 2 + k] = v / 100
                        apply((p) => (clip.cornerKeyframes.length ? setCornerKeyframe(p, clip.id, playhead, next) : setCorners(p, clip.id, next)))
                      }}
                    />
                  ))}
                </div>
              ))}
            </div>
            {clip.cornerKeyframes.length > 0 && (
              <ul className="space-y-1 rounded-md border bg-black/20 p-1.5" data-testid="pin-keyframes">
                <li className="text-[10px] text-muted-foreground">{t("editor.overlay.pinKfs")}</li>
                {clip.cornerKeyframes.map((k, i) => (
                  <li key={`${k.s}-${i}`} className="flex items-center gap-1.5 text-[11px] tabular-nums">
                    <button type="button" className="flex-1 text-left font-mono hover:underline" onClick={() => useEditor.getState().setPlayhead(kfTimeline(clip, k.s))}>
                      {formatTimecode(kfTimeline(clip, k.s), fps)}
                    </button>
                    <Button size="icon-xs" variant="ghost" aria-label={t("editor.kf.delete")} onClick={() => apply((p) => removeCornerKeyframe(p, clip.id, i))}>
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">{t("editor.overlay.pinHint")}</p>
          </>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.overlay.mask")}</legend>
        <Select value={clip.mask.shape} onValueChange={(v) => apply((p) => setMask(p, clip.id, { shape: v as MaskShape }))}>
          <SelectTrigger size="sm" className="w-full" data-testid="mask-shape">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MASK_SHAPES.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`editor.overlay.maskShape.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {clip.mask.shape !== "none" && (
          <div className="grid grid-cols-2 gap-2">
            <Row label={t("editor.overlay.feather")} htmlFor="mask-feather">
              <Num id="mask-feather" value={Math.round(clip.mask.feather * 100)} min={0} max={50} step={1} onCommit={(v) => apply((p) => setMask(p, clip.id, { feather: v / 100 }))} />
            </Row>
            {clip.mask.shape === "roundRect" && (
              <Row label={t("editor.overlay.radius")} htmlFor="mask-radius">
                <Num id="mask-radius" value={Math.round(clip.mask.radius * 100)} min={0} max={50} step={1} onCommit={(v) => apply((p) => setMask(p, clip.id, { radius: v / 100 }))} />
              </Row>
            )}
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{t("editor.overlay.regions")}</legend>
        <div className="flex gap-1.5">
          <Button size="xs" variant="outline" onClick={() => addRgn("blur")} data-testid="region-add-blur">
            <Plus />
            {t("editor.overlay.addBlur")}
          </Button>
          <Button size="xs" variant="outline" onClick={() => addRgn("color")} data-testid="region-add-color">
            <Plus />
            {t("editor.overlay.addCover")}
          </Button>
        </div>
        {clip.regions.map((r, i) => (
          <RegionEditor key={r.id} clip={clip} region={r} index={i} active={activeRegion === r.id && editMode === "region"} />
        ))}
      </fieldset>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="motion-blur" className="text-[11px] leading-snug text-muted-foreground">
          {t("editor.overlay.motionBlur")}
        </Label>
        <Switch id="motion-blur" checked={clip.motionBlur} onCheckedChange={(v) => apply((p) => updateClip(p, clip.id, { motionBlur: v }))} data-testid="motion-blur" />
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <span className="font-medium">{t("editor.overlay.pip")}: </span>
        {t("editor.overlay.pipHint")}
      </p>
    </div>
  )
}

function RegionEditor({ clip, region: r, index, active }: { clip: Clip; region: Region; index: number; active: boolean }) {
  const { t } = useI18n()
  const { apply, setEditMode } = useEditor.getState()
  const playhead = useEditor((s) => s.playhead)
  const set = (patch: Partial<Omit<Region, "id">>) => apply((p) => updateRegion(p, clip.id, r.id, patch))
  return (
    <div className={cn("space-y-1.5 rounded-md border p-2", active && "border-amber-400/60 bg-amber-500/5")} data-testid="region-item" data-region-id={r.id}>
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-medium">{t("editor.overlay.region", { n: index + 1 })}</span>
        <Select value={r.kind} onValueChange={(v) => set({ kind: v as Region["kind"] })}>
          <SelectTrigger size="sm" className="h-7 flex-1 text-[11px]" data-testid="region-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REGION_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`editor.overlay.regionKind.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={r.shape} onValueChange={(v) => set({ shape: v as Region["shape"] })}>
          <SelectTrigger size="sm" className="h-7 flex-1 text-[11px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REGION_SHAPES.map((k) => (
              <SelectItem key={k} value={k}>
                {t(`editor.overlay.regionShape.${k}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="icon-xs" variant="ghost" aria-label={t("common.delete")} onClick={() => apply((p) => removeRegion(p, clip.id, r.id))} data-testid="region-delete">
          <Trash2 />
        </Button>
      </div>
      <Row label={t("editor.overlay.regionBox")}>
        <div className="grid grid-cols-4 gap-1">
          {(["x", "y", "w", "h"] as const).map((k) => (
            <Num key={k} id={`region-${r.id}-${k}`} value={Math.round(r[k] * 100)} min={k === "w" || k === "h" ? 1 : -100} max={200} step={1} onCommit={(v) => set({ [k]: v / 100 })} />
          ))}
        </div>
      </Row>
      <div className="grid grid-cols-2 gap-2">
        {r.kind === "blur" ? (
          <Row label={t("editor.overlay.regionStrength")} htmlFor={`region-${r.id}-blur`}>
            <Num id={`region-${r.id}-blur`} value={Math.round(r.blur * 1000) / 10} min={0.2} max={10} step={0.1} onCommit={(v) => set({ blur: v / 100 })} />
          </Row>
        ) : (
          <Row label={t("editor.tr.color")} htmlFor={`region-${r.id}-color`}>
            <input id={`region-${r.id}-color`} type="color" value={r.color} onChange={(e) => set({ color: e.target.value })} className="h-7 w-14 cursor-pointer rounded border bg-transparent" />
          </Row>
        )}
        <Row label={t("editor.overlay.feather")} htmlFor={`region-${r.id}-feather`}>
          <Num id={`region-${r.id}-feather`} value={Math.round(r.feather * 100)} min={0} max={50} step={1} onCommit={(v) => set({ feather: v / 100 })} />
        </Row>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="xs" variant={active ? "secondary" : "outline"} onClick={() => setEditMode(active ? "none" : "region", r.id)} data-testid="region-edit">
          <Crosshair />
          {t("editor.overlay.regionEdit")}
        </Button>
        <Button size="xs" variant="outline" onClick={() => apply((p) => setRegionKeyframe(p, clip.id, r.id, playhead, r.x, r.y))} data-testid="region-keyframe">
          <Diamond />
          {t("editor.overlay.regionKf")}
          {r.keyframes.length > 0 && ` (${r.keyframes.length})`}
        </Button>
      </div>
    </div>
  )
}
