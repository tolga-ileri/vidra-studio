import type { StoreEvent } from "@vidra/core"

import { backend } from "./backend"

type Handler = (event: StoreEvent) => void
const handlers = new Set<Handler>()
let stop: (() => void) | null = null

/** Bridges backend store events to in-app subscribers (one native listener). */
export async function startEventBridge(): Promise<() => void> {
  stop?.()
  const unlisten = await backend().onStoreEvent((event) => {
    for (const h of [...handlers]) h(event)
  })
  stop = unlisten
  return () => {
    unlisten()
    if (stop === unlisten) stop = null
  }
}

export function subscribeStore(handler: Handler): () => void {
  handlers.add(handler)
  return () => handlers.delete(handler)
}
