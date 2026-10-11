import type { ModelDefinition, Pricing } from "./registry"
import type { ParamValues } from "./params"
import { evaluate, type RuleContext } from "./rules"

/**
 * Pre-submit cost estimate from a model's documented pricing (mirrored by
 * src-tauri/src/pricing.rs, checked by test/vectors/pricing.json).
 *
 * Never invents a number: anything not covered by a verified formula is
 * "unavailable" with a reason. Credits are never converted to money.
 * When a provider estimate API exists, its answer (fetched natively) is
 * authoritative and this function only reports "provider_estimate".
 */

export type PriceUnavailableReason =
  | "no_price" // not published / not verified
  | "outdated" // verifiedAt older than maxAgeDays
  | "compute_time" // billed by hardware time; no pre-run figure
  | "missing_input" // e.g. duration not chosen
  | "provider_estimate" // must ask the provider (native estimate call)

export type PriceEstimate =
  | {
      status: "estimated"
      amount: number
      currency: "USD" | "credits"
      unitName: string | null
      /** Published "from" price: the real cost may be higher. */
      lowerBound: boolean
      source: string | null
      verifiedAt: string | null
    }
  | { status: "unavailable"; reason: PriceUnavailableReason; pricingPageUrl: string | null }

const DAY = 86_400_000

export function isPricingOutdated(p: Pricing, now: number): boolean {
  if (!p.verifiedAt) return true
  const verified = Date.parse(`${p.verifiedAt}T00:00:00Z`)
  return !Number.isFinite(verified) || now - verified > p.maxAgeDays * DAY
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string") {
    const m = /^(\d+(?:\.\d+)?)/.exec(v.trim())
    if (m) return Number(m[1])
  }
  return null
}

function defaultOf(model: ModelDefinition, key: string): unknown {
  const p = model.params.find((x) => x.key === key)
  return p && "default" in p ? p.default : undefined
}

function valueOf(model: ModelDefinition, values: ParamValues, key: string): unknown {
  return values[key] ?? defaultOf(model, key)
}

export function estimatePrice(
  model: ModelDefinition,
  values: ParamValues,
  now: number,
  ctx: Omit<RuleContext, "values"> = {}
): PriceEstimate {
  const p = model.pricing
  const unavailable = (reason: PriceUnavailableReason): PriceEstimate => ({
    status: "unavailable",
    reason,
    pricingPageUrl: p.pricingPageUrl,
  })
  if (p.status === "provider_estimate") return unavailable("provider_estimate")
  if (p.status === "unavailable" || !p.formula) return unavailable("no_price")
  if (isPricingOutdated(p, now)) return unavailable("outdated")

  const f = p.formula
  if (f.kind === "compute_time") return unavailable("compute_time")

  // Effective values: user values over defaults (rules see the same).
  const effective: ParamValues = { ...values }
  for (const param of model.params)
    if (effective[param.key] === undefined && "default" in param && param.default !== undefined)
      effective[param.key] = param.default as never
  const ruleCtx: RuleContext = { ...ctx, values: effective }

  let rate = f.rate
  let multiplier = 1
  let rateOverridden = false
  for (const adj of p.adjustments) {
    if (!evaluate(adj.when, ruleCtx)) continue
    if (adj.rate !== undefined && !rateOverridden) {
      rate = adj.rate
      rateOverridden = true
    }
    if (adj.multiplier !== undefined) multiplier *= adj.multiplier
  }

  let quantity: number | null
  switch (f.kind) {
    case "per_second":
      quantity = f.fixedSeconds ?? num(valueOf(model, values, f.durationParam ?? "duration"))
      break
    case "per_output": {
      const count = f.countParam ? num(valueOf(model, values, f.countParam)) : 1
      quantity = count
      break
    }
    case "per_megapixel": {
      const w = num(valueOf(model, values, f.widthParam))
      const h = num(valueOf(model, values, f.heightParam))
      const count = f.countParam ? num(valueOf(model, values, f.countParam)) : 1
      quantity = w !== null && h !== null && count !== null ? ((w * h) / 1_000_000) * count : null
      break
    }
    case "per_request":
      quantity = 1
      break
  }
  if (quantity === null || !(quantity > 0)) return unavailable("missing_input")

  const amount = Math.round(rate * multiplier * quantity * 1e6) / 1e6
  return {
    status: "estimated",
    amount,
    currency: p.currency,
    unitName: p.unitName ?? null,
    lowerBound: p.from,
    source: p.source,
    verifiedAt: p.verifiedAt,
  }
}
