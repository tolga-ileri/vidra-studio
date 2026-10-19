import { useEffect, useMemo, useRef, useState } from "react"
import { Maximize2, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react"
import {
  formatTimecode,
  gainAt,
  itemState,
  placement,
  renderPlan,
  sourceTime,
  type EditorMedia,
  type EditorProject,
  type PlanAudio,
  type PlanVideo,
} from "@vidra/core"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/i18n"
import { fileSrc } from "@/lib/backend"
import { cn } from "@/lib/utils"
import { useEditor } from "./store"

/** Seeking threshold: media drifting more than this from the clock is re-seeked. */
const DRIFT = 0.25

/**
 * Live preview from the same render plan the export uses: the stacked video
 * and image layers are placed with the same `placement` math, and audio
 * (including video clips' own audio) plays with the planned gain and fades.
 * The browser clamps volume at 100% (the export applies gains above it).
 */
export function Preview({ project, safeArea }: { project: EditorProject; safeArea: string }) {
  const { t } = useI18n()
  const playing = useEditor((s) => s.playing)
  const playhead = useEditor((s) => s.playhead)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setPlaying = useEditor((s) => s.setPlaying)
  const plan = useMemo(() => renderPlan(project), [project])
  const media = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media])
  const { width: W, height: H } = project.settings
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)
  const els = useRef(new Map<string, HTMLMediaElement>())

  // Fit the frame into the available area.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setScale(Math.max(0.05, Math.min((r.width - 16) / W, (r.height - 16) / H)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [W, H])

  // Playback clock.
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const t0 = useEditor.getState().playhead
    const started = performance.now()
    const tick = () => {
      const t = t0 + (performance.now() - started) / 1000
      if (t >= plan.duration) {
        setPlayhead(plan.duration)
        setPlaying(false)
        return
      }
      setPlayhead(t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, plan.duration, setPlayhead, setPlaying])

  // Sync every media element with the clock.
  const visible = plan.video.filter((v) => playhead >= v.start && playhead < v.end)
  const audible = plan.audio.filter((a) => playhead >= a.start && playhead < a.end)
  useEffect(() => {
    const active = new Set<string>()
    const sync = (key: string, item: { start: number; srcIn: number; srcOut: number; speed: number }, vol: number | null) => {
      const el = els.current.get(key)
      if (!el) return
      active.add(key)
      // Clamped: transition hold frames freeze the first/last frame.
      const want = Math.min(item.srcOut - 0.01, Math.max(item.srcIn, sourceTime(item, playhead)))
      if (Math.abs(el.currentTime - want) > (playing ? DRIFT : 0.04)) el.currentTime = want
      el.playbackRate = item.speed
      if (vol !== null) el.volume = Math.min(1, Math.max(0, vol))
      if (playing && el.paused) void el.play().catch(() => undefined)
      if (!playing && !el.paused) el.pause()
    }
    for (const v of visible) if (v.kind === "video") sync(`v:${v.id}`, v, null)
    for (const a of audible) sync(`a:${a.clipId}`, a, gainAt(a, playhead))
    for (const [key, el] of els.current) if (!active.has(key) && !el.paused) el.pause()
  })

  const register = (key: string) => (el: HTMLMediaElement | null) => {
    if (el) els.current.set(key, el)
    else els.current.delete(key)
  }

  const step = (frames: number) => {
    setPlaying(false)
    setPlayhead(Math.max(0, Math.min(plan.duration, playhead + frames / project.settings.fps)))
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="editor-preview">
      <div ref={stageRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/60">
        <div
          className="relative overflow-hidden shadow-2xl ring-1 ring-white/10"
          style={{ width: W * scale, height: H * scale, background: project.settings.background }}
          data-testid="preview-frame"
          data-width={W}
          data-height={H}
        >
          <div style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", inset: 0 }}>
            {plan.video.map((v, i) => (
              <Layer
                key={v.id}
                item={v}
                order={i}
                t={playhead}
                media={media.get(v.mediaId)}
                W={W}
                H={H}
                visible={visible.includes(v)}
                register={register}
              />
            ))}
          </div>
          {safeArea !== "none" && <SafeArea kind={safeArea} />}
        </div>
        {plan.audio.map((a) => (
          <AudioEl key={a.clipId} item={a} media={media.get(a.mediaId)} register={register} />
        ))}
        {plan.video.length === 0 && (
          <p className="pointer-events-none absolute text-xs text-muted-foreground">{t("editor.preview.empty")}</p>
        )}
      </div>
      <div className="flex items-center gap-1 border-t px-3 py-1.5">
        <IconBtn label={t("editor.preview.start")} onClick={() => (setPlaying(false), setPlayhead(0))}>
          <SkipBack />
        </IconBtn>
        <IconBtn label={t("editor.preview.prevFrame")} onClick={() => step(-1)}>
          <StepBack />
        </IconBtn>
        <Button
          size="icon-sm"
          onClick={() => {
            if (!playing && playhead >= plan.duration - 0.01) setPlayhead(0)
            setPlaying(!playing)
          }}
          aria-label={playing ? t("editor.preview.pause") : t("editor.preview.play")}
          data-testid="editor-play"
          disabled={plan.duration <= 0}
        >
          {playing ? <Pause /> : <Play />}
        </Button>
        <IconBtn label={t("editor.preview.nextFrame")} onClick={() => step(1)}>
          <StepForward />
        </IconBtn>
        <IconBtn label={t("editor.preview.end")} onClick={() => (setPlaying(false), setPlayhead(plan.duration))}>
          <SkipForward />
        </IconBtn>
        <span className="ml-2 font-mono text-xs tabular-nums" data-testid="editor-timecode">
          {formatTimecode(playhead, project.settings.fps)} <span className="text-muted-foreground">/ {formatTimecode(plan.duration, project.settings.fps)}</span>
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {W}×{H} · {project.settings.fps} fps
        </span>
        <IconBtn label={t("editor.preview.fullscreen")} onClick={() => void stageRef.current?.requestFullscreen?.().catch(() => undefined)}>
          <Maximize2 />
        </IconBtn>
      </div>
    </div>
  )
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={label} onClick={onClick}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function Layer({
  item,
  order,
  t,
  media,
  W,
  H,
  visible,
  register,
}: {
  item: PlanVideo
  order: number
  t: number
  media: EditorMedia | undefined
  W: number
  H: number
  visible: boolean
  register: (key: string) => (el: HTMLMediaElement | null) => void
}) {
  // Same per-frame math as the export (scale/position/rotation keyframes, fades, wipes).
  const st = itemState(item, t)
  const base: React.CSSProperties = {
    position: "absolute",
    zIndex: order + 1,
    display: visible ? "block" : "none",
    opacity: st.opacity,
    clipPath: st.revealFrom > 0 || st.revealTo < 1 ? `inset(0 ${(1 - st.revealTo) * 100}% 0 ${st.revealFrom * 100}%)` : undefined,
    filter: item.blur > 0 ? `blur(${item.blur * H}px)` : undefined,
  }
  if (item.kind === "color") return <div style={{ ...base, inset: 0, background: item.color }} data-clip={item.clipId} />
  if (!media) return null
  const c = item.crop
  const cw = 1 - c.l - c.r
  const ch = 1 - c.t - c.b
  const sw = (media.width ?? W) * cw
  const sh = (media.height ?? H) * ch
  const p = placement(item.fit === "fill" ? "fill" : "fit", sw, sh, W, H, st.scale, st.x, st.y)
  const bg = item.fit === "blur" ? placement("fill", sw, sh, W, H) : null
  const src = fileSrc(media.path)
  // A box of the placed size that shows only the crop region of the source.
  const box = (q: { w: number; h: number; left: number; top: number }, extra: React.CSSProperties = {}): React.CSSProperties => ({
    ...base,
    left: q.left,
    top: q.top,
    width: q.w,
    height: q.h,
    overflow: "hidden",
    transform: st.rotation ? `rotate(${st.rotation}deg)` : undefined,
    ...extra,
  })
  const inner = (q: { w: number; h: number }): React.CSSProperties => ({
    position: "absolute",
    width: q.w / cw,
    height: q.h / ch,
    left: (-c.l * q.w) / cw,
    top: (-c.t * q.h) / ch,
    objectFit: "fill",
    maxWidth: "none",
  })
  if (item.kind === "image")
    return (
      <>
        {bg && (
          <div style={box(bg, { filter: "blur(24px)", transform: undefined, zIndex: order + 0.5 })}>
            <img src={src} alt="" style={inner(bg)} />
          </div>
        )}
        <div style={box(p)}>
          <img src={src} alt="" style={inner(p)} data-clip={item.clipId} />
        </div>
      </>
    )
  return (
    <>
      {bg && (
        <div style={box(bg, { filter: "blur(24px)", transform: undefined })}>
          <BlurMirror src={src} item={item} style={inner(bg)} register={register} />
        </div>
      )}
      <div style={box(p)}>
        <video ref={register(`v:${item.id}`)} src={src} muted playsInline preload="auto" style={inner(p)} data-clip={item.clipId} />
      </div>
    </>
  )
}

/** Blurred background copy for "blur" fit (muted, follows the same clock). */
function BlurMirror({
  src,
  item,
  style,
  register,
}: {
  src: string
  item: PlanVideo
  style: React.CSSProperties
  register: (key: string) => (el: HTMLMediaElement | null) => void
}) {
  const ref = useRef<HTMLVideoElement | null>(null)
  const main = useRef<HTMLMediaElement | null>(null)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      main.current ??= document.querySelector<HTMLVideoElement>(`video[data-clip="${item.clipId}"]`)
      const el = ref.current
      if (el && main.current && Math.abs(el.currentTime - main.current.currentTime) > 0.2) el.currentTime = main.current.currentTime
      if (el && main.current) {
        if (main.current.paused && !el.paused) el.pause()
        if (!main.current.paused && el.paused) void el.play().catch(() => undefined)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [item.clipId])
  void register
  return <video ref={ref} src={src} muted playsInline preload="auto" style={style} />
}

function AudioEl({
  item,
  media,
  register,
}: {
  item: PlanAudio
  media: EditorMedia | undefined
  register: (key: string) => (el: HTMLMediaElement | null) => void
}) {
  if (!media) return null
  return <audio ref={register(`a:${item.clipId}`)} src={fileSrc(media.path)} preload="auto" data-audio-clip={item.clipId} />
}

/** Safe-area guides (UI zones of short-video apps and title-safe for TV). */
function SafeArea({ kind }: { kind: string }) {
  const zones: Record<string, { top: number; bottom: number; left: number; right: number }> = {
    reels: { top: 14, bottom: 20, left: 6, right: 6 },
    tiktok: { top: 9, bottom: 19, left: 6, right: 15 },
    shorts: { top: 12, bottom: 18, left: 6, right: 12 },
    title: { top: 10, bottom: 10, left: 10, right: 10 },
  }
  const z = zones[kind]
  if (!z) return null
  return (
    <div
      className={cn("pointer-events-none absolute border border-dashed border-amber-300/70")}
      style={{ top: `${z.top}%`, bottom: `${z.bottom}%`, left: `${z.left}%`, right: `${z.right}%` }}
      data-testid="safe-area"
    />
  )
}
