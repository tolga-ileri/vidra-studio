# Higgsfield API: provider notes

Written only from Higgsfield's published documentation. No code from `higgsfield-ai/app-templates` and no local project code was used. Retrieved 2026-10-11. Endpoints, schemas and prices can change, so check them again before you release.

## 1. Sources (retrieved 2026-10-11)

| Topic | URL |
|---|---|
| Docs index | https://docs.higgsfield.ai/docs/llms.txt |
| Authentication | https://docs.higgsfield.ai/docs/authentication.md |
| Requests / statuses / outputs | https://docs.higgsfield.ai/docs/concepts/requests.md |
| Idempotency | https://docs.higgsfield.ai/docs/concepts/idempotency.md |
| Webhooks | https://docs.higgsfield.ai/docs/how-to/webhooks.md |
| File uploads | https://docs.higgsfield.ai/docs/concepts/file-uploads.md |
| Errors | https://docs.higgsfield.ai/docs/concepts/errors.md |
| Rate limits | https://docs.higgsfield.ai/docs/concepts/rate-limits.md |
| Billing, estimate, retention | https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md |
| API reference overview | https://docs.higgsfield.ai/docs/api-reference/overview.md |
| FAQ | https://docs.higgsfield.ai/docs/help/faq.md |
| OpenAPI (supplementary, partial) | https://docs.higgsfield.ai/docs/openapi.json |
| Per-model docs | https://docs.higgsfield.ai/docs/models/... (cited per row below) |
| Model explorer / prices | https://open.higgsfield.ai/explore and https://open.higgsfield.ai/models/... |
| Terms of Use | https://higgsfield.ai/terms-of-use-agreement |

The docs index says to treat the OpenAPI file as supplementary. A model that is missing from it can still be available. It only lists Soul standard, Kling 2.5 Turbo and Hailuo 2.3.

## 2. Authentication

- Header: `Authorization: Key <KEY_ID>:<KEY_SECRET>`. The ID and secret are joined by a colon. The scheme is `Key`, not Bearer.
- You create credentials (a key ID plus a secret) in the Higgsfield Console. The docs do not give a length, prefix or character set.
- The legacy headers `hf-api-key` and `hf-secret` still work but are discouraged.
- If credentials are missing, malformed or invalid, the API returns `401` with `{"detail": "Invalid credentials"}`.
- Authentication only identifies the account. A model the account cannot use can return `404`, `423` or `503`.
- The FAQ says the secret should not appear in browser or mobile code. A native desktop app that keeps the key locally on the user's machine is the closest fit.

**Validating a key.** There is no documented "whoami" or free validation endpoint. Options:
1. `GET /requests/<random-uuid>/status`. A `401` means the key is bad. A `404` most likely means the key was accepted. *Inferred, not documented.*
2. `POST /estimate/<model-path>`. This returns a price without creating a generation. The billing page **does not say whether estimate calls are free**, so treat that as unconfirmed. The idempotency page lists estimates as non-generation calls (see §3).

## 3. Request lifecycle

Base URL: `https://api.higgsfield.ai`

| Step | Call | Notes |
|---|---|---|
| Submit | `POST /<model-path>` with a JSON body | Returns right away with `status`, `request_id` (UUID), `status_url`, `cancel_url`. Use the returned URLs; don't build them yourself. |
| Status | `GET /requests/{request_id}/status` | Returns a `RequestStatus`: `status`, `request_id`, `status_url`, `cancel_url`, `error` (string or null), `images[]`, `video`, `audio`, `audios[]`. |
| Cancel | `POST /requests/{request_id}/cancel` | Only works while the request is `queued`. Success is `202` with an empty body. Once processing has started you get `400`. A canceled request is refunded. |
| Estimate | `POST /estimate/<model-path>` with the same body as the submit | Response, e.g. `{"credits": "1.500", "usd": "0.094"}`. Both values are **strings**. The documented example is `/estimate/higgsfield-ai/soul/v2/standard`. |

**Statuses**

