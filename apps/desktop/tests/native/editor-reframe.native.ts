import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { chromium, expect, test, type Browser, type Locator, type Page } from "@playwright/test"

/**
 * Video Editor Phase 2 / Milestone B acceptance on the REAL desktop app (e2e
 * build) with the real FFmpeg on PATH. Results are checked in frames decoded
 * from the exported MP4s:
 *
 *  C — Smart Reframe: a moving subject in a 16:9 source stays centred in a
 *      9:16 export (motion tracking), and real faces (a panned group photo)
 *      are found and followed (face tracking) with smooth keyframes.
 *  D — a 1080×1920 source in a 9:16 project is neither cropped nor scaled.
 *  E — 4K exports: 2160×3840 and 3840×2160, with the upscaling note shown.
 *  O — overlay / screen replacement: a real screenshot of the app is corner-
 *      pinned onto a screen in the scene; a video overlay as picture-in-picture.
 *  P — a 4K source previews through a 720p proxy while the export keeps the
 *      original's fine detail.
 *
 * Media is generated locally by FFmpeg; no provider is contacted. Set
 * EDITOR_SHOT_DIR to save screenshots of the real app.
 */

const EXE = resolve("src-tauri/target/debug/vidra-studio.exe")
let launches = 0
const cdpPort = () => 9534 + (launches % 40) * 2
const run = join(tmpdir(), `vidra-editor-b-${Date.now()}`)
const dataDir = join(run, "data")
const dialogDir = join(run, "dialogs")
const mediaDir = join(run, "media")
const frameDir = join(run, "frames")
const shotDir = process.env.EDITOR_SHOT_DIR ?? ""

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
function grayFrame(file: string, t: number): { b: Buffer; w: number; h: number } {
  mkdirSync(frameDir, { recursive: true })
  const v = ffprobe(file).streams.find((s) => s.codec_type === "video")!
  const [w, h] = [v.width!, v.height!]
  const out = join(frameDir, `f-${Date.now()}-${Math.round(t * 1000)}.gray`)
  ffmpeg(["-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", out])
  const b = readFileSync(out)
  expect(b.length).toBe(w * h)
  return { b, w, h }
}
const px = (f: { b: Buffer; w: number; h: number }, x: number, y: number) => f.b[Math.min(f.h - 1, Math.floor(y * f.h)) * f.w + Math.min(f.w - 1, Math.floor(x * f.w))]!
/** Horizontal centre (0..1) of the bright pixels of a frame. */
function brightCentre(f: { b: Buffer; w: number; h: number }, threshold = 180): number | null {
  let n = 0
  let sx = 0
  for (let y = 0; y < f.h; y += 2)
    for (let x = 0; x < f.w; x += 2) {
      if (f.b[y * f.w + x]! > threshold) {
        n++
        sx += x
      }
    }
  return n ? sx / n / f.w : null
}

/** rustface ships a 1927 group photo (BSD-2) in its crate; used for the face test when present. */
function groupPhoto(): string | null {
  const src = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "registry", "src")
  if (!existsSync(src)) return null
  for (const d of readdirSync(src)) {
    const p = join(src, d, "rustface-0.1.7", "test.png")
    if (existsSync(p)) return p
  }
  return null
}

