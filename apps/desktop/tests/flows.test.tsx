import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { FIXTURE_IDS } from "@/lib/mock-fixtures"
import { renderApp } from "./helpers"

async function typePrompt(text: string) {
  fireEvent.change(await screen.findByTestId("prompt-input"), { target: { value: text } })
}

describe("pricing", () => {
  it("shows outdated pricing as unavailable with the reason and a pricing link", async () => {
    await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.archived } })
    const box = await screen.findByTestId("studio-estimate")
    await waitFor(() => expect(within(box).getByTestId("price-unavailable")).toHaveTextContent("Pricing unavailable. This generation may incur charges."))
    expect(within(box).getByText("The published price is outdated and must be re-verified.")).toBeInTheDocument()
    expect(within(box).getByRole("button", { name: "Open pricing page" })).toBeInTheDocument()
  })

  it("requires an explicit acknowledgement for unknown pricing and sends it", async () => {
    const { user, backend } = await renderApp("#/video", {
      lastModel: { output: "video", id: FIXTURE_IDS.archived },
      before: async (b) => {
        await b.ipc.updateSettings({ budget: { dailyLimitUsd: null, monthlyLimitUsd: null, warnAtPercent: 80, confirmBeforeGenerate: false } })
      },
    })
    const spy = vi.spyOn(backend.ipc, "submitGeneration")
    await typePrompt("Rain over a harbour")
    await user.click(screen.getByTestId("generate-button"))
    const dialog = await screen.findByTestId("confirm-generate")
    expect(within(dialog).getByText("Pricing unavailable. This generation may incur charges.")).toBeInTheDocument()
    const confirm = within(dialog).getByTestId("confirm-generate-button")
    expect(confirm).toBeDisabled()
    await user.click(within(dialog).getByRole("checkbox"))
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(spy.mock.calls[0]![1].acknowledgeUnknownCost).toBe(true)
    await waitFor(() => expect(backend.mock!.control.jobs()).toHaveLength(1))
  })

  it("rejects a submit without acknowledgement in the backend and reopens the dialog", async () => {
    const { user, backend } = await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.archived } })
    await expect(
      backend.ipc.submitGeneration(
        { modelId: FIXTURE_IDS.archived, prompt: "x", negativePrompt: null, params: { duration: 5 } },
        { idempotencyKey: "k", confirmedEstimateUsd: null, acknowledgeUnknownCost: false, promptId: null, projectId: null }
      )
    ).rejects.toMatchObject({ code: "unknown_cost_ack_required" })
    // The first estimate wrongly reports a USD price, so the UI skips the
    // acknowledgement; the backend then insists on it.
    const real = backend.ipc.estimateGeneration
    let first = true
    backend.ipc.estimateGeneration = vi.fn(async (input) => {
      const e = await real(input)
      if (first) {
        first = false
        return { ...e, status: "estimated" as const, amount: 0.4, currency: "USD" as const, usd: 0.4, source: "published_rate" as const, reason: null }
      }
      return e
    })
    await backend.ipc.updateSettings({ budget: { dailyLimitUsd: null, monthlyLimitUsd: null, warnAtPercent: 80, confirmBeforeGenerate: false } })
    await typePrompt("Fog")
    await user.click(screen.getByTestId("generate-button"))
    expect(await screen.findByTestId("cost-ack")).toBeInTheDocument()
  })

  it("shows provider credits without converting them to USD", async () => {
    await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.units } })
    const box = await screen.findByTestId("studio-estimate")
    await waitFor(() => expect(within(box).getByTestId("price-amount")).toHaveTextContent("≈ 5 Kling units"))
    expect(box.textContent).not.toContain("$")
    expect(within(box).getByText("Provider units are never converted to money.")).toBeInTheDocument()
  })

  it("shows the source and verified date of a published rate", async () => {
    await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.cinema } })
    const box = await screen.findByTestId("studio-estimate")
    await waitFor(() => expect(within(box).getByTestId("price-amount")).toHaveTextContent("$0.50"))
    expect(within(box).getByText(/^Published rate · verified /)).toBeInTheDocument()
  })
})

