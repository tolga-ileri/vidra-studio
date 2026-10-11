import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect } from "vitest"
import type { Language, ModelDefinition, ProviderId } from "@vidra/core"

import App from "@/App"
import { setBackend, type Backend } from "@/lib/backend"
import { mockBackend } from "@/lib/mock-backend"
import { FIXTURE_MODELS } from "@/lib/mock-fixtures"
import { useApp, useDraft } from "@/lib/store"

let last: Backend | null = null
afterEach(() => {
  last?.mock?.control.dispose()
  last = null
  try {
    localStorage.clear()
  } catch {
    /* ignore */
  }
})

export interface Setup {
  backend: Backend
  user: ReturnType<typeof userEvent.setup>
}

export const NAV_LABEL: Record<Language, RegExp> = { en: /main navigation/i, tr: /ana gezinme/i }

/** Renders the whole app against a fresh in-memory backend with the
    deterministic v2 fixture models. */
export async function renderApp(
  route: string,
  options: {
    seedDemo?: boolean
    configured?: ProviderId[]
    onboarded?: boolean
    language?: Language
    storageAvailable?: boolean
    models?: ModelDefinition[]
    /** Studio model to preselect: { video|image: modelId }. */
    lastModel?: { output: "video" | "image"; id: string }
    before?: (b: Backend) => Promise<void> | void
  } = {}
): Promise<Setup> {
  const backend = mockBackend({
    seedDemo: options.seedDemo ?? false,
    stepMs: 30,
    onboarded: options.onboarded ?? true,
    configured: options.configured ?? ["replicate", "kling", "higgsfield"],
    models: options.models ?? FIXTURE_MODELS,
    language: options.language,
    storageAvailable: options.storageAvailable,
  })
  setBackend(backend)
  last = backend
  if (options.lastModel) localStorage.setItem(`vidra.studio.${options.lastModel.output}.model`, options.lastModel.id)
  await options.before?.(backend)
  useApp.setState({ ready: false, loadError: null, settings: null, providers: [], models: [] })
  useDraft.setState({ draft: null })
  window.location.hash = route
  const user = userEvent.setup()
  render(<App />)
  await waitFor(() => expect(useApp.getState().ready).toBe(true))
  if (options.onboarded ?? true) await screen.findByRole("complementary", { name: NAV_LABEL[options.language ?? "en"] })
  return { backend, user }
}
