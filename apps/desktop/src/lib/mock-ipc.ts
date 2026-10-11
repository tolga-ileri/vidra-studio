import {
  checkBudget,
  DEFAULT_BUDGET,
  deriveArchiveState,
  estimatePrice,
  parsePromptExport,
  requestedDuration,
  validateGeneration,
  ParamError,
  type AppSettings,
  type ArchiveMovePlan,
  type ArchiveMoveResult,
  type CatalogEntry,
  type CatalogState,
  type CatalogStatus,
  type CatalogSyncResult,
  type StorageStatus,
  type ArchiveEntry,
  type ArchiveItem,
  type ArchiveQuery,
  type DownloadTask,
  type GenerationJob,
  type Id,
  type MediaAsset,
  type ModelDefinition,
  type Project,
  type Prompt,
  type PromptCategory,
  type PromptInput,
  type PromptVersion,
  type ProviderId,
  type ProviderStatus,
  type StoreEvent,
} from "@vidra/core"

import { IpcError, type DroppedFile, type Estimate, type GenerationInput, type Ipc, type UploadedReference } from "./ipc"
import { demoFrame, loadManifestModels, loadSeed, PROVIDERS } from "./mock-data"
import { FIXTURE_FUTURE_MODEL } from "./mock-fixtures"

/**
 * In-memory implementation of the `ipc` contract used in the browser preview
 * and in tests. It mirrors the documented backend behavior (credentials,
 * budget, confirmation, job lifecycle, downloads) without any network access.
 */

export interface MockOptions {
  /** Populate a small, clearly labeled demo dataset. */
  seedDemo?: boolean
  /** Milliseconds per simulated lifecycle step. */
  stepMs?: number
  /** Start with onboarding already completed. */
  onboarded?: boolean
  /** Providers that start configured + verified. */
  configured?: ProviderId[]
  /** Replaces the model list (tests use deterministic fixtures). */
  models?: ModelDefinition[]
  /** Initial language (defaults to "en"). */
  language?: AppSettings["language"]
  /** Start with the archive folder unavailable (unplugged drive). */
  storageAvailable?: boolean
}

export interface MockBackend {
  ipc: Ipc
  onStoreEvent: (handler: (event: StoreEvent) => void) => Promise<() => void>
  onFilesDropped: (handler: (files: DroppedFile[]) => void) => Promise<() => void>
  /** Test/preview helpers. */
  control: {
    emitDrop: (files: Array<{ name: string; kind: DroppedFile["kind"]; dataUrl?: string }>) => void
    failNextGeneration: (code?: string) => void
    failNextSubmit: (code: "submit_uncertain" | "invalid_credentials" | "insufficient_credits") => void
    jobs: () => GenerationJob[]
    /** Simulates unplugging / re-plugging the archive drive. */
    setStorageAvailable: (available: boolean) => void
    /** Next archive move reports these relative paths as failed. */
    failNextMove: (paths: string[]) => void
    /** Arguments of the last finalizeArchiveMove call. */
    lastFinalize: () => { token: string; removeOldCopies: boolean } | null
    dispose: () => void
  }
}

