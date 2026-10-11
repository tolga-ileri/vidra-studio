import type { ProviderId, Workflow } from "./registry"
import type { ParamValues } from "./params"

/**
 * Vidra Studio persisted entities. The Rust backend serializes exactly these
 * shapes (serde camelCase). Timestamps are epoch milliseconds (UTC). Money is
 * USD; `null` means unknown — never treat it as zero.
 */

export type Id = string

/* ── Providers ──────────────────────────────────────────────────────────── */

export interface ProviderCapabilities {
  validateCredentials: boolean
  /** Official discovery API exists (models synchronized at runtime). */
  modelDiscovery: boolean
  estimateCost: boolean
  uploadReferences: boolean
  cancel: boolean
  /** Submit can be made idempotent (provider-side key or client token). */
  idempotentSubmit: boolean
}

export type CredentialField = { key: string; label: string; secret: boolean }

export interface ProviderStatus {
  id: ProviderId
  displayName: string
  enabled: boolean
  /** Credentials exist in the OS credential store (values never exposed). */
  configured: boolean
  /** Result of the last verification. */
  verification: "unknown" | "ok" | "failed"
  lastVerifiedAt: number | null
  lastError: string | null
  capabilities: ProviderCapabilities
  credentialFields: CredentialField[]
  docsUrl: string
  /** "integrated" = implemented and tested against a documented API;
      "planned" = listed but not implemented. */
  integration: "integrated" | "planned"
}

/* ── Generation ─────────────────────────────────────────────────────────── */

export type JobStatus =
  | "submitting"
  | "queued"
  | "generating"
  | "completed"
  | "failed"
  | "canceled"
  | "blocked"

export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
  "completed",
  "failed",
  "canceled",
  "blocked",
]

