# Kling AI (official developer API)

Retrieved 2026-10-11. Sources are official Kling docs only. Anything marked **UNVERIFIED** was not confirmed on an official page during this pass.

## 1. Sources and domains

| Topic | URL |
|---|---|
| Docs index (LLM-friendly) | https://kling.ai/document-api/llms.txt |
| Authentication | https://kling.ai/document-api/api/get-started/authentication.md |
| Error codes | https://kling.ai/document-api/api/get-started/error-codes.md |
| Concurrency | https://kling.ai/document-api/api/get-started/concurrency-rules.md |
| Callbacks | https://kling.ai/document-api/api/get-started/callbacks.md (not read) |
| 3.0 T2V / I2V / Omni | https://kling.ai/document-api/api/video/3-0-omni/{text-to-video,image-to-video,video-omni}.md |
| 2.5 Turbo I2V | https://kling.ai/document-api/api/video/2-5-turbo/image-to-video.md |
| Image 3.0 generation | https://kling.ai/document-api/api/image/3-0-omni/image-generation.md |
| Account usage | https://kling.ai/document-api/api/assets/account-usage.md |
| Video pricing | https://kling.ai/document-api/pricing/base/video.md |
| Image pricing | https://kling.ai/document-api/pricing/base/image.md (not read) |
| Paid service terms | https://kling.ai/document-api/guides/protocols/paid-service.md |
| Changelog | https://kling.ai/document-api/updates/api.md |
| Console (keys) | https://kling.ai/dev/api-key |

Domains: `https://api-singapore.klingai.com` is documented for servers outside China and replaces `https://api.klingai.com`. A China-mainland domain is not documented on these pages. Recommendation: default to Singapore and let the user override the base URL.

## 2. Authentication

Two methods. Both send `Authorization: Bearer <value>`.

| Method | Applies to | Details |
|---|---|---|
| **API Key** (added 2026-06-17) | All APIs. **Required** for the new API design | Created in the console and shown once. Sent as `Bearer <api_key>` |
| **AK/SK to JWT** (legacy) | Legacy-design APIs only | JWT header `{"alg":"HS256","typ":"JWT"}`, signed with the Secret Key. Claims: `iss` = Access Key, `exp` = now + 1800 s, `nbf` = now - 5 s |

The changelog says to migrate to API Key "as soon as possible". If you support AK/SK, sign a fresh JWT or cache it for under 30 minutes.

## 3. Endpoints

Two API generations exist side by side (changelog 2026-07-15). The legacy API has "no current plans for deprecation".

### 3a. New design (API key only): model in the path

| Purpose | Method + path |
|---|---|
| Text to video, 3.0 | `POST /text-to-video/kling-3.0` |
| Image to video, 3.0 | `POST /image-to-video/kling-3.0` |
| Omni video, 3.0 Omni (refs, elements, video edit) | `POST /omni-video/kling-3.0-omni` |
| Image to video, 2.5 Turbo | `POST /image-to-video/kling-2.5-turbo` |
| Other models (3.0 Turbo, 2.6, Motion Control) | Same pattern. See the llms.txt pages. Exact slugs not read |
| Query by IDs | `GET /tasks?task_ids=a,b` or `?external_task_ids=x,y` (use one, not both) |
| List tasks (cursor) | `POST /tasks` with body `{start_time, end_time, cursor, limit<=500 (default 100), filters:[{key:"status"\|"product_type", values:[...]}]}`. Response is `data.result[]`, `count`, `next_cursor`, `has_more`. The default window is the last 30 days |

Request body for the 3.0 models:

