import { useCallback, useEffect, useRef, useState } from "react"
import type { StoreEvent } from "@vidra/core"

import { subscribeStore } from "@/lib/events"

export interface Live<T> {
  data: T | undefined
  loading: boolean
  error: unknown
  reload: () => void
}

/**
 * Loads data through ipc and reloads it whenever one of the given store events
 * arrives. `key` should change whenever the query changes.
 */
export function useLive<T>(load: () => Promise<T>, key: string, events: Array<StoreEvent["type"]>): Live<T> {
  const [state, setState] = useState<{ data: T | undefined; loading: boolean; error: unknown }>({
    data: undefined,
    loading: true,
    error: null,
  })
  const loadRef = useRef(load)
  loadRef.current = load
  const seq = useRef(0)
  const eventsKey = events.join(",")

  const run = useCallback(() => {
    const id = ++seq.current
    loadRef
      .current()
      .then((data) => {
        if (id === seq.current) setState({ data, loading: false, error: null })
      })
      .catch((error: unknown) => {
        if (id === seq.current) setState((s) => ({ data: s.data, loading: false, error }))
      })
  }, [])

  useEffect(() => {
    setState((s) => ({ ...s, loading: true }))
    run()
  }, [key, run])

  useEffect(() => {
    const types = eventsKey.split(",")
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = subscribeStore((event) => {
      if (!types.includes(event.type)) return
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        run()
      }, 120)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [eventsKey, run])

  return { ...state, reload: run }
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}