function makeMedia() {
  mkdirSync(mediaDir, { recursive: true })
  // C: a bright "person" (white rounded block) walking left → right over 12 s in a 16:9 scene with a static texture.
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x303030:s=1920x1080:r=30:d=12,drawgrid=w=120:h=120:t=2:c=0x404040",
    "-f", "lavfi", "-i", "color=c=white:s=160x420:r=30:d=12",
    "-filter_complex", "[0:v][1:v]overlay=x='200+1300*t/12':y=300:eval=frame,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", join(mediaDir, "walk.mp4"),
  ])
  const photo = groupPhoto()
  if (photo)
    ffmpeg([
      "-loop", "1", "-framerate", "30", "-t", "10", "-i", photo,
      "-vf", "crop=640:360:x='100+800*t/10':y=60,scale=1280:720,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", join(mediaDir, "faces.mp4"),
    ])
  // D: a vertical source with a white border; any crop or scale would lose the border.
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x808080:s=1080x1920:r=30:d=4,drawbox=x=0:y=0:w=1080:h=1920:c=white:t=24",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(mediaDir, "tall.mp4"),
  ])
  // O: a scene with a bright screen on a grey wall; the screen is where the overlay goes.
  ffmpeg([
    "-f", "lavfi", "-i", "color=c=0x808080:s=1280x720:r=30:d=12,drawbox=x=400:y=150:w=480:h=300:c=white:t=fill",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", join(mediaDir, "screen.mp4"),
  ])
  ffmpeg(["-f", "lavfi", "-i", "color=c=green:s=640x360:r=30:d=6", "-f", "lavfi", "-i", "sine=f=660:d=6", "-shortest", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", join(mediaDir, "green.mp4")])
  // P: a 4K source with 2 px vertical stripes (a 720p proxy turns them into flat grey).
  ffmpeg([
    "-f", "lavfi", "-i", "nullsrc=s=3840x2160:r=30:d=2,geq=lum='if(mod(floor(X/2),2),235,16)':cb=128:cr=128",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", join(mediaDir, "uhd.mp4"),
  ])
}

/** 3×3 homography from four point pairs (same solver as packages/core). */
function homography(src: [number, number][], dst: [number, number][]): number[] {
  const A: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]!
    const [u, v] = dst[i]!
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(u, v)
  }
  const n = 8
  const M = A.map((row, i) => [...row, b[i]!])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r
    ;[M[piv], M[c]] = [M[c]!, M[piv]!]
    const d = M[c]![c]!
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const fct = M[r]![c]! / d
      for (let k = c; k <= n; k++) M[r]![k] = M[r]![k]! - fct * M[c]![k]!
    }
  }
  return [...M.map((row, i) => row[n]! / row[i]!), 1]
}
function project(H: number[], x: number, y: number): [number, number] {
  const [a, b, c, d, e, f, g, i] = H as [number, number, number, number, number, number, number, number, number]
  const w = g * x + i * y + 1
  return [(a * x + b * y + c) / w, (d * x + e * y + f) / w]
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
  app.on("exit", (code, signal) => appendFileSync(join(run, "app.log"), `EXIT code=${code} signal=${signal}
`))
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort()}`).catch(() => null)
    if (!browser) await new Promise((r) => setTimeout(r, 500))
  }
  if (!browser) throw new Error("Could not attach to the WebView2 of the desktop app")
  const context = browser.contexts()[0]!
  for (let i = 0; i < 60 && !context.pages().find((p) => !p.url().startsWith("about:")); i++) await new Promise((r) => setTimeout(r, 250))
  page = context.pages().find((p) => !p.url().startsWith("about:"))!
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
const clipOf = (name: string) => page.locator(`[data-testid="tl-clip"][title="${name}"]`)
const resetScroll = () => page.evaluate(() => document.querySelector("[data-testid=tl-scroller]")!.scrollTo({ left: 0 }))
async function clickClip(l: Locator) {
  await resetScroll()
  const b = await l.boundingBox()
  if (!b) throw new Error("clip not visible")
  await page.mouse.click(b.x + Math.min(30, b.width / 2), b.y + b.height / 2)
}
async function playheadTo(sec: number) {
  await page.keyboard.press("Escape")
  await page.keyboard.press("Home")
  for (let i = 0; i < sec; i++) await page.keyboard.press("Shift+ArrowRight")
}
async function newProject(name: string, aspect: "16:9" | "9:16") {
  if (await page.getByTestId("editor-workspace").isVisible()) await page.getByTestId("editor-close").click()
  await page.getByTestId("editor-new-name").fill(name)
  await page.getByTestId(`new-aspect-${aspect}`).click()
  await page.getByTestId("editor-create").click()
  await expect(page.getByTestId("editor-title")).toContainText(name)
}
async function importMedia(...files: string[]) {
  nextOpen(...files.map((f) => join(mediaDir, f)))
  await page.getByTestId("editor-import").click()
  for (const f of files) await expect(page.locator(`[data-testid="editor-media-item"][title="${f}"]`)).toBeVisible({ timeout: 60_000 })
}
async function place(file: string) {
  const item = page.locator(`[data-testid="editor-media-item"][title="${file}"]`)
  await item.hover()
  await item.getByTestId("editor-media-add").click()
  await page.getByRole("button", { name: "Fit" }).click()
}
async function exportTo(name: string, preset?: "720p" | "1080p" | "2160p"): Promise<string> {
  const out = join(dialogDir, `${name}.mp4`)
  if (existsSync(out)) rmSync(out)
  await page.getByTestId("editor-export").click()
  const dlg = page.getByTestId("export-dialog")
  if (preset) {
    await dlg.getByTestId("export-preset").click()
    await page.getByRole("option", { name: new RegExp(preset === "2160p" ? "^4K" : `^${preset}`) }).click()
  }
  if (shotDir && preset === "2160p") await shot("export-4k")
  await dlg.getByTestId("export-start").click()
  await expect(dlg.getByTestId("export-done")).toBeVisible({ timeout: 600_000 })
  await page.keyboard.press("Escape")
  await expect(dlg).toBeHidden()
  expect(existsSync(out)).toBe(true)
  if (process.env.EDITOR_DEBUG) {
    const keep = resolve("tests/native/.run/debug")
    mkdirSync(keep, { recursive: true })
    copyFileSync(out, join(keep, `${name}.mp4`))
  }
  return out
}
async function setNum(id: string, value: number) {
  const input = page.locator(`#${id}`)
  await input.fill(String(value))
  await input.press("Enter")
}
async function saved(name: string) {
  const file = join(dialogDir, `${name}.vidraproj`)
  // An earlier save of the same project must not be read back as the new one.
  if (existsSync(file)) rmSync(file)
  await page.getByTestId("editor-save").click()
  await expect.poll(() => existsSync(file)).toBe(true)
  return JSON.parse(readFileSync(file, "utf8")) as {
    media: Array<{ id: string; name: string }>
    clips: Array<{ id: string; mediaId: string; fit: string; x: number; y: number; scale: number; keyframes: { x?: Array<{ s: number; v: number }> }; reframe: { mode: string; status: string | null; method: string | null }; corners: number[] | null }>
  }
}
async function shot(name: string) {
  if (!shotDir) return
  mkdirSync(shotDir, { recursive: true })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(shotDir, `${name}.png`) })
}

