import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Bookmark,
  Combine,
  Copy,
  Eraser,
  Eye,
  EyeOff,
  Lock,
  Magnet,
  MousePointer2,
  Plus,
  Redo2,
  Scissors,
  Slice,
  Trash2,
  Undo2,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import {
  addMarker,
  canJoin,
  clipDuration,
  clipEnd,
  deleteClips,
  duplicateClips,
  formatTimecode,
  frameRound,
  joinClips,
  kfTimeline,
  KF_PROPS,
  moveClips,
  moveKeyframe,
  removeMarker,
  removeRange,
  setTransition,
  TRANSITIONS,
  trimToPlayhead,
  placeMedia,
  projectDuration,
  snapTime,
  splitAt,
  trimClip,
  updateTrack,
  addTrack,
  type Clip,
  type EditorMedia,
  type EditorProject,
  type Track,
  type TransitionKind,
} from "@vidra/core"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/i18n"
import { fileSrc } from "@/lib/backend"
import { cn } from "@/lib/utils"
import { useEditor, ZOOM_MAX, ZOOM_MIN } from "./store"

export const MEDIA_DRAG_TYPE = "application/x-vidra-media"
export const TRANSITION_DRAG_TYPE = "application/x-vidra-transition"
const HEADER_W = 148
const ROW_H: Record<Track["kind"], number> = { video: 64, audio: 52 }
const SNAP_PX = 8

type Drag =
  | { mode: "move"; ids: string[]; x0: number; y0: number; before: EditorProject; primary: Clip; moved: boolean }
  | { mode: "trim"; edge: "start" | "end"; id: string; x0: number; y0: number; before: EditorProject; moved: boolean }
  | { mode: "kf"; id: string; s: number; x0: number; before: EditorProject; moved: boolean }
  | { mode: "scrub" }

/** Picks a ruler step so labels are at least ~70px apart. */
function rulerStep(zoom: number): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return steps.find((s) => s * zoom >= 70) ?? 600
}

