import { useEffect, useMemo, useRef, useState } from "react"
import { Maximize2, Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react"
import {
  applyFocus,
  cornerPinCss,
  cornersAt,
  defaultCorners,
  formatTimecode,
  gainAt,
  itemState,
  placement,
  planRegionAt,
  regionAt,
  renderPlan,
  setCornerKeyframe,
  setCorners,
  setRegionKeyframe,
  sourceTime,
  updateRegion,
  type Clip,
  type Corners,
  type EditorMedia,
  type EditorProject,
  type Mask,
  type PlanAudio,
  type PlanRegion,
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
 * and image layers are placed with the same `placement` / `itemState` math
 * (keyframes, transitions, corner pins, masks and region fixes), and audio
 * (including video clips' own audio) plays with the planned gain and fades.
 * Large sources play from 720p proxies; exports always read the originals.
 */
export function Preview({ project, safeArea }: { project: EditorProject; safeArea: string }) {
  const { t } = useI18n()
  const playing = useEditor((s) => s.playing)
  const playhead = useEditor((s) => s.playhead)
  const setPlayhead = useEditor((s) => s.setPlayhead)
  const setPlaying = useEditor((s) => s.setPlaying)
  const editMode = useEditor((s) => s.editMode)
  const selection = useEditor((s) => s.selection)
  const plan = useMemo(() => renderPlan(project), [project])
  const media = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media])
  const { width: W, height: H } = project.settings
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0.3)
  const els = useRef(new Map<string, HTMLMediaElement>())
  const selected = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined

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
          ref={frameRef}
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
            {editMode !== "none" && selected && <EditOverlay project={project} clip={selected} mode={editMode} scale={scale} frameRef={frameRef} />}
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

/** CSS for a shape mask of an element of size w×h (same shapes as the export's geq masks). */
function maskStyle(mask: Mask, w: number, h: number): React.CSSProperties {
  if (mask.shape === "ellipse") {
    if (mask.feather <= 0) return { clipPath: "ellipse(50% 50% at 50% 50%)" }
    const img = `radial-gradient(ellipse 50% 50% at 50% 50%, #000 ${Math.round((1 - mask.feather) * 100)}%, transparent 100%)`
    return { WebkitMaskImage: img, maskImage: img }
  }
  if (mask.shape === "roundRect") return { borderRadius: mask.radius * Math.min(w, h), overflow: "hidden" }
  return {}
}

/** Source size after the clip's crop (what the picture math sees). */
function sourceSize(media: EditorMedia | undefined, crop: PlanVideo["crop"], W: number, H: number) {
  const cw = 1 - crop.l - crop.r
  const ch = 1 - crop.t - crop.b
  return { sw: (media?.width ?? W) * cw, sh: (media?.height ?? H) * ch, cw, ch }
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
  const proxy = useEditor((s) => (media ? s.proxies[media.id] : undefined))
  const useProxies = useEditor((s) => s.useProxies)
  // Same per-frame math as the export (scale/position/rotation keyframes, fades, wipes, corner pins).
  const st = itemState(item, t)
  const z = order * 10
  const base: React.CSSProperties = {
    position: "absolute",
    zIndex: z + 1,
    display: visible ? "block" : "none",
    opacity: st.opacity,
    clipPath: st.revealFrom > 0 || st.revealTo < 1 ? `inset(0 ${(1 - st.revealTo) * 100}% 0 ${st.revealFrom * 100}%)` : undefined,
    filter: item.blur > 0 ? `blur(${item.blur * H}px)` : undefined,
  }
  const regions = item.regions.map((r, j) => <RegionBox key={r.id} r={r} t={t} W={W} H={H} z={z + 2 + j} visible={visible} />)
  if (item.kind === "color")
    return (
      <>
        <div style={{ ...base, inset: 0, background: item.color }} data-clip={item.clipId} />
        {regions}
      </>
    )
  if (!media) return null
  const c = item.crop
  const { sw, sh, cw, ch } = sourceSize(media, c, W, H)
  const src = fileSrc(useProxies && proxy?.path ? proxy.path : media.path)
  // The media element shows only the crop region of the source inside a box.
  const inner = (q: { w: number; h: number }): React.CSSProperties => ({
    position: "absolute",
    width: q.w / cw,
    height: q.h / ch,
    left: (-c.l * q.w) / cw,
    top: (-c.t * q.h) / ch,
    objectFit: "fill",
    maxWidth: "none",
  })
  const mediaEl = (q: { w: number; h: number }, main: boolean) =>
    item.kind === "image" ? (
      <img src={src} alt="" style={inner(q)} data-clip={main ? item.clipId : undefined} />
    ) : main ? (
      <video ref={register(`v:${item.id}`)} src={src} muted playsInline preload="auto" style={inner(q)} data-clip={item.clipId} />
    ) : (
      <BlurMirror src={src} item={item} style={inner(q)} />
    )

  if (st.corners) {
    // Corner pin: the picture is stretched to the frame, then mapped onto the quad (like FFmpeg's perspective).
    const quad = st.corners.map((v, i) => v * (i % 2 ? H : W))
    return (
      <>
        <div
          style={{ ...base, left: 0, top: 0, width: W, height: H, overflow: "hidden", transform: cornerPinCss(W, H, quad), transformOrigin: "0 0", ...maskStyle(item.mask, W, H) }}
          data-pinned={item.clipId}
        >
          {mediaEl({ w: W, h: H }, true)}
        </div>
        {regions}
      </>
    )
  }
  const p = placement(item.fit === "fill" ? "fill" : "fit", sw, sh, W, H, st.scale, st.x, st.y)
  const bg = item.fit === "blur" ? placement("fill", sw, sh, W, H) : null
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
  return (
    <>
      {bg && <div style={box(bg, { filter: "blur(24px)", transform: undefined, zIndex: z })}>{mediaEl(bg, false)}</div>}
      <div style={box(p, maskStyle(item.mask, p.w, p.h))}>{mediaEl(p, true)}</div>
      {regions}
    </>
  )
}

/** A blur / cover fix drawn over the frame at the region's (animated) position. */
function RegionBox({ r, t, W, H, z, visible }: { r: PlanRegion; t: number; W: number; H: number; z: number; visible: boolean }) {
  const { x, y } = planRegionAt(r, t)
  const w = r.w * W
  const h = r.h * H
  const style: React.CSSProperties = {
    position: "absolute",
    zIndex: z,
    display: visible ? "block" : "none",
    left: Math.min(Math.max(x * W, 0), W - w),
    top: Math.min(Math.max(y * H, 0), H - h),
    width: w,
    height: h,
    borderRadius: r.shape === "ellipse" ? "50%" : undefined,
    background: r.kind === "color" ? r.color : undefined,
    backdropFilter: r.kind === "blur" ? `blur(${r.blur * H}px)` : undefined,
    WebkitBackdropFilter: r.kind === "blur" ? `blur(${r.blur * H}px)` : undefined,
  }
  if (r.feather > 0 && r.shape === "ellipse") {
    const img = `radial-gradient(ellipse 50% 50% at 50% 50%, #000 ${Math.round((1 - r.feather) * 100)}%, transparent 100%)`
    style.WebkitMaskImage = img
    style.maskImage = img
  }
  return <div style={style} data-region={r.id} data-kind={r.kind} />
}

/** Blurred background copy for "blur" fit (muted, follows the same clock). */
function BlurMirror({ src, item, style }: { src: string; item: PlanVideo; style: React.CSSProperties }) {
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

/* ── Direct manipulation on the preview ───────────────────────────────── */

type Drag =
  | { kind: "corner"; i: number; before: EditorProject }
  | { kind: "region"; mode: "move" | "size"; x0: number; y0: number; rx: number; ry: number; rw: number; rh: number; before: EditorProject }

/**
 * Handles drawn over the frame (in frame pixels): the corner-pin quad, a
 * focus-point crosshair, or the active blur/cover region. Drags preview live
 * and commit one undo step on release; when the property has keyframes, the
 * drag writes a keyframe at the playhead instead of the static value.
 */
function EditOverlay({ project, clip, mode, scale, frameRef }: { project: EditorProject; clip: Clip; mode: "corners" | "focus" | "region"; scale: number; frameRef: React.RefObject<HTMLDivElement | null> }) {
  const { t } = useI18n()
  const playhead = useEditor((s) => s.playhead)
  const activeRegion = useEditor((s) => s.activeRegion)
  const { W, H } = { W: project.settings.width, H: project.settings.height }
  const media = project.media.find((m) => m.id === clip.mediaId)
  const { sw, sh } = sourceSize(media, clip.crop, W, H)
  const frame = { W, H, sw, sh }
  const drag = useRef<Drag | null>(null)
  const pt = (e: { clientX: number; clientY: number }) => {
    const r = frameRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const st = useEditor.getState()
      const p = pt(e)
      if (d.kind === "corner") {
        const cur = cornersAt(d.before.clips.find((c) => c.id === clip.id) ?? clip, playhead) ?? defaultCorners(clip, frame)
        const quad = [...cur] as Corners
        quad[d.i * 2] = Math.min(4, Math.max(-3, p.x / W))
        quad[d.i * 2 + 1] = Math.min(4, Math.max(-3, p.y / H))
        st.preview((q) => (clip.cornerKeyframes.length ? setCornerKeyframe(q, clip.id, playhead, quad) : setCorners(q, clip.id, quad)))
      } else if (activeRegion) {
        const dx = (p.x - d.x0) / W
        const dy = (p.y - d.y0) / H
        if (d.mode === "move") {
          const x = Math.min(1 - d.rw, Math.max(0, d.rx + dx))
          const y = Math.min(1 - d.rh, Math.max(0, d.ry + dy))
          const r = clip.regions.find((q) => q.id === activeRegion)
          st.preview((q) => (r?.keyframes.length ? setRegionKeyframe(q, clip.id, activeRegion, playhead, x, y) : updateRegion(q, clip.id, activeRegion, { x, y })))
        } else {
          const w = Math.min(2, Math.max(0.02, d.rw + dx))
          const h = Math.min(2, Math.max(0.02, d.rh + dy))
          st.preview((q) => updateRegion(q, clip.id, activeRegion, { w, h }))
        }
      }
    }
    const up = () => {
      const d = drag.current
      drag.current = null
      if (d) useEditor.getState().commitFrom(d.before)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    return () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
    }
  })

  const handle = (x: number, y: number, extra: React.CSSProperties = {}): React.CSSProperties => ({
    position: "absolute",
    left: x - 14 / scale,
    top: y - 14 / scale,
    width: 28 / scale,
    height: 28 / scale,
    borderRadius: "50%",
    background: "rgba(255,255,255,0.9)",
    border: `${2 / scale}px solid #0ea5e9`,
    cursor: "grab",
    boxSizing: "border-box",
    ...extra,
  })

  if (mode === "focus") {
    const onClick = (e: React.MouseEvent) => {
      const p = pt(e)
      const st = itemState(renderPlan(project).video.find((v) => v.clipId === clip.id)!, playhead)
      const q = placement("fill", sw, sh, W, H, st.scale, st.x, st.y)
      const cx = Math.min(1, Math.max(0, (p.x - q.left) / q.w))
      const cy = Math.min(1, Math.max(0, (p.y - q.top) / q.h))
      useEditor.getState().apply((pr) => applyFocus(pr, clip.id, cx, cy, frame))
      useEditor.getState().setEditMode("none")
    }
    return (
      <div className="absolute inset-0 cursor-crosshair" style={{ zIndex: 1000 }} onClick={onClick} data-testid="preview-focus-layer" title={t("editor.reframe.focusHint")}>
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div style={{ width: 60 / scale, height: 60 / scale, border: `${2 / scale}px dashed rgba(255,255,255,0.8)`, borderRadius: "50%" }} />
        </div>
      </div>
    )
  }

  if (mode === "corners") {
    const quad = cornersAt(clip, playhead) ?? defaultCorners(clip, frame)
    const px = quad.map((v, i) => v * (i % 2 ? H : W))
    const order = [0, 1, 3, 2]
    return (
      <div className="absolute inset-0" style={{ zIndex: 1000, pointerEvents: "none" }} data-testid="preview-corner-layer">
        <svg width={W} height={H} className="absolute inset-0" style={{ overflow: "visible" }}>
          <polygon points={order.map((i) => `${px[i * 2]},${px[i * 2 + 1]}`).join(" ")} fill="none" stroke="#0ea5e9" strokeWidth={2 / scale} strokeDasharray={`${6 / scale} ${4 / scale}`} />
        </svg>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            role="button"
            aria-label={t("editor.overlay.corner", { n: i + 1 })}
            style={handle(px[i * 2] ?? 0, px[i * 2 + 1] ?? 0, { pointerEvents: "auto" })}
            onPointerDown={(e) => {
              e.preventDefault()
              e.stopPropagation()
              useEditor.getState().setPlaying(false)
              drag.current = { kind: "corner", i, before: project }
            }}
            data-testid={`corner-handle-${i}`}
          />
        ))}
      </div>
    )
  }

  const r = clip.regions.find((q) => q.id === activeRegion)
  if (!r) return null
  const pos = regionAt(clip, r, playhead)
  const left = pos.x * W
  const top = pos.y * H
  return (
    <div className="absolute inset-0" style={{ zIndex: 1000, pointerEvents: "none" }} data-testid="preview-region-layer">
      <div
        style={{
          position: "absolute",
          left,
          top,
          width: r.w * W,
          height: r.h * H,
          border: `${2 / scale}px solid #f59e0b`,
          borderRadius: r.shape === "ellipse" ? "50%" : undefined,
          cursor: "move",
          pointerEvents: "auto",
          boxSizing: "border-box",
        }}
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const p = pt(e)
          drag.current = { kind: "region", mode: "move", x0: p.x, y0: p.y, rx: pos.x, ry: pos.y, rw: r.w, rh: r.h, before: project }
        }}
        data-testid="region-handle-body"
      />
      <div
        style={handle(left + r.w * W, top + r.h * H, { pointerEvents: "auto", cursor: "nwse-resize", borderRadius: 4 / scale, borderColor: "#f59e0b" })}
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const p = pt(e)
          drag.current = { kind: "region", mode: "size", x0: p.x, y0: p.y, rx: pos.x, ry: pos.y, rw: r.w, rh: r.h, before: project }
        }}
        data-testid="region-handle-size"
      />
    </div>
  )
}

/** Safe-area guides (UI zones of short-video apps and title-safe for TV). */
function SafeArea({ kind }: { kind: string }) {
  const zones: Record<string, { top: number; bottom: number; left: number; right: number }> = {
    reels: { top: 14, bottom: 20, left: 6, right: 6 },
    tiktok: { top: 9, bottom: 19, left: 6, right: 15 },
    shorts: { top: 12, bottom: 18, left: 6, right: 12 },
    youtube: { top: 8, bottom: 12, left: 5, right: 5 },
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
