import { useEffect, useState } from "react"
import { AlertTriangle, Film, ImageIcon, Link2, Music, Plus, Upload } from "lucide-react"
import { toast } from "sonner"
import {
  ASPECTS,
  clipDuration,
  formatTimecode,
  placeMedia,
  setFormat,
  updateClip,
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
import { editorError, MEDIA_DRAG_TYPE } from "./timeline"

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
