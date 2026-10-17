import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { chromium, expect, test, type Browser, type Page } from "@playwright/test"

import { ensureFixtures } from "./fixtures.mjs"
import { MOCK_KEY_ID, MOCK_KEY_SECRET, startMockProviders } from "./mock-providers.mjs"

const SECRET_MARKERS = [MOCK_KEY_SECRET, `${MOCK_KEY_ID}:${MOCK_KEY_SECRET}`]

/**
 * The complete user journey on the real desktop app (debug build compiled with
 * the test-only `e2e-mock` feature): first-run onboarding → connect provider
 * (stored in Windows Credential Manager) → generate → automatic download into
 * the archive (verified on disk + SQLite) → network interruption recovery →
 * app restart mid-download → archive persistence after restart → play/export
 * → trash/restore → prompt library link → expired output URL → backup →
 * remove credentials. No real provider is contacted; nothing is billed.
 */

const EXE = resolve("src-tauri/target/debug/vidra-studio.exe")
/** A fresh DevTools port per launch: after a hard kill the old WebView2 can
 *  hold the previous port for a while. */
let launches = 0
const cdpPort = () => 9333 + (launches % 40) * 2
const run = join(tmpdir(), `vidra-native-${Date.now()}`)
const dataDir = join(run, "data")
const dialogDir = join(run, "dialogs")
const archiveRoot = join(dialogDir, "archive")
const secondRoot = join(run, "archive-second")
const KEYRING_SERVICE = "dev.tolgaileri.vidra.e2e"

let app: ChildProcess | null = null
let browser: Browser | null = null
let page: Page
let mock: Awaited<ReturnType<typeof startMockProviders>>
let fixtures: { webm: string; png: string }

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
const ROUTES: Record<string, string> = {
  Home: "#/",
  "Video Studio": "#/video",
  "Image Studio": "#/image",
  Archive: "#/archive",
  Downloads: "#/downloads",
  "Prompt Library": "#/prompts",
  Analytics: "#/analytics",
  Providers: "#/providers",
  Settings: "#/settings",
}

/** Navigates via the sidebar and verifies the route actually changed. A
    click can land on a different element if the page is still laying out
    (e.g. Home's quick-action cards appearing), so the result is asserted
    and the click repeated if needed — never assumed. */
const nav = (name: string) => ({
  click: async () => {
    const link = page.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name, exact: true })
    const hash = ROUTES[name]!
    for (let attempt = 0; attempt < 3; attempt++) {
      // Live job indicators in the sidebar can keep the link "unstable"
      // for Playwright; fall back to a direct click event.
      await link.click({ timeout: 5_000 }).catch(() => link.dispatchEvent("click"))
      try {
        await expect.poll(() => new URL(page.url()).hash || "#/", { timeout: 5_000 }).toBe(hash)
        return
      } catch {
        /* retry */
      }
    }
    throw new Error(`Navigation to ${name} did not happen`)
  },
})

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]
  )
}

function db() {
  return new DatabaseSync(join(dataDir, "vidra.sqlite3"), { readOnly: true })
}

function credentialTargets(): string {
  try {
    return execFileSync("cmdkey", ["/list"], { encoding: "utf8" })
  } catch {
    return ""
  }
}

