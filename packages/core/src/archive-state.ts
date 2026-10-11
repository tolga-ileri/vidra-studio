import type { ArchiveState, DownloadTask, GenerationJob, MediaAsset, ArchiveItem } from "./types"

/**
 * Derives the single user-visible archive state from the separately tracked
 * generation and download lifecycles. "saved" is only ever returned when the
 * asset has a persisted local file (downloadStatus === "saved" and a path).
 */
export function deriveArchiveState(
  job: GenerationJob,
  asset: MediaAsset | null,
  item: ArchiveItem | null,
  task: DownloadTask | null
): ArchiveState {
  if (item?.deletedAt != null) return "trashed"
  switch (job.status) {
    case "submitting":
    case "queued":
      return "generation_queued"
    case "generating":
      return "generating"
    case "failed":
    case "canceled":
    case "blocked":
      return "generation_failed"
    case "completed":
      break
  }
  if (!asset) return "download_pending"
  switch (asset.downloadStatus) {
    case "saved":
      return asset.localPath ? "saved" : "missing"
    case "missing":
      return "missing"
    case "failed":
      return "download_failed"
    case "downloading":
      return "downloading"
    case "paused":
    case "pending":
      return task?.status === "downloading" ? "downloading" : "download_pending"
  }
}
