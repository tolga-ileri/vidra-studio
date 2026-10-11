import { defineConfig, devices } from "@playwright/test"

/** Renderer e2e against the Vite dev server with the in-memory mock backend. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:1420", trace: "retain-on-failure" },
  webServer: {
    command: "pnpm exec vite --port 1420 --strictPort",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "narrow", use: { ...devices["Desktop Chrome"], viewport: { width: 960, height: 700 } } },
  ],
})