async function launch() {
  launches += 1
  app = spawn(EXE, [], {
    env: {
      ...process.env,
      VIDRA_E2E_MOCK_BASE: mock.base,
      VIDRA_E2E_DATA_DIR: dataDir,
      VIDRA_E2E_DIALOG_DIR: dialogDir,
      VIDRA_E2E_OPEN_FILE: fixtures.png,
      // Own WebView2 profile: the test app must not share (or fight over) the
      // profile of a Vidra Studio the user may have open.
      // A fresh profile per launch: a hard kill can leave the previous one locked.
      WEBVIEW2_USER_DATA_FOLDER: join(run, `webview-${Date.now()}`),
      // CDP for the test driver, plus Chromium's switches that stop throttling
      // when the window is covered by other windows on this desktop (the run
      // shares the user's screen). Without them requestAnimationFrame stalls
      // and menu animations never "settle" for the driver.
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        `--remote-debugging-port=${cdpPort()}`,
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
      ].join(" "),
    },
    stdio: "ignore",
  })
  for (let i = 0; i < 60; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort()}`)
      break
    } catch {
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  if (!browser) throw new Error("Could not attach to the WebView2 of the desktop app")
  const context = browser.contexts()[0]!
  for (let i = 0; i < 60 && !context.pages().find((p) => !p.url().startsWith("about:")); i++)
    await new Promise((r) => setTimeout(r, 250))
  page = context.pages().find((p) => !p.url().startsWith("about:"))!
  await page.waitForLoadState("domcontentloaded")
}

/** Hard kill (like a crash / power loss): no graceful shutdown. */
async function kill() {
  await browser?.close().catch(() => {})
  browser = null
  if (app?.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      /* already gone */
    }
  }
  app = null
  await new Promise((r) => setTimeout(r, 1500))
}

async function selectModel(name: string) {
  const picker = page.getByTestId("model-picker")
  if ((await picker.innerText()).includes(name)) return
  await picker.click()
  await page.getByRole("option").filter({ hasText: name }).first().click()
  await expect(picker).toContainText(name)
}

async function generate(prompt: string, model = "Seedance 2.0 · Text to video") {
  await nav("Video Studio").click()
  await expect(page.getByRole("heading", { name: "Video Studio", level: 1 })).toBeVisible()
  await selectModel(model)
  // Leftover references from a previous step would (rightly) block a model
  // that cannot take them; a user removes them first, and so does this helper.
  while ((await page.getByTestId("refs-remove").count()) > 0) await page.getByTestId("refs-remove").first().click()
  await page.getByTestId("prompt-input").fill(prompt)
  await expect(page.getByTestId("prompt-input")).toHaveValue(prompt)
  await expect(page.getByTestId("studio-estimate")).toContainText("$")
  await page.getByTestId("generate-button").click()
  const dialog = page.getByTestId("confirm-generate")
  await expect(dialog).toContainText("not a provider billing cap")
  await dialog.getByTestId("confirm-generate-button").click()
  await expect(dialog).toBeHidden()
  // The submission must show up as a job (any status) right away.
  await expect(page.getByTestId("studio-jobs").getByRole("listitem").filter({ hasText: prompt }).first()).toBeVisible()
}

/** States of every archive card matching "E2E", in display order. */
async function archiveStates() {
  const cards = await archiveCard("E2E")
  return Promise.all((await cards.all()).map((c) => c.getAttribute("data-state")))
}

/** Submits the current studio form without navigating (keeps references). */
async function submitPrompt(prompt: string) {
  await page.getByTestId("prompt-input").fill(prompt)
  await expect(page.getByTestId("prompt-input")).toHaveValue(prompt)
  await expect(page.getByTestId("studio-estimate")).toContainText("$")
  await page.getByTestId("generate-button").click()
  const dialog = page.getByTestId("confirm-generate")
  await expect(dialog).toContainText("not a provider billing cap")
  await dialog.getByTestId("confirm-generate-button").click()
  await expect(dialog).toBeHidden()
  await expect(page.getByTestId("studio-jobs").getByRole("listitem").filter({ hasText: prompt.slice(0, 40) }).first()).toBeVisible()
}

/** Click that falls back to a DOM click when a re-rendering element never
 *  settles for Playwright's stability check (e.g. a button with a spinner). */
async function robustClick(l: import("@playwright/test").Locator) {
  await l.click({ timeout: 10_000 }).catch(() => l.dispatchEvent("click"))
}

async function archiveCard(search: string) {
  await nav("Archive").click()
  const box = page.getByPlaceholder("Search prompts, titles, tags…")
  await box.fill("")
  await box.fill(search)
  // The search is debounced and served by SQLite. Wait until the grid really
  // reflects it (no non-matching card left) — this asserts the filter works
  // instead of racing it — then return the matching cards.
  const cards = page.getByTestId("archive-grid").getByRole("listitem")
  await expect(cards.filter({ hasNotText: search })).toHaveCount(0)
  return cards.filter({ hasText: search })
}

/** Removes test-only credentials from Windows Credential Manager (namespace
    `dev.tolgaileri.vidra.e2e` — never the user's real entries). */
function clearE2eCredentials() {
  const marker = "target="
  const suffix = "." + KEYRING_SERVICE
  for (const raw of credentialTargets().split(String.fromCharCode(10))) {
    const line = raw.trim()
    const at = line.indexOf(marker)
    if (at < 0) continue
    const target = line.slice(at + marker.length)
    if (target.endsWith(suffix)) execFileSync("cmdkey", ["/delete:" + target], { stdio: "ignore" })
  }
}

/** Drives the storage move wizard: plan → copy & verify → explicit choice. */
async function completeMoveWizard({ removeOld }: { removeOld: boolean }) {
  const wizard = page.getByTestId("storage-wizard")
  // The wizard may still be animating in; give it a moment to appear.
  await wizard.waitFor({ state: "visible", timeout: 5000 }).catch(() => {})
  // Steps re-render while progress updates, so dispatch clicks directly
  // instead of waiting for layout stability.
  const press = (id: string) => page.getByTestId(id).dispatchEvent("click", undefined, { timeout: 5000 }).catch(() => {})
  for (let i = 0; i < 40; i++) {
    if (!(await wizard.isVisible().catch(() => false))) break
    const step = await wizard.getAttribute("data-step").catch(() => null)
    if (step === "plan") await press("wizard-start")
    else if (step === "result") await press("wizard-next")
    else if (step === "confirm") {
      await wizard.getByRole("radio").nth(removeOld ? 1 : 0).dispatchEvent("click").catch(() => {})
      await press("wizard-finish")
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  await expect(wizard).toBeHidden()
}

/** Graceful close (WM_CLOSE, like clicking X), then wait for exit. */
async function closeGracefully() {
  await browser?.close().catch(() => {})
  browser = null
  const pid = app?.pid
  if (pid) {
    try {
      execFileSync("taskkill", ["/PID", String(pid)], { stdio: "ignore" })
    } catch {
      /* gone */
    }
    for (let i = 0; i < 40; i++) {
      try {
        process.kill(pid, 0)
        await new Promise((r) => setTimeout(r, 250))
      } catch {
        break
      }
    }
  }
  app = null
}

test.describe.serial("native desktop journey (mock provider, no paid calls)", () => {
  test.beforeAll(async () => {
    expect(existsSync(EXE), `build first: ${EXE}`).toBe(true)
    fixtures = await ensureFixtures()
    mock = await startMockProviders({ port: 4320, ...fixtures })
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(dialogDir, { recursive: true })
    // A real folder picker can only return an existing folder.
    mkdirSync(archiveRoot, { recursive: true })
    clearE2eCredentials()
    await launch()
  })

  test.afterAll(async () => {
    await kill()
    mock?.server.close()
    clearE2eCredentials()
    // WebView2 helper processes release file handles shortly after exit.
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(run, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  })

  test("first-run onboarding in Turkish connects Higgsfield and stores the key in Windows Credential Manager", async () => {
    // Choose Turkish on the welcome step; the whole flow continues in Turkish.
    await page.getByRole("radio", { name: "Türkçe" }).click()
    await expect(page.getByRole("heading", { name: "Vidra Studio'ya hoş geldiniz" })).toBeVisible()
    await page.getByRole("button", { name: "Başlayın" }).click()
    await expect(page.getByRole("heading", { name: "Sağlayıcılarınızı seçin" })).toBeVisible()
    await page.locator("label", { hasText: "Higgsfield" }).click()
    await page.getByRole("button", { name: "Devam" }).click()
    // Credential labels are localized too (no mixed-language form).
    await expect(page.getByText("API anahtar kimliği")).toBeVisible()
    await expect(page.getByText("API key ID")).toHaveCount(0)
    // Wrong key first: verification must fail visibly (in Turkish).
    await page.locator("#cred-higgsfield-key_id").fill("wrong-id")
    await page.locator("#cred-higgsfield-key_secret").fill("wrong-secret")
    await page.getByRole("button", { name: "Kaydet ve doğrula" }).click()
    await expect(page.getByRole("alert").first()).toBeVisible()
    await page.locator("#cred-higgsfield-key_id").fill(MOCK_KEY_ID)
    await page.locator("#cred-higgsfield-key_secret").fill(MOCK_KEY_SECRET)
    await page.getByRole("button", { name: "Kaydet ve doğrula" }).click()
    await expect(page.getByRole("heading", { name: "Medya nereye kaydedilsin?" })).toBeVisible()
    await page.getByTestId("onboarding-folder").click()
    await completeMoveWizard({ removeOld: false })
    await expect(page.getByText(archiveRoot).first()).toBeVisible()
    await page.getByRole("button", { name: "Devam" }).click()
    await page.getByRole("button", { name: "Vidra Studio'yu aç" }).click()
    await expect(page.getByRole("complementary").first()).toBeVisible()

    expect(credentialTargets()).toContain(KEYRING_SERVICE)
    // The key never lands in SQLite (incl. WAL) or on the renderer side.
    for (const f of readdirSync(dataDir).filter((n) => n.startsWith("vidra.sqlite3")))
      for (const m of SECRET_MARKERS) expect(readFileSync(join(dataDir, f)).includes(Buffer.from(m))).toBe(false)
    const visible = await page.evaluate(() => JSON.stringify({ ...localStorage }) + document.documentElement.outerHTML)
    for (const m of SECRET_MARKERS) expect(visible).not.toContain(m)
  })

  test("Turkish persists after a restart; switching to English persists too", async () => {
    await closeGracefully()
    await launch()
    await expect(page.locator("html")).toHaveAttribute("lang", "tr")
    await expect(page.getByRole("complementary").first().getByRole("link", { name: "Arşiv", exact: true })).toBeVisible()
    await page.getByRole("complementary").first().getByRole("link", { name: "Ayarlar", exact: true }).click()
    await page.locator("#set-lang").click()
    await page.getByRole("option", { name: "English" }).click()
    await expect(page.getByRole("complementary").first().getByRole("link", { name: "Archive", exact: true })).toBeVisible()
    await closeGracefully()
    await launch()
    await expect(page.locator("html")).toHaveAttribute("lang", "en")
    await expect(page.getByRole("heading", { name: "Home", level: 1 })).toBeVisible()
  })

  test("generates a video and saves the real file into the archive", async () => {
    await generate("E2E lighthouse at dusk, slow dolly")
    await expect(page.getByTestId("studio-jobs").locator('[data-job-status="completed"]').first()).toBeVisible({ timeout: 60_000 })
    const card = await archiveCard("lighthouse")
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute("data-state", "saved", { timeout: 60_000 })

    const conn = db()
    const asset = conn
      .prepare("SELECT id, local_path, sha256, size_bytes, download_status FROM media_assets")
      .get() as { id: string; local_path: string; sha256: string; size_bytes: number; download_status: string }
    conn.close()
    expect(asset.download_status).toBe("saved")
    const file = join(archiveRoot, asset.local_path)
    expect(existsSync(file)).toBe(true)
    expect(sha256(file)).toBe(sha256(fixtures.webm))
    expect(asset.sha256).toBe(sha256(fixtures.webm))
    expect(statSync(file).size).toBe(asset.size_bytes)
    // No partial files left behind.
    expect(filesUnder(join(archiveRoot, ".tmp")).filter((f) => f.endsWith(".part"))).toEqual([])
    // Thumbnail captured from the local video and stored inside the archive.
    await expect
      .poll(() => filesUnder(join(archiveRoot, "thumbs")).length, { timeout: 30_000 })
      .toBeGreaterThan(0)
  })

  test("plays the archived video from local disk and exports an identical copy", async () => {
    const card = await archiveCard("lighthouse")
    await card.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Play" }).click()
    const video = page.locator("video[src]").first()
    await expect(video).toBeVisible()
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThan(0)
    const src = await video.getAttribute("src")
    expect(src).toMatch(/asset\.localhost|^asset:/)
    await page.keyboard.press("Escape")

    await card.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Export…" }).click()
    await expect.poll(() => readdirSync(dialogDir).filter((f) => f.endsWith(".webm")).length).toBe(1)
    const exported = join(dialogDir, readdirSync(dialogDir).find((f) => f.endsWith(".webm"))!)
    expect(sha256(exported)).toBe(sha256(fixtures.webm))
  })

  test("recovers from a dropped connection during download (resume)", async () => {
    await fetch(`${mock.base}/__control`, { method: "POST", body: JSON.stringify({ dropNextMedia: true }) })
    const rangeBefore = mock.stats.rangeRequests
    await generate("E2E dropped connection river")
    const card = await archiveCard("dropped connection")
    await expect(card).toHaveAttribute("data-state", "saved", { timeout: 90_000 })
    expect(mock.stats.rangeRequests).toBeGreaterThan(rangeBefore)
  })

  test("resumes an interrupted download after the app is killed and restarted", async () => {
    await fetch(`${mock.base}/__control`, { method: "POST", body: JSON.stringify({ slowMedia: true }) })
    await generate("E2E restart mid-download canyon")
    const card = await archiveCard("restart mid-download")
    await expect(card).toHaveAttribute("data-state", "downloading", { timeout: 60_000 })
    await expect.poll(() => filesUnder(join(archiveRoot, ".tmp")).some((f) => f.endsWith(".part") && statSync(f).size > 0)).toBe(true)
    await kill()
    await fetch(`${mock.base}/__control`, { method: "POST", body: JSON.stringify({ slowMedia: false }) })
    const rangeBefore = mock.stats.rangeRequests
    await launch()
    const after = await archiveCard("restart mid-download")
    await expect(after).toHaveAttribute("data-state", "saved", { timeout: 90_000 })
    expect(mock.stats.rangeRequests).toBeGreaterThan(rangeBefore)
    const conn = db()
    const rows = conn.prepare("SELECT sha256 FROM media_assets WHERE download_status = 'saved'").all() as Array<{ sha256: string }>
    conn.close()
    for (const r of rows) expect(r.sha256).toBe(sha256(fixtures.webm))
  })

  test("archive and credentials persist across restarts", async () => {
    await kill()
    await launch()
    await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible()
    const all = await archiveCard("E2E")
    await expect(all).toHaveCount(3)
    for (const c of await all.all()) await expect(c).toHaveAttribute("data-state", "saved")
    await nav("Providers").click()
    await expect(page.getByTestId("status-higgsfield")).toHaveText(/Verified|Connected|Configured/)
  })

  test("closing the app normally and reopening keeps every saved video", async () => {
    await closeGracefully()
    await launch()
    const all = await archiveCard("E2E")
    await expect(all).toHaveCount(3)
    for (const c of await all.all()) await expect(c).toHaveAttribute("data-state", "saved")
    const conn = db()
    const rows = conn.prepare("SELECT local_path FROM media_assets WHERE download_status = 'saved'").all() as Array<{ local_path: string }>
    conn.close()
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(sha256(join(archiveRoot, r.local_path))).toBe(sha256(fixtures.webm))
  })

  test("plays and exports archived files with the provider completely offline", async () => {
    mock.server.close()
    await new Promise((r) => setTimeout(r, 300))
    const offline = await fetch(`${mock.base}/__stats`).then(() => true).catch(() => false)
    expect(offline).toBe(false)
    for (const f of readdirSync(dialogDir).filter((n) => n.endsWith(".webm"))) rmSync(join(dialogDir, f))

    const card = await archiveCard("canyon")
    await card.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Play" }).click()
    const video = page.locator("video[src]").first()
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 20_000 }).toBeGreaterThan(0)
    await page.keyboard.press("Escape")
    await card.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Export…" }).click()
    await expect.poll(() => readdirSync(dialogDir).filter((f) => f.endsWith(".webm")).length).toBe(1)
    expect(sha256(join(dialogDir, readdirSync(dialogDir).find((f) => f.endsWith(".webm"))!))).toBe(sha256(fixtures.webm))

    // Provider back online for the remaining steps (fresh counters).
    mock = await startMockProviders({ port: 4320, ...fixtures })
  })

  test("detects duplicate files by content hash and keeps both entries", async () => {
    const conn = db()
    const rows = conn
      .prepare("SELECT id, sha256, duplicate_of_asset_id FROM media_assets WHERE download_status = 'saved' ORDER BY created_at")
      .all() as Array<{ id: string; sha256: string; duplicate_of_asset_id: string | null }>
    conn.close()
    expect(rows.length).toBe(3)
    expect(rows[0]!.duplicate_of_asset_id).toBeNull()
    for (const r of rows.slice(1)) expect(r.duplicate_of_asset_id).toBe(rows[0]!.id)
  })

  test("trash and restore keep the file; saving the prompt links it to the library", async () => {
    const card = await archiveCard("lighthouse")
    await card.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Save prompt to library" }).click()
    const nameDialog = page.getByRole("dialog")
    await nameDialog.getByRole("textbox").fill("E2E lighthouse prompt")
    await nameDialog.getByRole("button", { name: "Save" }).click()
    await expect(nameDialog).toBeHidden()
    await card.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Move to trash" }).click()
    await expect(await archiveCard("lighthouse")).toHaveCount(0)
    const conn = db()
    const path = (conn.prepare("SELECT local_path FROM media_assets a JOIN archive_items i ON i.asset_id = a.id WHERE i.deleted_at IS NOT NULL").get() as { local_path: string }).local_path
    expect(existsSync(join(archiveRoot, path))).toBe(true)
    // The saved prompt is independent of the archive item.
    const saved = conn
      .prepare("SELECT p.title, p.body, p.source_job_id, j.prompt AS job_prompt FROM prompts p JOIN generation_jobs j ON j.id = p.source_job_id WHERE p.title = ?")
      .all("E2E lighthouse prompt") as Array<{ title: string; body: string; source_job_id: string; job_prompt: string }>
    expect(saved).toHaveLength(1)
    expect(saved[0]!.body).toBe("E2E lighthouse at dusk, slow dolly")
    expect(saved[0]!.job_prompt).toBe(saved[0]!.body)
    conn.close()

    await page.getByRole("button", { name: "Trash" }).click()
    const trashed = page.getByTestId("archive-grid").getByRole("listitem")
    await trashed.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Restore" }).click()
    await expect(trashed.filter({ hasText: "lighthouse" })).toHaveCount(0)
    await page.getByRole("button", { name: "All media" }).click()
    await expect(await archiveCard("lighthouse")).toHaveAttribute("data-state", "saved")

    await nav("Prompt Library").click()
    await expect(page.locator('[data-prompt-title="E2E lighthouse prompt"]')).toBeVisible()
  })

  test("regenerate pre-fills the studio with the original prompt", async () => {
    const card = await archiveCard("lighthouse")
    await card.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Regenerate" }).click()
    await expect(page.getByTestId("prompt-input")).toHaveValue("E2E lighthouse at dusk, slow dolly")
  })

  test("permanent deletion removes only that file and its rows; prompts stay", async () => {
    const conn0 = db()
    const target = conn0
      .prepare("SELECT a.id, a.local_path FROM media_assets a JOIN generation_jobs j ON j.id = a.job_id WHERE j.prompt LIKE '%river%'")
      .get() as { id: string; local_path: string }
    const promptsBefore = (conn0.prepare("SELECT COUNT(*) AS n FROM prompts").get() as { n: number }).n
    const otherFiles = (conn0.prepare("SELECT local_path FROM media_assets WHERE id <> ? AND local_path IS NOT NULL").all(target.id) as Array<{ local_path: string }>).map((r) => join(archiveRoot, r.local_path))
    conn0.close()
    expect(existsSync(join(archiveRoot, target.local_path))).toBe(true)

    const card = await archiveCard("river")
    await card.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Move to trash" }).click()
    await page.getByRole("button", { name: "Trash" }).click()
    const trashed = page.getByTestId("archive-grid").getByRole("listitem").filter({ hasText: "river" })
    await trashed.first().getByRole("button", { name: /^Actions for/ }).click()
    await page.getByRole("menuitem", { name: "Delete permanently" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete permanently" }).click()
    await expect(trashed).toHaveCount(0)
    await page.getByRole("button", { name: "All media" }).click()

    await expect.poll(() => existsSync(join(archiveRoot, target.local_path))).toBe(false)
    const conn = db()
    expect(conn.prepare("SELECT COUNT(*) AS n FROM media_assets WHERE id = ?").get(target.id)).toEqual({ n: 0 })
    expect((conn.prepare("SELECT COUNT(*) AS n FROM prompts").get() as { n: number }).n).toBe(promptsBefore)
    conn.close()
    for (const f of otherFiles) expect(existsSync(f)).toBe(true)
  })

  test("an expired provider URL is reported clearly and the item is kept", async () => {
    await fetch(`${mock.base}/__control`, { method: "POST", body: JSON.stringify({ expireMedia: true }) })
    await generate("E2E expired link glacier")
    const card = await archiveCard("expired link")
    await expect(card).toHaveAttribute("data-state", "download_failed", { timeout: 60_000 })
    await nav("Downloads").click()
    await expect(page.getByText(/expired/i).first()).toBeVisible()
    await fetch(`${mock.base}/__control`, { method: "POST", body: JSON.stringify({ expireMedia: false }) })
  })

  test("image-to-video uploads the first frame through the provider's storage flow", async () => {
    await nav("Video Studio").click()
    await selectModel("Kling 3.0 Pro · Image to video")
    const uploadsBefore = mock.stats.uploads
    await page.getByTestId("refs-add").click()
    const tile = page.getByTestId("refs-tile").first()
    await expect(tile).toHaveAttribute("data-status", "ready")
    await expect(tile.locator("img")).toBeVisible()
    expect(mock.stats.uploads).toBe(uploadsBefore + 1)
    expect(mock.stats.uploadPuts).toBeGreaterThan(0)
    // A mascot has no input on image-to-video; as the first frame it fits.
    await expect(page.getByTestId("refs-unsupported")).toContainText("no such input")
    await tile.getByTestId("refs-type").click()
    await page.getByRole("option", { name: "First frame" }).click()
    await expect(tile).toHaveAttribute("data-placed", "true")
    await expect(page.getByTestId("refs-unsupported")).toBeHidden()
  })


  test("a 30-second Seedance 2.5 request reaches the provider unchanged", async () => {
    await nav("Video Studio").click()
    await selectModel("Seedance 2.5 · Text to video")
    await expect(page.getByTestId("dynamic-form")).toContainText("30")
    const duration = page.getByRole("spinbutton", { name: /Duration/ })
    await duration.fill("30")
    await duration.blur()
    await generate("E2E thirty second panorama", "Seedance 2.5 · Text to video")
    await expect
      .poll(async () => {
        const jobs = (await (await fetch(`${mock.base}/__jobs`)).json()) as Array<{ path: string; body: Record<string, unknown> }>
        return jobs.find((j) => String(j.body.prompt ?? "").includes("thirty second"))?.body.duration
      })
      .toBe(30)
  })

  test("analytics, CSV export and archive backup write real files", async () => {
    await nav("Analytics").click()
    await expect(page.getByTestId("export-csv")).toBeEnabled()
    await page.getByTestId("export-csv").click()
    await expect.poll(() => readdirSync(dialogDir).filter((f) => f.endsWith(".csv")).length).toBe(1)
    const csv = readFileSync(join(dialogDir, readdirSync(dialogDir).find((f) => f.endsWith(".csv"))!), "utf8")
    expect(csv).toContain("estimated_cost_usd")
    expect(csv.split("\r\n").filter(Boolean).length).toBeGreaterThanOrEqual(4)

    await nav("Settings").click()
    await page.getByRole("button", { name: "Export archive…" }).click()
    await expect.poll(() => readdirSync(dialogDir).filter((f) => f.endsWith(".vidra")).length, { timeout: 60_000 }).toBe(1)
    const backup = readFileSync(join(dialogDir, readdirSync(dialogDir).find((f) => f.endsWith(".vidra"))!))
    expect(backup.subarray(0, 2).toString()).toBe("PK")
    for (const m of SECRET_MARKERS) expect(backup.includes(Buffer.from(m))).toBe(false)
  })

  test("moves the archive to a second folder: copies, verifies and keeps the old copy", async () => {
    const states = await archiveStates()
    expect(states).toContain("saved")
    const before = filesUnder(join(archiveRoot, "media")).length
    expect(before).toBeGreaterThan(0)
    mkdirSync(secondRoot, { recursive: true })
    writeFileSync(join(dialogDir, "next-folder.txt"), secondRoot)
    await nav("Settings").click()
    await page.getByTestId("storage-change").click()
    await completeMoveWizard({ removeOld: false })
    await expect(page.getByTestId("archive-root")).toContainText(secondRoot)
    expect(filesUnder(join(secondRoot, "media")).length).toBe(before)
    // Kept on request: the old copies are still there.
    expect(filesUnder(join(archiveRoot, "media")).length).toBe(before)
    // Nothing saved is lost (in-flight items may finish meanwhile).
    const saved = states.filter((x) => x === "saved").length
    await expect.poll(async () => (await archiveStates()).length).toBe(states.length)
    await expect.poll(async () => (await archiveStates()).filter((x) => x === "saved").length).toBeGreaterThanOrEqual(saved)
  })

  test("an unavailable archive folder shows a banner and reconnects without data loss", async () => {
    const states = await archiveStates()
    await closeGracefully()
    const offline = `${secondRoot}-unplugged`
    renameSync(secondRoot, offline)
    await launch()
    await expect(page.getByTestId("storage-banner")).toBeVisible()
    await expect(page.getByTestId("storage-banner")).toContainText(secondRoot)
    // Still unreachable: reconnect reports it and the banner stays.
    await robustClick(page.getByTestId("storage-reconnect"))
    await expect(page.getByTestId("storage-banner")).toBeVisible()
    renameSync(offline, secondRoot)
    await robustClick(page.getByTestId("storage-reconnect"))
    await expect(page.getByTestId("storage-banner")).toBeHidden()
    // Nothing saved is lost (in-flight items may finish meanwhile).
    const saved = states.filter((x) => x === "saved").length
    await expect.poll(async () => (await archiveStates()).length).toBe(states.length)
    await expect.poll(async () => (await archiveStates()).filter((x) => x === "saved").length).toBeGreaterThanOrEqual(saved)
  })

  test("a mascot reference is uploaded, saved to the library and sent as image_urls (reference-to-video)", async () => {
    await nav("Video Studio").click()
    await selectModel("Seedance 2.5 · Reference to video")
    const uploadsBefore = mock.stats.uploads
    await page.getByTestId("refs-add").click()
    const tile = page.getByTestId("refs-tile").first()
    await expect(tile).toHaveAttribute("data-status", "ready")
    await expect(tile).toHaveAttribute("data-placed", "true")
    expect(mock.stats.uploads).toBe(uploadsBefore + 1)
    await tile.getByTestId("refs-name").fill("ZihinLab maskot")
    await tile.getByTestId("refs-save").click()
    await expect(tile.getByText("Saved")).toBeVisible()
    await expect(page.getByTestId("refs-guidance")).toContainText('character "ZihinLab maskot"')
    await submitPrompt("E2E ZihinLab advert with the mascot")
    await expect(page.getByTestId("studio-jobs").locator('[data-job-status="completed"]').first()).toBeVisible({ timeout: 60_000 })

    const jobs = (await fetch(`${mock.base}/__jobs`).then((r) => r.json())) as Array<{ path: string; body: Record<string, unknown> }>
    const job = jobs.find((j) => j.path.endsWith("/reference-to-video") && String(j.body.prompt).includes("ZihinLab advert"))!
    expect(job).toBeTruthy()
    const urls = job.body.image_urls as string[]
    expect(urls).toHaveLength(1)
    expect(urls[0]!.startsWith("https://cdn.vidra-e2e-fixtures.example.com/")).toBe(true)
    expect(String(job.body.prompt)).toContain('Reference image 1 shows the character "ZihinLab maskot"')
    expect(job.body.image_url).toBeUndefined()

    const d = db()
    const row = d.prepare("SELECT references_json, preserve_identity FROM generation_jobs WHERE prompt LIKE '%ZihinLab advert%'").get() as { references_json: string; preserve_identity: number }
    const saved = d.prepare("SELECT name, ref_type, local_path, sha256 FROM reference_assets").all() as Array<{ name: string; ref_type: string; local_path: string; sha256: string }>
    d.close()
    expect(JSON.parse(row.references_json)[0]).toMatchObject({ paramKey: "reference_images", refType: "character", name: "ZihinLab maskot", savedId: expect.any(String) })
    expect(row.preserve_identity).toBe(1)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.name).toBe("ZihinLab maskot")
    const root = existsSync(join(secondRoot, "media")) ? secondRoot : archiveRoot
    expect(existsSync(join(root, saved[0]!.local_path))).toBe(true)
    expect(sha256(join(root, saved[0]!.local_path))).toBe(saved[0]!.sha256)
    expect(saved[0]!.sha256).toBe(sha256(fixtures.png))
  })

  test("a saved mascot is reused from the library, never dropped on an incompatible model, and maps to frames", async () => {
    await nav("Video Studio").click()
    await selectModel("Seedance 2.5 · Text to video")
    // Start from an empty panel (the previous step's tile is still there).
    while ((await page.getByTestId("refs-remove").count()) > 0) await page.getByTestId("refs-remove").first().click()
    const uploadsBefore = mock.stats.uploads
    await page.getByTestId("refs-library").click()
    await page.getByTestId("refs-library-item").filter({ hasText: "ZihinLab maskot" }).getByTestId("refs-library-use").click()
    const tile = page.getByTestId("refs-tile").first()
    await expect(tile).toHaveAttribute("data-status", "ready")
    // Re-uploaded from the local library (the provider's storage is temporary).
    expect(mock.stats.uploads).toBe(uploadsBefore + 1)
    await expect(tile.getByText("Saved")).toBeVisible()
    // Text-to-video has no reference input: warned and offered a compatible model; the image stays.
    const warning = page.getByTestId("refs-unsupported")
    await expect(warning).toContainText("no such input")
    await warning.getByTestId("refs-switch-higgsfield:bytedance/seedance-2.5/reference-to-video").click()
    await expect(page.getByTestId("model-picker")).toContainText("Seedance 2.5 · Reference to video")
    await expect(tile).toHaveAttribute("data-placed", "true")
    await expect(warning).toBeHidden()

    // As a first frame on an image-to-video model it goes to image_url.
    await tile.getByTestId("refs-type").click()
    await page.getByRole("option", { name: "First frame" }).click()
    await selectModel("Seedance 2.5 · Image to video")
    await expect(tile).toHaveAttribute("data-placed", "true")
    await submitPrompt("E2E first-frame mascot scene")
    await expect(page.getByTestId("studio-jobs").locator('[data-job-status="completed"]').first()).toBeVisible({ timeout: 60_000 })
    const jobs = (await fetch(`${mock.base}/__jobs`).then((r) => r.json())) as Array<{ path: string; body: Record<string, unknown> }>
    const job = jobs.find((j) => j.path.endsWith("/image-to-video") && String(j.body.prompt).includes("first-frame mascot"))!
    expect(typeof job.body.image_url).toBe("string")
    expect(String(job.body.image_url).startsWith("https://cdn.vidra-e2e-fixtures.example.com/")).toBe(true)
    expect(job.body.image_urls).toBeUndefined()
    // Frames are documented inputs: no consistency text is added for them.
    expect(String(job.body.prompt)).not.toContain("Reference image")
    const d = db()
    const used = d.prepare("SELECT use_count FROM reference_assets").get() as { use_count: number }
    d.close()
    expect(used.use_count).toBeGreaterThanOrEqual(1)
  })

  test("text-to-video without references is unchanged", async () => {
    await generate("E2E plain text-to-video after references", "Seedance 2.0 · Text to video")
    await expect(page.getByTestId("studio-jobs").locator('[data-job-status="completed"]').first()).toBeVisible({ timeout: 60_000 })
    const jobs = (await fetch(`${mock.base}/__jobs`).then((r) => r.json())) as Array<{ path: string; body: Record<string, unknown> }>
    const job = jobs.find((j) => String(j.body.prompt).includes("plain text-to-video"))!
    expect(job.body.image_urls).toBeUndefined()
    expect(job.body.image_url).toBeUndefined()
    expect(job.body.prompt).toBe("E2E plain text-to-video after references")
  })

  test("removing credentials deletes them from Windows Credential Manager", async () => {
    await nav("Providers").click()
    const hf = page.locator('[data-provider="higgsfield"]')
    await hf.getByRole("button", { name: "Remove" }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click()
    await expect.poll(() => credentialTargets().includes(KEYRING_SERVICE)).toBe(false)
  })
})