export interface GenerationJob {
  id: Id
  provider: ProviderId
  modelId: string
  modelName: string
  workflow: Workflow
  output: "video" | "image"
  providerRequestId: string | null
  status: JobStatus
  prompt: string
  negativePrompt: string | null
  params: ParamValues
  requestedDurationSec: number | null
  /** Provider estimate captured before submit (USD). */
  estimatedCostUsd: number | null
  /** Where the estimate came from. */
  estimateSource: "provider" | "published_rate" | null
  /** Only when the provider explicitly reports a billed amount. */
  confirmedCostUsd: number | null
  errorCode: string | null
  errorMessage: string | null
  promptId: Id | null
  projectId: Id | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

/* ── Archive ────────────────────────────────────────────────────────────── */

export type DownloadStatus = "pending" | "downloading" | "paused" | "saved" | "failed" | "missing"

export interface MediaAsset {
  id: Id
  jobId: Id
  /** Index of this output within its job (multi-output image runs). */
  outputIndex: number
  kind: "video" | "image"
  originalUrl: string
  /** Relative to the archive root; null until persisted. */
  localPath: string | null
  filename: string
  mimeType: string | null
  sizeBytes: number | null
  sha256: string | null
  durationSec: number | null
  width: number | null
  height: number | null
  thumbnailPath: string | null
  downloadStatus: DownloadStatus
  duplicateOfAssetId: Id | null
  createdAt: number
}

export interface Project {
  id: Id
  name: string
  createdAt: number
}

export interface ArchiveItem {
  id: Id
  assetId: Id
  projectId: Id | null
  customTitle: string | null
  favorite: boolean
  tags: string[]
  deletedAt: number | null
}

export type DownloadTaskStatus = "pending" | "downloading" | "paused" | "completed" | "failed"

export interface DownloadTask {
  id: Id
  assetId: Id
  status: DownloadTaskStatus
  bytesDownloaded: number
  totalBytes: number | null
  retryCount: number
  nextAttemptAt: number | null
  lastError: string | null
  /** expired | network | disk_full | integrity | blocked_url | too_large | http_<n> */
  lastErrorCode: string | null
  updatedAt: number
}

export type ArchiveState =
  | "generation_queued"
  | "generating"
  | "generation_failed"
  | "download_pending"
  | "downloading"
  | "saved"
  | "download_failed"
  | "missing"
  | "trashed"

export interface ArchiveEntry {
  job: GenerationJob
  asset: MediaAsset | null
  item: ArchiveItem | null
  task: DownloadTask | null
  state: ArchiveState
}

export interface ArchiveQuery {
  search?: string
  provider?: ProviderId
  modelId?: string
  output?: "video" | "image"
  from?: number
  to?: number
  favorite?: boolean
  projectId?: Id | null
  trashed?: boolean
  states?: ArchiveState[]
  sort?: "date" | "size" | "duration"
  direction?: "asc" | "desc"
}

export interface StorageStats {
  usedBytes: number
  savedCount: number
  trashedCount: number
  missingCount: number
  freeBytes: number | null
  archiveRoot: string
}

/* ── Prompt Library ─────────────────────────────────────────────────────── */

export interface PromptCategory {
  id: Id
  name: string
  builtIn: boolean
  createdAt: number
}

export interface Prompt {
  id: Id
  title: string
  body: string
  categoryId: Id | null
  tags: string[]
  favorite: boolean
  /** Recommended models (registry ids). */
  preferredModelIds: string[]
  /** Parameter preset (validated against a model when applied). */
  parameters: ParamValues
  variableDefaults: Record<string, string>
  version: number
  builtIn: boolean
  sourceJobId: Id | null
  createdAt: number
  updatedAt: number
}

export interface PromptVersion {
  id: Id
  promptId: Id
  version: number
  title: string
  body: string
  tags: string[]
  preferredModelIds: string[]
  parameters: ParamValues
  variableDefaults: Record<string, string>
  createdAt: number
}

export type PromptInput = Pick<
  Prompt,
  "title" | "body" | "categoryId" | "tags" | "favorite" | "preferredModelIds" | "parameters" | "variableDefaults"
> & { sourceJobId?: Id | null }

/* ── Settings ───────────────────────────────────────────────────────────── */

export type Language = "en" | "tr"

export interface BudgetSettings {
  dailyLimitUsd: number | null
  monthlyLimitUsd: number | null
  warnAtPercent: number
  confirmBeforeGenerate: boolean
}

export interface AppSettings {
  language: Language
  onboardingCompleted: boolean
  autoSave: boolean
  downloadConcurrency: number
  trashRetentionDays: number
  budget: BudgetSettings
  archiveRoot: string
  /** Default folder offered by Export dialogs (null = system default). */
  exportDir: string | null
  /** Check the signed model registry on launch and periodically. */
  catalogAutoSync: boolean
}

/* ── Model catalog ──────────────────────────────────────────────────────── */

/** How a model entered the catalog and whether this app build can run it.
    Discovery (new metadata) is separate from execution compatibility. */
export type CatalogState =
  | "bundled" // shipped with this app version
  | "new" // added by a signed registry update and executable
  | "updated" // bundled model whose verified metadata was updated
  | "deprecated" // still callable, scheduled for removal by the provider
  | "discontinued" // no longer callable
  | "update_required" // known to the registry but needs a newer app version

export interface CatalogEntry {
  model: import("./registry").ModelDefinition
  state: CatalogState
  /** Can be submitted by this build (false for update_required/discontinued). */
  executable: boolean
  /** Why it is not executable / what changed (localized by the UI via code). */
  reason: string | null
  /** Registry version that introduced the current metadata. */
  registryVersion: string | null
}

export interface CatalogStatus {
  /** Version of the active catalog (bundled or last verified registry). */
  version: string
  source: "bundled" | "registry"
  lastCheckedAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  autoSync: boolean
  counts: Record<CatalogState, number>
}

export interface CatalogSyncResult {
  checkedAt: number
  /** "updated" | "up_to_date" | "failed" | "skipped_active_jobs" */
  outcome: "updated" | "up_to_date" | "failed" | "skipped_active_jobs"
  added: string[]
  updated: string[]
  deprecated: string[]
  discontinued: string[]
  updateRequired: string[]
  /** Machine-readable failure reason: network | signature | schema | compatibility | downgrade */
  error: string | null
}

/* ── Storage ────────────────────────────────────────────────────────────── */

export interface StorageStatus {
  archiveRoot: string
  /** The folder exists and is writable right now. */
  available: boolean
  /** UNC path or mapped network drive (slower, may disconnect). */
  isNetwork: boolean
  /** Removable/external drive. */
  isRemovable: boolean
  freeBytes: number | null
  usedBytes: number
  exportDir: string | null
  /** Downloads are paused because the archive folder is unavailable. */
  downloadsPaused: boolean
}

/** A prepared archive move. Nothing is copied until `startArchiveMove`, and
    old files are only removed by `finalizeArchiveMove(token, true)`. */
export interface ArchiveMovePlan {
  token: string
  from: string
  to: string
  fileCount: number
  totalBytes: number
  freeBytes: number | null
  isNetwork: boolean
  isRemovable: boolean
  /** Machine-readable warnings: network_folder | removable_drive | low_space | not_empty */
  warnings: string[]
}

export interface ArchiveMoveResult {
  token: string
  copied: number
  verified: number
  failed: number
  /** Relative paths that failed verification (old copies are kept). */
  failures: string[]
}

export const DEFAULT_BUDGET: BudgetSettings = {
  dailyLimitUsd: null,
  monthlyLimitUsd: null,
  warnAtPercent: 80,
  confirmBeforeGenerate: true,
}

/* ── Backup ─────────────────────────────────────────────────────────────── */

export interface ImportPreview {
  token: string
  formatVersion: number
  createdAt: number
  jobCount: number
  assetCount: number
  promptCount: number
  totalBytes: number
  duplicateCount: number
  warnings: string[]
}

export interface ImportResult {
  importedJobs: number
  importedAssets: number
  importedPrompts: number
  skippedDuplicates: number
}

export type StoreEvent =
  | { type: "jobs-changed" }
  | { type: "archive-changed" }
  | { type: "download-progress"; assetId: Id; bytesDownloaded: number; totalBytes: number | null }
  | { type: "prompts-changed" }
  | { type: "settings-changed" }
  | { type: "providers-changed" }
  | { type: "catalog-changed" }
  | { type: "archive-move-progress"; token: string; processed: number; total: number }
