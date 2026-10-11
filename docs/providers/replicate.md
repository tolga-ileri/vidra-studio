# Replicate HTTP API: integration notes for Vidra Studio

Vidra Studio is an independent app and is not affiliated with Replicate. Everything below was checked against official sources on 2026-10-11. Anything marked "not documented" could not be found in those sources.

## 1. Sources (retrieved 2026-10-11)

| Topic | URL |
|---|---|
| HTTP API reference | https://replicate.com/docs/reference/http |
| OpenAPI schema | https://api.replicate.com/openapi.json |
| Create a prediction | https://replicate.com/docs/topics/predictions/create-a-prediction |
| Input files | https://replicate.com/docs/topics/predictions/input-files |
| Data retention | https://replicate.com/docs/topics/predictions/data-retention |
| Pricing | https://replicate.com/pricing |
| Per-model schema and price (embedded in page) | https://replicate.com/{owner}/{name}/api/schema |
| Terms of Service | https://replicate.com/terms |
| Acceptable Use Policy | https://replicate.com/acceptable-use-policy |

## 2. Authentication

- Send the token in a header: `Authorization: Bearer <token>`. This is the form the HTTP reference uses. Some OpenAPI examples use `Authorization: Token <token>` instead. **Use `Bearer`.**
- Users create tokens at https://replicate.com/account/api-tokens.
- **Cheapest way to validate a token:** call `GET /v1/account`.
  - A valid token returns `200` with `{type, username, name, github_url}`.
  - An invalid or missing token returns `401` (an unauthenticated `GET /v1/models/...` was observed returning 401).

## 3. Predictions

### Create

| Endpoint | Use |
|---|---|
| `POST /v1/models/{owner}/{name}/predictions` | Official models. No version is needed. |
| `POST /v1/predictions` | Body includes `version`, given as a 64-character id, `owner/model:id`, or `owner/model` for official models. |

**Body fields**

| Field | Notes |
|---|---|
| `input` (required) | Object of model inputs. Files can be passed as an HTTP URL or a data URI (see section 4). |
| `webhook` | HTTPS URL that receives a POST of the prediction. Calls may be duplicated on retry. Redirects are not followed. |
| `webhook_events_filter` | Any of `start`, `output`, `logs`, `completed`. `output` and `logs` are throttled to at most once per 500 ms. |
| `stream` | Deprecated. When a model supports streaming, the URL appears in `urls.stream`. |

**Headers**

| Header | Notes |
|---|---|
| `Prefer: wait=n` | Holds the request open for up to `n` seconds (1–60). If the prediction has not finished by then, the response comes back with a non-terminal status, and you continue by polling. For file outputs, the response can return with `output` already set while `status` is still `processing`. |
| `Cancel-After: <duration>` | Sets a maximum runtime measured from creation, e.g. `30s`, `5m` or `1h30m`. Minimum is 5 s. The resulting cutoff time appears in the response field `deadline`. |
| Idempotency key | **Not documented.** The only request headers the OpenAPI schema lists are `Prefer` and `Cancel-After`. To avoid duplicate predictions, do not blindly retry a create request. |

### Response object and polling

- **Fields:** `id`, `model`, `version`, `input`, `output`, `logs`, `error`, `status`, `created_at`, `started_at`, `completed_at`, `deadline`, `source` (`web` or `api`), `data_removed`, `metrics.predict_time`, `metrics.total_time`, and `urls` (`get`, `cancel`, `web`, and `stream` when available).
- **Poll:** `GET /v1/predictions/{id}`.
- **Statuses (OpenAPI enum):**

| Status | Meaning |
|---|---|
| `starting` | Not yet running |
| `processing` | Running |
| `succeeded` | Terminal |
| `failed` | Terminal; see `error` |
| `canceled` | Terminal |
| `aborted` | Terminal. The prediction was stopped before it started running, for example because its deadline passed. The HTTP reference page does not list this status, but the OpenAPI schema does. |

- **Cancel:** `POST /v1/predictions/{id}/cancel`, which returns the prediction object. The exact behavior of cancelling a prediction that has already finished is not documented.

### Output and retention

- The shape of `output` depends on the model and is defined by `components.schemas.Output` in the model's OpenAPI schema. Common shapes:
  - a single URL string (`{"type":"string","format":"uri"}`)
  - an array of URL strings (`{"type":"array","items":{"type":"string","format":"uri"}}`)
- Output files are served from `replicate.delivery` and its subdomains. The HTTP reference tells you to allowlist both `replicate.delivery` and `*.replicate.delivery`.
- Whether downloads need the `Authorization` header is not clearly documented. **Send the header, and fall back to an unauthenticated request if it fails.**
- An exact expiry time for output URLs is not documented.
- **Retention:** for API predictions, inputs, outputs, files and logs are deleted after **1 hour** by default. After deletion, `output` is `null` and `data_removed` is `true`. Web predictions are kept indefinitely.
- **Recommendation:** download every output as soon as the prediction succeeds.

