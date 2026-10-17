import { defineConfig, devices } from "@playwright/test"

/**
 * Renderer e2e against the Vite dev server with the in-memory mock backend.
 * Uses its own port and never reuses a server it did not start, so another
 * app on the usual dev port (1420) can't be tested by mistake.
 */
const PORT = Number(process.env.VIDRA_E2E_PORT ?? 14271)

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: `pnpm exec vite --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "narrow", use: { ...devices["Desktop Chrome"], viewport: { width: 960, height: 700 } } },
  ],
})
