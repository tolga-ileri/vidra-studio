import { useEffect, useState } from "react"
import { Download, Pause, Play, RotateCcw } from "lucide-react"
import type { DownloadTask } from "@vidra/core"

import { EmptyState, LoadingRows, PageHeader } from "@/components/app/common"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useLive } from "@/hooks/use-live"
import { useI18n, type MessageKey } from "@/i18n"
import { api } from "@/lib/backend"
import { attempt } from "@/lib/errors"
import { subscribeStore } from "@/lib/events"
import { cn } from "@/lib/utils"

const ERROR_KEYS: Record<string, MessageKey> = {
  expired: "downloads.err.expired",
  network: "downloads.err.network",
  disk_full: "downloads.err.disk_full",
  integrity: "downloads.err.integrity",
  blocked_url: "downloads.err.blocked_url",
  too_large: "downloads.err.too_large",
}

export function DownloadsScreen() {
  const { t, fmt, model: mn } = useI18n()
  const list = useLive(() => api.listDownloads(), "downloads", ["archive-changed"])
  const [progress, setProgress] = useState<Record<string, { done: number; total: number | null }>>({})

  useEffect(
    () =>
      subscribeStore((e) => {
        if (e.type === "download-progress")
          setProgress((p) => ({ ...p, [e.assetId]: { done: e.bytesDownloaded, total: e.totalBytes } }))
      }),
    []
  )

  const rows = list.data ?? []
  const active = rows.filter((r) => r.task.status !== "completed")
  const done = rows.filter((r) => r.task.status === "completed")

  const row = ({ task, asset, job }: (typeof rows)[number]) => {
    const live = progress[asset.id]
    const bytes = Math.max(live?.done ?? 0, task.bytesDownloaded)
    const total = live?.total ?? task.totalBytes
    const pct = total ? Math.min(100, (bytes / total) * 100) : 0
    return (
      <li key={task.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3" data-download-status={task.status}>
        <div className="min-w-0 space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="truncate text-sm font-medium">{asset.filename}</span>
            <span className={cn("text-xs whitespace-nowrap", task.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
              {t(`download.${task.status}`)}
            </span>
          </div>
          <Progress value={task.status === "completed" ? 100 : pct} className="h-1" aria-label={asset.filename} />
          <div className="flex justify-between gap-3 text-[11px] text-muted-foreground">
            <span className="truncate">{mn(job.modelName)}</span>
            <span className="tabular-nums">
              {fmt.bytes(bytes)} / {fmt.bytes(total)}
              {task.retryCount > 0 && ` · ${t("downloads.attempts", { count: task.retryCount })}`}
            </span>
          </div>
          {task.status === "failed" && <DownloadError task={task} />}
        </div>
        <div className="flex gap-1">
          {(task.status === "downloading" || task.status === "pending") && (
            <Button variant="ghost" size="icon-sm" aria-label={t("downloads.pause")} onClick={() => void attempt(() => api.pauseDownload(asset.id))}>
              <Pause />
            </Button>
          )}
          {task.status === "paused" && (
            <Button variant="ghost" size="icon-sm" aria-label={t("downloads.resume")} onClick={() => void attempt(() => api.resumeDownload(asset.id))}>
              <Play />
            </Button>
          )}
          {task.status === "failed" && task.lastErrorCode !== "expired" && (
            <Button variant="outline" size="sm" onClick={() => void attempt(() => api.retryDownload(asset.id), t("downloads.retrying"))}>
              <RotateCcw />
              {t("downloads.retry")}
            </Button>
          )}
        </div>
      </li>
    )
  }

  return (
    <>
      <PageHeader title={t("nav.downloads")} description={t("downloads.subtitle")} />
      {list.loading && !list.data ? (
        <LoadingRows />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Download />} title={t("downloads.empty")} description={t("downloads.emptyBody")} />
      ) : (
        <div className="space-y-6">
          <section>
            <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t("downloads.queue")} · {active.length}
            </h2>
            {active.length === 0 ? (
              <p className="rounded-xl border px-4 py-6 text-center text-sm text-muted-foreground">{t("downloads.queueEmpty")}</p>
            ) : (
              <ul className="divide-y rounded-xl border bg-card" data-testid="download-queue">
                {active.map(row)}
              </ul>
            )}
          </section>
          {done.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t("downloads.completed")} · {done.length}
              </h2>
              <ul className="divide-y rounded-xl border bg-card">{done.slice(0, 50).map(row)}</ul>
            </section>
          )}
        </div>
      )}
    </>
  )
}

function DownloadError({ task }: { task: DownloadTask }) {
  const { t } = useI18n()
  const code = task.lastErrorCode ?? ""
  const key = ERROR_KEYS[code] ?? (code.startsWith("http_") ? "downloads.err.http" : null)
  return (
    <p className="text-xs text-destructive" role="status">
      {key ? t(key, { status: code.replace("http_", "") }) : (task.lastError ?? t("error.unknown"))}
    </p>
  )
}
