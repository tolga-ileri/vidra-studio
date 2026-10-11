import { defineConfig } from "@playwright/test"

/**
 * Native end-to-end journey: drives the REAL Tauri app (WebView2 over CDP)
 * built with the test-only `e2e-mock` feature against a local mock of the
 * Higgsfield API. Real Windows Credential Manager, SQLite and filesystem.
 * Build first:  pnpm tauri build --debug --no-bundle --features e2e-mock
 */
export default defineConfig({
  testDir: "tests/native",
  testMatch: /.*\.native\.ts$/,
  workers: 1,
  fullyParallel: false,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [["list"], ["json", { outputFile: "tests/native/.run/results.json" }]],
})