| Status | Terminal | Meaning |
|---|---|---|
| `queued` | no | Can still be canceled |
| `in_progress` | no | Can no longer be canceled |
| `completed` | yes | Output URLs are present |
| `failed` | yes | May include `error`. Not charged. |
| `nsfw` | yes | Rejected by moderation. Not charged. |
| `canceled` | yes | Canceled before processing started |

**Idempotency-Key** (generation submissions only)
- 1 to 255 visible ASCII characters, no whitespace. UUIDs are recommended.
- The key is scoped to the account and survives API key rotation. Reuse it only when the endpoint, JSON body and webhook are identical. Key order inside objects doesn't matter. Array order, omitted fields, explicit `null` and different URLs all count as changes.
- Reusing a key with different parameters returns `422` "Idempotency-Key was already used with different request parameters."
- Requests rejected before acceptance (auth or validation errors) don't use up the key.
- After a network error, timeout or `5xx`, retry with the same key. The replay returns the original `request_id` and doesn't charge again. A replay may show `queued` even if the request has finished, so poll `status_url`.
- The docs do not state an expiry window.

**Webhooks**
- Pass `?hf_webhook=<url-encoded https URL>` on the submit request.
- Your endpoint must be public HTTPS and respond within 10 s.
- Deliveries are POSTs on `completed`, `failed` or `nsfw`. The envelope is `{request_id, status, error, payload}`, and `payload` holds `images`, `video` or `audio`. For `failed` and `nsfw`, `payload` is `null`.
- Network failures and `5xx` responses are retried for up to 2 h. A `4xx` is treated as permanent. Duplicates can arrive, so dedupe on (`request_id`, `status`).
- **No signing is documented.**
- A local desktop app has no public endpoint, so it should **poll** with backoff, as described in the polling docs.

## 4. File uploads

1. `POST /files/generate-upload-url` with the auth header and the body `{"content_type": "image/png"}`.
2. The response contains:
   - `upload_url`: presigned, expires after 1 h
   - `public_url`: pass this to the model as `image_url`, `video_url` or `audio_url`
   - `content_type`
   - `upload_headers`: e.g. `Content-Type`, and `x-amz-tagging: retention=temporary`
3. `PUT` the bytes to `upload_url` with **every** header from `upload_headers`. Do **not** send Higgsfield credentials to that URL. The content type must match the one you requested.

**Accepted content types**

| Kind | Types |
|---|---|
| Image | `image/jpeg`, `image/jpg`, `image/png`, `image/webp`, `image/gif` |
| Audio | `audio/wav`, `audio/x-wav` |
| Video | `video/mp4` |

**Size limits:** not documented. Some model pages add their own limits, such as maximum reference counts and durations.

Model docs say media must be public URLs and that `asset://` references are rejected.

## 5. Outputs and retention

- Image: `images[].url`. Video: `video.url`. Audio: `audio.url` and `audios[].url`. Some video and 3D operations can also return `zip`, `mov`, `jsx`, `fbx` or `ply`.
- Output URLs are kept for **at least 7 days** and may be removed after that. The app should download the media into the local library on completion.
- Billing: only successful generations are charged. `failed` and `nsfw` are refunded automatically. Credits expire one year after they are added.

## 6. Errors and rate limits

| Code | Meaning | Retry |
|---|---|---|
| 400 | Invalid params or rejected input, **or the concurrency limit was reached**; also cancel after processing started | After fixing the request, or after waiting |
| 401 | Missing or invalid credentials | No |
| 403 | Insufficient credits | After the user adds funds |
| 404 | Request or model not found for this account | No |
| 422 | Validation failed, or an idempotency key was reused with different params | No |
| 423 | Model temporarily blocked | Later |
| 500 | Server error | Exponential backoff with jitter, capped, same idempotency key |
| 503 | Model disabled or not ready | Later |

**Rate limits**
- The main limit is **concurrency**: how many requests can be queued or processing at once. It varies by account and model and is shown in the Console.
- When you hit it you get `400`, e.g. "Maximum number of concurrent requests (4) has been reached". The 4 is only an example.
- There are no rate-limit or `Retry-After` headers.
- The docs recommend a client-side semaphore, tracking each `request_id` until it is terminal, and keeping polling separate from submit concurrency.

