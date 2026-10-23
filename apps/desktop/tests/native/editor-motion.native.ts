import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test"

/**
 * Video Editor Phase 2 / Milestone A acceptance on the REAL desktop app (e2e
 * build) with the real FFmpeg on PATH. Every result is checked in frames
 * decoded from the exported MP4, not only in the UI:
 *
 *  A — cutting: 20 s clip, split at 7 s and 12 s, ripple-delete the middle → 15 s.
 *  T — a dip-to-black transition at the cut is black in the export.
 *  B — zoom in 2–4 s and zoom out 6–8 s, measured on a white box in the frames.
 *  G — a project saved by v0.3.0 (format version 1) opens and exports.
 *
 * Media is generated locally by FFmpeg; no provider is contacted.
 */

const EXE = resolve("src-tauri/target/debug/vidra-studio.exe")
let launches = 0
const cdpPort = () => 9434 + (launches % 40) * 2
const run = join(tmpdir(), `vidra-editor-a-${Date.now()}`)
const dataDir = join(run, "data")
const dialogDir = join(run, "dialogs")
const mediaDir = join(run, "media")
const frameDir = join(run, "frames")

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
/** One decoded grey frame of `file` at `t` seconds. */
function grayFrame(file: string, t: number, w: number, h: number): Buffer {
  mkdirSync(frameDir, { recursive: true })
  const out = join(frameDir, `f-${Date.now()}-${Math.round(t * 1000)}.gray`)
  ffmpeg(["-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", out])
  const b = readFileSync(out)
  expect(b.length).toBe(w * h)
  return b
}
const mean = (b: Buffer) => b.reduce((s, x) => s + x, 0) / b.length
/** Width of the white run on the middle row. */
const whiteWidth = (b: Buffer, w: number, h: number) => {
  const row = b.subarray(Math.floor(h / 2) * w, Math.floor(h / 2) * w + w)
  return row.filter((x) => x > 128).length
}

function makeMedia() {
  mkdirSync(mediaDir, { recursive: true })
  // Brightness encodes the source time (12 grey levels per second), so a cut is visible in the frames.
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=black:s=640x360:r=30:d=20,geq=lum='12*T':cb=128:cr=128",
    "-f", "lavfi", "-i", "sine=f=440:d=20",
    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", join(mediaDir, "ramp.mp4"),
  ])
  // A 200×100 white box in the middle of a black 1920×1080 frame.
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30:d=10,drawbox=x=860:y=490:w=200:h=100:c=white:t=fill",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", join(mediaDir, "box.mp4"),
  ])
}

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
  // "Close without saving?" confirmations are accepted.
  page.on("dialog", (d) => void d.accept())
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
const resetScroll = () => page.evaluate(() => document.querySelector("[data-testid=tl-scroller]")!.scrollTo({ left: 0 }))
async function clickClip(l: Locator) {
  await resetScroll()
  const b = await l.boundingBox()
  if (!b) throw new Error("clip not visible")
  await page.mouse.click(b.x + Math.min(30, b.width / 2), b.y + b.height / 2)
}
/** Puts the playhead at a whole second with the keyboard (Home, then Shift+→). */
async function playheadTo(sec: number) {
  await page.keyboard.press("Escape")
  await page.keyboard.press("Home")
  for (let i = 0; i < sec; i++) await page.keyboard.press("Shift+ArrowRight")
}
async function newProject(name: string) {
  if (await page.getByTestId("editor-workspace").isVisible()) await page.getByTestId("editor-close").click()
  await page.getByTestId("editor-new-name").fill(name)
  await page.getByTestId("editor-create").click()
  await expect(page.getByTestId("editor-title")).toContainText(name)
}
async function importAndPlace(file: string) {
  nextOpen(join(mediaDir, file))
  await page.getByTestId("editor-import").click()
  const item = page.locator(`[data-testid="editor-media-item"][title="${file}"]`)
  await expect(item).toBeVisible()
  await item.hover()
  await item.getByTestId("editor-media-add").click()
  await page.getByRole("button", { name: "Fit" }).click()
}
async function exportTo(name: string): Promise<string> {
  const out = join(dialogDir, `${name}.mp4`)
  if (existsSync(out)) rmSync(out)
  await page.getByTestId("editor-export").click()
  const dlg = page.getByTestId("export-dialog")
  await dlg.getByTestId("export-start").click()
  await expect(dlg.getByTestId("export-done")).toBeVisible({ timeout: 240_000 })
  await page.keyboard.press("Escape")
  await expect(dlg).toBeHidden()
  expect(existsSync(out)).toBe(true)
  return out
}
async function setNum(id: string, value: number) {
  const input = page.locator(`#${id}`)
  await input.fill(String(value))
  await input.press("Enter")
}

