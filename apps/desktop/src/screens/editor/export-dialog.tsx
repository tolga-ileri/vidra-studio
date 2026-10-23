import { useEffect, useMemo, useState } from "react"
import { AlertTriangle, CheckCircle2, FolderOpen, Loader2, X } from "lucide-react"
import {
  aspectMismatch,
  estimateBytes,
  EXPORT_FPS,
  EXPORT_PRESETS,
  exportSize,
  PLATFORM_SPECS,
  PLATFORMS,
  recommendedKbps,
  renderPlan,
  setFormat,
  upscaleInfo,
  type EditorProject,
  type ExportPreset,
  type Platform,
} from "@vidra/core"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useI18n } from "@/i18n"
import { api } from "@/lib/backend"
import { describeError } from "@/lib/errors"
import { subscribeStore } from "@/lib/events"
import type { EditorToolStatus } from "@/lib/ipc"
import { useEditor } from "./store"

type Job = { id: string; status: string; progress: number; message: string | null; output: string | null }

/** The platform whose aspect matches the project (so the dialog opens on a sensible target). */
function defaultPlatform(p: EditorProject): Platform {
  switch (p.settings.aspect) {
    case "9:16":
      return "reels"
    case "16:9":
      return "youtube"
    case "4:5":
      return "feed"
    default:
      return "custom"
  }
}