export function Timeline({ project }: { project: EditorProject }) {
  const i18n = useI18n()
  const { t } = i18n
  const zoom = useEditor((s) => s.zoom)
  const playhead = useEditor((s) => s.playhead)
  const selection = useEditor((s) => s.selection)
  const history = useEditor((s) => s.history)
  const tool = useEditor((s) => s.tool)
  const range = useEditor((s) => s.range)
  const { apply, preview, commitFrom, select, setPlayhead, setZoom, setPlaying, undo, redo, setTool, setRange } = useEditor.getState()
  const fps = project.settings.fps
  const [snap, setSnap] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const media = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media])
  const duration = projectDuration(project)
  const width = Math.max(duration + 30, 60) * zoom

  const timeAt = (clientX: number) => {
    const el = scroller.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return Math.max(0, (clientX - r.left - HEADER_W + el.scrollLeft) / zoom)
  }
  const snapped = (time: number, exclude: Set<string>) =>
    snap ? snapTime(project, time, SNAP_PX / zoom, exclude, [useEditor.getState().playhead]) : time

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      if (d.mode === "scrub") {
        setPlayhead(frameRound(timeAt(e.clientX), fps))
        return
      }
      const dx = e.clientX - d.x0
      if (d.mode === "kf") {
        if (!d.moved && Math.abs(dx) < 3) return
        d.moved = true
        const c = d.before.clips.find((x) => x.id === d.id)
        if (!c) return
        const to = frameRound(kfTimeline(c, d.s) + dx / zoom, fps)
        // Moves the keyframes of every property that share this source time.
        preview(() => {
          let next = d.before
          for (const k of KF_PROPS) {
            const i = (c.keyframes[k] ?? []).findIndex((x) => Math.abs(x.s - d.s) < 1e-6)
            if (i >= 0) next = moveKeyframe(next, d.id, k, i, to)
          }
          return next
        })
        setPlayhead(to)
        return
      }
      // Start a drag after a few pixels in any direction (vertical = change track).
      if (!d.moved && Math.hypot(dx, e.clientY - d.y0) < 3) return
      d.moved = true
      if (d.mode === "move") {
        const raw = d.primary.start + dx / zoom
        const exclude = new Set(d.ids)
        const len = clipDuration(d.primary)
        let start = snapped(raw, exclude)
        const endSnap = snapped(raw + len, exclude)
        if (start === raw && endSnap !== raw + len) start = endSnap - len
        const target = (document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-track-id]") as HTMLElement | null)?.dataset.trackId
        const from = d.before.tracks.find((x) => x.id === d.primary.trackId)
        const to = d.before.tracks.find((x) => x.id === target)
        const toTrack = d.ids.length === 1 && to && from && to.kind === from.kind && to.id !== from.id ? to.id : undefined
        preview(() => moveClips(d.before, d.ids, Math.max(-d.primary.start, start - d.primary.start), toTrack))
      } else {
        const c = d.before.clips.find((x) => x.id === d.id)
        if (!c) return
        const edgeTime = (d.edge === "start" ? c.start : clipEnd(c)) + dx / zoom
        preview(() => trimClip(d.before, d.id, d.edge, snapped(edgeTime, new Set([d.id]))))
      }
    }
    const up = () => {
      const d = drag.current
      drag.current = null
      if (d && d.mode !== "scrub" && d.moved) commitFrom(d.before)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  })

  // Ctrl + wheel zooms around the pointer.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom(useEditor.getState().zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15))
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [setZoom])

  const onClipDown = (e: React.PointerEvent, c: Clip, edge?: "start" | "end") => {
    e.stopPropagation()
    if (e.button !== 0) return
    const track = project.tracks.find((x) => x.id === c.trackId)
    const additive = e.ctrlKey || e.metaKey || e.shiftKey
    let ids = selection.includes(c.id) ? selection : [c.id]
    if (additive) ids = selection.includes(c.id) ? selection.filter((x) => x !== c.id) : [...selection, c.id]
    if (!edge && useEditor.getState().tool === "blade" && !track?.locked) {
      // Blade: cut this clip where it was clicked (frame accurate).
      const at = frameRound(timeAt(e.clientX), fps)
      apply((p) => splitAt(p, at, [c.id]).project)
      setPlayhead(at)
      return
    }
    select(ids)
    if (track?.locked || additive) return
    drag.current = edge
      ? { mode: "trim", edge, id: c.id, x0: e.clientX, y0: e.clientY, before: project, moved: false }
      : { mode: "move", ids: ids.includes(c.id) ? ids : [c.id], x0: e.clientX, y0: e.clientY, before: project, primary: c, moved: false }
  }

  const onLaneDrop = (e: React.DragEvent, track: Track) => {
    const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE)
    if (!id) return
    e.preventDefault()
    try {
      const at = snapped(timeAt(e.clientX), new Set())
      apply((p) => placeMedia(p, id, { trackId: track.id, start: at }).project)
    } catch (err) {
      toast.error(err instanceof Error ? editorError(i18n.t, err.message) : String(err))
    }
  }

  const onKfDown = (e: React.PointerEvent, c: Clip, s: number) => {
    e.stopPropagation()
    if (e.button !== 0) return
    select([c.id])
    setPlaying(false)
    setPlayhead(kfTimeline(c, s))
    if (project.tracks.find((x) => x.id === c.trackId)?.locked) return
    drag.current = { mode: "kf", id: c.id, s, x0: e.clientX, before: project, moved: false }
  }

  const onTransitionDrop = (e: React.DragEvent, c: Clip) => {
    const kind = e.dataTransfer.getData(TRANSITION_DRAG_TYPE) as TransitionKind
    if (!TRANSITIONS.includes(kind)) return
    e.preventDefault()
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const edge = e.clientX < r.left + r.width / 2 ? "in" : "out"
    apply((p) => setTransition(p, c.id, edge, { kind, duration: 1, color: "#000000" }))
    select([c.id])
  }

  const split = () => {
    const sel = selection.length ? selection : undefined
    apply((p) => splitAt(p, frameRound(playhead, fps), sel).project)
  }
  const trimTo = (edge: "start" | "end") => apply((p) => trimToPlayhead(p, frameRound(playhead, fps), edge, selection.length ? selection : undefined))
  const selectedClips = project.clips.filter((c) => selection.includes(c.id)).sort((a, b) => a.start - b.start)
  const joinable = selectedClips.some((c, i) => {
    const n = selectedClips[i + 1]
    return !!n && canJoin(c, n)
  })
  const join = () => {
    if (!joinable) return toast.error(t("editor.tl.cantJoin"))
    apply((p) => joinClips(p, selection))
  }
  const rangeReady = range.a !== null && range.b !== null && range.b - range.a > 0.01
  const cutRange = () => {
    if (range.a === null || range.b === null) return
    const [a, b] = [range.a, range.b]
    apply((p) => removeRange(p, a, b))
    setRange({ a: null, b: null })
    setPlayhead(a)
  }
  const remove = (ripple: boolean) => {
    if (!selection.length) return
    apply((p) => deleteClips(p, selection, ripple))
    select([])
  }

  const step = rulerStep(zoom)
  const ticks = Math.ceil(width / zoom / step) + 1

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="editor-timeline">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <ToolBtn label={`${t("editor.tl.undo")} (Ctrl+Z)`} onClick={undo} disabled={!history?.past.length}>
          <Undo2 />
        </ToolBtn>
        <ToolBtn label={`${t("editor.tl.redo")} (Ctrl+Y)`} onClick={redo} disabled={!history?.future.length}>
          <Redo2 />
        </ToolBtn>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolBtn label={t("editor.tl.select")} onClick={() => setTool("select")} pressed={tool === "select"} testId="tl-tool-select">
          <MousePointer2 />
        </ToolBtn>
        <ToolBtn label={t("editor.tl.blade")} onClick={() => setTool(tool === "blade" ? "select" : "blade")} pressed={tool === "blade"} testId="tl-tool-blade">
          <Slice />
        </ToolBtn>
        <ToolBtn label={`${t("editor.tl.split")} (S)`} onClick={split} testId="tl-split">
          <Scissors />
        </ToolBtn>
        <ToolBtn label={t("editor.tl.trimStart")} onClick={() => trimTo("start")} testId="tl-trim-to-start">
          <ArrowLeftToLine />
        </ToolBtn>
        <ToolBtn label={t("editor.tl.trimEnd")} onClick={() => trimTo("end")} testId="tl-trim-to-end">
          <ArrowRightToLine />
        </ToolBtn>
        <ToolBtn label={t("editor.tl.join")} onClick={join} disabled={selection.length < 2} testId="tl-join">
          <Combine />
        </ToolBtn>
        <ToolBtn label={`${t("editor.tl.duplicate")} (Ctrl+D)`} onClick={() => apply((p) => duplicateClips(p, selection).project)} disabled={!selection.length}>
          <Copy />
        </ToolBtn>
        <ToolBtn label={`${t("editor.tl.delete")} (Del)`} onClick={() => remove(false)} disabled={!selection.length} testId="tl-delete">
          <Trash2 />
        </ToolBtn>
        <Button size="xs" variant="ghost" onClick={() => remove(true)} disabled={!selection.length} data-testid="tl-ripple">
          {t("editor.tl.ripple")}
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolBtn label={t("editor.tl.marker")} onClick={() => apply((p) => addMarker(p, frameRound(playhead, fps)))} testId="tl-marker">
          <Bookmark />
        </ToolBtn>
        <Button size="xs" variant={range.a !== null ? "secondary" : "ghost"} onClick={() => setRange({ a: frameRound(playhead, fps), b: range.b !== null && range.b > playhead ? range.b : null })} title={t("editor.tl.rangeIn")} data-testid="tl-range-in">
          [
        </Button>
        <Button size="xs" variant={range.b !== null ? "secondary" : "ghost"} onClick={() => setRange({ a: range.a !== null && range.a < playhead ? range.a : null, b: frameRound(playhead, fps) })} title={t("editor.tl.rangeOut")} data-testid="tl-range-out">
          ]
        </Button>
        <ToolBtn label={t("editor.tl.rangeRemove")} onClick={cutRange} disabled={!rangeReady} testId="tl-range-remove">
          <Eraser />
        </ToolBtn>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolBtn label={t("editor.tl.snap")} onClick={() => setSnap(!snap)} pressed={snap}>
          <Magnet />
        </ToolBtn>
        <span className="ml-2 font-mono text-[11px] text-muted-foreground tabular-nums">{formatTimecode(playhead, project.settings.fps)}</span>
        <div className="ml-auto flex w-56 items-center gap-2">
          <ToolBtn label={t("editor.tl.zoomOut")} onClick={() => setZoom(zoom / 1.4)}>
            <ZoomOut />
          </ToolBtn>
          <Slider
            aria-label={t("editor.tl.zoom")}
            min={Math.log(ZOOM_MIN)}
            max={Math.log(ZOOM_MAX)}
            step={0.01}
            value={[Math.log(zoom)]}
            onValueChange={([v]) => v !== undefined && setZoom(Math.exp(v))}
          />
          <ToolBtn label={t("editor.tl.zoomIn")} onClick={() => setZoom(zoom * 1.4)}>
            <ZoomIn />
          </ToolBtn>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              const w = (scroller.current?.clientWidth ?? 800) - HEADER_W - 24
              setZoom(w / Math.max(duration, 5))
            }}
          >
            {t("editor.tl.fit")}
          </Button>
        </div>
      </div>

      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto" data-testid="tl-scroller">
        <div className="relative" style={{ width: width + HEADER_W }}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex h-7 border-b bg-card">
            <div className="sticky left-0 z-30 shrink-0 border-r bg-card" style={{ width: HEADER_W }} />
            <div
              className="relative flex-1 cursor-ew-resize select-none"
              onPointerDown={(e) => {
                setPlaying(false)
                drag.current = { mode: "scrub" }
                setPlayhead(frameRound(timeAt(e.clientX), fps))
              }}
              data-testid="tl-ruler"
            >
              {range.a !== null && (
                <div
                  className="pointer-events-none absolute inset-y-0 bg-amber-400/20"
                  style={{ left: range.a * zoom, width: Math.max(2, ((range.b ?? range.a) - range.a) * zoom) }}
                  data-testid="tl-range"
                />
              )}
              {project.markers.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="absolute bottom-0 z-10 -ml-[5px] h-3 w-[10px] cursor-pointer"
                  style={{ left: m.t * zoom, background: m.color, clipPath: "polygon(0 0, 100% 0, 50% 100%)" }}
                  title={t("editor.tl.markerTitle", { time: formatTimecode(m.t, fps) })}
                  aria-label={t("editor.tl.markerTitle", { time: formatTimecode(m.t, fps) })}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => (setPlaying(false), setPlayhead(m.t))}
                  onDoubleClick={() => apply((p) => removeMarker(p, m.id))}
                  data-testid="tl-marker-item"
                  data-t={m.t.toFixed(3)}
                />
              ))}
              {Array.from({ length: ticks }, (_, i) => (
                <div key={i} className="absolute top-0 h-full border-l border-white/10" style={{ left: i * step * zoom }}>
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">{formatTimecode(i * step, project.settings.fps).replace(/:\d\d$/, "")}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Tracks */}
          {project.tracks.map((track) => (
            <div key={track.id} className="flex border-b" style={{ height: ROW_H[track.kind] }}>
              <TrackHeader track={track} onChange={(patch) => apply((p) => updateTrack(p, track.id, patch))} />
              <div
                className={cn("relative flex-1", track.kind === "video" ? "bg-white/[0.015]" : "bg-emerald-500/[0.02]", track.locked && "opacity-60")}
                data-track-id={track.id}
                data-track-kind={track.kind}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  select([])
                  setPlaying(false)
                  setPlayhead(frameRound(timeAt(e.clientX), fps))
                }}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes(MEDIA_DRAG_TYPE)) e.preventDefault()
                }}
                onDrop={(e) => onLaneDrop(e, track)}
              >
                {project.clips
                  .filter((c) => c.trackId === track.id)
                  .map((c) => (
                    <ClipBlock
                      key={c.id}
                      clip={c}
                      media={media.get(c.mediaId)}
                      zoom={zoom}
                      selected={selection.includes(c.id)}
                      blade={tool === "blade"}
                      onDown={onClipDown}
                      onKfDown={onKfDown}
                      onTransitionDrop={onTransitionDrop}
                    />
                  ))}
              </div>
            </div>
          ))}
          <div className="flex gap-1 p-2" style={{ paddingLeft: 8 }}>
            <Button size="xs" variant="ghost" onClick={() => apply((p) => addTrack(p, "video"))} data-testid="tl-add-video">
              <Plus />
              {t("editor.tl.addVideoTrack")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => apply((p) => addTrack(p, "audio"))} data-testid="tl-add-audio">
              <Plus />
              {t("editor.tl.addAudioTrack")}
            </Button>
          </div>

          {project.markers.map((m) => (
            <div key={m.id} className="pointer-events-none absolute top-7 bottom-0 z-[5] w-px opacity-50" style={{ left: HEADER_W + m.t * zoom, background: m.color }} />
          ))}
          {/* Playhead */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-10 w-px bg-red-500"
            style={{ left: HEADER_W + playhead * zoom }}
            data-testid="tl-playhead"
          >
            <div className="absolute -top-0 -left-[5px] size-[11px] rotate-45 bg-red-500" />
          </div>
        </div>
      </div>
    </div>
  )
}

