import { exportSize, type Aspect, type EditorProject, type ExportPreset } from "./editor"

/** Platform export targets. Bitrates follow the platforms' published recommendations (VBR, H.264). */
export const PLATFORMS = ["reels", "stories", "tiktok", "shorts", "youtube", "youtube4k", "feed", "custom"] as const
export type Platform = (typeof PLATFORMS)[number]

export interface PlatformSpec {
  aspect: Aspect | null
  preset: ExportPreset
  fps: number
  kbps: number
  /** Platform limit in seconds (informational). */
  maxSec: number | null
}

export const PLATFORM_SPECS: Record<Platform, PlatformSpec> = {
  reels: { aspect: "9:16", preset: "1080p", fps: 30, kbps: 12000, maxSec: 90 },
  stories: { aspect: "9:16", preset: "1080p", fps: 30, kbps: 10000, maxSec: 60 },
  tiktok: { aspect: "9:16", preset: "1080p", fps: 30, kbps: 12000, maxSec: 600 },
  shorts: { aspect: "9:16", preset: "1080p", fps: 30, kbps: 12000, maxSec: 60 },
  youtube: { aspect: "16:9", preset: "1080p", fps: 30, kbps: 16000, maxSec: null },
  youtube4k: { aspect: "16:9", preset: "2160p", fps: 30, kbps: 45000, maxSec: null },
  feed: { aspect: "4:5", preset: "1080p", fps: 30, kbps: 10000, maxSec: 60 },
  custom: { aspect: null, preset: "1080p", fps: 30, kbps: 12000, maxSec: null },
}

export const EXPORT_FPS = [24, 25, 30, 60] as const

/** Bitrate from the pixel rate (bits per pixel ≈ 0.12 high / 0.07 standard; 1080p30 ≈ 7.5 Mbps, 4K30 ≈ 30 Mbps), kept in a sane range. */
export function recommendedKbps(size: { width: number; height: number }, fps: number, quality: "standard" | "high"): number {
  const bpp = quality === "high" ? 0.12 : 0.07
  const kbps = (size.width * size.height * fps * bpp) / 1000
  return Math.round(Math.min(80000, Math.max(1500, kbps)) / 100) * 100
}

/** Estimated file size in bytes for the given bitrates and duration. */
export function estimateBytes(videoKbps: number, audioKbps: number, durationSec: number): number {
  return Math.round(((videoKbps + audioKbps) * 1000 * durationSec) / 8)
}

/**
 * Whether the export is larger than every video/image source on the timeline.
 * Upscaling adds pixels, not detail; the UI says so.
 */
export function upscaleInfo(p: EditorProject, size: { width: number; height: number }): { upscaled: boolean; maxShort: number; exportShort: number } {
  let maxShort = 0
  const used = new Set(p.clips.map((c) => c.mediaId))
  for (const m of p.media) {
    if (!used.has(m.id) || m.kind === "audio" || !m.width || !m.height) continue
    maxShort = Math.max(maxShort, Math.min(m.width, m.height))
  }
  const exportShort = Math.min(size.width, size.height)
  return { upscaled: maxShort > 0 && exportShort > maxShort * 1.05, maxShort, exportShort }
}

/** Export size for a platform on this project (the project's own aspect is kept; custom keeps it too). */
export function platformSize(p: EditorProject, platform: Platform, preset?: ExportPreset) {
  return exportSize(p.settings, preset ?? PLATFORM_SPECS[platform].preset)
}

/** True when the project's aspect differs from the platform's. */
export function aspectMismatch(p: EditorProject, platform: Platform): Aspect | null {
  const want = PLATFORM_SPECS[platform].aspect
  return want && want !== p.settings.aspect ? want : null
}
