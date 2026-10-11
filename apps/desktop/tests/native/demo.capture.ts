import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { chromium, expect, test, type Browser, type CDPSession, type Page } from "@playwright/test"

import { ensureFixtures } from "./fixtures.mjs"
import { MOCK_KEY_ID, MOCK_KEY_SECRET, startMockProviders } from "./mock-providers.mjs"

/**
 * Captures the README screenshots and the demo video from the REAL desktop app
 * (e2e-mock debug build) against the local mock provider. No paid calls.
 * Local paths are blurred so no user name appears in the media.
 *
 *   pnpm tauri build --debug --no-bundle --features e2e-mock
 *   npx playwright test -c playwright.demo.config.ts
 *   (then tests/native/.run/demo/make-video.cmd is assembled by ffmpeg)
 */

const EXE = resolve("src-tauri/target/debug/vidra-studio.exe")
const SHOTS = resolve("../../docs/assets/screenshots")
const OUT = resolve("tests/native/.run/demo")
const CDP_PORT = 9334
const run = join(tmpdir(), `vidra-demo-${Date.now()}`)
const dataDir = join(run, "data")
const dialogDir = join(run, "dialogs")

let app: ChildProcess | null = null
let browser: Browser | null = null
let page: Page
let cdp: CDPSession
const frames: { file: string; t: number }[] = []

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function launch(env: Record<string, string>) {
  app = spawn(EXE, [], {
    env: {
      ...process.env,
      ...env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        `--remote-debugging-port=${CDP_PORT}`,
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
      ].join(" "),
    },
    stdio: "ignore",
  })
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => null)
    if (!browser) await pause(500)
  }
  if (!browser) throw new Error("Could not attach to the app")
  const context = browser.contexts()[0]!
  for (let i = 0; i < 60 && !context.pages().find((p) => !p.url().startsWith("about:")); i++) await pause(250)
  page = context.pages().find((p) => !p.url().startsWith("about:"))!
  await page.waitForLoadState("domcontentloaded")
  await page.setViewportSize({ width: 1440, height: 900 })
  // Redact local paths (they contain the OS user name) with a blur.
  await page.evaluate((needle) => {
    const mark = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement
        if (el && n.textContent?.includes(needle)) el.style.filter = "blur(5px)"
      }
      for (const el of document.querySelectorAll<HTMLElement>("[title]"))
        if (el.title.includes(needle)) el.title = ""
    }
    mark()
    new MutationObserver(mark).observe(document.body, { subtree: true, childList: true, characterData: true })
  }, run.split("\\").slice(0, 3).join("\\"))
}

async function startRecording() {
  cdp = await page.context().newCDPSession(page)
  let i = 0
  cdp.on("Page.screencastFrame", (f) => {
    const file = join(OUT, "frames", `f${String(i++).padStart(5, "0")}.jpg`)
    writeFileSync(file, Buffer.from(f.data, "base64"))
    frames.push({ file, t: f.metadata.timestamp ?? Date.now() / 1000 })
    void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1440, maxHeight: 900 })
}