/** Maps core error messages to localized text. */
export function editorError(t: (k: never) => string, message: string): string {
  const tr = t as (k: string) => string
  if (/audio tracks/.test(message)) return tr("editor.err.audioOnVideo")
  if (/no audio/.test(message)) return tr("editor.err.noAudio")
  if (/locked/.test(message)) return tr("editor.err.locked")
  if (/No suitable track/.test(message)) return tr("editor.err.noTrack")
  return message
}

function ToolBtn({
  label,
  onClick,
  disabled,
  pressed,
  testId,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  pressed?: boolean
  testId?: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-sm"
          variant={pressed ? "secondary" : "ghost"}
          aria-label={label}
          aria-pressed={pressed}
          onClick={onClick}
          disabled={disabled}
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function TrackHeader({ track, onChange }: { track: Track; onChange: (patch: Partial<Track>) => void }) {
  const { t } = useI18n()
  return (
    <div
      className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r bg-card px-2"
      style={{ width: HEADER_W }}
      data-testid={`track-${track.name}`}
    >
      <span className={cn("w-7 text-xs font-semibold", track.kind === "video" ? "text-sky-300" : "text-emerald-300")}>{track.name}</span>
      {track.kind === "video" && (
        <ToolBtn label={track.hidden ? t("editor.track.show") : t("editor.track.hide")} onClick={() => onChange({ hidden: !track.hidden })} pressed={track.hidden}>
          {track.hidden ? <EyeOff /> : <Eye />}
        </ToolBtn>
      )}
      <ToolBtn label={track.muted ? t("editor.track.unmute") : t("editor.track.mute")} onClick={() => onChange({ muted: !track.muted })} pressed={track.muted}>
        {track.muted ? <VolumeX /> : <Volume2 />}
      </ToolBtn>
      <ToolBtn label={track.locked ? t("editor.track.unlock") : t("editor.track.lock")} onClick={() => onChange({ locked: !track.locked })} pressed={track.locked}>
        {track.locked ? <Lock /> : <Unlock />}
      </ToolBtn>
    </div>
  )
}

function ClipBlock({
  clip,
  media,
  zoom,
  selected,
  blade,
  onDown,
  onKfDown,
  onTransitionDrop,
}: {
  clip: Clip
  media: EditorMedia | undefined
  zoom: number
  selected: boolean
  blade: boolean
  onDown: (e: React.PointerEvent, c: Clip, edge?: "start" | "end") => void
  onKfDown: (e: React.PointerEvent, c: Clip, s: number) => void
  onTransitionDrop: (e: React.DragEvent, c: Clip) => void
}) {
  const { t } = useI18n()
  // One diamond per distinct keyframe time (any property).
  const kfTimes = [...new Set(KF_PROPS.flatMap((k) => (clip.keyframes[k] ?? []).map((x) => x.s)))]
  const thumbs = useEditor((s) => (media ? s.thumbs[media.id] : undefined))
  const wave = useEditor((s) => (media ? s.waves[media.id] : undefined))
  const w = clipDuration(clip) * zoom
  const kind = media?.kind ?? "video"
  const thumb = thumbs?.[0]
  return (
    <div
      className={cn(
        "group absolute top-1 bottom-1 overflow-hidden rounded-md border text-[11px] select-none",
        blade ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing",
        kind === "audio" ? "border-emerald-400/40 bg-emerald-600/25" : kind === "image" ? "border-violet-400/40 bg-violet-600/25" : "border-sky-400/40 bg-sky-700/30",
        selected && "ring-2 ring-white",
        media && !media.available && "border-destructive bg-destructive/20"
      )}
      style={{ left: clip.start * zoom, width: Math.max(4, w) }}
      onPointerDown={(e) => onDown(e, clip)}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(TRANSITION_DRAG_TYPE)) e.preventDefault()
      }}
      onDrop={(e) => onTransitionDrop(e, clip)}
      data-testid="tl-clip"
      data-clip-id={clip.id}
      data-media-id={clip.mediaId}
      data-start={clip.start.toFixed(3)}
      data-duration={clipDuration(clip).toFixed(3)}
      data-selected={selected}
      title={media?.name}
    >
      {thumb && kind !== "audio" && (
        <div
          className="absolute inset-0 opacity-60"
          style={{ backgroundImage: `url("${fileSrc(thumb)}")`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" }}
        />
      )}
      {wave && wave.peaks.length > 0 && (kind === "audio" || w > 40) && (
        <Waveform peaks={wave.peaks} perSec={wave.perSec} clip={clip} width={w} audioOnly={kind === "audio"} />
      )}
      <span className="relative z-10 m-1 inline-block max-w-[calc(100%-8px)] truncate rounded bg-black/55 px-1 text-white">
        {media?.name ?? "?"}
        {clip.speed !== 1 && ` · ${clip.speed}×`}
      </span>
      {clip.volume !== 1 && (
        <span className="absolute right-1 bottom-0.5 z-10 rounded bg-black/55 px-1 text-[10px] text-white">{Math.round(clip.volume * 100)}%</span>
      )}
      {clip.transIn && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 z-10 bg-gradient-to-r from-white/45 to-transparent"
          style={{ width: Math.min(w, (clip.transIn.duration / 2) * zoom) }}
          title={t(`editor.tr.k.${clip.transIn.kind}`)}
          data-testid="tl-trans-in"
          data-kind={clip.transIn.kind}
        />
      )}
      {clip.transOut && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-10 bg-gradient-to-l from-white/45 to-transparent"
          style={{ width: Math.min(w, (clip.transOut.duration / 2) * zoom) }}
          title={t(`editor.tr.k.${clip.transOut.kind}`)}
          data-testid="tl-trans-out"
          data-kind={clip.transOut.kind}
        />
      )}
      {kfTimes.map((s) => (
        <button
          key={s}
          type="button"
          aria-label={t("editor.kf.title")}
          className="absolute bottom-0.5 z-30 -ml-[5px] size-[10px] rotate-45 border border-black/60 bg-amber-300 hover:bg-white"
          style={{ left: ((s - clip.in) / clip.speed) * zoom }}
          onPointerDown={(e) => onKfDown(e, clip, s)}
          data-testid="tl-kf"
        />
      ))}
      <div
        className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40"
        onPointerDown={(e) => onDown(e, clip, "start")}
        data-testid="tl-trim-start"
      />
      <div
        className="absolute inset-y-0 right-0 z-20 w-1.5 cursor-ew-resize bg-white/0 group-hover:bg-white/40"
        onPointerDown={(e) => onDown(e, clip, "end")}
        data-testid="tl-trim-end"
      />
    </div>
  )
}

function Waveform({ peaks, perSec, clip, width, audioOnly }: { peaks: number[]; perSec: number; clip: Clip; width: number; audioOnly: boolean }) {
  const from = Math.floor(clip.in * perSec)
  const to = Math.min(peaks.length, Math.ceil(clip.out * perSec))
  const slice = peaks.slice(from, to)
  if (!slice.length) return null
  const cols = Math.max(1, Math.min(slice.length, Math.floor(width / 2)))
  const per = slice.length / cols
  const bars: number[] = []
  for (let i = 0; i < cols; i++) {
    let m = 0
    for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j++) m = Math.max(m, slice[j] ?? 0)
    bars.push((m / 255) * Math.min(1, clip.volume))
  }
  return (
    <svg className={cn("absolute bottom-0 left-0 w-full", audioOnly ? "h-full" : "h-1/2")} viewBox={`0 0 ${cols} 100`} preserveAspectRatio="none" aria-hidden>
      {bars.map((b, i) => (
        <rect key={i} x={i} y={50 - b * 48} width={0.8} height={Math.max(1, b * 96)} className={audioOnly ? "fill-emerald-300/70" : "fill-white/40"} />
      ))}
    </svg>
  )
}
