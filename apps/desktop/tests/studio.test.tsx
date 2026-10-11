import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import type { ModelDefinition } from "@vidra/core"

import { DynamicForm } from "@/components/studio/dynamic-form"
import { TooltipProvider } from "@/components/ui/tooltip"
import { loadManifestModels } from "@/lib/mock-data"
import { FIXTURE_IDS, FIXTURE_MODELS } from "@/lib/mock-fixtures"
import { renderApp } from "./helpers"

const manifestModels = loadManifestModels()
const models: ModelDefinition[] = [...FIXTURE_MODELS, ...manifestModels.filter((m) => !FIXTURE_MODELS.some((f) => f.id === m.id))]
const byId = (id: string) => FIXTURE_MODELS.find((m) => m.id === id) as ModelDefinition

describe("DynamicForm", () => {
  it("renders exactly the manifest parameters of each model, nothing else", async () => {
    for (const model of models) {
      const { container, unmount } = render(
        <TooltipProvider>
          <DynamicForm model={model} values={{}} onChange={() => undefined} references={{}} onPickReference={async () => undefined} />
        </TooltipProvider>
      )
      const toggle = screen.queryByRole("button", { name: /advanced/i })
      if (toggle) fireEvent.click(toggle)
      const rendered = [...container.querySelectorAll("[data-param-key]")].map((n) => n.getAttribute("data-param-key"))
      expect(rendered.sort(), model.id).toEqual(model.params.map((p) => p.key).sort())
      unmount()
    }
  })
})

async function typePrompt(text: string) {
  const box = await screen.findByTestId("prompt-input")
  fireEvent.change(box, { target: { value: text } })
}

describe("Video Studio", () => {
  it("carries compatible parameters over when switching models", async () => {
    const { user } = await renderApp("#/video")
    const first = byId(FIXTURE_IDS.cinema)
    expect(await screen.findByTestId("model-picker")).toHaveTextContent(first.displayName)

    const ten = within(screen.getByTestId("dynamic-form")).getByRole("radio", { name: "10 s" })
    await user.click(ten)
    expect(ten).toHaveAttribute("data-state", "on")

    await user.click(screen.getByTestId("model-picker"))
    const target = byId(FIXTURE_IDS.units)
    await user.click(await screen.findByRole("option", { name: new RegExp(target.displayName) }))

    await waitFor(() => expect(screen.getByTestId("model-picker")).toHaveTextContent(target.displayName))
    const form = screen.getByTestId("dynamic-form")
    expect(within(form).getByRole("radio", { name: "10 s" })).toHaveAttribute("data-state", "on")
    // resolution exists only on the first model and must disappear.
    expect(form.querySelector('[data-param-key="resolution"]')).toBeNull()
    // Nothing was clamped or reset, so there is no notice.
    expect(screen.queryByTestId("switch-notice")).toBeNull()
  })

  it("asks for confirmation, then re-confirms when the backend reports a changed estimate", async () => {
    const { user, backend } = await renderApp("#/video")
    const real = backend.ipc.estimateGeneration
    let calls = 0
    backend.ipc.estimateGeneration = vi.fn(async (input) => {
      const e = await real(input)
      calls += 1
      // First estimate shown to the user is stale (lower than the real one).
      return calls === 1 && e.usd != null ? { ...e, usd: e.usd / 10 } : e
    })
    // Debounced studio estimate may have used the stub; reset the counter at submit time.
    await typePrompt("A lighthouse in a storm")
    await new Promise((r) => setTimeout(r, 600))
    calls = 0

    await user.click(screen.getByTestId("generate-button"))
    const dialog = await screen.findByTestId("confirm-generate")
    expect(within(dialog).getByText(/not a provider billing cap/i)).toBeInTheDocument()
    await user.click(within(dialog).getByTestId("confirm-generate-button"))

    // confirmation_required → dialog shows again with the changed-estimate notice.
    expect(await screen.findByText(/estimate changed/i)).toBeInTheDocument()
    expect(backend.mock!.control.jobs()).toHaveLength(0)
    await user.click(screen.getByTestId("confirm-generate-button"))

    await waitFor(() => expect(backend.mock!.control.jobs()).toHaveLength(1))
    const job = backend.mock!.control.jobs()[0]!
    expect(job.prompt).toBe("A lighthouse in a storm")
    await waitFor(() => expect(screen.getByTestId("studio-jobs").querySelector('[data-job-status="completed"]')).not.toBeNull(), {
      timeout: 5000,
    })
  })

  it("blocks generation when the budget would be exceeded", async () => {
    const { user, backend } = await renderApp("#/video", {
      before: async (b) => {
        await b.ipc.updateSettings({ budget: { dailyLimitUsd: 0.01, monthlyLimitUsd: null, warnAtPercent: 80, confirmBeforeGenerate: true } })
      },
    })
    await typePrompt("A city at night")
    await user.click(screen.getByTestId("generate-button"))
    expect(await screen.findByText(/blocked by your budget/i)).toBeInTheDocument()
    expect(screen.getByText(/exceed your daily limit/i)).toBeInTheDocument()
    expect(screen.queryByTestId("confirm-generate")).toBeNull()
    expect(backend.mock!.control.jobs()).toHaveLength(0)
  })

  it("submits directly with a fresh idempotency key per click when confirmation is off", async () => {
    const { user, backend } = await renderApp("#/video", {
      before: async (b) => {
        await b.ipc.updateSettings({ budget: { dailyLimitUsd: null, monthlyLimitUsd: null, warnAtPercent: 80, confirmBeforeGenerate: false } })
      },
    })
    const spy = vi.spyOn(backend.ipc, "submitGeneration")
    await typePrompt("Waves")
    await user.click(screen.getByTestId("generate-button"))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId("generate-button")).toBeEnabled())
    await user.click(screen.getByTestId("generate-button"))
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    const keys = spy.mock.calls.map((c) => c[1].idempotencyKey)
    expect(new Set(keys).size).toBe(2)
    expect(backend.mock!.control.jobs()).toHaveLength(2)
  })

  it("explains submit_uncertain instead of retrying", async () => {
    const { user, backend } = await renderApp("#/video", {
      before: async (b) => {
        await b.ipc.updateSettings({ budget: { dailyLimitUsd: null, monthlyLimitUsd: null, warnAtPercent: 80, confirmBeforeGenerate: false } })
      },
    })
    backend.mock!.control.failNextSubmit("submit_uncertain")
    await typePrompt("Fog")
    await user.click(screen.getByTestId("generate-button"))
    expect(await screen.findByText(/check your provider dashboard/i)).toBeInTheDocument()
  })

  it("applies a library template with editable variables and a live preview", async () => {
    const { backend, user } = await renderApp("#/video")
    const prompt = await backend.ipc.createPrompt({
      title: "Zeta orbit template",
      body: "Slow orbit around {product} on {surface}",
      categoryId: null,
      tags: [],
      favorite: false,
      preferredModelIds: [],
      parameters: {},
      variableDefaults: { product: "a watch" },
    })
    await user.click(await screen.findByTestId("preset-picker"))
    await user.click(await screen.findByRole("option", { name: new RegExp(prompt.title) }))
    const fields = await screen.findByTestId("template-fields")
    const surface = within(fields).getByLabelText("Surface")
    fireEvent.change(surface, { target: { value: "black marble" } })
    await waitFor(() => expect(screen.getByTestId("prompt-input")).toHaveValue("Slow orbit around a watch on black marble"))
  })
})