test.describe.serial("Video Editor Milestone B (real app, real FFmpeg, exported frames checked)", () => {
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
    for (const f of ["app.log", join("data", "panic.log")]) if (existsSync(join(run, f))) console.log(`${f}: ` + readFileSync(join(run, f), "utf8").slice(-4000))
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(run, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 500))
      }
    }
  })

  test("C1: Smart Reframe follows a moving subject into a 9:16 export (motion tracking)", async () => {
    await newProject("Reframe test", "9:16")
    await importMedia("walk.mp4")
    await place("walk.mp4")
    await clickClip(clips().first())
    await page.getByTestId("qa-reframe").click()
    await expect(page.getByTestId("reframe-section")).toBeVisible()
    await page.getByTestId("reframe-analyze").click()
    const result = page.getByTestId("reframe-result")
    await expect(result).toBeVisible({ timeout: 120_000 })
    // No face in a synthetic scene: the app says so and offers the moving area.
    await expect(result).toHaveAttribute("data-method", "motion")
    await page.getByTestId("reframe-follow").first().click()
    await expect(page.getByTestId("reframe-status")).toHaveAttribute("data-mode", "auto")
    await shot("reframe-motion")
    const doc = await saved("Reframe test")
    const c = doc.clips[0]!
    expect(c.fit).toBe("fill")
    const xs = c.keyframes.x!
    expect(xs.length).toBeGreaterThan(2)
    // Subject moves right → the picture pans left (x decreases), smoothly.
    expect(xs[0]!.v).toBeGreaterThan(xs[xs.length - 1]!.v + 0.5)
    for (let i = 1; i < xs.length; i++) expect(Math.abs(xs[i]!.v - xs[i - 1]!.v) / Math.max(0.1, xs[i]!.s - xs[i - 1]!.s)).toBeLessThan(0.5)

    const out = await exportTo("Reframe test", "1080p")
    const v = ffprobe(out).streams.find((s) => s.codec_type === "video")!
    expect([v.width, v.height]).toEqual([1080, 1920])
    // The subject stays near the horizontal centre of the vertical frame all along.
    for (const t of [1.5, 4, 6, 8, 10.5]) {
      const cx = brightCentre(grayFrame(out, t))
      expect(cx, `t=${t}`).not.toBeNull()
      expect(Math.abs(cx! - 0.5), `t=${t} centre ${cx}`).toBeLessThan(0.12)
    }
    // No jitter: consecutive frames keep the subject within a few pixels.
    const c1 = brightCentre(grayFrame(out, 6.0))!
    const c2 = brightCentre(grayFrame(out, 6.0 + 1 / 30))!
    const c3 = brightCentre(grayFrame(out, 6.0 + 2 / 30))!
    expect(Math.abs(c1 - c2) * 1080).toBeLessThan(6)
    expect(Math.abs(c2 - c3) * 1080).toBeLessThan(6)
  })

  test("C2: real faces are found and one of several people can be followed", async () => {
    test.skip(!existsSync(join(mediaDir, "faces.mp4")), "rustface sample photo not in the cargo cache")
    await importMedia("faces.mp4")
    await place("faces.mp4")
    await clickClip(clipOf("faces.mp4"))
    await page.getByTestId("qa-reframe").click()
    await page.getByTestId("reframe-analyze").click()
    const result = page.getByTestId("reframe-result")
    await expect(result).toBeVisible({ timeout: 180_000 })
    await expect(result).toHaveAttribute("data-method", "face")
    const subjects = page.getByTestId("reframe-subject")
    expect(await subjects.count()).toBeGreaterThanOrEqual(2)
    await shot("reframe-faces")
    await subjects.nth(1).getByTestId("reframe-follow").click()
    await expect(page.getByTestId("reframe-status")).toHaveAttribute("data-mode", "auto")
    const doc = await saved("Reframe test")
    const c = doc.clips.find((q) => doc.media.find((m) => m.id === q.mediaId)?.name === "faces.mp4")!
    expect(c.reframe.method).toBe("face")
    const xs = c.keyframes.x!
    expect(xs.length).toBeGreaterThan(1)
    // The window pans right, so a tracked face drifts left in the source and the crop pans right (x grows).
    expect(xs[xs.length - 1]!.v).toBeGreaterThan(xs[0]!.v)
    for (let i = 1; i < xs.length; i++) expect(xs[i]!.v).toBeGreaterThanOrEqual(xs[i - 1]!.v - 0.02)
  })

  test("D: a 1080×1920 source in a 9:16 project is not cropped or scaled", async () => {
    await newProject("Vertical test", "9:16")
    await importMedia("tall.mp4")
    await place("tall.mp4")
    await clickClip(clips().first())
    await page.getByTestId("qa-reframe").click()
    await expect(page.getByTestId("reframe-same-aspect")).toBeVisible()
    const out = await exportTo("Vertical test", "1080p")
    const f = grayFrame(out, 2)
    expect([f.w, f.h]).toEqual([1080, 1920])
    // The 24 px white border of the source is at the edges of the export: nothing was cropped.
    for (const [x, y] of [
      [0.005, 0.5],
      [0.995, 0.5],
      [0.5, 0.004],
      [0.5, 0.996],
    ] as const)
      expect(px(f, x, y), `edge ${x},${y}`).toBeGreaterThan(200)
    expect(px(f, 0.5, 0.5)).toBeLessThan(150)
  })

  test("E: 4K exports in both orientations, with the upscaling note", async () => {
    // 2160×3840 from the vertical project (sources are 1080p → the note shows).
    await page.getByTestId("editor-export").click()
    const dlg = page.getByTestId("export-dialog")
    await dlg.getByTestId("export-preset").click()
    await page.getByRole("option", { name: /^4K/ }).click()
    await expect(dlg.getByTestId("export-upscale")).toBeVisible()
    await expect(dlg.getByTestId("export-estimate")).toBeVisible()
    await shot("export-4k")
    await dlg.getByRole("button", { name: "Cancel" }).click()
    await expect(dlg).toBeHidden()
    const tall = await exportTo("Vertical test", "2160p")
    const tv = ffprobe(tall).streams.find((s) => s.codec_type === "video")!
    expect([tv.codec_name, tv.width, tv.height]).toEqual(["h264", 2160, 3840])
    execFileSync("ffmpeg", ["-v", "error", "-i", tall, "-f", "null", "-"], { stdio: "ignore" })

    await newProject("Wide 4K test", "16:9")
    await importMedia("walk.mp4")
    await place("walk.mp4")
    const wide = await exportTo("Wide 4K test", "2160p")
    const wv = ffprobe(wide).streams.find((s) => s.codec_type === "video")!
    expect([wv.codec_name, wv.width, wv.height]).toEqual(["h264", 3840, 2160])
    expect(Math.abs(Number(ffprobe(wide).format.duration) - 12)).toBeLessThan(0.15)
    execFileSync("ffmpeg", ["-v", "error", "-i", wide, "-f", "null", "-"], { stdio: "ignore" })
  })

  test("O: a real screenshot is corner-pinned onto the screen in the scene; a video overlay as PiP", async () => {
    await newProject("Overlay test", "16:9")
    await importMedia("screen.mp4")
    await place("screen.mp4")
    // A real screenshot of the app is the "correct screen".
    const screenshot = join(mediaDir, "shot.png")
    await page.screenshot({ path: screenshot })
    await clickClip(clips().first())
    await playheadTo(1)
    await clickClip(clips().first())
    nextOpen(screenshot)
    await page.getByTestId("qa-fix-screen").click()
    await expect(clips()).toHaveCount(2)
    await expect(page.getByTestId("overlay-section")).toBeVisible()
    await expect(page.getByTestId("pin-toggle")).toHaveAttribute("data-state", "checked")
    await expect(page.getByTestId("preview-corner-layer")).toBeVisible()
    // The screen is at (400,150)–(880,450) in 1280×720; pin the corners just inside it, seen at an angle.
    const quad = [0.32, 0.22, 0.68, 0.24, 0.325, 0.615, 0.675, 0.59]
    for (let i = 0; i < 4; i++) {
      await setNum(`corner-${i}-0`, Math.round(quad[i * 2]! * 1000) / 10)
      await setNum(`corner-${i}-1`, Math.round(quad[i * 2 + 1]! * 1000) / 10)
    }
    await shot("overlay-corner-pin")
    await page.getByTestId("pin-edit").click()
    // Preview shows the pinned element.
    expect(await page.locator("[data-pinned]").count()).toBe(1)

    // Video overlay as picture-in-picture at 8 s, top right, quarter size.
    await playheadTo(8)
    await clickClip(clipOf("screen.mp4"))
    nextOpen(join(mediaDir, "green.mp4"))
    await page.getByTestId("qa-add-video").click()
    await expect(clips()).toHaveCount(3)
    await page.getByTestId("tab-edit").click()
    await page.getByTestId("clip-inspector").getByRole("button", { name: "Top right" }).click()
    await shot("overlay-pip")

    const doc = await saved("Overlay test")
    const pinned = doc.clips.find((c) => doc.media.find((m) => m.id === c.mediaId)?.name === "shot.png")!
    expect(pinned.corners!.map((v) => Math.round(v * 1000) / 1000)).toEqual(quad)

    const out = await exportTo("Overlay test", "720p")
    const f = grayFrame(out, 3)
    // Inside the quad: the dark app UI (the screenshot), not the white screen.
    const cx = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4
    const cy = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4
    const shotF = (() => {
      const g = join(frameDir, "shot.gray")
      mkdirSync(frameDir, { recursive: true })
      ffmpeg(["-i", screenshot, "-f", "rawvideo", "-pix_fmt", "gray", g])
      const info = ffprobe(screenshot).streams[0]!
      return { b: readFileSync(g), w: info.width!, h: info.height! }
    })()
    // Map screenshot points through the same homography the export uses (unit square → quad)
    // and compare luma: the picture must land at the right place, in perspective.
    const H = homography(
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ],
      [
        [quad[0]!, quad[1]!],
        [quad[2]!, quad[3]!],
        [quad[4]!, quad[5]!],
        [quad[6]!, quad[7]!],
      ]
    )
    let close = 0
    const samples: string[] = []
    for (const u of [0.2, 0.35, 0.5, 0.65, 0.8])
      for (const v of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        const [x, y] = project(H, u, v)
        const a = px(f, x, y)
        const b = px(shotF, u, v)
        samples.push(`${u},${v}: export ${a} shot ${b}`)
        if (Math.abs(a - b) < 40) close++
      }
    expect(close, samples.join(" | ")).toBeGreaterThanOrEqual(20)
    // Just outside each corner the scene is untouched (grey wall or white screen), never the overlay.
    for (let i = 0; i < 4; i++) {
      const [x, y] = [quad[i * 2]!, quad[i * 2 + 1]!]
      const outside = px(f, x - (cx - x) * 0.08, y - (cy - y) * 0.08)
      expect(outside, `corner ${i} outside`).toBeGreaterThan(110)
    }
    // Picture in picture at 9 s: FFmpeg's "green" (0,128,0) has luma ≈ 76 in the top-right quarter; the scene elsewhere.
    const g = grayFrame(out, 9)
    expect(px(g, 0.85, 0.15)).toBeGreaterThan(60)
    expect(px(g, 0.85, 0.15)).toBeLessThan(95)
    expect(Math.abs(px(g, 0.15, 0.85) - 128)).toBeLessThan(12)
  })

  test("P: a 4K source previews through a 720p proxy; the export keeps the original detail", async () => {
    await newProject("Proxy test", "16:9")
    await importMedia("uhd.mp4")
    const status = page.getByTestId("proxy-status")
    await expect(status).toHaveAttribute("data-ready", "true", { timeout: 180_000 })
    await place("uhd.mp4")
    const src = await page.locator("video[data-clip]").first().getAttribute("src")
    expect(src).toContain("-720.mp4")
    await page.getByTestId("proxy-toggle").click()
    const orig = await page.locator("video[data-clip]").first().getAttribute("src")
    expect(orig).not.toContain("-720.mp4")
    await page.getByTestId("proxy-toggle").click()
    await shot("proxy")
    const out = await exportTo("Proxy test", "2160p")
    const f = grayFrame(out, 1)
    expect([f.w, f.h]).toEqual([3840, 2160])
    // 2 px stripes survive only when the original 4K file was rendered.
    const row = f.b.subarray(1080 * 3840 + 1000, 1080 * 3840 + 1200)
    expect(Math.max(...row) - Math.min(...row)).toBeGreaterThan(120)
  })
})
