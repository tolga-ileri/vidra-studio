import { useCallback } from "react"
import { useNavigate } from "react-router"

import { useApp, useDraft, type StudioDraft } from "@/lib/store"

/** Navigates to the matching studio with a prefilled draft. */
export function useOpenInStudio() {
  const navigate = useNavigate()
  return useCallback(
    (draft: StudioDraft, output?: "video" | "image") => {
      const model = useApp.getState().models.find((m) => m.id === draft.modelId)
      useDraft.getState().setDraft(draft)
      void navigate((output ?? model?.output) === "image" ? "/image" : "/video")
    },
    [navigate]
  )
}
