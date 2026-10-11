import type { Server } from "node:http"

export const MOCK_KEY_ID: string
export const MOCK_KEY_SECRET: string
export interface MockStats {
  submits: number
  idempotentReplays: number
  estimates: number
  uploads: number
  uploadPuts: number
  mediaRequests: number
  rangeRequests: number
  cancels: number
  authFailures: number
}
export function startMockProviders(options: { port?: number; webm: string; png: string }): Promise<{
  server: Server
  base: string
  stats: MockStats
  control: { dropNextMedia: boolean; slowMedia: boolean; expireMedia: boolean }
  jobs: Map<string, { id: string; path: string; body: Record<string, unknown> }>
}>