```json
{
  "prompt": "...",                       // T2V only; <=3072 chars (<=2500 recommended)
  "contents": [                          // I2V / Omni
    {"type":"prompt","text":"..."},
    {"type":"first_frame","url":"..."},
    {"type":"last_frame","url":"..."},  // optional; last-only not allowed
    {"type":"refer_image","url":"...","id":"image_1"},   // Omni
    {"type":"feature_video"|"base_video","url":"..."},   // Omni
    {"type":"element","element_id":123,"id":"el1"}      // up to 3
  ],
  "settings": {
    "duration": 5,              // int 3..15 (2.5 Turbo: 5 or 10)
    "resolution": "720p",       // 720p | 1080p | 4k (2.5 Turbo: 720p|1080p; first+last needs 1080p)
    "aspect_ratio": "16:9",     // 16:9 | 9:16 | 1:1 (T2V / Omni)
    "audio": "off",             // off | native (Omni also accepts original)
    "multi_shot": true          // prompt "shot n, m, words;" with 1-6 shots
  },
  "options": {"callback_url":"...","external_task_id":"...","watermark_info":{"enabled":false}}
}
```

The new design does not use `model_name`, `mode` (std/pro), `cfg_scale`, `negative_prompt` or `camera_control`. Quality is selected through `resolution`.

### 3b. Legacy design (`/v1/...`, `model_name` in the body; AK/SK or API key)

| Purpose | Method + path | Status |
|---|---|---|
| Image generation (T2I / I2I) | `POST /v1/images/generations`, `GET /v1/images/generations/{id}`, `GET /v1/images/generations?pageNum=&pageSize=` | Verified |
| Text to video | `POST /v1/videos/text2video` (+ `GET .../{id}`, list) | **UNVERIFIED** (not seen this pass) |
| Image to video (`image`, `image_tail`, `mode` std/pro, `cfg_scale`, `negative_prompt`, `camera_control`) | `POST /v1/videos/image2video` | **UNVERIFIED** |
| Multi-image, extend, lip sync | Lip sync and multi-element pages exist (llms.txt). Video extension is not listed | Paths not read |

Image generation fields: `model_name` (`kling-v3` default, `kling-v2-1`; empty means V1), `prompt` (<=2500), `negative_prompt` (not allowed together with `image`), `image` (URL or raw Base64 without a `data:` prefix, JPG/PNG, <=10 MB, >=300 px, aspect 1:2.5 to 2.5:1), `image_reference` (`subject` \| `face`), `image_fidelity`, `human_fidelity` (v2-1 only), `element_list`, `resolution` (`1k` \| `2k`), `n` 1..9, `aspect_ratio` (16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, 21:9), `callback_url`, `external_task_id`.

## 4. Statuses and responses

| | New design | Legacy |
|---|---|---|
| Envelope | `{code, message, request_id, data}` | same |
| ID | `data.id`, `data.external_id` | `data.task_id`, `data.task_info.external_task_id` |
| Status | `submitted`, `processing`, **`succeeded`**, `failed` | `submitted`, `processing`, **`succeed`**, `failed` |
| Failure reason | `message` | `task_status_msg` |
| Outputs | `outputs[]` of `{type:"video", id, url, watermark_url, duration(string s)}` plus `billing` | `task_result.images[]` / `.videos[]` of `{url, watermark_url, ...}`, `final_unit_deduction` |
| Timestamps | Unix ms | Unix ms |

Output URLs are cleared after **30 days**. They are hotlink-protected, so download them promptly. Callbacks support webhook signatures (since 2026-08-07).

## 5. Cancellation and idempotency

- **Cancellation:** no cancel endpoint is documented.
- **Idempotency:** `external_task_id` must be unique per account, and it can be used for lookups. The docs do not say whether a duplicate submission is rejected (which would make it a de-dup key) or what error that returns. Recommendation: generate a UUID per submission and, after a network error, query `GET /tasks?external_task_ids=` before resubmitting.

## 6. Image inputs

URL or Base64 is accepted. Legacy docs say raw Base64 with no `data:` prefix. The new design gives no prefix rule.

| Input | Formats | Max size | Min side | Aspect |
|---|---|---|---|---|
| Video frames / ref images (new) | jpg, jpeg, png | 50 MB | 300 px | 1:2.5 to 2.5:1 |
| Image-gen `image` (legacy) | jpg, jpeg, png | 10 MB | 300 px | 1:2.5 to 2.5:1 |
| Ref video (Omni) | mp4, mov, 3-15.5 s | 200 MB | 700-4553 px per side, 24-60 fps | 0.4 to 2 |

