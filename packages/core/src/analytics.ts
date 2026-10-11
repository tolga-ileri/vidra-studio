import type { ProviderId } from "./registry"
import type { GenerationJob, MediaAsset } from "./types"

/**
 * Analytics over locally recorded activity only. Estimated and confirmed
 * amounts are always reported separately; unknown costs are counted, never
 * treated as zero.
 */

export interface CostTotals {
  /** Sum of provider/published estimates for jobs that may have been billed. */
  estimatedUsd: number
  /** Sum of amounts the provider explicitly confirmed. */
  confirmedUsd: number
  /** Jobs that may have been billed but have no known cost. */
  unknownCostCount: number
  /** Estimates attached to failed/canceled/blocked jobs. Providers document
      these as not charged, but Vidra cannot confirm it per request. */
  unconfirmedFailedEstimateUsd: number
}

export interface Summary extends CostTotals {
  total: number
  succeeded: number
  failed: number
  canceled: number
  inProgress: number
  /** succeeded / (succeeded + failed + canceled); null with no finished jobs. */
  successRate: number | null
  /** Sum of actual output durations where known, else requested duration. */
  outputDurationSec: number
  /** Average estimate over succeeded jobs with a known estimate. */
  averageEstimatedUsd: number | null
}

export interface Bucket extends CostTotals {
  key: string
  total: number
  succeeded: number
  failed: number
}

const isFailed = (j: GenerationJob) => j.status === "failed" || j.status === "blocked"
const mayBeBilled = (j: GenerationJob) =>
  !(j.status === "failed" || j.status === "canceled" || j.status === "blocked")

export interface DateRange {
  from?: number
  to?: number
}

export function inRange(jobs: readonly GenerationJob[], range: DateRange = {}): GenerationJob[] {
  return jobs.filter(
    (j) => (range.from == null || j.createdAt >= range.from) && (range.to == null || j.createdAt <= range.to)
  )
}

function emptyTotals(): CostTotals {
  return { estimatedUsd: 0, confirmedUsd: 0, unknownCostCount: 0, unconfirmedFailedEstimateUsd: 0 }
}

function addCost(totals: CostTotals, job: GenerationJob): void {
  if (job.confirmedCostUsd != null) totals.confirmedUsd += job.confirmedCostUsd
  if (mayBeBilled(job)) {
    if (job.estimatedCostUsd != null) totals.estimatedUsd += job.estimatedCostUsd
    else if (job.confirmedCostUsd == null) totals.unknownCostCount += 1
  } else if (job.estimatedCostUsd != null) {
    totals.unconfirmedFailedEstimateUsd += job.estimatedCostUsd
  }
}

function roundTotals<T extends CostTotals>(t: T): T {
  t.estimatedUsd = round(t.estimatedUsd)
  t.confirmedUsd = round(t.confirmedUsd)
  t.unconfirmedFailedEstimateUsd = round(t.unconfirmedFailedEstimateUsd)
  return t
}

export function summarize(
  jobs: readonly GenerationJob[],
  assets: readonly MediaAsset[] = []
): Summary {
  const durationByJob = new Map<string, number>()
  for (const asset of assets)
    if (asset.durationSec != null)
      durationByJob.set(asset.jobId, Math.max(durationByJob.get(asset.jobId) ?? 0, asset.durationSec))

  const s: Summary = {
    ...emptyTotals(),
    total: jobs.length,
    succeeded: 0,
    failed: 0,
    canceled: 0,
    inProgress: 0,
    successRate: null,
    outputDurationSec: 0,
    averageEstimatedUsd: null,
  }
  let estimatedSucceeded = 0
  let estimatedSucceededCount = 0
  for (const job of jobs) {
    addCost(s, job)
    if (job.status === "completed") {
      s.succeeded += 1
      if (job.output === "video")
        s.outputDurationSec += durationByJob.get(job.id) ?? job.requestedDurationSec ?? 0
      if (job.estimatedCostUsd != null) {
        estimatedSucceeded += job.estimatedCostUsd
        estimatedSucceededCount += 1
      }
    } else if (isFailed(job)) s.failed += 1
    else if (job.status === "canceled") s.canceled += 1
    else s.inProgress += 1
  }
  const finished = s.succeeded + s.failed + s.canceled
  s.successRate = finished ? s.succeeded / finished : null
  s.averageEstimatedUsd = estimatedSucceededCount ? round(estimatedSucceeded / estimatedSucceededCount) : null
  s.outputDurationSec = round(s.outputDurationSec)
  return roundTotals(s)
}

