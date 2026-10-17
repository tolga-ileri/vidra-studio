import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test"

/**
 * Video Editor acceptance test on the REAL desktop app (e2e build) with the
 * real FFmpeg on PATH: create a project, import three MP4s, reorder, trim,
 * split, add music and a narration track, a PNG logo, switch to 9:16,
 * preview, export a 1080p H.264 MP4 (validated with FFprobe), cancel an
 * export, save, close and reopen. All media is generated locally by FFmpeg;
 * no provider is contacted.
 */

const EXE = resolve("src-tauri/target/debug/vidra-studio.exe")
/** A fresh DevTools port per launch: after a hard kill the old WebView2 can
 *  hold the previous port for a while. */
let launches = 0
const cdpPort = () => 9334 + (launches % 40) * 2
const run = join(tmpdir(), `vidra-editor-${Date.now()}`)
const dataDir = join(run, "data")
const dialogDir = join(run, "dialogs")
const mediaDir = join(run, "media")

let app: ChildProcess | null = null
let browser: Browser | null = null
let page: Page

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "ignore" })
}
function ffprobe(file: string): {
  streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; duration?: string }>
  format: { duration: string }
} {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { encoding: "utf8" }))
}

function makeMedia() {
  mkdirSync(mediaDir, { recursive: true })
  const clips = [
    ["clip-a.mp4", "red", 4, 440],
    ["clip-b.mp4", "green", 5, 550],
    ["clip-c.mp4", "blue", 6, 660],
  ] as const
  for (const [name, color, d, f] of clips)
    ffmpeg([
      "-f", "lavfi", "-i", `color=c=${color}:s=1280x720:r=30:d=${d}`,
      "-f", "lavfi", "-i", `sine=f=${f}:d=${d}`,
      "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(mediaDir, name),
    ])
  ffmpeg(["-f", "lavfi", "-i", "sine=f=220:d=30", join(mediaDir, "music.wav")])
  ffmpeg(["-f", "lavfi", "-i", "sine=f=880:d=4", join(mediaDir, "narration.wav")])
  ffmpeg(["-f", "lavfi", "-i", "color=c=white@1:s=400x200:d=1", "-frames:v", "1", join(mediaDir, "logo.png")])
  writeFileSync(join(mediaDir, "broken.mp4"), Buffer.from("this is not a video file at all"))
}

/** The next native Open dialog returns these files. */
const nextOpen = (...files: string[]) => writeFileSync(join(dialogDir, "next-open.txt"), files.join("\n"))

