import { convertFileSrc } from "@tauri-apps/api/core"

import {
  ipc as tauriIpc,
  onFilesDropped as tauriOnFilesDropped,
  onStoreEvent as tauriOnStoreEvent,
  type DroppedFile,
  type Ipc,
} from "./ipc"
import type { MockBackend } from "./mock-ipc"
import type { StoreEvent } from "@vidra/core"

/**
 * Chooses the backend: the real Tauri commands inside the desktop shell, or the
 * in-memory mock in a plain browser (dev preview and tests). The Tauri build
 * never instantiates the mock.
 */

export interface Backend {
  ipc: Ipc
  onStoreEvent: (handler: (event: StoreEvent) => void) => Promise<() => void>
  onFilesDropped: (handler: (files: DroppedFile[]) => void) => Promise<() => void>
  isMock: boolean
  mock: MockBackend | null
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

/** false in desktop (Tauri) builds: the mock module is then tree-shaken out of
    the bundle entirely, so production can never show demo data. */
declare const __VIDRA_MOCK__: boolean

async function initial(): Promise<Backend> {
  if (isTauri)
    return { ipc: tauriIpc, onStoreEvent: tauriOnStoreEvent, onFilesDropped: tauriOnFilesDropped, isMock: false, mock: null }
  if (!__VIDRA_MOCK__) throw new Error("Vidra Studio must run inside the desktop app.")
  const { createMockBackend } = await import("./mock-ipc")
  const mock = createMockBackend({ seedDemo: true })
  return { ...mock, isMock: true, mock }
}

let current: Backend = await initial()

/** Replaces the backend (tests). */
export function setBackend(next: Backend): void {
  current = next
}

export function backend(): Backend {
  return current
}

/** Always delegates to the active backend. */
export const api: Ipc = new Proxy({} as Ipc, {
  get: (_target, key) => Reflect.get(current.ipc, key),
})

/** Converts a backend file path to a URL the webview can load. */
export function fileSrc(path: string): string {
  if (!current.isMock && isTauri) return convertFileSrc(path)
  return path
}