async function shot(name: string) {
  await pause(600)
  const text = await page.evaluate(() => document.body.innerText)
  // Paths are blurred, never omitted silently: fail if one is still readable.
  const visible = await page.evaluate(
    (needle) =>
      [...document.querySelectorAll<HTMLElement>("body *")].some(
        (el) => el.children.length === 0 && el.innerText?.includes(needle) && !getComputedStyle(el).filter.includes("blur")
      ),
    run.split("\\").slice(0, 3).join("\\")
  )
  expect(visible, "a local path would be visible").toBe(false)
  expect(text).not.toContain(MOCK_KEY_SECRET)
  await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

const nav = async (name: string) => {
  await page.getByRole("complementary").first().getByRole("link", { name, exact: true }).click({ timeout: 5000 })
    .catch(() => page.getByRole("complementary").first().getByRole("link", { name, exact: true }).dispatchEvent("click"))
  await pause(900)
}

async function typeSlowly(selector: string, text: string) {
  await page.locator(selector).click()
  await page.locator(selector).pressSequentially(text, { delay: 35 })
}

async function generate(prompt: string, model: string, tweak?: () => Promise<void>) {
  const picker = page.getByTestId("model-picker")
  if (!(await picker.innerText()).includes(model)) {
    await picker.click()
    await pause(500)
    await page.getByRole("option").filter({ hasText: model }).first().click()
  }
  await pause(500)
  await tweak?.()
  await page.getByTestId("prompt-input").fill("")
  await typeSlowly('[data-testid="prompt-input"]', prompt)
  await expect(page.getByTestId("studio-estimate")).toContainText("$")
  await pause(800)
  await page.getByTestId("generate-button").click()
  await pause(1200)
  await page.getByTestId("confirm-generate-button").click()
  await pause(800)
}

test("capture demo media", async () => {
  test.setTimeout(600_000)
  const fixtures = await ensureFixtures()
  const mock = await startMockProviders({ port: 4321, ...fixtures })
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(join(OUT, "frames"), { recursive: true })
  mkdirSync(join(dialogDir, "archive"), { recursive: true })
  mkdirSync(SHOTS, { recursive: true })
  try {
    await launch({
      VIDRA_E2E_MOCK_BASE: mock.base,
      VIDRA_E2E_DATA_DIR: dataDir,
      VIDRA_E2E_DIALOG_DIR: dialogDir,
      VIDRA_E2E_OPEN_FILE: fixtures.png,
    })
    await startRecording()

    // Onboarding in English.
    await page.getByRole("radio", { name: "English" }).click()
    await pause(1200)
    await page.getByRole("button", { name: "Get started" }).click()
    await pause(1000)
    await page.locator("label", { hasText: "Higgsfield" }).click()
    await pause(700)
    await page.getByRole("button", { name: "Continue" }).click()
    await pause(800)
    await typeSlowly("#cred-higgsfield-key_id", MOCK_KEY_ID)
    await typeSlowly("#cred-higgsfield-key_secret", MOCK_KEY_SECRET)
    await page.getByRole("button", { name: "Save and verify" }).click()
    await pause(1800)
    await page.getByRole("button", { name: "Continue" }).click()
    await pause(1000)
    await page.getByRole("button", { name: /Open Vidra Studio/ }).click()
    await pause(1500)

    // Video Studio: three generations, including a 30 s request.
    await nav("Video Studio")
    await generate("A lighthouse at dusk, slow dolly in, waves crashing below, golden hour", "Seedance 2.0 · Text to video")
    await generate("Macro shot of morning dew on a spider web, shallow depth of field", "Seedance 2.0 · Text to video")
    await expect(page.getByTestId("studio-jobs").locator('[data-job-status="completed"]').first()).toBeVisible({ timeout: 90_000 })
    await pause(1500)
    await shot("video-studio")

    // Image Studio, briefly.
    await nav("Image Studio")
    await pause(1500)

    // Archive: wait for saved files, then play one.
    await nav("Archive")
    await expect(page.locator('li[data-state="saved"]').first()).toBeVisible({ timeout: 90_000 })
    await pause(2500)
    await shot("archive")
    await page.locator('li[data-state="saved"]').first().click()
    await pause(4000)
    await page.keyboard.press("Escape")
    await pause(800)

    await nav("Prompt Library")
    await pause(1500)
    await shot("prompt-library")

    await nav("Analytics")
    await pause(1500)
    await shot("analytics")

    await nav("Providers")
    await pause(1500)
    await shot("providers")

    // DEMO_EN_ONLY=1 records the English-only promo cut (no language switch).
    if (process.env.DEMO_EN_ONLY !== "1") {
      // Switch the whole app to Turkish.
      await nav("Settings")
      await page.locator("#set-lang").click()
      await pause(600)
      await page.getByRole("option", { name: "Türkçe" }).click()
      await pause(1200)
      await nav("Video Stüdyosu")
      await typeSlowly('[data-testid="prompt-input"]', "Sisli bir ormanda yürüyen kızıl bir tilki, sinematik çekim")
      await expect(page.getByTestId("studio-estimate")).toContainText("$")
      await pause(1500)
      await shot("video-studio-tr")
      await nav("Arşiv")
      await pause(2500)
    } else {
      await nav("Video Studio")
      await pause(2500)
    }

    await cdp.send("Page.stopScreencast")
  } finally {
    await browser?.close().catch(() => {})
    if (app?.pid) {
      try {
        execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
      } catch {
        /* gone */
      }
    }
    mock.server.close()
    // Remove only this test namespace's credentials.
    const list = execFileSync("cmdkey", ["/list"], { encoding: "utf8" })
    for (const raw of list.split(String.fromCharCode(10))) {
      const at = raw.indexOf("target=")
      const target = at < 0 ? "" : raw.slice(at + 7).trim()
      if (target.endsWith(".dev.tolgaileri.vidra.e2e")) execFileSync("cmdkey", ["/delete:" + target], { stdio: "ignore" })
    }
  }

  // ffmpeg concat list with real frame durations (screencast is event-driven).
  const lines: string[] = []
  frames.forEach((f, i) => {
    const next = frames[i + 1]?.t ?? f.t + 0.5
    lines.push(`file '${f.file.replace(/\\/g, "/")}'`, `duration ${Math.max(0.01, next - f.t).toFixed(3)}`)
  })
  lines.push(`file '${frames.at(-1)!.file.replace(/\\/g, "/")}'`)
  writeFileSync(join(OUT, "frames.txt"), lines.join("\n"))
  expect(frames.length).toBeGreaterThan(50)

  for (let i = 0; i < 20; i++) {
    try {
      rmSync(run, { recursive: true, force: true })
      break
    } catch {
      await pause(500)
    }
  }
})
