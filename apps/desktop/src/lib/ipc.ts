import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

import type {
  AppSettings,
  ArchiveEntry,
  ArchiveMovePlan,
  ArchiveMoveResult,
  CatalogEntry,
  CatalogStatus,
  CatalogSyncResult,
  StorageStatus,
  ArchiveQuery,
  DownloadTask,
  GenerationJob,
  Id,
  ImportPreview,
  ImportResult,
  MediaAsset,
  ModelDefinition,
  ParamValues,
  Project,
  Prompt,
  PromptCategory,
  PromptInput,
  PromptVersion,
  ProviderId,
  ProviderStatus,
  StorageStats,
  StoreEvent,
} from "@vidra/core"

/**
 * Typed client for the Rust backend — the single source of truth for command
 * names and shapes (see docs/architecture.md). Every call rejects with an
 * `IpcError` whose message is safe to show.
 */

export type ErrorCode =
  | "missing_credentials"
  | "invalid_credentials"
  | "insufficient_credits"
  | "invalid_input"
  | "rate_limited"
  | "network"
  | "provider_error"
  | "cancel_unsupported"
  | "cancel_too_late"
  | "budget_exceeded"
  | "confirmation_required"
  | "submit_uncertain"
  | "provider_disabled"
  | "not_found"
  | "io"
  | "disk_full"
  | "unknown_cost_ack_required"
  | "storage_unavailable"
  | "update_required"
  | "model_unavailable"
  | "unknown"

export class IpcError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | null
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> | null = null) {
    super(message)
    this.name = "IpcError"
    this.code = code
    this.details = details
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (raw) {
    if (raw && typeof raw === "object" && "code" in raw && "message" in raw) {
      const e = raw as { code: ErrorCode; message: string; details?: Record<string, unknown> }
      throw new IpcError(e.code, e.message, e.details ?? null)
    }
    throw new IpcError("unknown", typeof raw === "string" ? raw : "Unexpected error")
  }
}

export interface Estimate {
  /** "estimated": an amount is known; "unavailable": show "Pricing
      unavailable" and require explicit acknowledgement before submit. */
  status: "estimated" | "unavailable"
  /** Amount in `currency` (credits are never converted to money). */
  amount: number | null
  currency: "USD" | "credits" | null
  unitName: string | null
  /** Convenience: amount when currency is USD (used for budgets), else null. */
  usd: number | null
  credits: number | null
  source: "provider" | "published_rate" | null
  /** Published "from" rate: the final price may be higher. */
  lowerBound: boolean
  /** no_price | outdated | compute_time | missing_input | provider_error */
  reason: string | null
  verifiedAt: string | null
  pricingPageUrl: string | null
  /** Budget evaluation for this estimate (application-level). */
  budget: {
    allowed: boolean
    exceeded: Array<"daily" | "monthly">
    warnings: Array<"daily" | "monthly">
    dailySpentUsd: number
    monthlySpentUsd: number
    incomplete: boolean
  }
}

export interface GenerationInput {
  modelId: string
  prompt: string
  negativePrompt: string | null
  params: ParamValues
}

export interface UploadedReference {
  url: string
  kind: "image" | "video" | "audio"
  name: string
  /** Small data: URL preview for images, null otherwise. */
  previewDataUrl: string | null
}

export interface AppInfo {
  version: string
  dataDir: string
  platform: string
}

export interface UpdateInfo {
  currentVersion: string
  latestVersion: string
  url: string
  newer: boolean
}