const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`

const clone = <T>(v: T): T => structuredClone(v)

/** USD amount for budgets/analytics when the manifest price is in USD. */
export function estimateUsdFromManifest(model: ModelDefinition, params: GenerationInput["params"], now = Date.now()): number | null {
  const e = estimatePrice(model, params, now)
  return e.status === "estimated" && e.currency === "USD" ? e.amount : null
}

export function createMockBackend(options: MockOptions = {}): MockBackend {
  const stepMs = options.stepMs ?? 900
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms)
    timers.add(t)
  }
  const delay = <T>(value: T, ms = 40) => new Promise<T>((resolve) => later(ms, () => resolve(value)))

  /* ── State ─────────────────────────────────────────────────────────── */
  let settings: AppSettings = {
    language: "en",
    onboardingCompleted: options.onboarded ?? false,
    autoSave: true,
    downloadConcurrency: 2,
    trashRetentionDays: 30,
    budget: { ...DEFAULT_BUDGET },
    archiveRoot: "C:\\Users\\Demo\\Videos\\Vidra Studio",
    exportDir: null,
    catalogAutoSync: true,
  }
  if (options.language) settings.language = options.language
  const providers = new Map<ProviderId, ProviderStatus>(
    PROVIDERS.map((p) => [
      p.id,
      { ...p, configured: false, verification: "unknown", lastVerifiedAt: null, lastError: null },
    ])
  )
  const credentials = new Map<ProviderId, Record<string, string>>()
  for (const id of options.configured ?? []) {
    const p = providers.get(id)
    if (p) {
      p.configured = true
      p.verification = "ok"
      p.lastVerifiedAt = Date.now()
      credentials.set(id, { demo: "demo" })
    }
  }
  const models = options.models ? clone(options.models) : loadManifestModels()
  const storage = { available: options.storageAvailable ?? true, isNetwork: false, isRemovable: false }
  const moves = new Map<string, { plan: ArchiveMovePlan; result: ArchiveMoveResult | null }>()
  let failMovePaths: string[] = []
  let lastFinalize: { token: string; removeOldCopies: boolean } | null = null

  /* ── Catalog ───────────────────────────────────────────────────────── */
  const catalog: CatalogEntry[] = models.map((model) => ({
    model,
    state: model.availability === "available" ? "bundled" : model.availability,
    executable: model.availability !== "discontinued",
    reason: null,
    registryVersion: null,
  }))
  let catalogVersion = "2026.10.01"
  let catalogSource: CatalogStatus["source"] = "bundled"
  let lastCheckedAt: number | null = null
  let lastSuccessAt: number | null = null
  let pendingDemoSync = false
  if (options.seedDemo) {
    // Demo only: one model recently added by a signed registry update and one
    // the registry knows about that needs a newer app version.
    const added = catalog[1]
    if (added) Object.assign(added, { state: "new", registryVersion: "2026.10.05" })
    catalog.push({ model: clone(FIXTURE_FUTURE_MODEL), state: "update_required", executable: false, reason: "app_version", registryVersion: "2026.10.05" })
    catalogVersion = "2026.10.05"
    catalogSource = "registry"
    lastCheckedAt = Date.now() - 3 * 3600_000
    lastSuccessAt = lastCheckedAt
    pendingDemoSync = true
  }
  const executableModels = () => catalog.filter((e) => e.executable && e.state !== "update_required").map((e) => e.model)
  const jobs = new Map<Id, GenerationJob>()
  const assets = new Map<Id, MediaAsset>()
  const items = new Map<Id, ArchiveItem>() // keyed by assetId
  const tasks = new Map<Id, DownloadTask>() // keyed by assetId
  const projects = new Map<Id, Project>()
  const idempotency = new Map<string, Id>()
  const prompts = new Map<Id, Prompt>()
  const versions = new Map<Id, PromptVersion[]>()
  const categories = new Map<Id, PromptCategory>()
  const thumbs = new Map<Id, string>()
  const drops = new Map<string, { name: string; kind: DroppedFile["kind"]; dataUrl: string | null }>()
  const pendingImports = new Set<string>()
  let failNextGeneration: string | null = null
  let failNextSubmit: string | null = null

  /* ── Events ────────────────────────────────────────────────────────── */
  const storeHandlers = new Set<(e: StoreEvent) => void>()
  const dropHandlers = new Set<(f: DroppedFile[]) => void>()
  const emit = (event: StoreEvent) => {
    for (const h of [...storeHandlers]) h(event)
  }

  /* ── Seed prompts ──────────────────────────────────────────────────── */
  const seed = loadSeed()
  const t0 = Date.UTC(2026, 0, 1)
  for (const c of seed.categories)
    categories.set(`builtin-${c.slug}`, { id: `builtin-${c.slug}`, name: c.name.en, builtIn: true, createdAt: t0 })
  for (const s of seed.prompts) {
    const id = `builtin-prompt-${s.slug}`
    const prompt: Prompt = {
      id,
      title: s.title.en,
      body: s.body,
      categoryId: categories.has(`builtin-${s.category}`) ? `builtin-${s.category}` : null,
      tags: s.tags,
      favorite: false,
      preferredModelIds: s.preferredModelIds.filter((m) => models.some((x) => x.id === m)),
      parameters: s.parameters ?? {},
      variableDefaults: s.variableDefaults,
      version: 1,
      builtIn: true,
      sourceJobId: null,
      createdAt: t0,
      updatedAt: t0,
    }
    prompts.set(id, prompt)
    versions.set(id, [snapshot(prompt)])
  }

  function snapshot(p: Prompt): PromptVersion {
    return {
      id: uuid(),
      promptId: p.id,
      version: p.version,
      title: p.title,
      body: p.body,
      tags: [...p.tags],
      preferredModelIds: [...p.preferredModelIds],
      parameters: clone(p.parameters),
      variableDefaults: { ...p.variableDefaults },
      createdAt: p.updatedAt,
    }
  }

  /* ── Helpers ───────────────────────────────────────────────────────── */
  const fail = (code: ConstructorParameters<typeof IpcError>[0], message: string, details?: Record<string, unknown>) =>
    Promise.reject(new IpcError(code, message, details ?? null))

  const modelById = (id: string) => executableModels().find((m) => m.id === id)
  const catalogEntry = (id: string) => catalog.find((e) => e.model.id === id)

  function budgetFor(usd: number | null): Estimate["budget"] {
    const check = checkBudget([...jobs.values()], usd, settings.budget)
    return {
      allowed: check.allowed,
      exceeded: check.exceeded,
      warnings: check.warnings,
      dailySpentUsd: check.daily.estimatedUsd,
      monthlySpentUsd: check.monthly.estimatedUsd,
      incomplete: check.incomplete,
    }
  }

  function estimateOf(input: GenerationInput): Estimate {
    const model = requireModel(input.modelId)
    const price = estimatePrice(model, input.params, Date.now(), { prompt: input.prompt, negativePrompt: input.negativePrompt })
    const base = { lowerBound: false, verifiedAt: model.pricing.verifiedAt, pricingPageUrl: model.pricing.pricingPageUrl }
    if (price.status === "unavailable") {
      if (price.reason === "provider_estimate") {
        // Simulated provider quote API (the real one is called natively).
        const seconds = requestedDuration(model, input.params)
        if (seconds != null) {
          const usd = Math.round(seconds * 0.08 * 1e6) / 1e6
          return { ...base, status: "estimated", amount: usd, currency: "USD", unitName: null, usd, credits: null, source: "provider", reason: null, budget: budgetFor(usd) }
        }
        return { ...base, status: "unavailable", amount: null, currency: null, unitName: null, usd: null, credits: null, source: null, reason: "provider_error", budget: budgetFor(null) }
      }
      return { ...base, status: "unavailable", amount: null, currency: null, unitName: null, usd: null, credits: null, source: null, reason: price.reason, budget: budgetFor(null) }
    }
    const usd = price.currency === "USD" ? price.amount : null
    return {
      ...base,
      status: "estimated",
      amount: price.amount,
      currency: price.currency,
      unitName: price.unitName,
      usd,
      credits: price.currency === "credits" ? price.amount : null,
      source: "published_rate",
      lowerBound: price.lowerBound,
      verifiedAt: price.verifiedAt,
      reason: null,
      budget: budgetFor(usd),
    }
  }

  function requireModel(id: string): ModelDefinition {
    const model = modelById(id)
    if (model) return model
    const entry = catalogEntry(id)
    if (entry?.state === "update_required") throw new IpcError("update_required", "This model needs a newer version of Vidra Studio.", { modelId: id })
    if (entry) throw new IpcError("model_unavailable", "This model is no longer available.", { modelId: id })
    throw new IpcError("not_found", "This model is no longer available.")
  }

  function validate(input: GenerationInput): ModelDefinition {
    const model = requireModel(input.modelId)
    try {
      validateGeneration(model, { prompt: input.prompt, negativePrompt: input.negativePrompt, params: input.params })
    } catch (e) {
      if (e instanceof ParamError) throw new IpcError("invalid_input", e.message, { code: e.code, field: e.key, ...e.details })
      throw e
    }
    return model
  }

  function storageStatusOf(): StorageStatus {
    return {
      archiveRoot: settings.archiveRoot,
      available: storage.available,
      isNetwork: storage.isNetwork,
      isRemovable: storage.isRemovable,
      freeBytes: storage.available ? 412_000_000_000 : null,
      usedBytes: storageStats().usedBytes,
      exportDir: settings.exportDir,
      downloadsPaused: !storage.available,
    }
  }

  function catalogCounts(): Record<CatalogState, number> {
    const counts: Record<CatalogState, number> = { bundled: 0, new: 0, updated: 0, deprecated: 0, discontinued: 0, update_required: 0 }
    for (const e of catalog) counts[e.state] += 1
    return counts
  }

  function touchJob(job: GenerationJob, patch: Partial<GenerationJob>) {
    Object.assign(job, patch, { updatedAt: Date.now() })
    emit({ type: "jobs-changed" })
    emit({ type: "archive-changed" })
  }

  function entriesFor(job: GenerationJob): ArchiveEntry[] {
    const owned = [...assets.values()].filter((a) => a.jobId === job.id)
    if (!owned.length) return [{ job: clone(job), asset: null, item: null, task: null, state: deriveArchiveState(job, null, null, null) }]
    return owned.map((asset) => {
      const item = items.get(asset.id) ?? null
      const task = tasks.get(asset.id) ?? null
      return {
        job: clone(job),
        asset: clone(asset),
        item: item && clone(item),
        task: task && clone(task),
        state: deriveArchiveState(job, asset, item, task),
      }
    })
  }

  function createOutputs(job: GenerationJob, model: ModelDefinition) {
    const count = job.output === "image" ? Math.max(1, Math.min(4, Number(job.params.num_images ?? 1) || 1)) : 1
    for (let i = 0; i < count; i++) {
      const id = uuid()
      const size = job.output === "video" ? 8_400_000 + Math.round(Math.random() * 6_000_000) : 1_200_000
      const asset: MediaAsset = {
        id,
        jobId: job.id,
        outputIndex: i,
        kind: job.output,
        originalUrl: `https://demo.vidra.invalid/output/${id}`,
        localPath: null,
        filename: `${model.family.toLowerCase().replace(/\W+/g, "-")}-${id.slice(0, 8)}.${job.output === "video" ? "mp4" : "png"}`,
        mimeType: job.output === "video" ? "video/mp4" : "image/png",
        sizeBytes: size,
        sha256: null,
        durationSec: job.output === "video" ? job.requestedDurationSec : null,
        width: 1280,
        height: 720,
        thumbnailPath: null,
        downloadStatus: "pending",
        duplicateOfAssetId: null,
        createdAt: Date.now(),
      }
      assets.set(id, asset)
      items.set(id, { id: uuid(), assetId: id, projectId: job.projectId, customTitle: null, favorite: false, tags: [], deletedAt: null })
      thumbs.set(id, demoFrame(job.modelName, Math.abs(hash(id))))
      if (settings.autoSave) {
        tasks.set(id, {
          id: uuid(),
          assetId: id,
          status: "pending",
          bytesDownloaded: 0,
          totalBytes: size,
          retryCount: 0,
          nextAttemptAt: null,
          lastError: null,
          lastErrorCode: null,
          updatedAt: Date.now(),
        })
        later(stepMs / 2, () => runDownload(id))
      }
    }
  }

  function runDownload(assetId: Id) {
    const asset = assets.get(assetId)
    const task = tasks.get(assetId)
    if (!asset || !task || task.status === "paused" || task.status === "completed") return
    if (!storage.available) {
      // Archive folder unavailable: downloads wait until it is reconnected.
      later(stepMs, () => runDownload(assetId))
      return
    }
    task.status = "downloading"
    asset.downloadStatus = "downloading"
    const total = task.totalBytes ?? asset.sizeBytes ?? 1
    task.bytesDownloaded = Math.min(total, task.bytesDownloaded + Math.ceil(total / 5))
    task.updatedAt = Date.now()
    emit({ type: "download-progress", assetId, bytesDownloaded: task.bytesDownloaded, totalBytes: total })
    if (task.bytesDownloaded >= total) {
      task.status = "completed"
      asset.downloadStatus = "saved"
      asset.localPath = `media\\2026\\10\\${asset.id}.${asset.kind === "video" ? "mp4" : "png"}`
      asset.sha256 = Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(hash(asset.id) + i * 7) & 15]).join("")
      asset.thumbnailPath = `thumbs\\${asset.id}.jpg`
      emit({ type: "archive-changed" })
      return
    }
    emit({ type: "archive-changed" })
    later(stepMs / 3, () => runDownload(assetId))
  }

  function runJob(jobId: Id) {
    const job = jobs.get(jobId)
    if (!job) return
    if (job.status === "queued") {
      touchJob(job, { status: "generating" })
      later(stepMs * 2, () => runJob(jobId))
    } else if (job.status === "generating") {
      if (failNextGeneration) {
        const code = failNextGeneration
        failNextGeneration = null
        touchJob(job, {
          status: "failed",
          errorCode: code,
          errorMessage: "The provider rejected this request. No output was produced.",
          completedAt: Date.now(),
        })
        return
      }
      const model = modelById(job.modelId)
      touchJob(job, { status: "completed", completedAt: Date.now() })
      if (model) createOutputs(job, model)
      emit({ type: "archive-changed" })
    }
  }

  function storageStats() {
    let usedBytes = 0
    let savedCount = 0
    let trashedCount = 0
    let missingCount = 0
    for (const a of assets.values()) {
      if (a.downloadStatus === "saved") {
        usedBytes += a.sizeBytes ?? 0
        savedCount += 1
      }
      if (a.downloadStatus === "missing") missingCount += 1
      if (items.get(a.id)?.deletedAt != null) trashedCount += 1
    }
    return { usedBytes, savedCount, trashedCount, missingCount, freeBytes: storage.available ? 412_000_000_000 : null, archiveRoot: settings.archiveRoot }
  }

  /* ── Demo dataset (browser preview only) ───────────────────────────── */
  if (options.seedDemo) seedDemo()
  function seedDemo() {
    const picks = models.filter((m) => !m.params.some((p) => p.type === "media" && p.required)).slice(0, 8)
    const statuses: GenerationJob["status"][] = ["completed", "completed", "completed", "failed", "completed", "canceled", "completed"]
    const now = Date.now()
    const project: Project = { id: uuid(), name: "Demo project", createdAt: now - 40 * 86400000 }
    projects.set(project.id, project)
    for (let i = 0; i < 14 && picks.length; i++) {
      const model = picks[i % picks.length]!
      const status = statuses[i % statuses.length]!
      const created = now - (i * 3 + 1) * 86400000 - i * 3600000
      const params: Record<string, string | number | boolean> = {}
      for (const p of model.params) if ("default" in p && p.default !== undefined) params[p.key] = p.default
      const job: GenerationJob = {
        id: uuid(),
        provider: model.provider,
        modelId: model.id,
        modelName: model.displayName,
        workflow: model.workflow,
        output: model.output,
        providerRequestId: `demo-${i}`,
        status,
        prompt: `Demo prompt ${i + 1}: a slow cinematic shot of a coastline at dawn`,
        negativePrompt: null,
        params,
        requestedDurationSec: requestedDuration(model, params),
        estimatedCostUsd: estimateUsdFromManifest(model, params),
        estimateSource: estimateUsdFromManifest(model, params) == null ? null : "published_rate",
        confirmedCostUsd: null,
        errorCode: status === "failed" ? "provider_error" : null,
        errorMessage: status === "failed" ? "Demo failure: the provider rejected the request." : null,
        promptId: null,
        projectId: i % 3 === 0 ? project.id : null,
        createdAt: created,
        updatedAt: created,
        completedAt: status === "completed" ? created + 120000 : null,
      }
      jobs.set(job.id, job)
      if (status === "completed") {
        const save = settings.autoSave
        settings.autoSave = false
        createOutputs(job, model)
        settings.autoSave = save
        for (const a of assets.values()) {
          if (a.jobId !== job.id) continue
          a.createdAt = created
          if (i === 4) {
            a.downloadStatus = "failed"
            tasks.set(a.id, {
              id: uuid(),
              assetId: a.id,
              status: "failed",
              bytesDownloaded: 0,
              totalBytes: a.sizeBytes,
              retryCount: 6,
              nextAttemptAt: null,
              lastError: "The provider link has expired (HTTP 410).",
              lastErrorCode: "expired",
              updatedAt: created,
            })
          } else {
            a.downloadStatus = "saved"
            a.localPath = `media\\demo\\${a.id}`
            a.thumbnailPath = `thumbs\\${a.id}.jpg`
          }
          const item = items.get(a.id)
          if (item && i === 1) item.favorite = true
        }
      }
    }
  }

  /* ── File inputs for the browser preview ───────────────────────────── */
  function readFile(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
  }
  function pickFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement("input")
      input.type = "file"
      input.accept = accept
      input.onchange = () => resolve(input.files?.[0] ?? null)
      input.addEventListener("cancel", () => resolve(null))
      input.click()
    })
  }
  function download(name: string, content: Blob) {
    const url = URL.createObjectURL(content)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const onWindowDrop = (event: DragEvent) => {
    if (!event.dataTransfer?.files.length) return
    event.preventDefault()
    const files = [...event.dataTransfer.files]
    void Promise.all(
      files.map(async (f) => {
        const kind: DroppedFile["kind"] = f.type.startsWith("image/")
          ? "image"
          : f.type.startsWith("video/")
            ? "video"
            : f.type.startsWith("audio/")
              ? "audio"
              : "unsupported"
        const token = uuid()
        drops.set(token, { name: f.name, kind, dataUrl: kind === "image" ? await readFile(f) : null })
        return { token, name: f.name, kind }
      })
    ).then((list) => dropHandlers.forEach((h) => h(list)))
  }
  const onDragOver = (event: DragEvent) => event.preventDefault()
  if (typeof window !== "undefined") {
    window.addEventListener("drop", onWindowDrop)
    window.addEventListener("dragover", onDragOver)
  }

  function makeReference(name: string, kind: UploadedReference["kind"], dataUrl: string | null): UploadedReference {
    return {
      url: `https://demo.vidra.invalid/uploads/${uuid()}`,
      kind,
      name,
      previewDataUrl: kind === "image" ? (dataUrl ?? demoFrame(name, name.length, 320, 180)) : null,
    }
  }

  /* ── Prompt helpers ────────────────────────────────────────────────── */
  function cleanPromptInput(input: PromptInput) {
    const title = input.title.trim()
    if (!title) throw new IpcError("invalid_input", "A title is required.")
    if (!input.body.trim()) throw new IpcError("invalid_input", "The prompt body is empty.")
    if (input.categoryId && !categories.has(input.categoryId)) throw new IpcError("not_found", "Category not found.")
    return { ...clone(input), title, tags: [...new Set(input.tags.map((t) => t.trim()).filter(Boolean))] }
  }

  /* ── The ipc implementation ────────────────────────────────────────── */
  const ipc: Ipc = {
    appInfo: () => delay({ version: "0.1.0", dataDir: "(browser preview — in memory)", platform: "browser" }),
    getSettings: () => delay(clone(settings)),
    updateSettings: async (patch) => {
      settings = { ...settings, ...clone(patch), budget: { ...settings.budget, ...(patch.budget ?? {}) } }
      emit({ type: "settings-changed" })
      return delay(clone(settings))
    },
    storageStatus: () => delay(storageStatusOf()),
    planArchiveMove: async () => {
      const stats = storageStats()
      const token = uuid()
      const plan: ArchiveMovePlan = {
        token,
        from: settings.archiveRoot,
        to: "E:\\Vidra Studio Archive",
        fileCount: stats.savedCount,
        totalBytes: stats.usedBytes,
        freeBytes: 64_000_000_000,
        isNetwork: false,
        isRemovable: true,
        warnings: ["removable_drive"],
      }
      moves.set(token, { plan, result: null })
      return delay(clone(plan), 120)
    },
    startArchiveMove: async (token) => {
      const move = moves.get(token)
      if (!move) return fail("not_found", "This move is no longer pending.")
      const saved = [...assets.values()].filter((a) => a.downloadStatus === "saved")
      const failures = storage.available ? failMovePaths : saved.map((a) => a.localPath ?? a.filename)
      failMovePaths = []
      const copied = storage.available ? saved.length : 0
      const result: ArchiveMoveResult = { token, copied, verified: Math.max(0, copied - failures.length), failed: failures.length, failures }
      move.result = result
      const total = saved.length
      for (let i = 1; i <= total; i++) later((Math.max(200, stepMs) * i) / (total + 1), () => emit({ type: "archive-move-progress", token, processed: i, total }))
      return delay(clone(result), Math.max(200, stepMs))
    },
    finalizeArchiveMove: async (token, removeOldCopies) => {
      const move = moves.get(token)
      if (!move?.result) return fail("not_found", "This move is no longer pending.")
      if (removeOldCopies && move.result.failed > 0)
        return fail("io", "Some files failed verification; old copies must be kept.", { reason: "move_incomplete" })
      moves.delete(token)
      lastFinalize = { token, removeOldCopies }
      settings = { ...settings, archiveRoot: move.plan.to }
      Object.assign(storage, { available: true, isNetwork: move.plan.isNetwork, isRemovable: move.plan.isRemovable })
      emit({ type: "settings-changed" })
      emit({ type: "archive-changed" })
      return delay(clone(settings))
    },
    cancelArchiveMove: async (token) => {
      moves.delete(token)
      return delay(undefined)
    },
    reconnectArchiveRoot: async () => {
      storage.available = true
      emit({ type: "settings-changed" })
      emit({ type: "archive-changed" })
      return delay(storageStatusOf(), 150)
    },
    chooseExportDir: async () => {
      settings = { ...settings, exportDir: "C:\\Users\\Demo\\Videos\\Vidra Exports" }
      emit({ type: "settings-changed" })
      return delay(clone(settings))
    },
    checkForUpdates: () =>
      delay({ currentVersion: "0.1.0", latestVersion: "0.1.0", url: "https://github.com/tolga-ileri/vidra-studio/releases", newer: false }, 300),
    installUpdate: async (_acknowledgeActive) => fail("not_found", "Vidra Studio is up to date."),

    openExternalUrl: async (url) => {
      window.open(url, "_blank", "noopener,noreferrer")
    },
    saveTextFile: async (suggestedName, contents, extension) => {
      const type = extension === "csv" ? "text/csv;charset=utf-8" : extension === "json" ? "application/json" : "text/plain"
      const href = URL.createObjectURL(new Blob([contents], { type }))
      const a = document.createElement("a")
      a.href = href
      a.download = suggestedName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(href), 2000)
      return true
    },

    listProviders: () => delay([...providers.values()].map(clone)),
    setProviderCredentials: async (provider, values) => {
      const p = providers.get(provider)
      if (!p) return fail("not_found", "Unknown provider.")
      for (const f of p.credentialFields)
        if (!values[f.key]?.trim()) return fail("invalid_input", `${f.label} is required.`)
      credentials.set(provider, { ...values })
      Object.assign(p, { configured: true, verification: "unknown", lastError: null })
      emit({ type: "providers-changed" })
      return delay(undefined)
    },
    removeProviderCredentials: async (provider) => {
      const p = providers.get(provider)
      credentials.delete(provider)
      if (p) Object.assign(p, { configured: false, verification: "unknown", lastVerifiedAt: null, lastError: null })
      emit({ type: "providers-changed" })
      return delay(undefined)
    },
    verifyProvider: async (provider) => {
      const p = providers.get(provider)
      if (!p) return fail("not_found", "Unknown provider.")
      const creds = credentials.get(provider)
      if (!creds) return fail("missing_credentials", `Add ${p.displayName} credentials first.`)
      const bad = Object.values(creds).some((v) => /invalid|wrong/i.test(v))
      Object.assign(p, {
        verification: bad ? "failed" : "ok",
        lastVerifiedAt: Date.now(),
        lastError: bad ? "The provider rejected these credentials (401)." : null,
      })
      emit({ type: "providers-changed" })
      return delay(clone(p), 400)
    },
    setProviderEnabled: async (provider, enabled) => {
      const p = providers.get(provider)
      if (p) p.enabled = enabled
      emit({ type: "providers-changed" })
      return delay(undefined)
    },
    catalogStatus: () =>
      delay<CatalogStatus>({
        version: catalogVersion,
        source: catalogSource,
        lastCheckedAt,
        lastSuccessAt,
        lastError: null,
        autoSync: settings.catalogAutoSync,
        counts: catalogCounts(),
      }),
    listCatalog: () => delay(catalog.map(clone)),
    syncCatalog: async () => {
      const now = Date.now()
      const empty = { added: [], updated: [], deprecated: [], discontinued: [], updateRequired: [], error: null }
      lastCheckedAt = now
      if ([...jobs.values()].some((j) => j.status === "queued" || j.status === "generating" || j.status === "submitting"))
        return delay<CatalogSyncResult>({ checkedAt: now, outcome: "skipped_active_jobs", ...empty }, 300)
      lastSuccessAt = now
      if (!pendingDemoSync) return delay<CatalogSyncResult>({ checkedAt: now, outcome: "up_to_date", ...empty }, 400)
      pendingDemoSync = false
      const updated = catalog.find((e) => e.state === "bundled")
      if (updated) Object.assign(updated, { state: "updated", registryVersion: "2026.10.11" })
      catalogVersion = "2026.10.11"
      emit({ type: "catalog-changed" })
      return delay<CatalogSyncResult>(
        {
          checkedAt: now,
          outcome: "updated",
          ...empty,
          added: catalog.filter((e) => e.state === "new").map((e) => e.model.id),
          updated: updated ? [updated.model.id] : [],
          updateRequired: catalog.filter((e) => e.state === "update_required").map((e) => e.model.id),
        },
        400
      )
    },

    listModels: () => delay(clone(executableModels())),

    pickReference: async (provider, kind) => {
      if (!providers.get(provider)?.configured) return fail("missing_credentials", "Add credentials for this provider first.")
      if (typeof document !== "undefined" && !import.meta.env.MODE.includes("test")) {
        const file = await pickFile(`${kind}/*`)
        if (!file) return null
        return makeReference(file.name, kind, kind === "image" ? await readFile(file) : null)
      }
      return delay(makeReference(`demo-${kind}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "mp3"}`, kind, null))
    },
    uploadDroppedReference: async (provider, dropToken) => {
      const drop = drops.get(dropToken)
      if (!drop) return fail("not_found", "That file is no longer available. Drop it again.")
      drops.delete(dropToken)
      if (drop.kind === "unsupported") return fail("invalid_input", "This file type is not supported.")
      if (!providers.get(provider)?.configured) return fail("missing_credentials", "Add credentials for this provider first.")
      return delay(makeReference(drop.name, drop.kind, drop.dataUrl), 200)
    },

    estimateGeneration: async (input) => {
      try {
        return delay(estimateOf(input), 80)
      } catch (e) {
        return Promise.reject(e)
      }
    },
    submitGeneration: async (input, opts) => {
      const existing = idempotency.get(opts.idempotencyKey)
      if (existing && jobs.get(existing)) return delay(clone(jobs.get(existing)!))
      let model: ModelDefinition
      try {
        model = validate(input)
      } catch (e) {
        return Promise.reject(e)
      }
      const provider = providers.get(model.provider)!
      if (!provider.enabled) return fail("provider_disabled", `${provider.displayName} is disabled in Providers.`)
      if (!provider.configured) return fail("missing_credentials", `Add ${provider.displayName} credentials in Providers.`)
      if (provider.verification === "failed")
        return fail("invalid_credentials", `${provider.displayName} rejected the saved credentials.`)
      const estimate = estimateOf(input)
      if ((estimate.status === "unavailable" || estimate.currency === "credits") && !opts.acknowledgeUnknownCost)
        return fail("unknown_cost_ack_required", "Confirm that this generation may incur charges.", { reason: estimate.reason })
      if (!estimate.budget.allowed)
        return fail("budget_exceeded", "This generation would exceed your budget limit.", {
          exceeded: estimate.budget.exceeded,
          estimateUsd: estimate.usd,
        })
      if (settings.budget.confirmBeforeGenerate) {
        const confirmed = opts.confirmedEstimateUsd
        // Unknown cost cannot be confirmed numerically; the UI dialog is the confirmation.
        const needs = estimate.usd != null && (confirmed == null || confirmed + 1e-9 < estimate.usd)
        if (needs)
          return fail("confirmation_required", "Please confirm the estimated cost.", { estimateUsd: estimate.usd })
      }
      if (failNextSubmit) {
        const code = failNextSubmit as "submit_uncertain"
        failNextSubmit = null
        return fail(code, code === "submit_uncertain" ? "The provider did not confirm the request." : "The provider rejected the request.")
      }
      const now = Date.now()
      const job: GenerationJob = {
        id: uuid(),
        provider: model.provider,
        modelId: model.id,
        modelName: model.displayName,
        workflow: model.workflow,
        output: model.output,
        providerRequestId: `demo-${uuid().slice(0, 8)}`,
        status: "queued",
        prompt: input.prompt.trim(),
        negativePrompt: input.negativePrompt,
        params: clone(input.params),
        requestedDurationSec: requestedDuration(model, input.params),
        estimatedCostUsd: estimate.usd,
        estimateSource: estimate.source,
        confirmedCostUsd: null,
        errorCode: null,
        errorMessage: null,
        promptId: opts.promptId,
        projectId: opts.projectId,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }
      jobs.set(job.id, job)
      idempotency.set(opts.idempotencyKey, job.id)
      emit({ type: "jobs-changed" })
      emit({ type: "archive-changed" })
      later(stepMs, () => runJob(job.id))
      return delay(clone(job))
    },
    cancelGeneration: async (jobId) => {
      const job = jobs.get(jobId)
      if (!job) return fail("not_found", "Job not found.")
      if (!providers.get(job.provider)?.capabilities.cancel)
        return fail("cancel_unsupported", "This provider does not support cancellation.")
      if (job.status !== "queued" && job.status !== "generating" && job.status !== "submitting")
        return fail("cancel_too_late", "This job can no longer be canceled.")
      touchJob(job, { status: "canceled", completedAt: Date.now() })
      return delay(undefined)
    },
    listJobs: async (filter = {}) =>
      delay(
        [...jobs.values()]
          .filter((j) => (filter.from == null || j.createdAt >= filter.from) && (filter.to == null || j.createdAt <= filter.to))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(clone)
      ),
    getJob: async (id) => delay(jobs.has(id) ? clone(jobs.get(id)!) : null),
    deleteJob: async (id) => {
      jobs.delete(id)
      for (const a of [...assets.values()]) if (a.jobId === id) assets.delete(a.id)
      emit({ type: "jobs-changed" })
      emit({ type: "archive-changed" })
      return delay(undefined)
    },

    listArchive: async (query: ArchiveQuery) => {
      const search = query.search?.trim().toLowerCase()
      let out = [...jobs.values()].flatMap(entriesFor)
      out = out.filter((e) => {
        const trashed = e.state === "trashed"
        if (query.trashed ? !trashed : trashed) return false
        if (query.provider && e.job.provider !== query.provider) return false
        if (query.modelId && e.job.modelId !== query.modelId) return false
        if (query.output && e.job.output !== query.output) return false
        const created = e.asset?.createdAt ?? e.job.createdAt
        if (query.from != null && created < query.from) return false
        if (query.to != null && created > query.to) return false
        if (query.favorite && !e.item?.favorite) return false
        if (query.projectId !== undefined && query.projectId !== null && (e.item?.projectId ?? e.job.projectId) !== query.projectId)
          return false
        if (query.states?.length && !query.states.includes(e.state)) return false
        if (search) {
          const hay = [e.job.prompt, e.job.modelName, e.item?.customTitle, e.asset?.filename, ...(e.item?.tags ?? [])]
            .join(" ")
            .toLowerCase()
          if (!hay.includes(search)) return false
        }
        return true
      })
      const dir = query.direction === "asc" ? 1 : -1
      const key = (e: ArchiveEntry) =>
        query.sort === "size" ? (e.asset?.sizeBytes ?? 0) : query.sort === "duration" ? (e.asset?.durationSec ?? 0) : (e.asset?.createdAt ?? e.job.createdAt)
      out.sort((a, b) => (key(a) - key(b)) * dir)
      return delay(out)
    },
    renameItem: async (itemId, title) => {
      for (const it of items.values()) if (it.id === itemId) it.customTitle = title?.trim() || null
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    setFavorite: async (itemIds, favorite) => {
      for (const it of items.values()) if (itemIds.includes(it.id)) it.favorite = favorite
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    setTags: async (itemId, tags) => {
      for (const it of items.values()) if (it.id === itemId) it.tags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))]
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    moveToProject: async (itemIds, projectId) => {
      if (projectId && !projects.has(projectId)) return fail("not_found", "Project not found.")
      for (const it of items.values()) if (itemIds.includes(it.id)) it.projectId = projectId
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    trashItems: async (itemIds) => {
      for (const it of items.values()) if (itemIds.includes(it.id)) it.deletedAt = Date.now()
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    restoreItems: async (itemIds) => {
      for (const it of items.values()) if (itemIds.includes(it.id)) it.deletedAt = null
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    deletePermanently: async (itemIds) => {
      for (const it of [...items.values()])
        if (itemIds.includes(it.id)) {
          items.delete(it.assetId)
          assets.delete(it.assetId)
          tasks.delete(it.assetId)
        }
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    verifyFiles: () => delay(0, 300),
    storageStats: () => delay(storageStats()),
    mediaPath: async (assetId) => {
      const a = assets.get(assetId)
      return delay(a?.downloadStatus === "saved" ? (thumbs.get(assetId) ?? null) : null)
    },
    thumbnailPath: async (assetId) => delay(thumbs.get(assetId) ?? null),
    saveThumbnail: async (assetId, imageBase64) => {
      thumbs.set(assetId, `data:image/jpeg;base64,${imageBase64}`)
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    exportMedia: async (assetId, suggestedName) => {
      const a = assets.get(assetId)
      if (!a || a.downloadStatus !== "saved") return fail("not_found", "The file is not saved yet.")
      const src = thumbs.get(assetId)
      if (src && typeof document !== "undefined") download(`${suggestedName}.svg`, await (await fetch(src)).blob())
      return delay(true)
    },
    openFileLocation: async (assetId) => {
      if (!assets.has(assetId)) return fail("not_found", "File not found.")
      return delay(undefined)
    },

    listProjects: () => delay([...projects.values()].sort((a, b) => a.name.localeCompare(b.name)).map(clone)),
    createProject: async (name) => {
      const n = name.trim()
      if (!n) return fail("invalid_input", "A name is required.")
      if ([...projects.values()].some((p) => p.name.toLowerCase() === n.toLowerCase()))
        return fail("invalid_input", "A project with this name already exists.")
      const p: Project = { id: uuid(), name: n, createdAt: Date.now() }
      projects.set(p.id, p)
      emit({ type: "archive-changed" })
      return delay(clone(p))
    },
    renameProject: async (id, name) => {
      const p = projects.get(id)
      if (!p) return fail("not_found", "Project not found.")
      if (!name.trim()) return fail("invalid_input", "A name is required.")
      p.name = name.trim()
      emit({ type: "archive-changed" })
      return delay(undefined)
    },
    deleteProject: async (id) => {
      projects.delete(id)
      for (const it of items.values()) if (it.projectId === id) it.projectId = null
      emit({ type: "archive-changed" })
      return delay(undefined)
    },

    listDownloads: async () =>
      delay(
        [...tasks.values()]
          .map((task) => {
            const asset = assets.get(task.assetId)
            const job = asset && jobs.get(asset.jobId)
            return asset && job ? { task: clone(task), asset: clone(asset), job: clone(job) } : null
          })
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .sort((a, b) => b.task.updatedAt - a.task.updatedAt)
      ),
    retryDownload: async (assetId) => {
      const asset = assets.get(assetId)
      if (!asset) return fail("not_found", "File not found.")
      const task =
        tasks.get(assetId) ??
        ({ id: uuid(), assetId, status: "pending", bytesDownloaded: 0, totalBytes: asset.sizeBytes, retryCount: 0, nextAttemptAt: null, lastError: null, lastErrorCode: null, updatedAt: Date.now() } satisfies DownloadTask)
      tasks.set(assetId, task)
      if (task.lastErrorCode === "expired") {
        task.lastError = "The provider link has expired. Regenerate to get a new file."
        task.updatedAt = Date.now()
        emit({ type: "archive-changed" })
        return fail("provider_error", task.lastError)
      }
      Object.assign(task, { status: "pending", lastError: null, lastErrorCode: null, retryCount: task.retryCount + 1, updatedAt: Date.now() })
      asset.downloadStatus = "pending"
      emit({ type: "archive-changed" })
      later(stepMs / 3, () => runDownload(assetId))
      return delay(undefined)
    },
    pauseDownload: async (assetId) => {
      const task = tasks.get(assetId)
      const asset = assets.get(assetId)
      if (task && asset && (task.status === "downloading" || task.status === "pending")) {
        task.status = "paused"
        asset.downloadStatus = "paused"
        emit({ type: "archive-changed" })
      }
      return delay(undefined)
    },
    resumeDownload: async (assetId) => {
      const task = tasks.get(assetId)
      if (task?.status === "paused") {
        task.status = "pending"
        emit({ type: "archive-changed" })
        later(stepMs / 3, () => runDownload(assetId))
      }
      return delay(undefined)
    },

    listPrompts: async (query = {}) => {
      const search = query.search?.trim().toLowerCase()
      return delay(
        [...prompts.values()]
          .filter(
            (p) =>
              (!query.categoryId || p.categoryId === query.categoryId) &&
              (!query.favorite || p.favorite) &&
              (!query.tag || p.tags.includes(query.tag)) &&
              (!search || `${p.title} ${p.body} ${p.tags.join(" ")}`.toLowerCase().includes(search))
          )
          .sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title))
          .map(clone)
      )
    },
    getPrompt: async (id) => delay(prompts.has(id) ? clone(prompts.get(id)!) : null),
    createPrompt: async (input) => {
      let clean
      try {
        clean = cleanPromptInput(input)
      } catch (e) {
        return Promise.reject(e)
      }
      const now = Date.now()
      const p: Prompt = {
        ...clean,
        sourceJobId: clean.sourceJobId ?? null,
        id: uuid(),
        version: 1,
        builtIn: false,
        createdAt: now,
        updatedAt: now,
      }
      prompts.set(p.id, p)
      versions.set(p.id, [snapshot(p)])
      emit({ type: "prompts-changed" })
      return delay(clone(p))
    },
    updatePrompt: async (id, input) => {
      const p = prompts.get(id)
      if (!p) return fail("not_found", "Prompt not found.")
      let clean
      try {
        clean = cleanPromptInput(input)
      } catch (e) {
        return Promise.reject(e)
      }
      Object.assign(p, clean, { sourceJobId: p.sourceJobId, version: p.version + 1, updatedAt: Math.max(Date.now(), p.updatedAt + 1) })
      versions.get(id)!.push(snapshot(p))
      emit({ type: "prompts-changed" })
      return delay(clone(p))
    },
    duplicatePrompt: async (id) => {
      const p = prompts.get(id)
      if (!p) return fail("not_found", "Prompt not found.")
      const now = Date.now()
      const copy: Prompt = { ...clone(p), id: uuid(), title: `${p.title} (copy)`, version: 1, builtIn: false, createdAt: now, updatedAt: now }
      prompts.set(copy.id, copy)
      versions.set(copy.id, [snapshot(copy)])
      emit({ type: "prompts-changed" })
      return delay(clone(copy))
    },
    deletePrompt: async (id) => {
      prompts.delete(id)
      versions.delete(id)
      emit({ type: "prompts-changed" })
      return delay(undefined)
    },
    setPromptFavorite: async (id, favorite) => {
      const p = prompts.get(id)
      if (p) p.favorite = favorite
      emit({ type: "prompts-changed" })
      return delay(undefined)
    },
    listPromptVersions: async (promptId) => delay([...(versions.get(promptId) ?? [])].reverse().map(clone)),
    restorePromptVersion: async (promptId, version) => {
      const p = prompts.get(promptId)
      const v = versions.get(promptId)?.find((x) => x.version === version)
      if (!p || !v) return fail("not_found", "Version not found.")
      Object.assign(p, {
        title: v.title,
        body: v.body,
        tags: [...v.tags],
        preferredModelIds: [...v.preferredModelIds],
        parameters: clone(v.parameters),
        variableDefaults: { ...v.variableDefaults },
        version: p.version + 1,
        updatedAt: Math.max(Date.now(), p.updatedAt + 1),
      })
      versions.get(promptId)!.push(snapshot(p))
      emit({ type: "prompts-changed" })
      return delay(clone(p))
    },
    listCategories: () =>
      delay(
        [...categories.values()]
          .sort((a, b) => Number(b.builtIn) - Number(a.builtIn) || a.name.localeCompare(b.name))
          .map(clone)
      ),
    createCategory: async (name) => {
      const n = name.trim()
      if (!n) return fail("invalid_input", "A name is required.")
      if ([...categories.values()].some((c) => c.name.toLowerCase() === n.toLowerCase()))
        return fail("invalid_input", "A category with this name already exists.")
      const c: PromptCategory = { id: uuid(), name: n, builtIn: false, createdAt: Date.now() }
      categories.set(c.id, c)
      emit({ type: "prompts-changed" })
      return delay(clone(c))
    },
    renameCategory: async (id, name) => {
      const c = categories.get(id)
      if (!c || c.builtIn) return fail("invalid_input", "Built-in categories cannot be renamed.")
      if (!name.trim()) return fail("invalid_input", "A name is required.")
      c.name = name.trim()
      emit({ type: "prompts-changed" })
      return delay(undefined)
    },
    deleteCategory: async (id) => {
      const c = categories.get(id)
      if (!c || c.builtIn) return fail("invalid_input", "Built-in categories cannot be deleted.")
      categories.delete(id)
      for (const p of prompts.values()) if (p.categoryId === id) p.categoryId = null
      emit({ type: "prompts-changed" })
      return delay(undefined)
    },
    exportPrompts: async (ids) => {
      const list = [...prompts.values()].filter((p) => !ids || ids.includes(p.id))
      const used = new Set(list.map((p) => p.categoryId).filter(Boolean))
      const data = {
        format: "vidra.prompts",
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        categories: [...categories.values()].filter((c) => used.has(c.id)).map((c) => ({ name: c.name })),
        prompts: list.map((p) => ({
          title: p.title,
          body: p.body,
          category: p.categoryId ? (categories.get(p.categoryId)?.name ?? null) : null,
          tags: p.tags,
          favorite: p.favorite,
          preferredModelIds: p.preferredModelIds,
          parameters: p.parameters,
          variableDefaults: p.variableDefaults,
        })),
      }
      if (typeof document !== "undefined")
        download("vidra-prompts.json", new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }))
      return delay(true)
    },
    importPrompts: async () => {
      const file = await pickFile("application/json,.json")
      if (!file) return null
      let parsed
      try {
        parsed = parsePromptExport(await file.text())
      } catch (e) {
        return fail("invalid_input", e instanceof Error ? e.message : "Invalid file.")
      }
      let imported = 0
      let skipped = 0
      for (const c of parsed.categories)
        if (![...categories.values()].some((x) => x.name === c.name)) {
          const id = uuid()
          categories.set(id, { id, name: c.name, builtIn: false, createdAt: Date.now() })
        }
      for (const p of parsed.prompts) {
        if ([...prompts.values()].some((x) => x.title === p.title && x.body === p.body)) {
          skipped++
          continue
        }
        const cat = [...categories.values()].find((c) => c.name === p.category)
        await ipc.createPrompt({ ...p, categoryId: cat?.id ?? null })
        imported++
      }
      emit({ type: "prompts-changed" })
      return { imported, skipped }
    },
    savePromptFromJob: async (jobId, title) => {
      const job = jobs.get(jobId)
      if (!job) return fail("not_found", "Job not found.")
      return ipc.createPrompt({
        title,
        body: job.prompt,
        categoryId: null,
        tags: [],
        favorite: false,
        preferredModelIds: [job.modelId],
        parameters: Object.fromEntries(Object.entries(job.params).filter(([, v]) => !Array.isArray(v))),
        variableDefaults: {},
        sourceJobId: job.id,
      })
    },

    exportArchive: () => delay(`C:\\Users\\Demo\\Documents\\vidra-backup-${new Date().toISOString().slice(0, 10)}.vidra`, 400),
    previewImport: async () => {
      const token = uuid()
      pendingImports.add(token)
      return delay(
        {
          token,
          formatVersion: 1,
          createdAt: Date.now(),
          jobCount: jobs.size,
          assetCount: assets.size,
          promptCount: prompts.size,
          totalBytes: storageStats().usedBytes,
          duplicateCount: assets.size,
          warnings: ["Browser preview: this backup is a copy of the current demo data, so every item is a duplicate."],
        },
        300
      )
    },
    confirmImport: async (token) => {
      if (!pendingImports.delete(token)) return fail("not_found", "This import is no longer pending.")
      return delay({ importedJobs: 0, importedAssets: 0, importedPrompts: 0, skippedDuplicates: assets.size }, 300)
    },
    cancelImport: async (token) => {
      pendingImports.delete(token)
      return delay(undefined)
    },
  }

  return {
    ipc,
    onStoreEvent: async (handler) => {
      storeHandlers.add(handler)
      return () => storeHandlers.delete(handler)
    },
    onFilesDropped: async (handler) => {
      dropHandlers.add(handler)
      return () => dropHandlers.delete(handler)
    },
    control: {
      emitDrop: (files) => {
        const list = files.map((f) => {
          const token = uuid()
          drops.set(token, { name: f.name, kind: f.kind, dataUrl: f.dataUrl ?? null })
          return { token, name: f.name, kind: f.kind }
        })
        dropHandlers.forEach((h) => h(list))
      },
      failNextGeneration: (code = "provider_error") => {
        failNextGeneration = code
      },
      failNextSubmit: (code) => {
        failNextSubmit = code
      },
      jobs: () => [...jobs.values()].map(clone),
      setStorageAvailable: (available) => {
        storage.available = available
        emit({ type: "settings-changed" })
      },
      failNextMove: (paths) => {
        failMovePaths = [...paths]
      },
      lastFinalize: () => lastFinalize,
      dispose: () => {
        timers.forEach(clearTimeout)
        timers.clear()
        storeHandlers.clear()
        dropHandlers.clear()
        if (typeof window !== "undefined") {
          window.removeEventListener("drop", onWindowDrop)
          window.removeEventListener("dragover", onDragOver)
        }
      },
    },
  }
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
