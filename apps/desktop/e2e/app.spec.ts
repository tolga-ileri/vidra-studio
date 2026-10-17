import { expect, test, type Page } from "@playwright/test"

const nav = (page: Page, name: string) => page.getByRole("complementary", { name: "Main navigation" }).getByRole("link", { name, exact: true })

async function skipOnboarding(page: Page) {
  await page.goto("/")
  await expect(page.getByText("Demo data — browser preview")).toBeVisible()
  await page.getByTestId("skip-onboarding").click()
  await expect(page.getByRole("complementary", { name: "Main navigation" })).toBeVisible()
}

async function connectReplicate(page: Page) {
  await nav(page, "Providers").click()
  const card = page.locator('[data-provider="replicate"]')
  await card.getByRole("button", { name: "Add credentials" }).click()
  await page.getByLabel("API token").fill("demo-test-key")
  await page.getByRole("button", { name: "Save and verify" }).click()
  await expect(card.getByTestId("status-replicate")).toHaveText("Verified")
}

async function connectHiggsfield(page: Page) {
  await nav(page, "Providers").click()
  const card = page.locator('[data-provider="higgsfield"]')
  await card.getByRole("button", { name: "Add credentials" }).click()
  await page.locator("#cred-higgsfield-key_id").fill("demo-key-id")
  await page.locator("#cred-higgsfield-key_secret").fill("demo-key-secret")
  await page.getByRole("button", { name: "Save and verify" }).click()
  await expect(card.getByTestId("status-higgsfield")).toHaveText("Verified")
}

async function selectModel(page: Page, search: string, option: string) {
  await page.getByTestId("model-picker").click()
  await page.getByPlaceholder("Search models…").fill(search)
  await page.getByRole("option").filter({ hasText: option }).first().click()
  await expect(page.getByTestId("model-picker")).toContainText(option)
}

test("onboarding can be skipped", async ({ page }) => {
  await skipOnboarding(page)
  await expect(page.getByRole("heading", { name: "Home" })).toBeVisible()
})

test("generate a video end-to-end until it is saved in the archive", async ({ page }) => {
  await skipOnboarding(page)
  await connectReplicate(page)
  await nav(page, "Video Studio").click()
  await page.getByTestId("prompt-input").fill("A paper boat drifting down a rainy street, macro lens")
  await expect(page.getByTestId("studio-estimate").getByTestId("price")).toBeVisible()
  await page.getByTestId("generate-button").click()
  const dialog = page.getByTestId("confirm-generate")
  await expect(dialog).toContainText("not a provider billing cap")
  // Unknown or unit-based pricing needs an explicit acknowledgement.
  if (await dialog.getByTestId("cost-ack").isVisible()) await dialog.getByTestId("cost-ack").getByRole("checkbox").check()
  await dialog.getByTestId("confirm-generate-button").click()
  await expect(page.getByTestId("studio-jobs").locator('[data-job-status="completed"]').first()).toBeVisible({ timeout: 20_000 })

  await nav(page, "Archive").click()
  await page.getByPlaceholder("Search prompts, titles, tags…").fill("paper boat")
  const card = page.getByTestId("archive-grid").getByRole("listitem")
  await expect(card).toHaveCount(1)
  await expect(card).toHaveAttribute("data-state", "saved", { timeout: 20_000 })
  await expect(card.getByText("Saved")).toBeVisible()
})

test("create a prompt in the library and use it in the studio", async ({ page }) => {
  await skipOnboarding(page)
  await nav(page, "Prompt Library").click()
  await page.getByTestId("new-prompt").click()
  await page.getByLabel("Title").fill("E2E neon alley")
  await page.getByLabel("Prompt", { exact: true }).fill("A neon alley in {city}, wet asphalt reflections")
  await page.getByLabel("City").fill("Tokyo")
  await expect(page.getByTestId("prompt-preview")).toHaveText("A neon alley in Tokyo, wet asphalt reflections")
  await page.getByTestId("save-prompt").click()

  const row = page.locator('[data-prompt-title="E2E neon alley"]')
  await expect(row).toBeVisible()
  await row.getByRole("button", { name: "Use" }).click()
  await expect(page.getByRole("heading", { name: "Video Studio" })).toBeVisible()
  await expect(page.getByTestId("prompt-input")).toHaveValue("A neon alley in Tokyo, wet asphalt reflections")
  await page.getByTestId("template-fields").getByLabel("City").fill("Lagos")
  await expect(page.getByTestId("prompt-input")).toHaveValue("A neon alley in Lagos, wet asphalt reflections")
})