## 7. Model discovery

There is **no documented model-list API**. The docs index says to discover models through the Console (https://console.higgsfield.ai) and the per-model docs. The API overview and FAQ do not mention a list endpoint either. Availability depends on the account, and a model being documented does not mean the account can use it.

The client should ship a static catalog like the one below and handle `404`, `423` and `503` per model.

## 8. Model catalog (verified on official model docs)

"Req" means required. Every body below rejects unknown fields (`additionalProperties: false`) unless noted. Prices come from open.higgsfield.ai/explore or the model page, are in USD, and are list prices that may include promotional discounts. Treat them as indicative and use `/estimate` for real costs.

### Video

| # | Endpoint (POST) | Workflow | Fields | Price (from) |
|---|---|---|---|---|
| V1 | `bytedance/seedance-2.0/text-to-video` | t2v | `prompt` str **req** (min 1); `duration` int 4–15, default 5; `resolution` `480p`/`720p`/`1080p`/`4k`, default `720p`; `aspect_ratio` `16:9`/`4:3`/`1:1`/`3:4`/`9:16`/`21:9`, default `16:9`; `generate_audio` bool, default true | $0.099/s (explore) |
| V2 | `bytedance/seedance-2.0/image-to-video` | i2v + first/last frame | `image_url` uri **req**; `prompt` str; `end_image_url` uri; `duration` 4–15 (5); `resolution` as V1; `generate_audio` bool (true). No `aspect_ratio` listed. | same model |
| V3 | `bytedance/seedance-2.0/reference-to-video` | reference | `prompt`; `image_urls` 1–9 and/or `video_urls` 1–3 (at least one required); `audio_urls` 1–3 (audio alone is not enough); `duration` 4–15 (5); `resolution` as V1; `aspect_ratio` as V1; `generate_audio` (true). Don't mix with `image_url`, `end_image_url` or `video_url`. Reference videos are trimmed to 15 s. | same model |
| V4 | `bytedance/seedance-2.5/text-to-video` | t2v | `prompt` **req**; `duration` 4–30 (5); `resolution` `480p`/`720p`/`1080p` (720p); `aspect_ratio` as V1 (16:9); `bitrate_mode` `standard`/`high` (high); `output_format` `mp4`/`mov` (mp4); `generate_audio` (true) | $0.144/s (explore) |
| V5 | `bytedance/seedance-2.5/image-to-video` | i2v + first/last frame | `image_url` **req**; `prompt`; `end_image_url`; `duration` 4–30 (5); `resolution` 480p/720p/1080p (720p); `bitrate_mode` (high); `generate_audio` (true) | same model |
| V6 | `bytedance/seedance-2.5/reference-to-video` | reference | `prompt`; at least one non-empty array among `image_urls` (≤30), `video_urls` (≤10), `audio_urls` (≤10), 50 total, audio-only allowed; `duration` 4–30 (5); `resolution` 480p/720p/1080p; `aspect_ratio` as V1; `bitrate_mode`; `generate_audio` | same model |
| V7 | `bytedance/seedance-2.5/video-edit` | video edit | `prompt` **req**; `video_url` **req**; `image_urls` ≤30, `video_urls` ≤9, `audio_urls` ≤10; `resolution` (720p); `bitrate_mode` (high); `generate_audio` (true). **No `duration`**: it is derived from the source. | same model |
| V8 | `kling-video/v3.0/std/text-to-video` | t2v | `prompt` str (non-empty, max 2500, truncated beyond that); `sound` `"on"`/`"off"` (on); `duration` int 3–15 (5); `aspect_ratio` `16:9`/`9:16`/`1:1` (16:9); `cfg_scale` 0–1 step 0.01 (0.5); `multi_shots` bool (false); `multi_prompt[]` 1–6 × {`prompt` ≤512 **req**, `duration` 1–15 **req**}; `elements` string[] (account-owned Kling element IDs). The docs don't say whether additionalProperties is false. | $0.042/s (explore, shown as 50% off $0.084/s) |
| V9 | `kling-video/v3.0/std/image-to-video` | i2v + first/last frame | `image_url` **req** (first frame); `last_image_url` (end frame; **note the name differs from Seedance/Wan**); `prompt` (non-empty per notes, ≤2500); `sound`; `duration` 3–15; `cfg_scale`; `multi_shots`; `multi_prompt[]`; `elements`. No `aspect_ratio` listed. | $0.042–0.063/s (model page) |
| V10 | `kling-video/v3.0/pro/…`, `/4k/…`, `kling-video/v3.0-turbo/{text,image}-to-video` | t2v / i2v tiers | Listed on https://docs.higgsfield.ai/docs/models/kling-3.md. **Fields not verified**; assumed to match V8/V9 *(inferred)*. | not verified |
| V11 | `wan/v2.7/text-to-video` | t2v | `prompt` **req**; `seed` int 1–2147483646; `duration` 2–15 (5); `audio_url` uri (driving audio); `resolution` `720p`/`1080p` (720p); `aspect_ratio` `16:9`/`9:16`/`1:1`/`4:3`/`3:4` (16:9); `prompt_extend` (false); `negative_prompt` ("") | $0.050/s (explore) |
| V12 | `wan/v2.7/image-to-video` | i2v + first/last frame | `image_url` **req**; `prompt`; `end_image_url`; `audio_url`; `duration` 2–15 (5); `resolution` 720p/1080p; `prompt_extend`; `negative_prompt`; `seed` 1–2147483646 | same model |
| V13 | `wan/v2.7/reference-to-video` | reference | `prompt` **req**; `image_urls` and/or `video_urls` (at least one, ≤5 combined); `duration` 2–10 (5); `resolution` 720p/1080p; `aspect_ratio` `16:9`/`9:16`; `seed`; `prompt_extend`; `negative_prompt` | same model |
| V14 | `alibaba/wan-3.0/text-to-video` | t2v | `prompt` **req**; `seed` 0–2147483647 (0 is not forwarded); `duration` 2–30 (5); `resolution` `480p`/`720p`/`1080p` (**1080p**); `aspect_ratio` `16:9`/`4:3`/`1:1`/`3:4`/`9:16`/`adaptive` (adaptive); `generate_audio` (true); `enable_thinking` (false) | $0.025/s (explore). The model page lists $0.05/$0.10/$0.20 per s for 480p/720p/1080p before discount, which conflicts with explore. |
| V15 | `alibaba/wan-3.0/image-to-video` | i2v + first/last frame | as V14 plus `image_url` **req** and `end_image_url` | same model |
| V16 | `alibaba/wan-3.0/reference-to-video` | reference | `prompt` **req**; `image_urls` ≤10; `video_urls` ≤5 (30 s total); `audio_urls` ≤5 (WAV/MP3, 30 s total); `file_url` / `link_url` (documents or web pages; force thinking); `seed`, `duration`, `resolution`, `aspect_ratio`, `generate_audio`, `enable_thinking` as V14 | same model |

Also listed on explore but not field-verified: MiniMax H3 (`minimax/h3/{text,image,reference}-to-video`, $0.065/s at 2K, paths taken from playground URLs), Wan 3.0 Prime, LTX 2.5, Grok Imagine Video 1.5, Happy Horse, and Kling 2.5 Turbo / Hailuo 2.3. The Kling 2.5 Turbo and Hailuo 2.3 schemas are in openapi.json: Kling uses `duration` 5|10, `cfg_scale`, `negative_prompt`; Hailuo uses `duration` 6|10, `prompt_optimizer`.

### Image

| # | Endpoint (POST) | Workflow | Fields | Price |
|---|---|---|---|---|
| I1 | `higgsfield-ai/soul/v2/standard` | t2i | `prompt` **req**; `aspect_ratio` `9:16`/`16:9`/`4:3`/`3:4`/`1:1`/`2:3`/`3:2` (1:1); `resolution` `720p`/`1080p` (720p); `enhance_prompt` (false); `seed` 1–1000000 (null is invalid); `batch_size` 1 or 4 (1); `style_id` uuid; `style_strength` 0–1; `custom_reference_id` uuid or null; `custom_reference_strength` 0–1 | $0.0032/img at 720p, $0.0057 at 1080p (model page) |
| I2 | `higgsfield-ai/soul/standard` | t2i | (from openapi.json) `prompt` **req**; `num_images` 1–4 (1); `resolution` `2K`/`4K` (2K); `aspect_ratio` `1:1`/`4:3`/`3:4`/`3:2`/`2:3`/`5:4`/`4:5`/`16:9`/`9:16`/`21:9` (4:3) | $0.094/img (explore) |
| I3 | `alibaba/qwen-image-3/text-to-image` | t2i | `prompt` **req**; `resolution` `1k`/`2k` (1k); `aspect_ratio` `1:1`/`2:3`/`3:2`/`3:4`/`4:3`/`7:9`/`9:7`/`9:16`/`16:9`/`21:9` (1:1); `seed` 0–2147483647; `prompt_extend` (true); `enable_thinking` (true, requires `prompt_extend`); `negative_prompt`; `prompt_extend_mode` `direct`/`agent` (direct) | $0.04 at 1k, $0.075 at 2k per image |
| I4 | `alibaba/qwen-image-3/edit` | image edit | `prompt` **req**; `image_urls` 1–3 **req**; other fields as I3 (`prompt_extend_mode` only `direct`) | same model |
| I5 | `z-image/turbo` | t2i | `prompt` **req** 1–800 chars; `resolution` `1k`/`2k` (1k); `aspect_ratio` as I3 (1:1); `prompt_extend` (false; `true` uses the enhanced price tier); `seed` 0–2147483647. Output is PNG. | $0.015/img |

**Field-name differences to map per model:** the end frame is `end_image_url` for Seedance and Wan but `last_image_url` for Kling 3.0. Audio is `generate_audio` (bool) for Seedance and Wan 3 but `sound` (`"on"`/`"off"`) for Kling. Seed ranges differ (Wan 2.7 1–2147483646, Wan 3 and Qwen 0–2147483647, Soul 2 1–1000000).

## 9. Terms of Use notes (https://higgsfield.ai/terms-of-use-agreement)

| Clause | Gist (paraphrased) | Implication for Vidra Studio |
|---|---|---|
| §5.1 Restrictions | No illegal or infringing use, and no using the Service or Outputs to develop competing AI. | Vidra is a client UI and doesn't train models. Don't add features that harvest outputs to train models. |
| §11.3 API Key Security | Keep API keys confidential. Don't share, publish or embed them in public code. Store them securely. The key holder is responsible for all activity on the key. | Each user enters **their own** key. It stays on their machine in the OS keychain (Windows Credential Manager, macOS Keychain, Secret Service), is never committed or bundled, never goes through a Vidra server, and is never sent to any host except `api.higgsfield.ai`. Never send it to the presigned upload URL. Redact it in logs. |
| §11.8 Attribution and Branding | Include attribution as required by the Company's guidelines. Don't use the Company's name or logos to imply endorsement or affiliation without written consent. | Name Higgsfield only descriptively ("works with the Higgsfield API"), don't use its logos, and add a "not affiliated with or endorsed by Higgsfield" disclaimer. Follow any attribution guidelines if Higgsfield publishes them (none were found). |

## Gaps

- No documented free key-validation endpoint. Whether `/estimate` is free is unconfirmed.
- No upload size limits are documented, no webhook signing is documented, and no idempotency expiry is documented.
- Model pages under docs.higgsfield.ai don't carry prices. Prices come from open.higgsfield.ai, show promotional discounts, and are sometimes inconsistent (Wan 3.0).
- Kling 3.0 pro, 4k and turbo, MiniMax H3, and the Soul 2 response shape for `batch_size: 4` were not verified field by field.