describe("studio capabilities", () => {
  it("shows the actual max duration and notifies when a duration is clamped on model switch", async () => {
    const { user } = await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.cinema } })
    expect(await screen.findByTestId("max-duration")).toHaveTextContent("Max duration: 30 s")
    await user.click(within(screen.getByTestId("dynamic-form")).getByRole("radio", { name: "30 s" }))
    await user.click(screen.getByTestId("model-picker"))
    await user.click(await screen.findByRole("option", { name: /Demo Units/ }))
    const notice = await screen.findByTestId("switch-notice")
    expect(notice).toHaveTextContent("Some settings changed for Demo Units")
    expect(notice).toHaveTextContent("Duration: 30 s → 10 s (this model allows at most 10 s)")
    expect(screen.getByTestId("max-duration")).toHaveTextContent("Max duration: 10 s")
  })

  it("exposes the maximum number of image outputs", async () => {
    await renderApp("#/image", { lastModel: { output: "image", id: FIXTURE_IDS.still } })
    expect(await screen.findByTestId("max-outputs")).toHaveTextContent("Up to 4 outputs")
    expect(document.querySelector('[data-param-key="num_outputs"]')).not.toBeNull()
  })

  it("fills reference slots up to the maximum, then rejects further files", async () => {
    const { user, backend } = await renderApp("#/video", { lastModel: { output: "video", id: FIXTURE_IDS.motion } })
    for (let i = 0; i < 4; i++) {
      await user.click(await screen.findByTestId("add-reference_images"))
      await waitFor(() => expect(screen.getByTestId("count-reference_images")).toHaveTextContent(`${i + 1}/4`))
    }
    expect(screen.queryByTestId("add-reference_images")).toBeNull()
    // A dropped file in an unaccepted format is rejected with the accepted list.
    backend.mock!.control.emitDrop([{ name: "extra.gif", kind: "image" }])
    expect(await screen.findByText("extra.gif is not an accepted format (JPG, PNG, WEBP).")).toBeInTheDocument()
  })
})

describe("catalog", () => {
  it("checks for new models, summarizes the result and keeps update-required models out of the studios", async () => {
    const { user } = await renderApp("#/models", { seedDemo: true })
    const future = await screen.findByText("Demo Future")
    const card = future.closest("li") as HTMLElement
    expect(card).toHaveAttribute("data-catalog-state", "update_required")
    expect(within(card).getByText("Update required")).toBeInTheDocument()
    expect(within(card).getByText("Not available in the studios")).toBeInTheDocument()
    expect(screen.getAllByText("New").length).toBeGreaterThan(0)

    await user.click(screen.getByTestId("catalog-sync"))
    const result = await screen.findByTestId("catalog-result")
    expect(result).toHaveAttribute("data-outcome", "updated")
    expect(result).toHaveTextContent("1 added")
    expect(result).toHaveTextContent("1 updated")
    expect(result).toHaveTextContent("1 need an app update")
    await waitFor(() => expect(screen.getAllByText("Updated").length).toBeGreaterThan(0))

    await user.click(within(card).getAllByRole("button")[0]!)
    expect(await screen.findByRole("button", { name: "Not available in the studios" })).toBeDisabled()
  })

  it("toggles automatic catalog checks in settings", async () => {
    const { user, backend } = await renderApp("#/models")
    await user.click(await screen.findByTestId("catalog-autosync"))
    await waitFor(async () => expect((await backend.ipc.getSettings()).catalogAutoSync).toBe(false))
  })

  it("compares selected models", async () => {
    const { user } = await renderApp("#/models")
    await user.click(await screen.findByRole("checkbox", { name: "Compare Demo Cinema" }))
    await user.click(screen.getByRole("checkbox", { name: "Compare Demo Units" }))
    await user.click(screen.getByTestId("compare-open"))
    const table = await screen.findByTestId("compare-table")
    expect(table).toHaveTextContent("30 s")
    expect(table).toHaveTextContent("≈ 1 Kling units per second")
  })

  it("filters by minimum max duration", async () => {
    const { user } = await renderApp("#/models")
    const grid = await screen.findByTestId("model-grid")
    expect(within(grid).getByText("Demo Units")).toBeInTheDocument()
    await user.click(screen.getByRole("combobox", { name: "Max duration" }))
    await user.click(await screen.findByRole("option", { name: "At least 30 s" }))
    await waitFor(() => expect(within(screen.getByTestId("model-grid")).queryByText("Demo Units")).toBeNull())
    expect(within(screen.getByTestId("model-grid")).getByText("Demo Cinema")).toBeInTheDocument()
  })
})

describe("providers", () => {
  it("lists fal.ai only as planned, pending provider authorization", async () => {
    await renderApp("#/providers")
    expect(document.querySelector('[data-provider="fal"]')).toBeNull()
    const planned = await screen.findByTestId("planned")
    const fal = within(planned).getByText("fal.ai").closest("li") as HTMLElement
    expect(within(fal).getAllByText("Pending provider authorization").length).toBeGreaterThan(0)
    expect(fal.querySelector("img")).toBeNull()
  })
})