## 4. File uploads and file inputs

**`POST /v1/files`** (multipart/form-data)

| Part | Notes |
|---|---|
| `content` (required) | The file bytes |
| `filename` | Up to 255 bytes |
| `type` | MIME type; defaults to `application/octet-stream` |
| `metadata` | JSON object; defaults to `{}` |

- **Response:** `201` with `{id, urls.get, expires_at, checksums.sha256, size, content_type, created_at, metadata}`.
- **Size limit:** files over 100 MB return `413`.
- **Reading:** `urls.get` is an API URL that needs the token. `files.download` uses signed URLs (owner, expiry and signature).
- **Expiry:** the default length of `expires_at` is not documented. Read it from the response.
- **Model inputs:** inputs with `format: uri` accept any of these:

| Input form | Limit or notes |
|---|---|
| Public HTTPS URL | Recommended for files over 256 KB |
| Data URI | The HTTP reference allows it for files up to 256 KB; the Input files guide says under 1 MB. **Use 256 KB as the safe limit.** |
| `urls.get` from the Files API | No extra notes |

## 5. Model discovery

| Endpoint | Notes |
|---|---|
| `GET /v1/models` | Paginated (`next`/`previous` cursors). `sort_by` is `model_created_at` or `latest_version_created_at` (default). `sort_direction` is `asc` or `desc` (default). |
| `QUERY /v1/models` | Search. Uses the HTTP method `QUERY` with a `text/plain` body containing the search text. |
| `GET /v1/search?query=&limit=` | Beta. `limit` is 1–50, default 20. Returns models with `metadata.generated_description`, `tags` and `score`. |
| `GET /v1/collections` | Lists collections. |
| `GET /v1/collections/{slug}` | Returns one collection, including its models. |
| `GET /v1/models/{owner}/{name}` | Returns the model, including `is_official`, `latest_version.id` and `latest_version.openapi_schema`. |

**Building dynamic forms from the model schema.** The input definition is at `latest_version.openapi_schema.components.schemas.Input`.

- **Fields and required inputs:** each entry in `properties` is a field. `required` lists the mandatory ones.
- **Field order:** sort fields by `x-order`.
- **Types:**
  - `string` (`format: uri` means a file or URL)
  - `integer`, `number`, `boolean`
  - `array` (check `items.type` and `items.format`)
- **Enums:** these appear either as a direct `enum`, or through `allOf: [{"$ref": "#/components/schemas/<name>"}]`. In the latter case, resolve the ref to get `{type, enum}`. The page-embedded `dereferenced_openapi_schema` has refs already inlined.
- **Constraints and metadata:**
  - `minimum` / `maximum`
  - `default`
  - `nullable`
  - `title` / `description` for labels
- **Output:** the output type is at `components.schemas.Output`.

## 6. Pricing

- **No pricing field in the API.** The model object has no pricing field. The OpenAPI description of `is_official` only says official models have "predictable pricing."
- **Where prices are shown:** on https://replicate.com/pricing and on each model page. The model page HTML embeds a `billingConfig.current_tiers` structure (criteria plus price), but this is undocumented website internals, not a supported API.
- **Billing model:**
  - Official models are billed per unit: per output image, per second of output video, or per output video. Tiers depend on inputs such as resolution, mode, or audio.
  - Other public models are billed by hardware time per second.
- The actual cost of a run is not returned in the prediction object (not documented). `metrics.predict_time` is returned.

## 7. Errors and rate limits

- **Error format:** `application/problem+json` with a `detail` string. Other fields are not formally specified.
- **Status codes to handle:**

| Code | Meaning |
|---|---|
| `401` | Bad token |
| `402` | Billing; not specified in the docs, so treat it generically |
| `404` | Not found |
| `413` | File too large |
| `422` | Invalid input |
| `429` | Rate limited |
| `5xx` | Server error |

- **Rate limits:**
  - Create prediction: **600 requests/min**.
  - All other endpoints: **3000 requests/min**.
  - Exceeding a limit returns `429` with a `detail` message.
  - A `Retry-After` header is not documented, so use exponential backoff.
- **Polling:** keep each poll loop well under the limits. Prefer `Prefer: wait`, then poll every 1–2 s, backing off to about 5 s for video.

## 8. Curated official models

Parameters and prices were taken on 2026-10-11 from each model's `https://replicate.com/{owner}/{name}/api/schema` page: the embedded OpenAPI Input and Output schema, plus the billing tiers. Every model below is called with `POST /v1/models/{owner}/{name}/predictions`.

### Video models (output for all: a single `string` URI pointing to an mp4)

