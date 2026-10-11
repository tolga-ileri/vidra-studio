import { screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { describeError } from "@/lib/errors"
import { IpcError } from "@/lib/ipc"
import { FIXTURE_MODELS } from "@/lib/mock-fixtures"
import { useApp } from "@/lib/store"
import { NAV_LABEL, renderApp } from "./helpers"

/** English UI words that must never appear in Turkish mode. Model names,
    provider names, prompts and other user data are excluded via the
    data-user-content/model-name allowlist below. */
const ENGLISH_WORDS = [
  "Home",
  "Settings",
  "Generate",
  "Models",
  "Archive",
  "Downloads",
  "Providers",
  "Analytics",
  "Pricing",
  "Cancel",
  "Loading",
  "Search",
  "Storage",
  "Language",
  "Estimated",
  "Duration",
  "Resolution",
  "Available",
  "Unavailable",
  "Verified",
  "Not connected",
  "Check for new models",
  "Model catalog",
  "Recent jobs",
  "Prompt",
  "Max duration",
  "Free",
  "Export",
  "Budget",
  "Add credentials",
  "Planned",
  "Pending provider authorization",
]

/** Strings that are data, not UI copy (model/provider names, units from manifests). */
const ALLOWED = [/Demo (Cinema|Motion|Archive Cut|Units|Quote|Still|Retouch|Future)/g, /Kling units/g, /Vidra Studio/g, /Higgsfield|Replicate|Kling AI|fal\.ai/g]

function visibleText(): string {
  let text = document.body.textContent ?? ""
  for (const re of ALLOWED) text = text.replace(re, " ")
  return text
}

const ROUTES = ["#/", "#/video", "#/image", "#/models", "#/archive", "#/generations", "#/downloads", "#/analytics", "#/providers", "#/settings"]

function setNavigatorLanguage(tag: string) {
  Object.defineProperty(navigator, "language", { value: tag, configurable: true })
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, "language")
})

describe("Turkish localization", () => {
  it.each(ROUTES)("renders %s without English UI words", async (route) => {
    await renderApp(route, { language: "tr", seedDemo: true, lastModel: { output: "video", id: "replicate:demo/cinema-t2v" } })
    await waitFor(() => expect(document.querySelector("[data-testid], h1")).not.toBeNull())
    // Let async panels (estimates, catalog, storage) settle.
    await new Promise((r) => setTimeout(r, 700))
    const text = visibleText()
    const found = ENGLISH_WORDS.filter((w) => new RegExp(`(^|[^\\p{L}])${w}([^\\p{L}]|$)`, "u").test(text))
    expect(found, `${route}: ${found.join(", ")}`).toEqual([])
  })

  it("renders Turkish characters", async () => {
    let all = ""
    for (const route of ["#/", "#/video", "#/models", "#/settings", "#/providers"]) {
      await renderApp(route, { language: "tr", seedDemo: true })
      await new Promise((r) => setTimeout(r, 300))
      all += document.body.textContent ?? ""
      document.body.innerHTML = ""
    }
    for (const ch of ["ğ", "ü", "ş", "ı", "ö", "ç", "İ"]) expect(all, ch).toContain(ch)
  })

  it("shows the unavailable pricing notice and storage banner in Turkish", async () => {
    await renderApp("#/video", { language: "tr", storageAvailable: false, lastModel: { output: "video", id: "replicate:demo/archive-t2v" } })
    expect(await screen.findByText("Fiyat doğrulanamadı. Bu üretim ücretli olabilir.")).toBeInTheDocument()
    expect(screen.getByTestId("storage-banner")).toHaveTextContent("Yeniden bağlan (klasör taşındı/sürücü harfi değişti)")
  })

  it("persists the language chosen in Settings", async () => {
    const { user, backend } = await renderApp("#/settings")
    await user.click(await screen.findByRole("combobox", { name: "Language" }))
    await user.click(await screen.findByRole("option", { name: "Türkçe" }))
    await waitFor(async () => expect((await backend.ipc.getSettings()).language).toBe("tr"))
    expect(await screen.findByRole("heading", { name: "Ayarlar" })).toBeInTheDocument()
    expect(screen.getByRole("complementary", { name: NAV_LABEL.tr })).toBeInTheDocument()
  })

  it("defaults to Turkish on first run when the system language is Turkish", async () => {
    setNavigatorLanguage("tr-TR")
    const { backend } = await renderApp("#/", { onboarded: false })
    await waitFor(async () => expect((await backend.ipc.getSettings()).language).toBe("tr"))
    expect(await screen.findByText("Vidra Studio'ya hoş geldiniz", { exact: false })).toBeInTheDocument()
  })

  it("keeps English on first run for other system languages", async () => {
    setNavigatorLanguage("de-DE")
    const { backend } = await renderApp("#/", { onboarded: false })
    await new Promise((r) => setTimeout(r, 200))
    expect((await backend.ipc.getSettings()).language).toBe("en")
  })
})

describe("error localization", () => {
  const withLanguage = (language: "en" | "tr") =>
    useApp.setState({
      models: FIXTURE_MODELS,
      settings: {
        language,
        onboardingCompleted: true,
        autoSave: true,
        downloadConcurrency: 2,
        trashRetentionDays: 30,
        budget: { dailyLimitUsd: null, monthlyLimitUsd: null, warnAtPercent: 80, confirmBeforeGenerate: true },
        archiveRoot: "C:\\Archive",
        exportDir: null,
        catalogAutoSync: true,
      },
    })

  it("maps backend codes and parameter codes to localized messages", () => {
    withLanguage("tr")
    const e = describeError(new IpcError("invalid_input", "Width: must be in steps of 64", { code: "bad_step", field: "width", step: 64 }))
    expect(e.title).toBe("Girdinizi kontrol edin")
    expect(e.description).toBe("Genişlik: 64 adımlarla artmalı.")
    const ack = describeError(new IpcError("unknown_cost_ack_required", "Confirm"))
    expect(ack.description).toBe("Bu üretimin ücreti doğrulanamadı. Ücretli olabileceğini onaylayın.")
    withLanguage("en")
    expect(describeError(new IpcError("storage_unavailable", "x")).description).toMatch(/Downloads are paused/)
  })

  it("falls back to the backend message only for unknown codes", () => {
    withLanguage("tr")
    expect(describeError(new IpcError("unknown", "Raw backend text")).description).toBe("Raw backend text")
  })
})