function groupBy(jobs: readonly GenerationJob[], keyOf: (job: GenerationJob) => string): Bucket[] {
  const map = new Map<string, Bucket>()
  for (const job of jobs) {
    const key = keyOf(job)
    const bucket = map.get(key) ?? { key, total: 0, succeeded: 0, failed: 0, ...emptyTotals() }
    bucket.total += 1
    if (job.status === "completed") bucket.succeeded += 1
    else if (isFailed(job)) bucket.failed += 1
    addCost(bucket, job)
    map.set(key, bucket)
  }
  return [...map.values()].map(roundTotals)
}

const pad = (n: number) => String(n).padStart(2, "0")
export const dayKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const monthKey = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}
/** ISO-8601 week key, e.g. 2026-W41. */
export const weekKey = (t: number) => {
  const d = new Date(t)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86400000 + 1) / 7)
  return `${date.getUTCFullYear()}-W${pad(week)}`
}

export const byDay = (jobs: readonly GenerationJob[]) =>
  groupBy(jobs, (j) => dayKey(j.createdAt)).sort((a, b) => a.key.localeCompare(b.key))
export const byWeek = (jobs: readonly GenerationJob[]) =>
  groupBy(jobs, (j) => weekKey(j.createdAt)).sort((a, b) => a.key.localeCompare(b.key))
export const byMonth = (jobs: readonly GenerationJob[]) =>
  groupBy(jobs, (j) => monthKey(j.createdAt)).sort((a, b) => a.key.localeCompare(b.key))
export const byModel = (jobs: readonly GenerationJob[]) =>
  groupBy(jobs, (j) => j.modelId).sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))
export const byProvider = (jobs: readonly GenerationJob[]) =>
  groupBy(jobs, (j) => j.provider).sort((a, b) => b.total - a.total) as Array<Bucket & { key: ProviderId }>

/** Fills missing days so charts show gaps as zero activity (not zero cost). */
export function dailySeries(jobs: readonly GenerationJob[], from: number, to: number): Bucket[] {
  const buckets = new Map(byDay(jobs).map((b) => [b.key, b]))
  const out: Bucket[] = []
  const cursor = new Date(from)
  cursor.setHours(0, 0, 0, 0)
  for (let guard = 0; cursor.getTime() <= to && guard < 3700; guard++) {
    const key = dayKey(cursor.getTime())
    out.push(buckets.get(key) ?? { key, total: 0, succeeded: 0, failed: 0, ...emptyTotals() })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

/* ── CSV ────────────────────────────────────────────────────────────────── */

/** RFC 4180 field, plus formula-injection guard for spreadsheet apps. */
export function csvField(value: unknown): string {
  if (value == null) return ""
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function jobsToCsv(jobs: readonly GenerationJob[], assets: readonly MediaAsset[] = []): string {
  const duration = new Map<string, number>()
  for (const a of assets) if (a.durationSec != null) duration.set(a.jobId, a.durationSec)
  const header = [
    "created_at",
    "provider",
    "model_id",
    "model_name",
    "status",
    "request_id",
    "requested_duration_sec",
    "output_duration_sec",
    "estimated_cost_usd",
    "estimate_source",
    "confirmed_cost_usd",
    "error_code",
    "prompt",
  ]
  const rows = jobs.map((j) =>
    [
      new Date(j.createdAt).toISOString(),
      j.provider,
      j.modelId,
      j.modelName,
      j.status,
      j.providerRequestId,
      j.requestedDurationSec,
      duration.get(j.id) ?? null,
      j.estimatedCostUsd,
      j.estimateSource,
      j.confirmedCostUsd,
      j.errorCode,
      j.prompt,
    ]
      .map(csvField)
      .join(",")
  )
  return [header.join(","), ...rows].join("\r\n") + "\r\n"
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