**`google/veo-3`**
- **Workflow:** text-to-video with audio; image-to-video via `image`
- **Required:** `prompt` (string)
- **Key inputs:**

| Field | Values |
|---|---|
| `aspect_ratio` | `16:9` (default), `9:16` |
| `duration` | 4, 6, 8 (default 8) |
| `resolution` | `720p`, `1080p` (default `1080p`) |
| `image` | uri |
| `negative_prompt` | string |
| `generate_audio` | bool (default true) |
| `seed` | int |

- **Price:** $0.40 per second of output with audio; $0.20 per second without audio

**`google/veo-3-fast`**
- **Workflow:** same inputs as `google/veo-3`
- **Price:** $0.15 per second with audio; $0.10 per second without audio

**`kwaivgi/kling-v2.1`**
- **Workflow:** image-to-video
- **Required:** `prompt` (string), `start_image` (uri)
- **Key inputs:**

| Field | Values |
|---|---|
| `mode` | `standard` (default), `pro` |
| `duration` | 5 (default), 10 |
| `end_image` | uri |
| `negative_prompt` | string, default `""` |

- **Price:** standard (720p) $0.05 per second; pro (1080p) $0.09 per second

**`minimax/hailuo-02`**
- **Workflow:** text-to-video; image-to-video via `first_frame_image`
- **Required:** `prompt` (string)
- **Key inputs:**

| Field | Values |
|---|---|
| `duration` | 6 (default), 10 |
| `resolution` | `512p`, `768p`, `1080p` (default `1080p`) |
| `first_frame_image` | uri |
| `last_frame_image` | uri |
| `prompt_optimizer` | bool (default true) |

- **Price (per video):**

| Resolution | 6 s | 10 s |
|---|---|---|
| 512p | $0.10 | $0.15 |
| 768p | $0.27 | $0.45 |
| 1080p | $0.48 | No price tier published |

**`minimax/video-01`**
- **Workflow:** text-to-video; image-to-video; subject reference
- **Required:** `prompt` (string)
- **Key inputs:** `first_frame_image` (uri), `subject_reference` (uri), `prompt_optimizer` (bool, default true)
- **Price:** $0.50 per video

**`bytedance/seedance-1-pro`**
- **Workflow:** text-to-video; image-to-video
- **Required:** `prompt` (string)
- **Key inputs:**

| Field | Values |
|---|---|
| `image` | uri |
| `last_frame_image` | uri |
| `duration` | int, 2–12 (default 5) |
| `resolution` | `480p`, `720p`, `1080p` (default `1080p`) |
| `aspect_ratio` | `16:9` (default), `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `9:21` |
| `fps` | 24 |
| `camera_fixed` | bool |
| `seed` | int |

- **Price (per second):** 480p $0.03; 720p $0.06; 1080p $0.15

**`wan-video/wan-2.2-t2v-fast`**
- **Workflow:** text-to-video
- **Required:** `prompt` (string)
- **Key inputs:**

| Field | Values |
|---|---|
| `num_frames` | int, 81–121 (default 81) |
| `aspect_ratio` | `16:9` (default), `9:16` |
| `resolution` | `480p` (default), `720p` |
| `frames_per_second` | int, 5–30 (default 16) |
| `go_fast` | bool |
| `optimize_prompt` | bool |
| `interpolate_output` | bool |
| `sample_shift` | number, 1–20 |
| `seed` | int |
| `disable_safety_checker` | bool |
| `lora_weights_transformer` | string |
| `lora_scale_transformer` | number |

- **Price (per video):** 480p $0.05; 720p $0.10

**`luma/ray-2-720p`**
- **Workflow:** text-to-video; image-to-video
- **Required:** `prompt` (string)
- **Key inputs:**

| Field | Values |
|---|---|
| `duration` | 5 (default), 9 |
| `aspect_ratio` | `1:1`, `3:4`, `4:3`, `9:16`, `16:9` (default), `9:21`, `21:9` |
| `loop` | bool |
| `start_image` | uri |
| `end_image` | uri |
| `concepts` | array of string |

- **Price:** $0.18 per second

### Image models

| Model | Workflow | Key inputs (required: `prompt`) | Output | Price |
|---|---|---|---|---|
| `black-forest-labs/flux-1.1-pro` | Text-to-image | See below | string uri | $0.04 per image |
| `black-forest-labs/flux-schnell` | Text-to-image (fast) | See below | **array** of uri | $3 per 1000 images |
| `black-forest-labs/flux-kontext-pro` | Image editing / text-to-image | See below | string uri | $0.04 per image |
| `google/imagen-4` | Text-to-image | See below | string uri | $0.04 per image |
| `recraft-ai/recraft-v3` | Text-to-image | See below | string uri | $0.04 per image |
| `ideogram-ai/ideogram-v3-turbo` | Text-to-image / edit | See below | string uri | $0.03 per image |

**`black-forest-labs/flux-1.1-pro`**

| Field | Values |
|---|---|
| `aspect_ratio` | `custom`, `1:1` (default), `16:9`, `3:2`, `2:3`, `4:5`, `5:4`, `9:16`, `3:4`, `4:3` |
| `width`, `height` | 256–1440 (used when `aspect_ratio` is `custom`) |
| `output_format` | `webp` (default), `jpg`, `png` |
| `output_quality` | 0–100 (default 80) |
| `safety_tolerance` | 1–6 (default 2) |
| `prompt_upsampling` | bool |
| `image_prompt` | uri |
| `seed` | int |

**`black-forest-labs/flux-schnell`**

| Field | Values |
|---|---|
| `aspect_ratio` | `1:1` (default), `16:9`, `21:9`, `3:2`, `2:3`, `4:5`, `5:4`, `3:4`, `4:3`, `9:16`, `9:21` |
| `num_outputs` | 1–4 |
| `num_inference_steps` | 1–4 (default 4) |
| `output_format` | `webp`, `jpg`, `png` |
| `output_quality` | 0–100 |
| `megapixels` | `1`, `0.25` |
| `go_fast` | bool |
| `disable_safety_checker` | bool |
| `seed` | int |

**`black-forest-labs/flux-kontext-pro`**

| Field | Values |
|---|---|
| `input_image` | uri |
| `aspect_ratio` | `match_input_image` (default), `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `4:5`, `5:4`, `21:9`, `9:21`, `2:1`, `1:2` |
| `output_format` | `jpg`, `png` (default `png`) |
| `safety_tolerance` | 0–6 (default 2) |
| `prompt_upsampling` | bool |
| `seed` | int |

