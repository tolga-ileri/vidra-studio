import { useEffect, useRef, useState, type RefObject } from "react"
import { AlertTriangle, Clapperboard, ImageIcon, Loader2 } from "lucide-react"
import type { ArchiveEntry, MediaAsset } from "@vidra/core"

import { api, fileSrc } from "@/lib/backend"
import { cn } from "@/lib/utils"

const capturing = new Set<string>()

/**
 * Captures a poster frame for a saved local video: seek to ~10%, draw to a
 * canvas and hand the JPEG to the backend, which validates and stores it.
 */
export async function captureVideoThumbnail(asset: MediaAsset): Promise<boolean> {
  if (capturing.has(asset.id) || typeof document === "undefined") return false
  capturing.add(asset.id)
  try {
    const path = await api.mediaPath(asset.id)
    if (!path) return false
    const video = document.createElement("video")
    video.muted = true
    video.preload = "metadata"
    video.crossOrigin = "anonymous"
    video.src = fileSrc(path)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 15000)
      video.onloadedmetadata = () => {
        video.currentTime = Number.isFinite(video.duration) ? video.duration * 0.1 : 0
      }
      video.onseeked = () => {
        clearTimeout(timer)
        resolve()
      }
      video.onerror = () => {
        clearTimeout(timer)
        reject(new Error("video error"))
      }
    })
    const scale = Math.min(1, 640 / (video.videoWidth || 640))
    const canvas = document.createElement("canvas")
    canvas.width = Math.round((video.videoWidth || 640) * scale)
    canvas.height = Math.round((video.videoHeight || 360) * scale)
    const ctx = canvas.getContext("2d")
    if (!ctx) return false
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const base64 = canvas.toDataURL("image/jpeg", 0.82).split(",")[1] ?? ""
    if (!base64) return false
    await api.saveThumbnail(asset.id, base64, {
      durationSec: Number.isFinite(video.duration) ? video.duration : null,
      width: video.videoWidth || null,
      height: video.videoHeight || null,
    })
    video.removeAttribute("src")
    video.load()
    return true
  } catch {
    return false
  } finally {
    capturing.delete(asset.id)
  }
}

function useVisible<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined")
  useEffect(() => {
    if (visible || !ref.current) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setVisible(true)
      },
      { rootMargin: "200px" }
    )
    io.observe(ref.current)
    return () => io.disconnect()
  }, [visible])
  return [ref, visible]
}

export function Thumb({ entry, className }: { entry: ArchiveEntry; className?: string }) {
  const asset = entry.asset
  const [ref, visible] = useVisible<HTMLDivElement>()
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!visible || !asset) return
    let live = true
    api
      .thumbnailPath(asset.id)
      .then((path) => {
        if (!live) return
        if (path) setSrc(fileSrc(path))
        else if (asset.kind === "video" && entry.state === "saved") void captureVideoThumbnail(asset)
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [visible, asset, asset?.id, asset?.thumbnailPath, entry.state])

  const Icon = entry.job.output === "video" ? Clapperboard : ImageIcon
  const busy = entry.state === "generating" || entry.state === "generation_queued" || entry.state === "downloading"
  return (
    <div ref={ref} className={cn("relative flex items-center justify-center overflow-hidden bg-black/50", className)}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" draggable={false} className="size-full object-cover" onError={() => setFailed(true)} />
      ) : (
        <div className="flex flex-col items-center gap-1.5 text-muted-foreground">
          {busy ? (
            <Loader2 className="size-5 animate-spin" />
          ) : entry.state === "generation_failed" || entry.state === "download_failed" || entry.state === "missing" ? (
            <AlertTriangle className="size-5" />
          ) : (
            <Icon className="size-5" />
          )}
        </div>
      )}
    </div>
  )
}