describe("storage", () => {
  async function runWizard(user: Awaited<ReturnType<typeof renderApp>>["user"], choice: RegExp) {
    await user.click(await screen.findByTestId("storage-change"))
    const wizard = await screen.findByTestId("storage-wizard")
    await waitFor(() => expect(wizard).toHaveAttribute("data-step", "plan"))
    expect(wizard).toHaveTextContent("The destination is a removable drive")
    await user.click(within(wizard).getByTestId("wizard-start"))
    await waitFor(() => expect(within(wizard).getByTestId("wizard-result")).toBeInTheDocument())
    await user.click(within(wizard).getByTestId("wizard-next"))
    expect(within(wizard).getByTestId("wizard-finish")).toBeDisabled()
    await user.click(within(wizard).getByRole("radio", { name: choice }))
    await user.click(within(wizard).getByTestId("wizard-finish"))
  }

  it("moves the archive and keeps old copies", async () => {
    const { user, backend } = await renderApp("#/settings", { seedDemo: true })
    await runWizard(user, /Keep old copies/)
    await waitFor(() => expect(backend.mock!.control.lastFinalize()?.removeOldCopies).toBe(false))
    await waitFor(() => expect(screen.getByTestId("archive-root")).toHaveTextContent("E:\\Vidra Studio Archive"))
  })

  it("moves the archive and removes verified old copies", async () => {
    const { user, backend } = await renderApp("#/settings", { seedDemo: true })
    await runWizard(user, /Remove old copies \(verified files only\)/)
    await waitFor(() => expect(backend.mock!.control.lastFinalize()?.removeOldCopies).toBe(true))
  })

  it("lists failed files and only allows keeping old copies when the move is incomplete", async () => {
    const { user, backend } = await renderApp("#/settings", { seedDemo: true })
    backend.mock!.control.failNextMove(["media\\demo\\broken.mp4"])
    await user.click(await screen.findByTestId("storage-change"))
    const wizard = await screen.findByTestId("storage-wizard")
    await waitFor(() => expect(wizard).toHaveAttribute("data-step", "plan"))
    await user.click(within(wizard).getByTestId("wizard-start"))
    expect(await within(wizard).findByTestId("wizard-failures")).toHaveTextContent("media\\demo\\broken.mp4")
    await user.click(within(wizard).getByTestId("wizard-next"))
    expect(within(wizard).getByRole("radio", { name: /Remove old copies/ })).toBeDisabled()
    await user.click(within(wizard).getByRole("radio", { name: /Keep old copies/ }))
    await user.click(within(wizard).getByTestId("wizard-finish"))
    await waitFor(() => expect(backend.mock!.control.lastFinalize()?.removeOldCopies).toBe(false))
  })

  it("cancels a move without changing anything", async () => {
    const { user, backend } = await renderApp("#/settings")
    const spy = vi.spyOn(backend.ipc, "cancelArchiveMove")
    await user.click(await screen.findByTestId("storage-change"))
    const wizard = await screen.findByTestId("storage-wizard")
    await waitFor(() => expect(wizard).toHaveAttribute("data-step", "plan"))
    await user.click(within(wizard).getByRole("button", { name: "Cancel move" }))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    expect(backend.mock!.control.lastFinalize()).toBeNull()
  })

  it("shows the unavailable-root banner app-wide and reconnects", async () => {
    const { user } = await renderApp("#/", { storageAvailable: false })
    const banner = await screen.findByTestId("storage-banner")
    expect(banner).toHaveTextContent("Downloads are paused")
    expect(screen.getByTestId("storage-indicator")).toHaveAttribute("data-available", "false")
    await user.click(within(banner).getByRole("button", { name: "Reconnect (folder moved/drive letter changed)" }))
    await waitFor(() => expect(screen.queryByTestId("storage-banner")).toBeNull())
    expect(await screen.findByText("Archive folder reconnected")).toBeInTheDocument()
  })

  it("chooses an export folder", async () => {
    const { user, backend } = await renderApp("#/settings")
    const section = await screen.findByTestId("storage-section")
    await waitFor(() => expect(within(section).getByTestId("export-dir")).toHaveTextContent("System default"))
    await user.click(within(section).getByRole("button", { name: "Choose…" }))
    await waitFor(async () => expect((await backend.ipc.getSettings()).exportDir).toContain("Vidra Exports"))
  })
})
