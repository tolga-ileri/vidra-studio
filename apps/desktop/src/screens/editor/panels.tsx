import { useEffect, useState } from "react"
import { AlertTriangle, ClipboardCopy, ClipboardPaste, Diamond, Film, ImageIcon, Link2, Music, Plus, RotateCcw, Trash2, Upload, Wand2 } from "lucide-react"
import { toast } from "sonner"
import {
  applyMotion,
  ASPECTS,
  clearKeyframes,
  clipDuration,
  clipEnd,
  clipValueAt,
  EASES,
  formatTimecode,
  kfTimeline,
  motionDefaults,
  MOTION_PRESETS,
  nextAdjacent,
  pasteKeyframes,
  placeMedia,
  previousAdjacent,
  removeKeyframe,
  setFormat,
  setKeyframe,
  setKeyframeEase,
  setTransition,
  TRANSITIONS,
  updateClip,
  type Ease,
  type KfProp,
  type MotionParams,
  type MotionPreset,
  type Transition,
  type TransitionKind,
  type Aspect,
  type Clip,
  type EditorMedia,
  type EditorProject,
  type FitMode,
} from "@vidra/core"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
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
      {visual && media && <MotionSection project={project} clip={clip} media={media} />}
      <KeyframeSection project={project} clip={clip} props={[...(visual ? (["scale", "x", "y", "rotation", "opacity"] as const) : []), ...(hasAudio ? (["gain"] as const) : [])]} />
      {visual && <TransitionSection project={project} clip={clip} />}
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