## 7. Account / balance

- `GET /account/costs?start_time=<ms>&end_time=<ms>[&resource_pack_name=]` returns `data.resource_pack_subscribe_infos[]` with `{resource_pack_name, resource_pack_id, resource_pack_type, total_quantity, remaining_quantity (up to 12 h delay), purchase_time, effective_time, invalid_time, status: toBeOnline|online|expired|runOut}`. The call is free, but the docs ask for QPS <= 1. This is a good credential-validation call: 401 with code 1000-1004 means bad credentials.
- Deduction detail: `.../assets/billing-deduction/{balance,package}.md`. Paths not read.

## 8. Pricing (video, per second; 1 Unit is about $0.14 by implication)

| Model / mode | 720p | 1080p | 4K |
|---|---|---|---|
| 3.0 Turbo, native audio | 0.8 | 1.0 | - |
| 3.0, no audio | 0.6 | 0.8 | 3.0 |
| 3.0, native audio | 0.9 | 1.2 | 3.0 |
| 3.0 Omni, no video input, no audio | 0.6 | 0.8 | 3.0 |
| 3.0 Omni, no video input, audio | 0.8 | 1.0 | 3.0 |
| 3.0 Omni, with video input | 0.9 | 1.2 | 3.0 |
| O1, no video / with video | 0.6 / 0.9 | 0.8 / 1.2 | - |
| 2.6, no audio | 0.3 | 0.5 | - |
| 2.6, audio (no voice / voice) | - | 1.0 / 1.2 | - |
| 2.5 Turbo | 0.3 | 0.5 | - |
| Motion Control 3.0 / 2.6 | 0.9 / 0.5 | 1.2 / 0.8 | - |
| Lip sync | 0.5 per 5 s | | |

Prices are published as a Markdown table only, with no JSON price API. Per-task billing is returned in the new design's `billing` field and in the legacy `final_unit_deduction` field. Image pricing is at /pricing/base/image.md (not read).

## 9. Errors and limits

| HTTP | Code | Meaning |
|---|---|---|
| 401 | 1000-1004 | Auth failed / header empty / invalid / token not yet valid / expired |
| 429 | 1100 / 1101 / 1102 | Account abnormal / postpaid arrears / resource pack exhausted or expired |
| 403 | 1103 | No access to the API or model |
| 400 | 1200 / 1201 | Invalid params |
| 404 | 1202 / 1203 | Bad method / resource (model) not found |
| 400 | 1300 / 1301 | Platform policy / content safety |
| 429 | 1302 | Rate limit |
| 429 | 1303 | Concurrency over resource pack limit |
| 429 | 1304 | IP whitelist |
| 500 / 503 / 504 | 5000 / 5001 / 5002 | Internal / maintenance / timeout |

Concurrency is counted per account, per model version and per package type. All keys on an account share it. A slot is held from submit until the task finishes. A video task uses 1 slot, and an image task uses `n` slots. The concurrency rules page says "no QPS limits", yet error 1302 exists. Back off for at least 1 s, exponentially. Numeric limits per tier are not documented.

## 10. Terms notes (third-party BYOK app)

- Paid Service Terms §3.8-3.9: keys must not be disclosed or transferred to third parties. Under BYOK, each user is the key holder and operator for their own use, and the app only stores the key locally. The terms do not explicitly address this desktop-BYOK pattern, so get a legal review.
- §6.2: using the other party's trademarks or names needs prior written consent. Use "Kling" only as a plain factual compatibility statement (for example, "works with the Kling AI API"). Do not use the logo, and do not imply endorsement.
- Account balance is non-refundable. The terms do not specify refunds for failed tasks. The user bears responsibility for content and must comply with law.

## Gaps

- Legacy `/v1/videos/*` paths and fields (model_name list, mode, cfg_scale, camera_control, image_tail, video extend) were not re-verified this pass.
- No cancel endpoint. De-duplication semantics of `external_task_id` are undocumented.
- Exact path slugs for 3.0 Turbo, 2.6 and Motion Control, the callback payload, image pricing, the China domain and numeric concurrency tiers were not captured.
