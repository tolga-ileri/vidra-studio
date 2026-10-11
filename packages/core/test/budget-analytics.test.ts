import { describe, expect, it } from "vitest"

import {
  byModel,
  byMonth,
  byProvider,
  checkBudget,
  csvField,
  dailySeries,
  jobsToCsv,
  summarize,
  usageSince,
  weekKey,
} from "../src"
import { DEFAULT_BUDGET } from "../src/types"
import { job } from "./fixtures"

const NOW = new Date(2026, 9, 10, 18)
const today = (h: number) => new Date(2026, 9, 10, h).getTime()
const earlierThisMonth = new Date(2026, 9, 2, 10).getTime()
const lastMonth = new Date(2026, 8, 28, 10).getTime()

describe("spending and budget", () => {
  const jobs = [
    job({ createdAt: today(9), estimatedCostUsd: 1.5 }),
    job({ createdAt: today(10), estimatedCostUsd: 0.5, status: "generating" }),
    job({ createdAt: today(11), estimatedCostUsd: 2, status: "failed" }),
    job({ createdAt: today(12), estimatedCostUsd: 3, status: "canceled" }),
    job({ createdAt: today(13), estimatedCostUsd: null }),
    job({ createdAt: earlierThisMonth, estimatedCostUsd: 4 }),
    job({ createdAt: lastMonth, estimatedCostUsd: 100 }),
  ]

  it("sums only jobs that may have been billed and counts unknown costs", () => {
    expect(usageSince(jobs, new Date(2026, 9, 10).getTime())).toEqual({
      estimatedUsd: 2,
      unknownCount: 1,
    })
    expect(usageSince(jobs, new Date(2026, 9, 1).getTime()).estimatedUsd).toBe(6)
  })

  it("prefers a provider-confirmed amount over the estimate", () => {
    expect(
      usageSince([job({ createdAt: today(9), estimatedCostUsd: 1, confirmedCostUsd: 0.8 })], 0)
        .estimatedUsd
    ).toBe(0.8)
  })

  it("blocks when the projected daily spend exceeds the limit", () => {
    const check = checkBudget(jobs, 1, { ...DEFAULT_BUDGET, dailyLimitUsd: 2.5 }, NOW)
    expect(check.allowed).toBe(false)
    expect(check.exceeded).toEqual(["daily"])
  })

  it("allows exactly reaching the limit and warns at the threshold", () => {
    const check = checkBudget(jobs, 0.5, { ...DEFAULT_BUDGET, dailyLimitUsd: 2.5, warnAtPercent: 80 }, NOW)
    expect(check.allowed).toBe(true)
    expect(check.warnings).toEqual(["daily"])
  })

  it("enforces the monthly limit independently", () => {
    const check = checkBudget(jobs, 5, { ...DEFAULT_BUDGET, monthlyLimitUsd: 10 }, NOW)
    expect(check.exceeded).toEqual(["monthly"])
  })

  it("never blocks without limits, but flags unknown request cost", () => {
    const check = checkBudget(jobs, null, DEFAULT_BUDGET, NOW)
    expect(check.allowed).toBe(true)
    expect(check.incomplete).toBe(true)
  })
})

describe("analytics", () => {
  it("separates estimated, confirmed, unknown and failed-job estimates", () => {
    const s = summarize(
      [
        job({ estimatedCostUsd: 1 }),
        job({ estimatedCostUsd: 2, confirmedCostUsd: 1.8 }),
        job({ estimatedCostUsd: null }),
        job({ status: "failed", estimatedCostUsd: 3 }),
        job({ status: "canceled", estimatedCostUsd: 4 }),
        job({ status: "queued", estimatedCostUsd: 0.5 }),
      ],
      []
    )
    expect(s.total).toBe(6)
    expect(s.succeeded).toBe(3)
    expect(s.failed).toBe(1)
    expect(s.canceled).toBe(1)
    expect(s.inProgress).toBe(1)
    expect(s.estimatedUsd).toBe(3.5)
    expect(s.confirmedUsd).toBe(1.8)
    expect(s.unknownCostCount).toBe(1)
    expect(s.unconfirmedFailedEstimateUsd).toBe(7)
    expect(s.successRate).toBeCloseTo(3 / 5)
    expect(s.averageEstimatedUsd).toBe(1.5)
  })

  it("uses actual output duration when known, else requested", () => {
    const a = job({ requestedDurationSec: 5 })
    const b = job({ requestedDurationSec: 10 })
    const s = summarize([a, b], [
      {
        id: "x", jobId: a.id, outputIndex: 0, kind: "video", originalUrl: "", localPath: null,
        filename: "", mimeType: null, sizeBytes: null, sha256: null, durationSec: 5.04,
        width: null, height: null, thumbnailPath: null, downloadStatus: "saved",
        duplicateOfAssetId: null, createdAt: 0,
      },
    ])
    expect(s.outputDurationSec).toBeCloseTo(15.04)
  })

  it("handles an empty history without dividing by zero", () => {
    const s = summarize([])
    expect(s.successRate).toBeNull()
    expect(s.averageEstimatedUsd).toBeNull()
  })

  it("groups by model, provider, month and fills daily gaps", () => {
    const jobs = [
      job({ modelId: "replicate:a", provider: "replicate", createdAt: new Date(2026, 9, 1).getTime() }),
      job({ modelId: "replicate:a", provider: "replicate", createdAt: new Date(2026, 9, 3).getTime() }),
      job({ modelId: "kling:b", provider: "kling", createdAt: new Date(2026, 8, 3).getTime() }),
    ]
    expect(byModel(jobs).map((b) => [b.key, b.total])).toEqual([["replicate:a", 2], ["kling:b", 1]])
    expect(byProvider(jobs)[0]).toMatchObject({ key: "replicate", estimatedUsd: 2 })
    expect(byMonth(jobs).map((b) => b.key)).toEqual(["2026-09", "2026-10"])
    const series = dailySeries(jobs, new Date(2026, 9, 1).getTime(), new Date(2026, 9, 4).getTime())
    expect(series.map((b) => b.total)).toEqual([1, 0, 1, 0])
  })

  it("computes ISO week keys", () => {
    expect(weekKey(new Date(2026, 0, 1).getTime())).toBe("2026-W01")
    expect(weekKey(new Date(2027, 0, 1).getTime())).toBe("2026-W53")
  })
})

describe("CSV export", () => {
  it("escapes quotes, commas and newlines", () => {
    expect(csvField('a "b", c\nd')).toBe('"a ""b"", c\nd"')
  })

  it("neutralizes spreadsheet formula injection", () => {
    expect(csvField("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"")
    expect(csvField("+1")).toBe("'+1")
    expect(csvField("@cmd")).toBe("'@cmd")
  })

  it("exports estimated and confirmed costs in separate columns", () => {
    const csv = jobsToCsv([job({ estimatedCostUsd: 1.25, confirmedCostUsd: null, prompt: "=evil()" })])
    const [header, row] = csv.trim().split("\r\n")
    expect(header).toContain("estimated_cost_usd")
    expect(header).toContain("confirmed_cost_usd")
    expect(row).toContain(",1.25,provider,,")
    expect(row).toContain("'=evil()")
  })
})
