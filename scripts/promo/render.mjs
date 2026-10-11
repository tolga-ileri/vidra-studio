// Renders the English promo package from REAL app screenshots and the demo
// capture (see apps/desktop/tests/native/demo.capture.ts, DEMO_EN_ONLY=1).
//   node scripts/promo/render.mjs
// Requires Playwright (apps/desktop devDependency) and ffmpeg on PATH.
import { execFileSync } from "node:child_process"
import { mkdirSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const require = createRequire(join(root, "apps/desktop/package.json"))
const { chromium } = require("@playwright/test")

const out = join(root, "media/promo")
const work = join(root, "apps/desktop/tests/native/.run/promo")
mkdirSync(out, { recursive: true })
mkdirSync(work, { recursive: true })
const template = pathToFileURL(join(root, "scripts/promo/template.html")).href

const images = {
  poster: [1080, 1350, "vidra-launch-poster"],
  social: [1280, 640, "vidra-github-social-preview"],
  banner: [1500, 500, "vidra-linkedin-x-banner"],
  story: [1080, 1920, "vidra-instagram-story"],
  title: [1440, 900, null],
  end: [1440, 900, null],
  label: [1440, 900, null],
}

const browser = await chromium.launch()
for (const [v, [w, h, name]] of Object.entries(images)) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
  await page.goto(`${template}?v=${v}`)
  await page.waitForLoadState("networkidle")
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => {}))))
  const target = name ? join(out, `${name}.png`) : join(work, `${v}.png`)
  await page.screenshot({ path: target, omitBackground: v === "label" })
  await page.close()
  if (name) {
    // Optimized JPEG companion for social upload limits.
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", target, "-q:v", "3", join(out, `${name}.jpg`)])
  }
}
await browser.close()

// Promo video: title card → real English UI capture (labelled) → end card.
const demo = join(root, "apps/desktop/tests/native/.run/demo")
const body = join(work, "body.mp4")
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y",
  "-f", "concat", "-safe", "0", "-i", join(demo, "frames.txt"),
  "-i", join(work, "label.png"),
  "-filter_complex", "[0:v]fps=30,scale=1440:900:flags=lanczos[b];[b][1:v]overlay=0:0,format=yuv420p",
  "-c:v", "libx264", "-preset", "slow", "-crf", "20", body])
const card = (png, file, sec) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-t", String(sec), "-i", png,
    "-vf", `fps=30,format=yuv420p,fade=t=in:st=0:d=0.5,fade=t=out:st=${sec - 0.5}:d=0.5`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", file])
card(join(work, "title.png"), join(work, "title.mp4"), 3.5)
card(join(work, "end.png"), join(work, "end.mp4"), 4)
const list = join(work, "parts.txt")
writeFileSync(list, ["title.mp4", "body.mp4", "end.mp4"].map((f) => `file '${join(work, f).replace(/\\/g, "/")}'`).join("\n"))
const video = join(out, "vidra-studio-promo.mp4")
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
  "-c:v", "libx264", "-preset", "slow", "-crf", "21", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video])
execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", "8", "-i", video, "-frames:v", "1", "-q:v", "3",
  join(out, "vidra-studio-promo-poster.jpg")])

for (const f of ["vidra-launch-poster", "vidra-github-social-preview", "vidra-linkedin-x-banner", "vidra-instagram-story"])
  for (const ext of ["png", "jpg"]) console.log(`${f}.${ext}`, statSync(join(out, `${f}.${ext}`)).size)
console.log("vidra-studio-promo.mp4", statSync(video).size)
