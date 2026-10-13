import { create } from "zustand"
import type {
  GenerationReference, AppSettings, ModelDefinition, ParamValues, ProviderStatus } from "@vidra/core"

import { api } from "./backend"
import { subscribeStore } from "./events"

interface AppState {
  ready: boolean
  loadError: unknown
  settings: AppSettings | null
  providers: ProviderStatus[]
  models: ModelDefinition[]
  load: () => Promise<void>
  refreshSettings: () => Promise<void>
  refreshProviders: () => Promise<void>
  refreshModels: () => Promise<void>
  updateSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>
}

export const useApp = create<AppState>((set) => ({
  ready: false,
  loadError: null,
  settings: null,
  providers: [],
  models: [],
  load: async () => {
    try {
      const [settings, providers, models] = await Promise.all([api.getSettings(), api.listProviders(), api.listModels()])
      set({ settings, providers, models, ready: true, loadError: null })
    } catch (loadError) {
      set({ loadError, ready: false })
    }
  },
  refreshSettings: async () => set({ settings: await api.getSettings() }),
  refreshProviders: async () => set({ providers: await api.listProviders() }),
  refreshModels: async () => set({ models: await api.listModels() }),
  updateSettings: async (patch) => {
    const settings = await api.updateSettings(patch)
    set({ settings })
    return settings
  },
}))

/** Keeps the global store in sync with backend events. */
export function bindAppStore(): () => void {
  return subscribeStore((event) => {
    const s = useApp.getState()
    if (event.type === "settings-changed") void s.refreshSettings().catch(() => undefined)
    if (event.type === "providers-changed" || event.type === "catalog-changed")
      void Promise.all([s.refreshProviders(), s.refreshModels()]).catch(() => undefined)
  })
}

/** Hand-off from other screens into a studio ("Use in studio", "Regenerate"). */
export interface StudioDraft {
  modelId: string | null
  prompt: string
  negativePrompt: string | null
  params: ParamValues
  promptId: string | null
  /** When set, the studio opens the template variable editor. */
  template?: { body: string; defaults: Record<string, string> }
  /** Reference images of the job being regenerated (re-uploaded on open). */
  references?: GenerationReference[]
  preserveIdentity?: boolean
}

interface DraftState {
  draft: StudioDraft | null
  setDraft: (d: StudioDraft) => void
  take: () => StudioDraft | null
}

export const useDraft = create<DraftState>((set, get) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
  take: () => {
    const d = get().draft
    if (d) set({ draft: null })
    return d
  },
}))