test("analytics exports a CSV", async ({ page }) => {
  await skipOnboarding(page)
  await nav(page, "Analytics").click()
  await page.getByRole("radio", { name: "12 months" }).click()
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByTestId("export-csv").click()])
  expect(download.suggestedFilename()).toMatch(/^vidra-generations-\d{4}-\d{2}-\d{2}\.csv$/)
  const path = await download.path()
  const fs = await import("node:fs/promises")
  const text = await fs.readFile(path, "utf8")
  expect(text).toContain("created_at,provider,model_id")
})

test.describe("Turkish system language", () => {
  test.use({ locale: "tr-TR" })

  test("first run defaults to Turkish and the main screens are localized", async ({ page }) => {
    await page.goto("/")
    await expect(page.getByText("Demo verisi — tarayıcı önizlemesi")).toBeVisible()
    await expect(page.getByRole("heading", { name: "Vidra Studio'ya hoş geldiniz" })).toBeVisible()
    await page.getByTestId("skip-onboarding").click()
    const sidebar = page.getByRole("complementary", { name: "Ana gezinme" })
    await expect(sidebar).toBeVisible()

    await sidebar.getByRole("link", { name: "Modeller" }).click()
    await expect(page.getByRole("button", { name: "Yeni modelleri denetle" })).toBeVisible()
    await page.getByTestId("catalog-sync").click()
    await expect(page.getByTestId("catalog-result")).toBeVisible()

    await sidebar.getByRole("link", { name: "Video Stüdyosu" }).click()
    await expect(page.getByTestId("max-duration")).toContainText("En uzun süre")
    await expect(page.getByText("Tahmini maliyet")).toBeVisible()

    await sidebar.getByRole("link", { name: "Sağlayıcılar" }).click()
    await expect(page.getByText("Sağlayıcı yetkilendirmesi bekleniyor").first()).toBeVisible()

    await sidebar.getByRole("link", { name: "Ayarlar" }).click()
    await expect(page.getByText("Depolama ve arşiv")).toBeVisible()
    await page.getByTestId("storage-change").click()
    const wizard = page.getByTestId("storage-wizard")
    await expect(wizard.getByRole("button", { name: "Kopyala ve doğrula" })).toBeVisible()
    await wizard.getByRole("button", { name: "Taşımayı iptal et" }).click()
    await expect(page.getByText("Taşıma iptal edildi. Hiçbir şey değiştirilmedi.")).toBeVisible()
  })
})

