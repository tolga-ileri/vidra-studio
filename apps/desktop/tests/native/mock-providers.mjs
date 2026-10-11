// Local mock of the documented Higgsfield API (docs/providers/higgsfield.md)
// plus a media host, for the native end-to-end journey. Plain http on
// 127.0.0.1 — only reachable by app builds compiled with the test-only
// `e2e-mock` feature. Never contacts any real provider; nothing is billed.
import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"

/** Self-describing fake credentials (two-part Higgsfield key). */
export const MOCK_KEY_ID = "test-only-not-a-secret-id"
export const MOCK_KEY_SECRET = "test-only-not-a-secret-secret"
const AUTH = `Key ${MOCK_KEY_ID}:${MOCK_KEY_SECRET}`

export function startMockProviders({ port = 4320, webm, png }) {
  const video = readFileSync(webm)
  const image = readFileSync(png)
  const base = `http://127.0.0.1:${port}`
  const jobs = new Map()
  const byIdempotencyKey = new Map()
  const stats = {
    submits: 0,
    idempotentReplays: 0,
    estimates: 0,
    uploads: 0,
    uploadPuts: 0,
    mediaRequests: 0,
    rangeRequests: 0,
    cancels: 0,
    authFailures: 0,
  }
  /** Test controls: drop the next media response midway / throttle / expire. */
  const control = { dropNextMedia: false, slowMedia: false, expireMedia: false }

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers })
    res.end(body === undefined ? "" : JSON.stringify(body))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base)
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks)
    const path = url.pathname

    // ── test controls ──
    if (path === "/__stats") return send(res, 200, { ...stats, jobs: jobs.size })
    if (path === "/__control" && req.method === "POST") {
      Object.assign(control, JSON.parse(raw.toString() || "{}"))
      return send(res, 200, control)
    }
    if (path === "/__jobs") return send(res, 200, [...jobs.values()].map(({ id, path: p, body }) => ({ id, path: p, body })))

    // ── media host (provider CDN) ──
    const media = path.match(/^\/media\/([\w-]+)\.(webm|png)$/)
    if (media) {
      stats.mediaRequests += 1
      if (control.expireMedia) return send(res, 410, { detail: "expired" })
      const bytes = media[2] === "webm" ? video : image
      const type = media[2] === "webm" ? "video/webm" : "image/png"
      const etag = `"${media[1]}-${bytes.length}"`
      let start = 0
      const range = req.headers.range?.match(/^bytes=(\d+)-$/)
      const ifRange = req.headers["if-range"]
      if (range && (!ifRange || ifRange === etag)) {
        stats.rangeRequests += 1
        start = Number(range[1])
      }
      const body = bytes.subarray(start)
      res.writeHead(start ? 206 : 200, {
        "content-type": type,
        "content-length": body.length,
        "accept-ranges": "bytes",
        etag,
        ...(start ? { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
      })
      if (control.dropNextMedia) {
        control.dropNextMedia = false
        res.write(body.subarray(0, Math.floor(body.length / 2)))
        setTimeout(() => res.destroy(), 50)
        return
      }
      if (control.slowMedia) {
        // ~5 KB every 300 ms so the app can be killed mid-download.
        for (let i = 0; i < body.length; i += 5000) {
          if (res.destroyed) return
          res.write(body.subarray(i, i + 5000))
          await new Promise((r) => setTimeout(r, 300))
        }
        return res.end()
      }
      return res.end(body)
    }

    // ── signed upload destination (storage) ──
    if (path === "/upload-put" && req.method === "PUT") {
      stats.uploadPuts += 1
      // The API key must never be sent to storage.
      if (req.headers.authorization) return send(res, 400, { detail: "unexpected authorization header" })
      return send(res, 200, {})
    }

    if (!path.startsWith("/higgsfield/")) return send(res, 404, { detail: "not found" })
    const p = path.slice("/higgsfield".length)

    const status = p.match(/^\/requests\/([\w-]+)\/status$/)
    const cancel = p.match(/^\/requests\/([\w-]+)\/cancel$/)
    if (req.headers.authorization !== AUTH) {
      stats.authFailures += 1
      return send(res, 401, { detail: "Invalid credentials" })
    }

    if (status && req.method === "GET") {
      const job = jobs.get(status[1])
      if (!job) return send(res, 404, { detail: "Request not found" })
      job.polls += 1
      if (job.canceled) return send(res, 200, { status: "canceled", request_id: job.id })
      if (job.polls < 2) return send(res, 200, { status: "queued", request_id: job.id })
      if (job.polls < 3) return send(res, 200, { status: "in_progress", request_id: job.id })
      return send(
        res,
        200,
        job.image
          ? { status: "completed", request_id: job.id, images: [{ url: `${base}/media/${job.id}.png` }] }
          : { status: "completed", request_id: job.id, video: { url: `${base}/media/${job.id}.webm` } }
      )
    }
    if (cancel && req.method === "POST") {
      stats.cancels += 1
      const job = jobs.get(cancel[1])
      if (!job || job.polls > 0) return send(res, 400, { detail: "Request is already being processed" })
      job.canceled = true
      return send(res, 202)
    }
    if (p.startsWith("/estimate/") && req.method === "POST") {
      stats.estimates += 1
      return send(res, 200, { credits: "8.000", usd: "0.495" })
    }
    if (p === "/files/generate-upload-url" && req.method === "POST") {
      stats.uploads += 1
      const { content_type } = JSON.parse(raw.toString() || "{}")
      return send(res, 200, {
        upload_url: `${base}/upload-put`,
        public_url: `https://cdn.vidra-e2e-fixtures.example.com/${randomUUID()}.png`,
        upload_headers: { "Content-Type": content_type ?? "image/png" },
      })
    }

    // submit: POST /<model path> with Idempotency-Key
    if (req.method === "POST") {
      const key = req.headers["idempotency-key"]
      if (key && byIdempotencyKey.has(key)) {
        stats.idempotentReplays += 1
        const id = byIdempotencyKey.get(key)
        return send(res, 200, { status: "queued", request_id: id, status_url: `${base}/higgsfield/requests/${id}/status`, cancel_url: `${base}/higgsfield/requests/${id}/cancel` })
      }
      stats.submits += 1
      const id = randomUUID()
      const modelPath = p.slice(1)
      const isImage = /soul|image|qwen|z-image/i.test(modelPath) && !/video|image-to-video/i.test(modelPath)
      jobs.set(id, { id, path: modelPath, polls: 0, image: isImage, body: JSON.parse(raw.toString() || "{}"), canceled: false })
      if (key) byIdempotencyKey.set(key, id)
      return send(res, 200, {
        status: "queued",
        request_id: id,
        status_url: `${base}/higgsfield/requests/${id}/status`,
        cancel_url: `${base}/higgsfield/requests/${id}/cancel`,
      })
    }
    return send(res, 404, { detail: "not found" })
  })

  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, base, stats, control, jobs })))
}
