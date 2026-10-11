import type { BudgetSettings, GenerationJob } from "./types"

/**
 * Application-level spending guard. Works only on estimates Vidra recorded
 * locally; it is NOT a provider-side billing cap. The Rust backend runs the
 * same rules (src-tauri/src/budget.rs) at submit time; both are tested
 * against the same fixtures.
 */

export interface BudgetWindowUsage {
  /** Sum of known estimates in the window (USD). */
  estimatedUsd: number
  /** Jobs in the window whose cost is unknown (budget is then incomplete). */
  unknownCount: number
}

export interface BudgetCheck {
  allowed: boolean
  /** Which limits would be exceeded. */
  exceeded: Array<"daily" | "monthly">
  /** Limits whose warning threshold would be reached. */
  warnings: Array<"daily" | "monthly">
  daily: BudgetWindowUsage
  monthly: BudgetWindowUsage
  /** Cost of this request is unknown, so the check could not be exact. */
  incomplete: boolean
}

/** Jobs that count toward spending: anything that may have been billed.
    Failed/canceled/blocked are excluded only because providers document that
    such requests are not charged — they stay visible in analytics as
    "unconfirmed". */
function counts(job: GenerationJob): boolean {
  return job.status !== "failed" && job.status !== "canceled" && job.status !== "blocked"
}

export function startOfLocalDay(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

export function startOfLocalMonth(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime()
}

export function usageSince(jobs: readonly GenerationJob[], since: number): BudgetWindowUsage {
  let estimatedUsd = 0
  let unknownCount = 0
  for (const job of jobs) {
    if (job.createdAt < since || !counts(job)) continue
    const cost = job.confirmedCostUsd ?? job.estimatedCostUsd
    if (cost == null) unknownCount += 1
    else estimatedUsd += cost
  }
  return { estimatedUsd: round(estimatedUsd), unknownCount }
}

export function checkBudget(
  jobs: readonly GenerationJob[],
  requestUsd: number | null,
  budget: BudgetSettings,
  now: Date = new Date()
): BudgetCheck {
  const daily = usageSince(jobs, startOfLocalDay(now))
  const monthly = usageSince(jobs, startOfLocalMonth(now))
  const add = requestUsd ?? 0
  const exceeded: BudgetCheck["exceeded"] = []
  const warnings: BudgetCheck["warnings"] = []
  const evaluate = (name: "daily" | "monthly", used: number, limit: number | null) => {
    if (limit == null) return
    const projected = used + add
    if (projected > limit + 1e-9) exceeded.push(name)
    else if (projected >= (limit * budget.warnAtPercent) / 100) warnings.push(name)
  }
  evaluate("daily", daily.estimatedUsd, budget.dailyLimitUsd)
  evaluate("monthly", monthly.estimatedUsd, budget.monthlyLimitUsd)
  return {
    allowed: exceeded.length === 0,
    exceeded,
    warnings,
    daily,
    monthly,
    incomplete: requestUsd == null || daily.unknownCount > 0 || monthly.unknownCount > 0,
  }
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6
}