/** 1×1 red PNG, enough for a real file-chooser upload through the mock. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64"
)

test("reference images: upload, save to the library, reuse and send with the request", async ({ page }) => {
  await skipOnboarding(page)
  await connectHiggsfield(page)
  await nav(page, "Video Studio").click()
  await selectModel(page, "Seedance 2.5", "Seedance 2.5 · Reference to video")

  const chooser = page.waitForEvent("filechooser")
  await page.getByTestId("refs-add").click()
  await (await chooser).setFiles({ name: "mascot.png", mimeType: "image/png", buffer: PNG })
  const tile = page.getByTestId("refs-tile").first()
  await expect(tile).toHaveAttribute("data-status", "ready")
  await expect(tile).toHaveAttribute("data-placed", "true")
  await tile.getByTestId("refs-name").fill("ZihinLab maskotu")
  await tile.getByTestId("refs-save").click()
  await expect(tile.getByText("Saved")).toBeVisible()
  await expect(page.getByTestId("refs-guidance")).toContainText('character "ZihinLab maskotu"')

  await page.getByTestId("prompt-input").fill("A 28-second cinematic ZihinLab advertisement with the mascot")
  await page.getByTestId("generate-button").click()
  const dialog = page.getByTestId("confirm-generate")
  if (await dialog.getByTestId("cost-ack").isVisible()) await dialog.getByTestId("cost-ack").getByRole("checkbox").check()
  await dialog.getByTestId("confirm-generate-button").click()
  await expect(page.getByTestId("studio-jobs").locator('[data-job-status="completed"]').first()).toBeVisible({ timeout: 20_000 })

  // Reuse from the library on a fresh visit to the studio.
  await nav(page, "Home").click()
  await nav(page, "Video Studio").click()
  await expect(page.getByTestId("refs-tile")).toHaveCount(0)
  await page.getByTestId("refs-library").click()
  const item = page.getByTestId("refs-library-item").filter({ hasText: "ZihinLab maskotu" })
  await item.getByTestId("refs-library-use").click()
  await expect(page.getByTestId("refs-tile").first()).toHaveAttribute("data-placed", "true")
  await expect(page.getByTestId("refs-tile").first().getByText("Saved")).toBeVisible()
  await page.getByTestId("refs-library").click()
  await expect(page.getByTestId("refs-library-item").filter({ hasText: "ZihinLab maskotu" })).toContainText("Used 1 times")
  await page.keyboard.press("Escape")
  // On a model without a reference input the image is kept and a switch is offered.
  await selectModel(page, "Seedance 2.5", "Seedance 2.5 · Text to video")
  await expect(page.getByTestId("refs-unsupported")).toContainText("no such input")
  await page.getByTestId("refs-switch-higgsfield:bytedance/seedance-2.5/reference-to-video").click()
  await expect(page.getByTestId("model-picker")).toContainText("Reference to video")
  await expect(page.getByTestId("refs-tile").first()).toHaveAttribute("data-placed", "true")
})

test.describe("phone-width viewport", () => {
  test.use({ viewport: { width: 375, height: 812 } })
  test("the video studio and the reference panel fit without horizontal scrolling", async ({ page }) => {
    await skipOnboarding(page)
    await page.goto("/#/video")
    await expect(page.getByTestId("refs-panel")).toBeVisible()
    await expect(page.getByTestId("generate-button")).toBeVisible()
    const wide = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth
      return [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.getBoundingClientRect().right > limit + 1)
        .slice(0, 8)
        .map((el) => `${el.tagName.toLowerCase()}${el.dataset.testid ? `[${el.dataset.testid}]` : ""}.${String(el.className).split(" ").slice(0, 3).join(".")} right=${Math.round(el.getBoundingClientRect().right)}`)
    })
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    expect(overflow, wide.join(" | ")).toBeLessThanOrEqual(0)
  })
})

test("video editor: create a project, import, arrange, export (browser preview backend)", async ({ page }) => {
  await skipOnboarding(page)
  await nav(page, "Video Editor").click()
  await page.getByTestId("editor-new-name").fill("Browser edit")
  await page.getByTestId("new-aspect-9:16").click()
  await page.getByTestId("editor-create").click()
  await expect(page.getByTestId("editor-workspace")).toBeVisible()
  await page.getByTestId("editor-import").click()
  await expect(page.getByTestId("editor-media-item")).toHaveCount(5)
  for (const name of ["Demo clip 1.mp4", "Demo clip 2.mp4", "Demo music.mp3"]) {
    const item = page.locator(`[data-testid="editor-media-item"][title="${name}"]`)
    await item.hover()
    await item.getByTestId("editor-media-add").click()
  }
  await expect(page.getByTestId("tl-clip")).toHaveCount(3)
  await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-height", "1920")
  // Undo / redo
  await page.keyboard.press("Control+z")
  await expect(page.getByTestId("tl-clip")).toHaveCount(2)
  await page.keyboard.press("Control+y")
  await expect(page.getByTestId("tl-clip")).toHaveCount(3)
  await page.getByTestId("editor-export").click()
  await expect(page.getByTestId("export-summary")).toContainText("1080×1920")
  await page.getByTestId("export-start").click()
  await expect(page.getByTestId("export-done")).toBeVisible()
})