test.describe.serial("Video Editor Milestone A (real app, real FFmpeg, exported frames checked)", () => {
  test.beforeAll(async () => {
    expect(existsSync(EXE), `build first: ${EXE}`).toBe(true)
    mkdirSync(dataDir, { recursive: true })
    mkdirSync(dialogDir, { recursive: true })
    makeMedia()
    await launch()
    await page.getByRole("radio", { name: "English" }).click()
    await page.getByTestId("skip-onboarding").click()
    await page.getByRole("complementary").first().getByRole("link", { name: "Video Editor", exact: true }).click()
    await expect(page.getByTestId("editor-new")).toBeVisible()
  })

  test.afterAll(async () => {
    await kill()
    const panics = join(dataDir, "panic.log")
    if (existsSync(panics)) console.log("panic.log: " + readFileSync(panics, "utf8").slice(-4000))
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(run, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  })

  let cutExport = ""
  test("A: split at 7 s and 12 s, ripple-delete the middle — the export is 15 s", async () => {
    await newProject("Cut test")
    await importAndPlace("ramp.mp4")
    await expect(clips()).toHaveCount(1)
    await playheadTo(7)
    await page.keyboard.press("s")
    await playheadTo(12)
    await page.keyboard.press("Control+b")
    await expect(clips()).toHaveCount(3)
    await expect(page.locator('[data-testid="tl-clip"][data-start="7.000"]')).toHaveAttribute("data-duration", "5.000")
    await clickClip(page.locator('[data-testid="tl-clip"][data-start="7.000"]'))
    await page.keyboard.press("Shift+Delete")
    await expect(clips()).toHaveCount(2)
    await expect(page.locator('[data-testid="tl-clip"][data-start="7.000"]')).toHaveAttribute("data-duration", "8.000")
    // Undo / redo work on the cut.
    await page.keyboard.press("Control+z")
    await expect(clips()).toHaveCount(3)
    await page.keyboard.press("Control+y")
    await expect(clips()).toHaveCount(2)

    cutExport = await exportTo("Cut test")
    const probe = ffprobe(cutExport)
    expect(Math.abs(Number(probe.format.duration) - 15)).toBeLessThan(0.1)
    const v = probe.streams.find((s) => s.codec_type === "video")!
    const [w, h] = [v.width!, v.height!]
    // Before the cut the source time equals the timeline time; after it, 5 s were removed.
    // Compare with the source decoded at the matching source time (brightness encodes time).
    const src = (t: number) => mean(grayFrame(join(mediaDir, "ramp.mp4"), t, 640, 360))
    for (const [tl, st] of [[6.5, 6.5], [7.5, 12.5], [14.5, 19.5]] as const) {
      const got = mean(grayFrame(cutExport, tl, w, h))
      expect(Math.abs(got - src(st)), `t=${tl}: ${got} vs source ${st}s ${src(st)}`).toBeLessThan(3)
      // 5 s earlier in the source would be ≥ 50 grey levels darker.
      if (tl > 7) expect(Math.abs(got - src(tl))).toBeGreaterThan(30)
    }
  })

  test("T: a dip-to-black transition at the cut is black in the export, length unchanged", async () => {
    await clickClip(page.locator('[data-testid="tl-clip"][data-start="0.000"]'))
    await page.getByTestId("transition-dipBlack").click()
    await expect(page.getByTestId("tl-trans-in")).toHaveAttribute("data-kind", "dipBlack")
    const out = await exportTo("Cut test")
    const probe = ffprobe(out)
    expect(Math.abs(Number(probe.format.duration) - 15)).toBeLessThan(0.1)
    const v = probe.streams.find((s) => s.codec_type === "video")!
    expect(mean(grayFrame(out, 7.0, v.width!, v.height!))).toBeLessThan(22)
    // Outside the transition the picture is untouched.
    const src5 = mean(grayFrame(join(mediaDir, "ramp.mp4"), 5.0, 640, 360))
    expect(Math.abs(mean(grayFrame(out, 5.0, v.width!, v.height!)) - src5)).toBeLessThan(3)
    expect(src5).toBeGreaterThan(30)
  })

  test("B: zoom in 2–4 s and zoom out 6–8 s, measured in the exported frames", async () => {
    await newProject("Zoom test")
    await importAndPlace("box.mp4")
    await clickClip(clips().first())
    // Motion presets live in the inspector's Motion tab (also reachable through the "Zoom" quick action).
    await page.getByTestId("qa-zoom").click()
    const motion = page.getByTestId("clip-motion")
    await motion.getByTestId("motion-preset").click()
    await page.getByRole("option", { name: "Smooth zoom in" }).click()
    await setNum("mo-from", 2)
    await setNum("mo-to", 4)
    await setNum("mo-s0", 100)
    await setNum("mo-s1", 200)
    await motion.getByTestId("motion-apply").click()
    await motion.getByTestId("motion-preset").click()
    await page.getByRole("option", { name: "Smooth zoom out" }).click()
    await setNum("mo-from", 6)
    await setNum("mo-to", 8)
    await setNum("mo-s0", 200)
    await setNum("mo-s1", 100)
    await motion.getByTestId("motion-apply").click()
    // Four keyframe times (2, 4, 6, 8 s) show as diamonds on the clip.
    await expect(page.getByTestId("tl-kf")).toHaveCount(4)

    const out = await exportTo("Zoom test")
    const v = ffprobe(out).streams.find((s) => s.codec_type === "video")!
    const [w, h] = [v.width!, v.height!]
    expect([w, h]).toEqual([1920, 1080])
    const at = (t: number) => whiteWidth(grayFrame(out, t, w, h), w, h)
    const k = w / 1920
    // The box is 200 px wide at scale 1, 400 px at 2× (ease in-out: 1.5× at the middle).
    expect(Math.abs(at(1) - 200 * k)).toBeLessThan(8)
    expect(Math.abs(at(3) - 300 * k)).toBeLessThan(12)
    expect(Math.abs(at(5) - 400 * k)).toBeLessThan(8)
    expect(Math.abs(at(7) - 300 * k)).toBeLessThan(12)
    expect(Math.abs(at(9) - 200 * k)).toBeLessThan(8)
  })

  test("G: a v0.3.0 project (format version 1) opens and exports", async () => {
    const ramp = join(mediaDir, "ramp.mp4")
    const v1 = {
      format: "vidra.editor",
      formatVersion: 1,
      id: "prj_legacy030",
      name: "Legacy v030",
      createdAt: 1_760_000_000_000,
      updatedAt: 1_760_000_000_000,
      settings: { aspect: "16:9", width: 1920, height: 1080, fps: 30, background: "#000000" },
      media: [
        {
          id: "med_ramp",
          kind: "video",
          name: "ramp.mp4",
          path: ramp,
          durationSec: 20,
          width: 640,
          height: 360,
          fps: 30,
          hasAudio: true,
          hasVideo: true,
          sizeBytes: statSync(ramp).size,
          available: true,
        },
      ],
      tracks: [
        { id: "trk_v2", kind: "video", name: "V2", muted: false, hidden: false, locked: false, volume: 1 },
        { id: "trk_v1", kind: "video", name: "V1", muted: false, hidden: false, locked: false, volume: 1 },
        { id: "trk_a1", kind: "audio", name: "A1", muted: false, hidden: false, locked: false, volume: 1 },
      ],
      clips: [
        { id: "clp_1", trackId: "trk_v1", mediaId: "med_ramp", start: 0, in: 2, out: 6, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0, opacity: 1, fit: "fit", x: 0, y: 0, scale: 1 },
      ],
    }
    const file = join(dialogDir, "Legacy v030.vidraproj")
    writeFileSync(file, JSON.stringify(v1, null, 2))
    await page.getByTestId("editor-close").click()
    nextOpen(file)
    await page.getByTestId("editor-open").click()
    await expect(page.getByTestId("editor-title")).toContainText("Legacy v030")
    await expect(clips()).toHaveCount(1)
    await expect(clips().first()).toHaveAttribute("data-duration", "4.000")
    const out = await exportTo("Legacy v030")
    expect(Math.abs(Number(ffprobe(out).format.duration) - 4)).toBeLessThan(0.1)
  })
})
