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