export const ipc = {
  /* App */
  appInfo: () => call<AppInfo>("app_info"),
  getSettings: () => call<AppSettings>("get_settings"),
  updateSettings: (patch: Partial<AppSettings>) => call<AppSettings>("update_settings", { patch }),
  /* Storage */
  storageStatus: () => call<StorageStatus>("storage_status"),
  /** Folder dialog for a NEW archive location; returns a plan (nothing copied). */
  planArchiveMove: () => call<ArchiveMovePlan | null>("plan_archive_move"),
  /** Copies every managed file and verifies sha256; old files untouched. */
  startArchiveMove: (token: string) => call<ArchiveMoveResult>("start_archive_move", { token }),
  /** Switches to the new root. Removes old managed copies ONLY when
      removeOldCopies is true (explicit user confirmation) and all verified. */
  finalizeArchiveMove: (token: string, removeOldCopies: boolean) =>
    call<AppSettings>("finalize_archive_move", { token, removeOldCopies }),
  cancelArchiveMove: (token: string) => call<void>("cancel_archive_move", { token }),
  /** When the archive folder is unavailable (unplugged drive): point Vidra
      at the folder's new location without copying. Validated by content. */
  reconnectArchiveRoot: () => call<StorageStatus | null>("reconnect_archive_root"),
  chooseExportDir: () => call<AppSettings | null>("choose_export_dir"),
  checkForUpdates: () => call<UpdateInfo | null>("check_for_updates"),
  /** Downloads and verifies the signed update, installs it and restarts. */
  installUpdate: () => call<void>("install_update"),
  /** Opens an allowlisted official docs/project URL in the system browser. */
  openExternalUrl: (url: string) => call<void>("open_external_url", { url }),
  /** Native save dialog for text exports (csv/json/txt); false if cancelled. */
  saveTextFile: (suggestedName: string, contents: string, extension: "csv" | "json" | "txt") =>
    call<boolean>("save_text_file", { suggestedName, contents, extension }),

  /* Providers */
  listProviders: () => call<ProviderStatus[]>("list_providers"),
  setProviderCredentials: (provider: ProviderId, values: Record<string, string>) =>
    call<void>("set_provider_credentials", { provider, values }),
  removeProviderCredentials: (provider: ProviderId) => call<void>("remove_provider_credentials", { provider }),
  verifyProvider: (provider: ProviderId) => call<ProviderStatus>("verify_provider", { provider }),
  setProviderEnabled: (provider: ProviderId, enabled: boolean) =>
    call<void>("set_provider_enabled", { provider, enabled }),
  /* Model catalog (signed registry + official discovery) */
  catalogStatus: () => call<CatalogStatus>("catalog_status"),
  listCatalog: () => call<CatalogEntry[]>("list_catalog"),
  /** Manual "Check for new models". Never applied while jobs are active. */
  syncCatalog: () => call<CatalogSyncResult>("sync_catalog"),

  /* Models */
  /** Executable models only (bundled + verified registry additions). */
  listModels: () => call<ModelDefinition[]>("list_models"),

  /* References */
  pickReference: (provider: ProviderId, kind: "image" | "video" | "audio") =>
    call<UploadedReference | null>("pick_reference", { provider, kind }),
  uploadDroppedReference: (provider: ProviderId, dropToken: string) =>
    call<UploadedReference>("upload_dropped_reference", { provider, dropToken }),

  /* Generation */
  estimateGeneration: (input: GenerationInput) => call<Estimate>("estimate_generation", { input }),
  submitGeneration: (
    input: GenerationInput,
    options: {
      idempotencyKey: string
      confirmedEstimateUsd: number | null
      /** Required when the estimate is unavailable: the user explicitly
          accepted that the generation may incur an unknown charge. */
      acknowledgeUnknownCost: boolean
      promptId: Id | null
      projectId: Id | null
    }
  ) => call<GenerationJob>("submit_generation", { input, options }),
  cancelGeneration: (jobId: Id) => call<void>("cancel_generation", { jobId }),
  listJobs: (filter: { from?: number; to?: number } = {}) => call<GenerationJob[]>("list_jobs", { filter }),
  getJob: (id: Id) => call<GenerationJob | null>("get_job", { id }),
  deleteJob: (id: Id) => call<void>("delete_job", { id }),

  /* Archive */
  listArchive: (query: ArchiveQuery) => call<ArchiveEntry[]>("list_archive", { query }),
  renameItem: (itemId: Id, title: string | null) => call<void>("rename_item", { itemId, title }),
  setFavorite: (itemIds: Id[], favorite: boolean) => call<void>("set_favorite", { itemIds, favorite }),
  setTags: (itemId: Id, tags: string[]) => call<void>("set_tags", { itemId, tags }),
  moveToProject: (itemIds: Id[], projectId: Id | null) => call<void>("move_to_project", { itemIds, projectId }),
  trashItems: (itemIds: Id[]) => call<void>("trash_items", { itemIds }),
  restoreItems: (itemIds: Id[]) => call<void>("restore_items", { itemIds }),
  deletePermanently: (itemIds: Id[]) => call<void>("delete_permanently", { itemIds }),
  verifyFiles: () => call<number>("verify_files"),
  storageStats: () => call<StorageStats>("storage_stats"),
  mediaPath: (assetId: Id) => call<string | null>("media_path", { assetId }),
  thumbnailPath: (assetId: Id) => call<string | null>("thumbnail_path", { assetId }),
  saveThumbnail: (
    assetId: Id,
    imageBase64: string,
    meta: { durationSec: number | null; width: number | null; height: number | null }
  ) => call<void>("save_thumbnail", { assetId, imageBase64, ...meta }),
  exportMedia: (assetId: Id, suggestedName: string) => call<boolean>("export_media", { assetId, suggestedName }),
  openFileLocation: (assetId: Id) => call<void>("open_file_location", { assetId }),

  /* Projects */
  listProjects: () => call<Project[]>("list_projects"),
  createProject: (name: string) => call<Project>("create_project", { name }),
  renameProject: (id: Id, name: string) => call<void>("rename_project", { id, name }),
  deleteProject: (id: Id) => call<void>("delete_project", { id }),

  /* Downloads */
  listDownloads: () =>
    call<Array<{ task: DownloadTask; asset: MediaAsset; job: GenerationJob }>>("list_downloads"),
  retryDownload: (assetId: Id) => call<void>("retry_download", { assetId }),
  pauseDownload: (assetId: Id) => call<void>("pause_download", { assetId }),
  resumeDownload: (assetId: Id) => call<void>("resume_download", { assetId }),

  /* Prompts */
  listPrompts: (query: { search?: string; categoryId?: Id; favorite?: boolean; tag?: string } = {}) =>
    call<Prompt[]>("list_prompts", { query }),
  getPrompt: (id: Id) => call<Prompt | null>("get_prompt", { id }),
  createPrompt: (input: PromptInput) => call<Prompt>("create_prompt", { input }),
  updatePrompt: (id: Id, input: PromptInput) => call<Prompt>("update_prompt", { id, input }),
  duplicatePrompt: (id: Id) => call<Prompt>("duplicate_prompt", { id }),
  deletePrompt: (id: Id) => call<void>("delete_prompt", { id }),
  setPromptFavorite: (id: Id, favorite: boolean) => call<void>("set_prompt_favorite", { id, favorite }),
  listPromptVersions: (promptId: Id) => call<PromptVersion[]>("list_prompt_versions", { promptId }),
  restorePromptVersion: (promptId: Id, version: number) =>
    call<Prompt>("restore_prompt_version", { promptId, version }),
  listCategories: () => call<PromptCategory[]>("list_categories"),
  createCategory: (name: string) => call<PromptCategory>("create_category", { name }),
  renameCategory: (id: Id, name: string) => call<void>("rename_category", { id, name }),
  deleteCategory: (id: Id) => call<void>("delete_category", { id }),
  /** Opens a native save dialog; returns false if the user cancelled. */
  exportPrompts: (ids: Id[] | null) => call<boolean>("export_prompts", { ids }),
  /** Opens a native open dialog; null if cancelled. */
  importPrompts: () => call<{ imported: number; skipped: number } | null>("import_prompts"),
  savePromptFromJob: (jobId: Id, title: string) => call<Prompt>("save_prompt_from_job", { jobId, title }),

  /* Backup */
  exportArchive: () => call<string | null>("export_archive"),
  previewImport: () => call<ImportPreview | null>("preview_import"),
  confirmImport: (token: string) => call<ImportResult>("confirm_import", { token }),
  cancelImport: (token: string) => call<void>("cancel_import", { token }),
}

export type Ipc = typeof ipc

export function onStoreEvent(handler: (event: StoreEvent) => void): Promise<() => void> {
  return listen<StoreEvent>("vidra://store", (e) => handler(e.payload))
}

/** Natively captured drag-drop: Rust emits a token per dropped file. */
export interface DroppedFile {
  token: string
  name: string
  kind: "image" | "video" | "audio" | "unsupported"
}
export function onFilesDropped(handler: (files: DroppedFile[]) => void): Promise<() => void> {
  return listen<DroppedFile[]>("vidra://dropped", (e) => handler(e.payload))
}