export function ExportDialog({ project, open, onOpenChange, tools }: { project: EditorProject; open: boolean; onOpenChange: (v: boolean) => void; tools: EditorToolStatus | null }) {
  const { t, fmt } = useI18n()
  const [platform, setPlatform] = useState<Platform>(() => defaultPlatform(project))
  const [preset, setPreset] = useState<ExportPreset>("1080p")
  const [fps, setFps] = useState<number>(project.settings.fps)
  const [quality, setQuality] = useState<"standard" | "high">("high")
  const [bitrate, setBitrate] = useState<"auto" | "custom">("auto")
  const [customMbps, setCustomMbps] = useState("12")
  const [encoder, setEncoder] = useState<"auto" | "software" | "hardware">("auto")
  const [name, setName] = useState(project.name)
  const [job, setJob] = useState<Job | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const size = exportSize(project.settings, preset)
  const plan = useMemo(() => renderPlan({ ...project, settings: { ...project.settings, fps } }, size), [project, fps, size.width, size.height]) // eslint-disable-line react-hooks/exhaustive-deps
  const autoKbps = recommendedKbps(size, fps, quality)
  const custom = Number(customMbps.replace(",", "."))
  const kbps = bitrate === "custom" && Number.isFinite(custom) ? Math.round(Math.min(80, Math.max(1, custom)) * 1000) : autoKbps
  const hw = (tools?.h264Encoders ?? []).filter((e) => e !== "libx264")
  const running = job && ["queued", "rendering", "validating"].includes(job.status)
  const up = upscaleInfo(project, size)
  const mismatch = aspectMismatch(project, platform)
  const spec = PLATFORM_SPECS[platform]
  const estimate = estimateBytes(kbps, 192, plan.duration)

  useEffect(() => setName(project.name), [project.name])
  // Reopening after a finished export starts fresh (the edit may have changed since).
  useEffect(() => {
    if (open) setJob((j) => (j && ["queued", "rendering", "validating"].includes(j.status) ? j : null))
  }, [open])
  useEffect(
    () =>
      subscribeStore((e) => {
        if (e.type !== "editor-export") return
        setJob((j) => (j && j.id === e.exportId ? { ...j, status: e.status, progress: e.progress, message: e.message, output: e.outputPath } : j))
      }),
    []
  )

  const pickPlatform = (v: Platform) => {
    setPlatform(v)
    const s = PLATFORM_SPECS[v]
    setPreset(s.preset)
    setFps(v === "custom" ? project.settings.fps : s.fps)
  }

  const start = async () => {
    setError(null)
    setStarting(true)
    try {
      const id = await api.editorStartExport(project.id, plan, { encoder, videoKbps: kbps, audioKbps: 192 }, name)
      if (id) setJob({ id, status: "queued", progress: 0, message: null, output: null })
    } catch (e) {
      const d = describeError(e)
      setError(d.description || d.title)
    } finally {
      setStarting(false)
    }
  }

  const missing = project.media.filter((m) => !m.available && project.clips.some((c) => c.mediaId === m.id))

  return (
    <Dialog open={open} onOpenChange={(v) => !running && onOpenChange(v)}>
      <DialogContent className="sm:max-w-lg" data-testid="export-dialog">
        <DialogHeader>
          <DialogTitle>{t("editor.export.title")}</DialogTitle>
          <DialogDescription>{t("editor.export.body")}</DialogDescription>
        </DialogHeader>
        {!job || job.status === "failed" || job.status === "canceled" ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("editor.export.platform")}</Label>
                <Select value={platform} onValueChange={(v) => pickPlatform(v as Platform)}>
                  <SelectTrigger size="sm" className="w-full" data-testid="export-platform">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PLATFORMS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {t(`editor.export.platform.${p}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("editor.export.resolution")}</Label>
                <Select value={preset} onValueChange={(v) => setPreset(v as ExportPreset)}>
                  <SelectTrigger size="sm" className="w-full" data-testid="export-preset">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPORT_PRESETS.map((p) => {
                      const s = exportSize(project.settings, p)
                      return (
                        <SelectItem key={p} value={p}>
                          {p === "2160p" ? "4K" : p} · {s.width}×{s.height}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("editor.export.fps")}</Label>
                <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))}>
                  <SelectTrigger size="sm" className="w-full" data-testid="export-fps">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[...new Set([...EXPORT_FPS, project.settings.fps])]
                      .sort((a, b) => a - b)
                      .map((f) => (
                        <SelectItem key={f} value={String(f)}>
                          {f} fps
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("editor.export.quality")}</Label>
                <Select value={quality} onValueChange={(v) => setQuality(v as "standard" | "high")}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="high">{t("editor.export.qualityHigh")}</SelectItem>
                    <SelectItem value="standard">{t("editor.export.qualityStandard")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("editor.export.bitrate")}</Label>
                <div className="flex gap-1.5">
                  <Select value={bitrate} onValueChange={(v) => setBitrate(v as "auto" | "custom")}>
                    <SelectTrigger size="sm" className="w-full" data-testid="export-bitrate">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">{t("editor.export.bitrateAuto", { mbps: (autoKbps / 1000).toFixed(1) })}</SelectItem>
                      <SelectItem value="custom">{t("editor.export.bitrateCustom")}</SelectItem>
                    </SelectContent>
                  </Select>
                  {bitrate === "custom" && (
                    <Input
                      className="h-8 w-20 text-xs tabular-nums"
                      inputMode="decimal"
                      value={customMbps}
                      onChange={(e) => setCustomMbps(e.target.value)}
                      aria-label={t("editor.export.bitrateCustom")}
                      data-testid="export-bitrate-custom"
                    />
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">{t("editor.export.encoder")}</Label>
                <Select value={encoder} onValueChange={(v) => setEncoder(v as typeof encoder)}>
                  <SelectTrigger size="sm" className="w-full" data-testid="export-encoder">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t("editor.export.encAuto")}</SelectItem>
                    <SelectItem value="software" disabled={!tools?.h264Encoders.includes("libx264")}>
                      {t("editor.export.encSoftware")}
                    </SelectItem>
                    <SelectItem value="hardware" disabled={!hw.length}>
                      {t("editor.export.encHardware")}
                      {hw.length ? ` (${hw[0]})` : ""}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="exp-name" className="text-xs text-muted-foreground">
                  {t("editor.export.fileName")}
                </Label>
                <Input id="exp-name" className="h-8 text-xs" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground" data-testid="export-summary">
              {t("editor.export.summary", {
                size: `${size.width}×${size.height}`,
                fps,
                duration: fmt.duration(plan.duration),
                mbps: (kbps / 1000).toFixed(1),
              })}{" "}
              <span data-testid="export-estimate">{t("editor.export.estimate", { size: fmt.bytes(estimate) })}</span>
            </p>
            {up.upscaled && (
              <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warning" data-testid="export-upscale">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {t("editor.export.upscale", { src: up.maxShort, out: up.exportShort })}
              </p>
            )}
            {mismatch && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-warning" data-testid="export-mismatch">
                <AlertTriangle className="size-3.5 shrink-0" />
                <span>{t("editor.export.mismatch", { aspect: mismatch, current: project.settings.aspect })}</span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => useEditor.getState().apply((p) => setFormat(p, mismatch, { width: p.settings.width, height: p.settings.height }))}
                  data-testid="export-convert"
                >
                  {t("editor.export.convertNow", { aspect: mismatch })}
                </Button>
              </div>
            )}
            {spec.maxSec !== null && plan.duration > spec.maxSec && (
              <p className="text-[11px] text-warning">{t("editor.export.maxSec", { sec: spec.maxSec, dur: fmt.duration(plan.duration) })}</p>
            )}
            {missing.length > 0 && <p className="text-xs text-destructive">{t("editor.export.missing", { count: missing.length })}</p>}
            {(error || job?.status === "failed") && (
              <p className="text-xs text-destructive" role="alert" data-testid="export-error">
                {error ?? job?.message}
              </p>
            )}
            {job?.status === "canceled" && <p className="text-xs text-muted-foreground">{t("editor.export.canceled")}</p>}
          </div>
        ) : job.status === "completed" ? (
          <div className="flex items-start gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm" data-testid="export-done">
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-400" />
            <div className="min-w-0">
              <p className="font-medium">{t("editor.export.done")}</p>
              <p className="truncate text-xs text-muted-foreground" title={job.output ?? ""}>
                {job.output}
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2" data-testid="export-progress" data-status={job.status}>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3.5 animate-spin" />
                {t(`editor.export.status.${job.status as "queued" | "rendering" | "validating"}`)}
              </span>
              <span className="tabular-nums">{Math.round(job.progress * 100)}%</span>
            </div>
            <Progress value={job.progress * 100} aria-label={t("editor.export.title")} />
          </div>
        )}
        <DialogFooter>
          {running ? (
            <Button variant="outline" onClick={() => job && void api.editorCancelExport(job.id).catch(() => undefined)} data-testid="export-cancel">
              <X />
              {t("common.cancel")}
            </Button>
          ) : job?.status === "completed" ? (
            <>
              <Button variant="outline" onClick={() => void api.editorRevealExport(job.id).catch(() => undefined)}>
                <FolderOpen />
                {t("editor.export.reveal")}
              </Button>
              <Button onClick={() => (setJob(null), onOpenChange(false))}>{t("common.close")}</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => void start()} disabled={starting || plan.duration <= 0 || missing.length > 0 || !tools?.available} data-testid="export-start">
                {starting && <Loader2 className="animate-spin" />}
                {t("editor.export.start")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