**`google/imagen-4`**

| Field | Values |
|---|---|
| `aspect_ratio` | `1:1` (default), `9:16`, `16:9`, `3:4`, `4:3` |
| `image_size` | `1K` (default), `2K` |
| `safety_filter_level` | `block_low_and_above`, `block_medium_and_above`, `block_only_high` (default) |
| `output_format` | `jpg` (default), `png` |

**`recraft-ai/recraft-v3`**

| Field | Values |
|---|---|
| `size` | Enum of 15 sizes, e.g. `1024x1024` (default), `1365x1024`, `1024x1365`, `1536x1024`, `1024x1536`, `1820x1024`, `1024x1820`, `2048x1024`, `1024x2048`; read the full list from the schema |
| `aspect_ratio` | `Not set` (default) or a ratio from `1:1` to `5:3` |
| `style` | `any` (default), `realistic_image`, `digital_illustration`, plus their sub-styles such as `digital_illustration/pixel_art` and `realistic_image/hdr` |

**`ideogram-ai/ideogram-v3-turbo`**

| Field | Values |
|---|---|
| `aspect_ratio` | 15 values from `1:3` to `3:1`; default `1:1` |
| `resolution` | `None` (default) or about 69 fixed sizes; read the list from the schema |
| `magic_prompt_option` | `Auto` (default), `On`, `Off` |
| `style_type` | `None` (default), `Auto`, `General`, `Realistic`, `Design` |
| `style_preset` | `None` plus 60+ presets; read the list from the schema |
| `image` | uri (for edits) |
| `mask` | uri (for edits) |
| `style_reference_images` | array of uri |
| `seed` | int, up to 2147483647 |

**Recommendation:** do not hardcode these schemas. Fetch `GET /v1/models/{owner}/{name}` at runtime and render forms from `Input`, because official models update their schemas in place.

## 9. Terms of Service notes (BYO-token desktop app)

- **Token sharing:**
  - Under the Terms (§2.3, §2.7(c)(ii)), each user must keep their own credentials confidential and must not share them. Each user enters **their own** token, which fits these rules.
  - The app must never ship, proxy or pool a single token.
- **Usage and spend:** the account holder is responsible for all usage and spend under their token (§2.7, §3.1, §4.7). Show costs and estimates clearly in the UI.
- **No SaaS resale:** §2.7(c)(iii) forbids making the Services available to others, including through "software as a service." A local client in which each user brings their own token is not addressed explicitly. **Do not run a hosted relay service.**
- **Acceptable Use:** users must follow the Acceptable Use Policy and the Community Guidelines (§2.7(a)). Link to the AUP in the app.
- **Trademarks:**
  - The Terms contain no brand or logo guidelines, and no public trademark policy was found (not documented).
  - Use "Replicate" only as a plain word to say which service the app works with (e.g. "Works with Replicate").
  - Do not use Replicate's logo, and do not imply endorsement.
  - Add a non-affiliation disclaimer.
- **Token storage:** store the token in the OS keychain (Windows Credential Manager), never in logs.
