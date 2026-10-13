import { fireEvent, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { GenerationJob } from "@vidra/core"

import { renderApp } from "./helpers"

describe("Prompt Library", () => {
  it("shows template variables with a live preview in the editor and saves", async () => {
    const { user, backend } = await renderApp("#/prompts")
    await user.click(await screen.findByTestId("new-prompt"))
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Rooftop chase" } })
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "A chase across rooftops in {city} at {time}" } })
    fireEvent.change(await screen.findByLabelText("City"), { target: { value: "Istanbul" } })
    expect(screen.getByTestId("prompt-preview")).toHaveTextContent("A chase across rooftops in Istanbul at {time}")
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "dusk" } })
    expect(screen.getByTestId("prompt-preview")).toHaveTextContent("A chase across rooftops in Istanbul at dusk")
    await user.click(screen.getByTestId("save-prompt"))
    await waitFor(async () => {
      const list = await backend.ipc.listPrompts({ search: "Rooftop chase" })
      expect(list).toHaveLength(1)
      expect(list[0]!.variableDefaults).toEqual({ city: "Istanbul", time: "dusk" })
    })
  })

  it("restores an earlier version from the history drawer", async () => {
    const { user, backend } = await renderApp("#/prompts", {
      before: async (b) => {
        const p = await b.ipc.createPrompt({
          title: "Original title",
          body: "First body",
          categoryId: null,
          tags: [],
          favorite: false,
          preferredModelIds: [],
          parameters: {},
          variableDefaults: {},
        })
        await b.ipc.updatePrompt(p.id, { ...p, title: "Changed title", body: "Second body" })
      },
    })
    // Wait for the specific row: the list can render seeded prompts first.
    const row = await waitFor(() => {
      const found = screen
        .getAllByRole("listitem")
        .find((li) => li.getAttribute("data-prompt-title") === "Changed title")
      if (!found) throw new Error("row not rendered yet")
      return found
    })
    await user.click(within(row).getByRole("button", { name: /actions for changed title/i }))
    await user.click(await screen.findByRole("menuitem", { name: /version history/i }))
    const versions = await screen.findByTestId("versions")
    await waitFor(() => expect(within(versions).getAllByRole("listitem")).toHaveLength(2))
    await user.click(within(versions).getByRole("button", { name: /restore this version/i }))
    await waitFor(async () => {
      const [p] = await backend.ipc.listPrompts({ search: "Original title" })
      expect(p?.body).toBe("First body")
      expect(p?.version).toBe(3)
    })
  })
})

describe("Archive", () => {
  it("filters favorites, multi-selects, trashes and restores", async () => {
    const { user, backend } = await renderApp("#/archive", { seedDemo: true })
    const grid = await screen.findByTestId("archive-grid")
    const total = within(grid).getAllByRole("listitem").length
    expect(total).toBeGreaterThan(3)
    // All nine states have labels; the seeded set shows several of them.
    expect(grid.querySelector('[data-state="saved"]')).not.toBeNull()
    expect(grid.querySelector('[data-state="generation_failed"]')).not.toBeNull()
    expect(grid.querySelector('[data-state="download_failed"]')).not.toBeNull()

    await user.click(screen.getByRole("button", { name: "Favorites" }))
    await waitFor(() => expect(within(screen.getByTestId("archive-grid")).getAllByRole("listitem")).toHaveLength(1))
    await user.click(screen.getByRole("button", { name: "All media" }))
    await waitFor(() => expect(within(screen.getByTestId("archive-grid")).getAllByRole("listitem")).toHaveLength(total))

    const boxes = within(screen.getByTestId("archive-grid")).getAllByRole("checkbox")
    await user.click(boxes[0]!)
    await user.click(boxes[1]!)
    const toolbar = screen.getByRole("toolbar", { name: /selection/i })
    expect(toolbar).toHaveTextContent("2 selected")
    await user.click(within(toolbar).getByRole("button", { name: /move to trash/i }))
    await waitFor(() => expect(within(screen.getByTestId("archive-grid")).getAllByRole("listitem")).toHaveLength(total - 2))

    await user.click(screen.getByRole("button", { name: "Trash" }))
    const trash = await screen.findByTestId("archive-grid")
    await waitFor(() => expect(within(trash).getAllByRole("listitem")).toHaveLength(2))
    for (const box of within(screen.getByTestId("archive-grid")).getAllByRole("checkbox")) await user.click(box)
    await user.click(within(screen.getByRole("toolbar", { name: /selection/i })).getByRole("button", { name: /restore/i }))
    await waitFor(async () => expect(await backend.ipc.listArchive({ trashed: true })).toHaveLength(0))
    expect(await screen.findByText(/trash is empty/i)).toBeInTheDocument()
  })
})

function job(over: Partial<GenerationJob>): GenerationJob {
  const now = Date.now()
  return {
    id: Math.random().toString(16).slice(2),
    provider: "replicate",
    modelId: "replicate:demo/cinema-t2v",
    modelName: "Demo Cinema",
    workflow: "text-to-video",
    output: "video",
    providerRequestId: "r",
    status: "completed",
    prompt: "p",
    negativePrompt: null,
    params: {},
    requestedDurationSec: 8,
    estimatedCostUsd: 1.6,
    estimateSource: "published_rate",
    confirmedCostUsd: null,
    errorCode: null,
    errorMessage: null,
    promptId: null,
    projectId: null,
    references: [],
    preserveIdentity: false,
    createdAt: now - 3600000,
    updatedAt: now,
    completedAt: now,
    ...over,
  }
}

describe("Analytics", () => {
  it("shows no invented numbers when there is no activity", async () => {
    await renderApp("#/analytics")
    expect(await screen.findByText(/no activity in this range/i)).toBeInTheDocument()
    const kpis = screen.getByTestId("kpis")
    const value = (label: string) => kpis.querySelector(`[data-kpi="${label}"] dd`)?.textContent
    expect(value("Generations")).toBe("0")
    expect(value("Estimated spend")).toBe("—")
    expect(value("Confirmed spend")).toBe("—")
    expect(value("Success rate")).toBe("—")
    expect(value("Average estimate")).toBe("—")
    expect(screen.getByTestId("export-csv")).toBeDisabled()
  })

  it("reports estimated and confirmed spend separately and counts unknown costs", async () => {
    const fixtures = [
      job({ estimatedCostUsd: 1.6, confirmedCostUsd: 1.5 }),
      job({ estimatedCostUsd: 0.4 }),
      job({ estimatedCostUsd: null, estimateSource: null }),
      job({ status: "failed", estimatedCostUsd: 0.8 }),
    ]
    await renderApp("#/analytics", {
      before: (b) => {
        b.ipc.listJobs = async () => fixtures
      },
    })
    const kpis = await screen.findByTestId("kpis")
    const value = (label: string) => kpis.querySelector(`[data-kpi="${label}"] dd`)?.textContent
    await waitFor(() => expect(value("Generations")).toBe("4"))
    expect(value("Estimated spend")).toBe("$2.00")
    expect(value("Confirmed spend")).toBe("$1.50")
    expect(value("Unknown cost")).toBe("1")
    expect(screen.getByText(/belongs to failed or canceled jobs/i)).toBeInTheDocument()
  })
})
