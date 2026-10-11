import type { Backend } from "./backend"
import { createMockBackend } from "./mock-ipc"

/** Test/dev helper: a fresh in-memory backend. Never imported by app code. */
export function mockBackend(options?: Parameters<typeof createMockBackend>[0]): Backend {
  const mock = createMockBackend(options)
  return { ...mock, isMock: true, mock }
}
