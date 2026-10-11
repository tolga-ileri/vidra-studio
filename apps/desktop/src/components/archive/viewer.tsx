import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import type { MediaAsset } from "@vidra/core"

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/i18n"
import { api, fileSrc } from "@/lib/backend"

/** Fullscreen player (video) or lightbox (image) for a local archive file. */
export function MediaViewer({ asset, title, onClose }: { asset: MediaAsset | null; title: string; onClose: () => void }) {
  const { t } = useI18n()
  const [src, setSrc] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    setSrc(null)
    setError(false)
    if (!asset) return
    let live = true
    api
      .mediaPath(asset.id)
      .then((p) => {
        if (!live) return
        if (p) setSrc(fileSrc(p))
        else setError(true)
      })
      .catch(() => live && setError(true))
    return () => {
      live = false
    }
  }, [asset])

  const isImage = asset?.kind === "image" || src?.startsWith("data:image")
  return (
    <Dialog open={!!asset} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] w-[min(92vw,1400px)] max-w-none border-white/10 bg-black p-0 sm:max-w-none">
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{t("archive.viewer")}</DialogDescription>
        <div className="flex max-h-[92vh] min-h-[40vh] items-center justify-center">
          {error ? (
            <p className="p-8 text-sm text-muted-foreground">{t("archive.fileUnavailable")}</p>
          ) : !src ? (
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          ) : isImage ? (
            <img src={src} alt={title} className="max-h-[92vh] max-w-full object-contain" onError={() => setError(true)} />
          ) : (
            <video src={src} controls autoPlay className="max-h-[92vh] max-w-full" onError={() => setError(true)}>
              <track kind="captions" />
            </video>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
