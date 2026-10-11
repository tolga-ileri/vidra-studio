import { defineConfig } from "@playwright/test"

/** Captures README screenshots and the demo video from the real app (see tests/native/demo.capture.ts). */
export default defineConfig({
  testDir: "tests/native",
  testMatch: /demo\.capture\.ts$/,
  workers: 1,
  timeout: 600_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
})