async function launch() {
  launches += 1
  app = spawn(EXE, [], {
    env: {
      ...process.env,
      VIDRA_E2E_MOCK_BASE: "http://127.0.0.1:1",
      VIDRA_E2E_DATA_DIR: dataDir,
      VIDRA_E2E_DIALOG_DIR: dialogDir,
      WEBVIEW2_USER_DATA_FOLDER: join(run, `webview-${Date.now()}`),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: [
        `--remote-debugging-port=${cdpPort()}`,
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--autoplay-policy=no-user-gesture-required",
      ].join(" "),
    },
    stdio: "ignore",
  })
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort()}`).catch(() => null)
    if (!browser) await new Promise((r) => setTimeout(r, 500))
  }
  if (!browser) throw new Error("Could not attach to the WebView2 of the desktop app")
  const context = browser.contexts()[0]!
  for (let i = 0; i < 60 && !context.pages().find((p) => !p.url().startsWith("about:")); i++) await new Promise((r) => setTimeout(r, 250))
  page = context.pages().find((p) => !p.url().startsWith("about:"))!
  await page.waitForLoadState("domcontentloaded")
}

async function kill() {
  await browser?.close().catch(() => {})
  browser = null
  if (app?.pid) {
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" })
    } catch {
      /* gone */
    }
  }
  app = null
  await new Promise((r) => setTimeout(r, 1500))
}

const clips = () => page.getByTestId("tl-clip")
const clipOf = (name: string) => page.locator(`[data-testid="tl-clip"][title="${name}"]`)
async function box(l: Locator) {
  const b = await l.boundingBox()
  if (!b) throw new Error("element not visible")
  return b
}
/** Drags with the mouse in small steps (pointer events, like a user). */
async function dragBy(l: Locator, dx: number, dy = 0, at: "body" | "end" | "start" = "body") {
  await resetScroll()
  const b = await box(l)
  const x = at === "end" ? b.x + b.width - 2 : at === "start" ? b.x + 2 : b.x + Math.min(30, b.width / 2)
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) await page.mouse.move(x + (dx * i) / 10, y + (dy * i) / 10)
  await page.mouse.up()
}
async function savedProject(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as {
    name: string
    settings: { width: number; height: number; aspect: string }
    media: Array<{ id: string; name: string; path: string }>
    tracks: Array<{ id: string; name: string; kind: string }>
    clips: Array<{ id: string; trackId: string; mediaId: string; start: number; in: number; out: number; speed: number; volume: number; scale: number; x: number; y: number }>
  }
}
const end = (c: { start: number; in: number; out: number; speed: number }) => c.start + (c.out - c.in) / c.speed
/** Scrolls the timeline back to 0 s (Playwright's click() would scroll it sideways). */
const resetScroll = () => page.evaluate(() => document.querySelector("[data-testid=tl-scroller]")!.scrollTo({ left: 0 }))
/** Clicks a timeline clip with the mouse, without auto-scrolling. */
async function clickClip(l: Locator, modifiers: Array<"Control"> = []) {
  await resetScroll()
  const b = await box(l)
  for (const m of modifiers) await page.keyboard.down(m)
  await page.mouse.click(b.x + Math.min(30, b.width / 2), b.y + b.height / 2)
  for (const m of modifiers) await page.keyboard.up(m)
}
/** x of time 0 on the timeline (the lanes' left edge). */
const laneLeft = async () => (await box(page.locator("[data-track-kind]").first())).x

test.describe.serial("Video Editor acceptance (real app, real FFmpeg, local media only)", () => {
  test.beforeAll(async () => {
    expect(existsSync(EXE), `build first: ${EXE}`).toBe(true)
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(dialogDir, { recursive: true })
    makeMedia()
    await launch()
    await page.getByRole("radio", { name: "English" }).click()
    await page.getByTestId("skip-onboarding").click()
  })

  test.afterAll(async () => {
    await kill()
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(run, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  })

  test("1–3: open the Video Editor and create a project", async () => {
    await page.getByRole("complementary").first().getByRole("link", { name: "Video Editor", exact: true }).click()
    await expect(page.getByTestId("editor-new")).toBeVisible()
    await page.getByTestId("editor-new-name").fill("Acceptance edit")
    await page.getByTestId("editor-create").click()
    await expect(page.getByTestId("editor-workspace")).toBeVisible()
    await expect(page.getByTestId("editor-title")).toContainText("Acceptance edit")
  })

  test("4: import three MP4s (a damaged file is reported, the rest import)", async () => {
    nextOpen(join(mediaDir, "clip-a.mp4"), join(mediaDir, "clip-b.mp4"), join(mediaDir, "clip-c.mp4"), join(mediaDir, "broken.mp4"))
    await page.getByTestId("editor-import").click()
    await expect(page.getByTestId("editor-media-item")).toHaveCount(3)
    await expect(page.getByText("broken.mp4")).toBeVisible()
    for (const name of ["clip-a.mp4", "clip-b.mp4", "clip-c.mp4"]) {
      const item = page.locator(`[data-testid="editor-media-item"][title="${name}"]`)
      await item.hover()
      await item.getByTestId("editor-media-add").click()
    }
    await expect(clips()).toHaveCount(3)
    await expect(clipOf("clip-c.mp4")).toHaveAttribute("data-start", "9.000")
  })

  test("5: reorder — move clip A after clip C, then close the gap", async () => {
    await page.getByRole("button", { name: "Fit" }).click()
    const a = clipOf("clip-a.mp4")
    await resetScroll()
    const c = await box(clipOf("clip-c.mp4"))
    const ab = await box(a)
    // Drop A just after C (snaps to C's end at 15 s).
    await dragBy(a, c.x + c.width - ab.x + 4)
    await expect(a).toHaveAttribute("data-start", "15.000")
    // Select B and C, drag them left to 0 (snaps to the timeline start).
    await clickClip(clipOf("clip-b.mp4"))
    await clickClip(clipOf("clip-c.mp4"), ["Control"])
    await resetScroll()
    const bb = await box(clipOf("clip-b.mp4"))
    await dragBy(clipOf("clip-b.mp4"), (await laneLeft()) - bb.x + 2)
    await expect(clipOf("clip-b.mp4")).toHaveAttribute("data-start", "0.000")
    await expect(clipOf("clip-c.mp4")).toHaveAttribute("data-start", "5.000")
    // Close the remaining gap: A moves left to follow C (fit first so A is on screen).
    await page.getByRole("button", { name: "Fit" }).click()
    await clickClip(clipOf("clip-a.mp4"))
    await resetScroll()
    const cb = await box(clipOf("clip-c.mp4"))
    const ab2 = await box(clipOf("clip-a.mp4"))
    await dragBy(clipOf("clip-a.mp4"), cb.x + cb.width - ab2.x + 2)
    await expect(clipOf("clip-a.mp4")).toHaveAttribute("data-start", "11.000")
  })

  test("6–7: trim clip C's end and split clip B at the playhead", async () => {
    const c = clipOf("clip-c.mp4")
    const before = Number(await c.getAttribute("data-duration"))
    const cb = await box(c)
    await dragBy(c, -cb.width / 3, 0, "end")
    const after = Number(await c.getAttribute("data-duration"))
    expect(after).toBeLessThan(before - 1)
    expect(after).toBeGreaterThan(before / 2)
    // Move the playhead into B (2.5 s) by clicking an empty lane, select B and split it.
    await resetScroll()
    const b = await box(clipOf("clip-b.mp4"))
    const emptyLane = await box(page.locator('[data-track-kind="audio"]').nth(1))
    await page.mouse.click(b.x + b.width / 2, emptyLane.y + emptyLane.height / 2)
    await expect(page.getByTestId("editor-timecode")).not.toContainText("0:00:00 /")
    await clickClip(clipOf("clip-b.mp4").first())
    await page.getByTestId("tl-split").click()
    await expect(clipOf("clip-b.mp4")).toHaveCount(2)
  })

  test("8–11: a narration track, music with a lower level and a PNG logo", async () => {
    nextOpen(join(mediaDir, "music.wav"), join(mediaDir, "narration.wav"), join(mediaDir, "logo.png"))
    await page.getByTestId("editor-import").click()
    await expect(page.getByTestId("editor-media-item")).toHaveCount(6)
    const add = async (name: string) => {
      const item = page.locator(`[data-testid="editor-media-item"][title="${name}"]`)
      await item.hover()
      await item.getByTestId("editor-media-add").click()
      await page.getByRole("button", { name: "Fit" }).click()
    }
    const lane = (kind: "video" | "audio", n: number) => page.locator(`[data-track-kind="${kind}"]`).nth(n)
    // Narration lands on A1 at 0; drag it straight down onto A2 (its own track).
    await add("narration.wav")
    const n = clipOf("narration.wav")
    await resetScroll()
    const a2 = await box(lane("audio", 1))
    const nb = await box(n)
    await dragBy(n, 0, a2.y + a2.height / 2 - (nb.y + nb.height / 2))
    await expect(lane("audio", 1).getByTestId("tl-clip")).toHaveCount(1)
    // Music then goes on the free A1, and its level is lowered to 40%.
    await add("music.wav")
    await expect(lane("audio", 0).getByTestId("tl-clip")).toHaveCount(1)
    await clickClip(clipOf("music.wav"))
    const slider = page.getByTestId("clip-inspector").getByRole("slider")
    await slider.focus()
    for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowLeft")
    await expect(page.getByTestId("clip-inspector")).toContainText("Volume 40%")
    // Logo: added after the last V1 clip, dragged up onto V2 at 0, placed top-right.
    await add("logo.png")
    const lg = clipOf("logo.png")
    await resetScroll()
    const v2 = await box(lane("video", 0))
    const lb = await box(lg)
    await dragBy(lg, (await laneLeft()) - lb.x + 1, v2.y + v2.height / 2 - (lb.y + lb.height / 2))
    await expect(lane("video", 0).getByTestId("tl-clip")).toHaveCount(1)
    await expect(lg).toHaveAttribute("data-start", "0.000")
    await clickClip(lg)
    await page.getByTestId("clip-inspector").getByRole("button", { name: "Top right" }).click()
  })

  test("12–13: switch to 9:16 and preview the edit", async () => {
    await page.keyboard.press("Escape")
    await page.getByTestId("aspect-9:16").click()
    await expect(page.getByTestId("editor-frame-size")).toContainText("1080×1920")
    await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-height", "1920")
    const tc0 = await page.getByTestId("editor-timecode").innerText()
    await page.getByTestId("editor-play").click()
    await page.waitForTimeout(1500)
    await page.getByTestId("editor-play").click()
    const tc = await page.getByTestId("editor-timecode").innerText()
    expect(tc).not.toBe(tc0)
    const playedVideo = await page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>("[data-testid=preview-frame] video")].some((v) => v.currentTime > 0.2 && v.readyState >= 2))
    expect(playedVideo).toBe(true)
    if (process.env.EDITOR_SHOT) {
      await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined)
      await page.waitForTimeout(800)
      await page.screenshot({ path: process.env.EDITOR_SHOT })
    }
  })

  let exported = ""
  let projectFile = ""
  test("14: export a playable 1080p H.264 MP4 (validated), and cancelling leaves nothing", async () => {
    // Save first so the expected duration can be read from the project file.
    await page.getByTestId("editor-save").click()
    projectFile = join(dialogDir, "Acceptance edit.vidraproj")
    await expect.poll(() => existsSync(projectFile)).toBe(true)
    const doc = await savedProject(projectFile)
    const duration = Math.max(...doc.clips.map(end))

    await page.getByTestId("editor-export").click()
    const dlg = page.getByTestId("export-dialog")
    await expect(dlg.getByTestId("export-summary")).toContainText("1080×1920")
    // Cancel path first.
    await dlg.getByTestId("export-start").click()
    await expect(dlg.getByTestId("export-progress")).toBeVisible()
    await dlg.getByTestId("export-cancel").click()
    await expect(dlg.getByText("Export canceled")).toBeVisible({ timeout: 30_000 })
    exported = join(dialogDir, "Acceptance edit.mp4")
    expect(existsSync(exported)).toBe(false)
    // Real export.
    await dlg.getByTestId("export-start").click()
    await expect(dlg.getByTestId("export-done")).toBeVisible({ timeout: 240_000 })
    expect(existsSync(exported)).toBe(true)
    const probe = ffprobe(exported)
    const v = probe.streams.find((s) => s.codec_type === "video")!
    const a = probe.streams.find((s) => s.codec_type === "audio")!
    expect([v.codec_name, v.width, v.height]).toEqual(["h264", 1080, 1920])
    expect(a.codec_name).toBe("aac")
    expect(Math.abs(Number(probe.format.duration) - duration)).toBeLessThan(0.35)
    // Audio/video stay in sync: both streams cover the timeline.
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.15)
    // The export decodes end to end (playable).
    execFileSync("ffmpeg", ["-v", "error", "-i", exported, "-f", "null", "-"], { stdio: "ignore" })
    await page.keyboard.press("Escape")
    await expect(dlg).toBeHidden()
  })

  test("15: save, close and reopen — every edit survives", async () => {
    const before = await savedProject(projectFile)
    expect(before.settings).toMatchObject({ aspect: "9:16", width: 1080, height: 1920 })
    expect(before.clips).toHaveLength(7)
    expect(before.media).toHaveLength(6)
    const music = before.clips.find((c) => before.media.find((m) => m.id === c.mediaId)?.name === "music.wav")!
    expect(music.volume).toBeCloseTo(0.4, 2)
    const logo = before.clips.find((c) => before.media.find((m) => m.id === c.mediaId)?.name === "logo.png")!
    expect([logo.x, logo.y]).toEqual([0.4, -0.4])
    const narr = before.clips.find((c) => before.media.find((m) => m.id === c.mediaId)?.name === "narration.wav")!
    expect(before.tracks.find((t) => t.id === narr.trackId)?.name).toBe("A2")
    // Source files were never modified.
    expect(ffprobe(join(mediaDir, "clip-a.mp4")).format.duration.startsWith("4.0")).toBe(true)

    await page.getByTestId("editor-save").click()
    await page.getByTestId("editor-close").click()
    await expect(page.getByTestId("editor-new")).toBeVisible()
    await expect(page.getByTestId("editor-recent")).toContainText("Acceptance edit")
    nextOpen(projectFile)
    await page.getByTestId("editor-open").click()
    await expect(page.getByTestId("editor-title")).toContainText("Acceptance edit")
    await expect(clips()).toHaveCount(7)
    await expect(page.getByTestId("editor-media-item")).toHaveCount(6)
    await expect(page.getByTestId("preview-frame")).toHaveAttribute("data-height", "1920")
    // Undo history starts fresh; the project is not dirty after opening.
    await expect(page.getByTestId("editor-title")).not.toContainText("•")
  })
})
