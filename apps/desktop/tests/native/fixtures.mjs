// Generates real media fixtures for the native end-to-end journey:
//   clip.webm  – a 2 s playable VP8/VP9 video recorded from an animated canvas
//   frame.png  – a 640×360 PNG used as a reference image
// Nothing binary is committed to the repository; files are generated per run.
import { mkdir, writeFile, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "@playwright/test"

const dir = join(dirname(fileURLToPath(import.meta.url)), ".fixtures")

export async function ensureFixtures() {
  await mkdir(dir, { recursive: true })
  const webm = join(dir, "clip.webm")
  const png = join(dir, "frame.png")
  try {
    if ((await stat(webm)).size > 1000 && (await stat(png)).size > 100) return { webm, png }
  } catch {
    /* generate */
  }
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const result = await page.evaluate(async () => {
    const canvas = document.createElement("canvas")
    canvas.width = 640
    canvas.height = 360
    const ctx = canvas.getContext("2d")
    const draw = (t) => {
      ctx.fillStyle = "#0b0b0c"
      ctx.fillRect(0, 0, 640, 360)
      ctx.fillStyle = "#e9ecef"
      ctx.beginPath()
      ctx.arc(80 + ((t / 4) % 480), 180, 40, 0, Math.PI * 2)
      ctx.fill()
    }
    draw(0)
    const png = canvas.toDataURL("image/png").split(",")[1]
    const stream = canvas.captureStream(30)
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm" })
    const chunks = []
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    const start = performance.now()
    let raf = 0
    const loop = () => {
      draw(performance.now() - start)
      raf = requestAnimationFrame(loop)
    }
    loop()
    recorder.start(250)
    await new Promise((r) => setTimeout(r, 2000))
    recorder.stop()
    await new Promise((r) => (recorder.onstop = r))
    cancelAnimationFrame(raf)
    const blob = new Blob(chunks, { type: "video/webm" })
    const buf = new Uint8Array(await blob.arrayBuffer())
    let bin = ""
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return { webm: btoa(bin), png }
  })
  await browser.close()
  await writeFile(webm, Buffer.from(result.webm, "base64"))
  await writeFile(png, Buffer.from(result.png, "base64"))
  await mkdir(dirname(webm), { recursive: true })
  return { webm, png }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(await ensureFixtures())
}
