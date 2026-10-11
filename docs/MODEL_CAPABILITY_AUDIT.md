# Model capability audit

Every model Vidra Studio can run was audited **individually** against its
exact endpoint's official documentation or schema on 2026-10-11. No live or
paid API calls were made. "Verified" here means **verified against
documentation**, not tested against the live API. fal.ai models are excluded
from v0.1 (see PROVIDER_TERMS_REVIEW.md).

- **Models in v0.1:** 44 (generated from `packages/core/manifests/*.json`).
- **Rules:** conditional combinations (resolution-dependent duration,
  frame/reference exclusivity, media totals, dimension bounds) are encoded as
  machine-readable rules. They are enforced identically in TypeScript and
  Rust, checked by `packages/core/test/vectors/capabilities.json`.
- **Pricing:** Higgsfield uses the provider's own estimate API (authoritative,
  per account). Replicate uses published per-model rates with source and
  date. Kling uses published unit tables, in Kling units and never converted
  to money. Anything unverifiable shows "Pricing unavailable", and outdated
  prices (older than 120 days) are treated as unavailable.
- **Unverified items:** each model's `unverified` list in its manifest, and the
  per-provider sections below.

## Summary

| Provider | Endpoint / model | Workflow | Duration | Resolution | Aspect ratios | Audio | Media inputs (max) | Max outputs | Pricing | Docs | Verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| higgsfield | `bytedance/seedance-2.0/text-to-video` | text-to-video | 4–15 s | 480p, 720p, 1080p, 4k | 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 | yes | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/seedance-2/text-to-video) | 2026-10-11 |
| higgsfield | `bytedance/seedance-2.0/image-to-video` | image-to-video | 4–15 s | 480p, 720p, 1080p, 4k | — | yes | start_image≤1, end_image≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/seedance-2/image-to-video) | 2026-10-11 |
| higgsfield | `bytedance/seedance-2.0/reference-to-video` | reference-to-video | 4–15 s | 480p, 720p, 1080p, 4k | 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 | yes | reference_images≤9, reference_videos≤3, reference_audio≤3 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/seedance-2/reference-to-video) | 2026-10-11 |
| higgsfield | `bytedance/seedance-2.5/text-to-video` | text-to-video | 4–30 s | 480p, 720p, 1080p | 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 | yes | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/seedance-2-5/text-to-video) | 2026-10-11 |
| higgsfield | `bytedance/seedance-2.5/image-to-video` | image-to-video | 4–30 s | 480p, 720p, 1080p | — | yes | start_image≤1, end_image≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/seedance-2-5/image-to-video) | 2026-10-11 |
| higgsfield | `bytedance/seedance-2.5/reference-to-video` | reference-to-video | 4–30 s | 480p, 720p, 1080p | 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 | yes | reference_images≤30, reference_videos≤10, reference_audio≤10 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/seedance-2-5/reference-to-video) | 2026-10-11 |
| higgsfield | `bytedance/seedance-2.5/video-edit` | video-edit | — | 480p, 720p, 1080p | — | yes | source_video≤1, reference_images≤30, reference_videos≤9, reference_audio≤10 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/seedance-2-5/video-edit) | 2026-10-11 |
| higgsfield | `bytedance/seedance-2.5/video-extend` | video-extend | 4–30 s | 480p, 720p, 1080p | — | yes | source_video≤1, reference_images≤30, reference_videos≤9, reference_audio≤10 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/seedance-2-5/video-extend) | 2026-10-11 |
| higgsfield | `kling-video/v3.0/std/text-to-video` | text-to-video | 3–15 s | — | 16:9, 9:16, 1:1 | yes | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/kling-3/standard-text-to-video) | 2026-10-11 |
| higgsfield | `kling-video/v3.0/std/image-to-video` | image-to-video | 3–15 s | — | — | yes | start_image≤1, end_image≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/kling-3/standard-image-to-video) | 2026-10-11 |
| higgsfield | `kling-video/v3.0/pro/text-to-video` | text-to-video | 3–15 s | — | 16:9, 9:16, 1:1 | yes | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/kling-3/pro-text-to-video) | 2026-10-11 |
| higgsfield | `kling-video/v3.0/pro/image-to-video` | image-to-video | 3–15 s | — | — | yes | start_image≤1, end_image≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/kling-3/pro-image-to-video) | 2026-10-11 |
| higgsfield | `kling-video/v3.0/4k/text-to-video` | text-to-video | 3–15 s | — | 16:9, 9:16, 1:1 | yes | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/kling-3/4k-text-to-video) | 2026-10-11 |
| higgsfield | `kling-video/v3.0/4k/image-to-video` | image-to-video | 3–15 s | — | — | yes | start_image≤1, end_image≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/kling-3/4k-image-to-video) | 2026-10-11 |
| higgsfield | `kling-video/v3.0-turbo/text-to-video` | text-to-video | 3–15 s | 720p, 1080p | 16:9, 9:16, 1:1 | no | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/kling-3/turbo-text-to-video) | 2026-10-11 |
| higgsfield | `kling-video/v3.0-turbo/image-to-video` | image-to-video | 3–15 s | 720p, 1080p | — | no | start_image≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/kling-3/turbo-image-to-video) | 2026-10-11 |
| higgsfield | `wan/v2.7/text-to-video` | text-to-video | 2–15 s | 720p, 1080p | 16:9, 9:16, 1:1, 4:3, 3:4 | no | driving_audio≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/wan-2-7/text-to-video) | 2026-10-11 |
| higgsfield | `wan/v2.7/image-to-video` | image-to-video | 2–15 s | 720p, 1080p | — | no | start_image≤1, end_image≤1, driving_audio≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/wan-2-7/image-to-video) | 2026-10-11 |
| higgsfield | `wan/v2.7/reference-to-video` | reference-to-video | 2–10 s | 720p, 1080p | 16:9, 9:16 | no | reference_images≤5, reference_videos≤5 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/wan-2-7/reference-to-video) | 2026-10-11 |
| higgsfield | `alibaba/wan-3.0/text-to-video` | text-to-video | 2–30 s | 480p, 720p, 1080p | adaptive, 16:9, 4:3, 1:1, 3:4, 9:16 | yes | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/wan-3/text-to-video) | 2026-10-11 |
| higgsfield | `alibaba/wan-3.0/image-to-video` | image-to-video | 2–30 s | 480p, 720p, 1080p | adaptive, 16:9, 4:3, 1:1, 3:4, 9:16 | yes | start_image≤1, end_image≤1 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/wan-3/image-to-video) | 2026-10-11 |
| higgsfield | `alibaba/wan-3.0/reference-to-video` | reference-to-video | 2–30 s | 480p, 720p, 1080p | adaptive, 16:9, 4:3, 1:1, 3:4, 9:16 | yes | reference_images≤10, reference_videos≤5, reference_audio≤5 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/wan-3/reference-to-video) | 2026-10-11 |
| higgsfield | `higgsfield-ai/soul/v2/standard` | text-to-image | — | 720p, 1080p | 1:1, 9:16, 16:9, 4:3, 3:4, 2:3, 3:2 | no | — | 4 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/soul-2/generate) | 2026-10-11 |
| higgsfield | `alibaba/qwen-image-3/text-to-image` | text-to-image | — | 1k, 2k | 1:1, 2:3, 3:2, 3:4, 4:3, 7:9, 9:7, 9:16, 16:9, 21:9 | no | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/qwen-image-3/text-to-image) | 2026-10-11 |
| higgsfield | `alibaba/qwen-image-3/edit` | image-edit | — | 1k, 2k | 1:1, 2:3, 3:2, 3:4, 4:3, 7:9, 9:7, 9:16, 16:9, 21:9 | no | images≤3 | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/qwen-image-3/edit) | 2026-10-11 |
| higgsfield | `z-image/turbo` | text-to-image | — | 1k, 2k | 1:1, 2:3, 3:2, 3:4, 4:3, 7:9, 9:7, 9:16, 16:9, 21:9 | no | — | 1 | Provider estimate API | [docs](https://docs.higgsfield.ai/docs/models/z-image-turbo/generate) | 2026-10-11 |
| replicate | `google/veo-3` | text-to-video | 4, 6, 8 s | 720p, 1080p | 16:9, 9:16 | yes | image≤1 | 1 | per_second USD (verified 2026-10-11) | [docs](https://replicate.com/google/veo-3/api) | 2026-10-11 |
| replicate | `google/veo-3-fast` | text-to-video | 4, 6, 8 s | 720p, 1080p | 16:9, 9:16 | yes | image≤1 | 1 | per_second USD (verified 2026-10-11) | [docs](https://replicate.com/google/veo-3-fast/api) | 2026-10-11 |
| replicate | `google/veo-3.1` | text-to-video | 4, 6, 8 s | 720p, 1080p | 16:9, 9:16 | yes | image≤1, last_frame≤1, reference_images≤3 | 1 | per_second USD (verified 2026-10-11) | [docs](https://replicate.com/google/veo-3.1/api) | 2026-10-11 |
| replicate | `kwaivgi/kling-v2.1` | image-to-video | 5, 10 s | — | — | no | start_image≤1, end_image≤1 | 1 | per_second USD (verified 2026-10-11) | [docs](https://replicate.com/kwaivgi/kling-v2.1/api) | 2026-10-11 |
| replicate | `kwaivgi/kling-v2.5-turbo-pro` | text-to-video | 5, 10 s | — | 16:9, 9:16, 1:1 | no | start_image≤1, end_image≤1 | 1 | per_second USD (verified 2026-10-11) | [docs](https://replicate.com/kwaivgi/kling-v2.5-turbo-pro/api) | 2026-10-11 |
| replicate | `minimax/hailuo-02` | text-to-video | 6, 10 s | 512p, 768p, 1080p | — | no | first_frame_image≤1, last_frame_image≤1 | 1 | per_output USD (verified 2026-10-11) | [docs](https://replicate.com/minimax/hailuo-02/api) | 2026-10-11 |
| replicate | `bytedance/seedance-1-pro` | text-to-video | 2–12 s | 480p, 720p, 1080p | 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, 9:21 | no | image≤1, last_frame_image≤1 | 1 | per_second USD (verified 2026-10-11) | [docs](https://replicate.com/bytedance/seedance-1-pro/api) | 2026-10-11 |
| replicate | `luma/ray-2-720p` | text-to-video | 5, 9 s | — | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9 | no | start_image≤1, end_image≤1 | 1 | per_second USD (verified 2026-10-11) | [docs](https://replicate.com/luma/ray-2-720p/api) | 2026-10-11 |
| replicate | `black-forest-labs/flux-1.1-pro` | text-to-image | — | — | custom, 1:1, 16:9, 3:2, 2:3, 4:5, 5:4, 9:16, 3:4, 4:3 | no | image_prompt≤1 | 1 | per_output USD (verified 2026-10-11) | [docs](https://replicate.com/black-forest-labs/flux-1.1-pro/api) | 2026-10-11 |
| replicate | `black-forest-labs/flux-1.1-pro-ultra` | text-to-image | — | — | 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 9:21 | no | image_prompt≤1 | 1 | per_output USD (verified 2026-10-11) | [docs](https://replicate.com/black-forest-labs/flux-1.1-pro-ultra/api) | 2026-10-11 |
| replicate | `black-forest-labs/flux-schnell` | text-to-image | — | — | 1:1, 16:9, 21:9, 3:2, 2:3, 4:5, 5:4, 3:4, 4:3, 9:16, 9:21 | no | — | 4 | per_output USD (verified 2026-10-11) | [docs](https://replicate.com/black-forest-labs/flux-schnell/api) | 2026-10-11 |
| replicate | `black-forest-labs/flux-kontext-pro` | image-edit | — | — | match_input_image, 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 4:5, 5:4, 21:9, 9:21, 2:1, 1:2 | no | input_image≤1 | 1 | per_output USD (verified 2026-10-11) | [docs](https://replicate.com/black-forest-labs/flux-kontext-pro/api) | 2026-10-11 |
| replicate | `google/imagen-4` | text-to-image | — | — | 1:1, 9:16, 16:9, 3:4, 4:3 | no | — | 1 | per_output USD (verified 2026-10-11) | [docs](https://replicate.com/google/imagen-4/api) | 2026-10-11 |
| kling | `text-to-video/kling-3.0` | text-to-video | 3–15 s | 720p, 1080p, 4k | 16:9, 9:16, 1:1 | yes | — | 1 | per_second Kling units (verified 2026-10-11) | [docs](https://kling.ai/document-api/api/video/3-0-omni/text-to-video.md) | 2026-10-11 |
| kling | `image-to-video/kling-3.0` | image-to-video | 3–15 s | 720p, 1080p, 4k | — | yes | image≤1, end_image≤1 | 1 | per_second Kling units (verified 2026-10-11) | [docs](https://kling.ai/document-api/api/video/3-0-omni/image-to-video.md) | 2026-10-11 |
| kling | `image-to-video/kling-2.5-turbo` | image-to-video | 5, 10 s | 720p, 1080p | — | no | image≤1, end_image≤1 | 1 | per_second Kling units (verified 2026-10-11) | [docs](https://kling.ai/document-api/api/video/2-5-turbo/image-to-video.md) | 2026-10-11 |
| kling | `v1/images/generations#kling-v3` | text-to-image | — | 1k, 2k | 16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, 21:9 | no | — | 9 | per_output Kling units (verified 2026-10-11) | [docs](https://kling.ai/document-api/api/image/3-0-omni/image-generation.md) | 2026-10-11 |
| kling | `v1/images/generations#kling-v3-image-to-image` | image-to-image | — | 1k, 2k | 16:9, 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, 21:9 | no | image≤1 | 9 | per_output Kling units (verified 2026-10-11) | [docs](https://kling.ai/document-api/api/image/3-0-omni/image-generation.md) | 2026-10-11 |

## Higgsfield model audit

Manifest: `packages/core/manifests/higgsfield.json`, format v2, version `2026.10.11.1`.
Verified: 2026-10-11, only from official docs: the docs index (https://docs.higgsfield.ai/docs/llms.txt), each model's workflow page under https://docs.higgsfield.ai/docs/models/ (endpoint, usage notes, and the "Complete JSON schema" block), the billing page, and https://open.higgsfield.ai/explore for list prices.
No live API calls were made: no credentials, no paid calls. **Account availability is not verified for any model.** The docs say access depends on the account, and a model can return 404/423/503 per account.

## Shared facts (all models)

- Base URL `https://api.higgsfield.ai`. Submit with `POST /<endpoint>`, then poll `status_url`. The output is `video.url` for video and `images[].url` for images.
- Pricing: `provider_estimate` (USD). The authoritative cost comes from `POST /estimate/<endpoint>` (source: https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md). Explore list prices appear only in `pricing.notes`, and only where the explore page clearly maps a price to the model.
- Upload content types (file-uploads doc): image jpeg/jpg/png/webp/gif, video mp4, audio wav. Per-file size limits are not documented. Media must be public URLs, and `asset://` is rejected.
- fps is not documented for any endpoint, so no fps parameter is exposed.
- Turkish labels and help texts were written for Vidra. They are not provider text.

## Changes vs. previous (v1) manifest

- **Kept (12, all re-verified per endpoint):** Seedance 2.0 t2v/i2v/r2v, Seedance 2.5 video-edit, Kling 3.0 std t2v/i2v, Wan 2.7 t2v/i2v, Soul v2 standard, Qwen Image 3 t2i/edit, Z-Image Turbo.
- **Added (14):** Seedance 2.5 t2v/i2v/r2v/video-extend, Kling 3.0 pro t2v/i2v, Kling 3.0 4k t2v/i2v, Kling 3.0 Turbo t2v/i2v, Wan 2.7 r2v, Wan 3.0 t2v/i2v/r2v.
- **Dropped:** none.
- **Not added (documented or listed, not audited in this pass):** Kling 3.0 Motion Control, Wan 3.0 Prime, MiniMax H3, Soul standard (v1), Soul Cinema, Soul ID, Grok Image 2.0, Marketing Studio, Recraft v4.1, Ideogram v4, Cinema Studio, workflow apps. A later audit can add them from their own pages.

## Seedance 2.0 · Text to video

- Provider: Higgsfield
- Model id: `higgsfield:bytedance/seedance-2.0/text-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.0/text-to-video`
- Workflow: text-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/seedance-2/text-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 4–15 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p, 4k (default 720p)
- Aspect ratios: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 (default 16:9)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: required, max 20000
- Media reference limits: none (no media inputs)
- Other exposed params: `generate_audio` (boolean, default true)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Seedance 2.0 from $0.099/s (promotional, 2026-10-11).
- Unsupported/unverified: Prompt maximum length not documented (Vidra caps at 20000). | No fps, seed, negative prompt or camera controls are documented.

## Seedance 2.0 · Image to video

- Provider: Higgsfield
- Model id: `higgsfield:bytedance/seedance-2.0/image-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.0/image-to-video`
- Workflow: image-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/seedance-2/image-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 4–15 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p, 4k (default 720p)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: optional, max 20000
- Media reference limits: `image_url` image start_frame 1–1 (required), jpeg/jpg/png/webp/gif; `end_image_url` image end_frame 0–1, jpeg/jpg/png/webp/gif
- Other exposed params: `generate_audio` (boolean, default true)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Seedance 2.0 from $0.099/s (promotional, 2026-10-11).
- Unsupported/unverified: No aspect_ratio field: framing follows the start frame. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Seedance 2.0 · Reference to video

- Provider: Higgsfield
- Model id: `higgsfield:bytedance/seedance-2.0/reference-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.0/reference-to-video`
- Workflow: reference-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/seedance-2/reference-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 4–15 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p, 4k (default 720p)
- Aspect ratios: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 (default 16:9)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: optional, max 20000
- Media reference limits: `image_urls` image reference 0–9, jpeg/jpg/png/webp/gif; `video_urls` video reference 0–3, ≤15 s each, mp4; `audio_urls` audio audio 0–3, ≤15 s each, wav
- Other exposed params: `generate_audio` (boolean, default true)
- Rules: `needs-visual-ref` (Add at least one reference image or video. Audio alone is not enough.)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Seedance 2.0 from $0.099/s (promotional, 2026-10-11).
- Unsupported/unverified: Reference audio total of 15 s is enforced by the provider, not by Vidra. | Frame fields (image_url/end_image_url/video_url) must not be mixed with references; they are not exposed here. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Seedance 2.5 · Text to video

- Provider: Higgsfield
- Model id: `higgsfield:bytedance/seedance-2.5/text-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.5/text-to-video`
- Workflow: text-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/seedance-2-5/text-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 4–30 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p (default 720p)
- Aspect ratios: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 (default 16:9)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: required, max 20000
- Media reference limits: none (no media inputs)
- Other exposed params: `generate_audio` (boolean, default true), `bitrate_mode` (enum: standard/high, default high), `output_format` (enum: mp4/mov, default mp4)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Seedance 2.5 from $0.144/s (promotional, 2026-10-11).
- Unsupported/unverified: No 4K tier on 2.5 (unlike 2.0). | Prompt maximum length not documented (Vidra caps at 20000).

## Seedance 2.5 · Image to video

- Provider: Higgsfield
- Model id: `higgsfield:bytedance/seedance-2.5/image-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.5/image-to-video`
- Workflow: image-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/seedance-2-5/image-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 4–30 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p (default 720p)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: optional, max 20000
- Media reference limits: `image_url` image start_frame 1–1 (required), jpeg/jpg/png/webp/gif; `end_image_url` image end_frame 0–1, jpeg/jpg/png/webp/gif
- Other exposed params: `generate_audio` (boolean, default true), `bitrate_mode` (enum: standard/high, default high)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Seedance 2.5 from $0.144/s (promotional, 2026-10-11).
- Unsupported/unverified: No aspect_ratio or output_format field on this endpoint. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Seedance 2.5 · Reference to video

- Provider: Higgsfield
- Model id: `higgsfield:bytedance/seedance-2.5/reference-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.5/reference-to-video`
- Workflow: reference-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/seedance-2-5/reference-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 4–30 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p (default 720p)
- Aspect ratios: 16:9, 4:3, 1:1, 3:4, 9:16, 21:9 (default 16:9)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: optional, max 20000
- Media reference limits: `image_urls` image reference 0–30, jpeg/jpg/png/webp/gif; `video_urls` video reference 0–10, mp4; `audio_urls` audio audio 0–10, wav
- Other exposed params: `generate_audio` (boolean, default true), `bitrate_mode` (enum: standard/high, default high)
- Rules: `needs-ref` (Add at least one reference (image, video or audio).); `ref-total` (At most 50 references in total.)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Seedance 2.5 from $0.144/s (promotional, 2026-10-11).
- Unsupported/unverified: 30 s total video/audio budgets are normalized by the provider, not enforced by Vidra. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Seedance 2.5 · Video edit

- Provider: Higgsfield
- Model id: `higgsfield:bytedance/seedance-2.5/video-edit`
- Exact endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.5/video-edit`
- Workflow: video-edit (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/seedance-2-5/video-edit
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): no duration field
- Resolution: 480p, 720p, 1080p (default 720p)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: required, max 20000
- Media reference limits: `video_url` video source_video 1–1 (required), mp4; `image_urls` image reference 0–30, jpeg/jpg/png/webp/gif; `video_urls` video reference 0–9, mp4; `audio_urls` audio audio 0–10, wav
- Other exposed params: `generate_audio` (boolean, default true), `bitrate_mode` (enum: standard/high, default high)
- Rules: `media-total` (At most 50 media items including the source video.)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Seedance 2.5 from $0.144/s (promotional, 2026-10-11).
- Unsupported/unverified: No duration field: output length follows the processed source video (normalized to at least 4 s; 30 s video/audio budgets). | capabilities.maxDurationSec is null because duration is not a parameter. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Seedance 2.5 · Video extend

- Provider: Higgsfield
- Model id: `higgsfield:bytedance/seedance-2.5/video-extend`
- Exact endpoint: `POST https://api.higgsfield.ai/bytedance/seedance-2.5/video-extend`
- Workflow: video-extend (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/seedance-2-5/video-extend
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 4–30 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p (default 720p)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: required, max 20000
- Media reference limits: `video_url` video source_video 1–1 (required), mp4; `image_urls` image reference 0–30, jpeg/jpg/png/webp/gif; `video_urls` video reference 0–9, mp4; `audio_urls` audio audio 0–10, wav
- Other exposed params: `generate_audio` (boolean, default true), `bitrate_mode` (enum: standard/high, default high)
- Rules: `media-total` (At most 50 media items including the source video.)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Seedance 2.5 from $0.144/s (promotional, 2026-10-11).
- Unsupported/unverified: Docs do not state whether duration is the added length or the total output length. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Kling 3.0 Standard · Text to video

- Provider: Higgsfield
- Model id: `higgsfield:kling-video/v3.0/std/text-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/kling-video/v3.0/std/text-to-video`
- Workflow: text-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/kling-3/standard-text-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency; `elements` IDs must belong to the calling account
- Duration (verified): 3–15 s, integer, step 1, default 5; no `auto`
- Resolution: no field (not stated)
- Aspect ratios: 16:9, 9:16, 1:1 (default 16:9)
- fps: not documented
- Audio: `sound` "on"/"off", default on (boolean encoded)
- Prompt: required, max 2500
- Media reference limits: none (no media inputs)
- Other exposed params: `sound` (boolean, default true), `cfg_scale` (number 0–1, default 0.5)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Kling 3.0 Standard at $0.042/s (50% promotional, 2026-10-11).
- Unsupported/unverified: multi_shots / multi_prompt (1–6 custom shots, 512 chars, 1–15 s each, durations summed) not exposed. | elements (account-owned Kling element IDs) not exposed. | Prompt over 2500 characters is truncated by the provider. | Output resolution of this tier is not stated on the page.

## Kling 3.0 Standard · Image to video

- Provider: Higgsfield
- Model id: `higgsfield:kling-video/v3.0/std/image-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/kling-video/v3.0/std/image-to-video`
- Workflow: image-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/kling-3/standard-image-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency; `elements` IDs must belong to the calling account
- Duration (verified): 3–15 s, integer, step 1, default 5; no `auto`
- Resolution: no field (not stated)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: `sound` "on"/"off", default on (boolean encoded)
- Prompt: required, max 2500
- Media reference limits: `image_url` image start_frame 1–1 (required), jpeg/jpg/png/webp/gif; `last_image_url` image end_frame 0–1, jpeg/jpg/png/webp/gif
- Other exposed params: `sound` (boolean, default true), `cfg_scale` (number 0–1, default 0.5)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Kling 3.0 Standard at $0.042/s (50% promotional, 2026-10-11).
- Unsupported/unverified: No aspect_ratio field: framing follows the first frame. | multi_shots / multi_prompt (1–6 custom shots, 512 chars, 1–15 s each, durations summed) not exposed. | elements (account-owned Kling element IDs) not exposed. | Prompt over 2500 characters is truncated by the provider. | Output resolution of this tier is not stated on the page. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Kling 3.0 Pro · Text to video

- Provider: Higgsfield
- Model id: `higgsfield:kling-video/v3.0/pro/text-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/kling-video/v3.0/pro/text-to-video`
- Workflow: text-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/kling-3/pro-text-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency; `elements` IDs must belong to the calling account
- Duration (verified): 3–15 s, integer, step 1, default 5; no `auto`
- Resolution: no field (not stated)
- Aspect ratios: 16:9, 9:16, 1:1 (default 16:9)
- fps: not documented
- Audio: `sound` "on"/"off", default on (boolean encoded)
- Prompt: required, max 2500
- Media reference limits: none (no media inputs)
- Other exposed params: `sound` (boolean, default true), `cfg_scale` (number 0–1, default 0.5)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: multi_shots / multi_prompt (1–6 custom shots, 512 chars, 1–15 s each, durations summed) not exposed. | elements (account-owned Kling element IDs) not exposed. | Prompt over 2500 characters is truncated by the provider. | Output resolution of this tier is not stated on the page.

## Kling 3.0 Pro · Image to video

- Provider: Higgsfield
- Model id: `higgsfield:kling-video/v3.0/pro/image-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/kling-video/v3.0/pro/image-to-video`
- Workflow: image-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/kling-3/pro-image-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency; `elements` IDs must belong to the calling account
- Duration (verified): 3–15 s, integer, step 1, default 5; no `auto`
- Resolution: no field (not stated)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: `sound` "on"/"off", default on (boolean encoded)
- Prompt: required, max 2500
- Media reference limits: `image_url` image start_frame 1–1 (required), jpeg/jpg/png/webp/gif; `last_image_url` image end_frame 0–1, jpeg/jpg/png/webp/gif
- Other exposed params: `sound` (boolean, default true), `cfg_scale` (number 0–1, default 0.5)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: No aspect_ratio field: framing follows the first frame. | multi_shots / multi_prompt (1–6 custom shots, 512 chars, 1–15 s each, durations summed) not exposed. | elements (account-owned Kling element IDs) not exposed. | Prompt over 2500 characters is truncated by the provider. | Output resolution of this tier is not stated on the page. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Kling 3.0 4K · Text to video

- Provider: Higgsfield
- Model id: `higgsfield:kling-video/v3.0/4k/text-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/kling-video/v3.0/4k/text-to-video`
- Workflow: text-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/kling-3/4k-text-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency; `elements` IDs must belong to the calling account
- Duration (verified): 3–15 s, integer, step 1, default 5; no `auto`
- Resolution: no field (not stated)
- Aspect ratios: 16:9, 9:16, 1:1 (default 16:9)
- fps: not documented
- Audio: `sound` "on"/"off", default on (boolean encoded)
- Prompt: required, max 2500
- Media reference limits: none (no media inputs)
- Other exposed params: `sound` (boolean, default true), `cfg_scale` (number 0–1, default 0.5)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: multi_shots / multi_prompt (1–6 custom shots, 512 chars, 1–15 s each, durations summed) not exposed. | elements (account-owned Kling element IDs) not exposed. | Prompt over 2500 characters is truncated by the provider. | Output resolution of this tier is not stated on the page.

## Kling 3.0 4K · Image to video

- Provider: Higgsfield
- Model id: `higgsfield:kling-video/v3.0/4k/image-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/kling-video/v3.0/4k/image-to-video`
- Workflow: image-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/kling-3/4k-image-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency; `elements` IDs must belong to the calling account
- Duration (verified): 3–15 s, integer, step 1, default 5; no `auto`
- Resolution: no field (not stated)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: `sound` "on"/"off", default on (boolean encoded)
- Prompt: required, max 2500
- Media reference limits: `image_url` image start_frame 1–1 (required), jpeg/jpg/png/webp/gif; `last_image_url` image end_frame 0–1, jpeg/jpg/png/webp/gif
- Other exposed params: `sound` (boolean, default true), `cfg_scale` (number 0–1, default 0.5)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: No aspect_ratio field: framing follows the first frame. | multi_shots / multi_prompt (1–6 custom shots, 512 chars, 1–15 s each, durations summed) not exposed. | elements (account-owned Kling element IDs) not exposed. | Prompt over 2500 characters is truncated by the provider. | Output resolution of this tier is not stated on the page. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Kling 3.0 Turbo · Text to video

- Provider: Higgsfield
- Model id: `higgsfield:kling-video/v3.0-turbo/text-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/kling-video/v3.0-turbo/text-to-video`
- Workflow: text-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/kling-3/turbo-text-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 3–15 s, integer, step 1, default 5; no `auto`
- Resolution: 720p, 1080p (default 720p)
- Aspect ratios: 16:9, 9:16, 1:1 (default 16:9)
- fps: not documented
- Audio: no generated audio documented
- Prompt: required, max 3072
- Media reference limits: none (no media inputs)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: No sound, multi_shots, elements or last-frame field (docs). | Prompt over 3072 characters is truncated by the provider.

## Kling 3.0 Turbo · Image to video

- Provider: Higgsfield
- Model id: `higgsfield:kling-video/v3.0-turbo/image-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/kling-video/v3.0-turbo/image-to-video`
- Workflow: image-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/kling-3/turbo-image-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 3–15 s, integer, step 1, default 5; no `auto`
- Resolution: 720p, 1080p (default 720p)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: no generated audio documented
- Prompt: required, max 2500
- Media reference limits: `image_url` image start_frame 1–1 (required), jpeg/jpg/png/webp/gif
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: No sound, multi_shots, elements, aspect ratio or last-frame field (docs). | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Wan 2.7 · Text to video

- Provider: Higgsfield
- Model id: `higgsfield:wan/v2.7/text-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/wan/v2.7/text-to-video`
- Workflow: text-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/wan-2-7/text-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 2–15 s, integer, step 1, default 5; no `auto`
- Resolution: 720p, 1080p (default 720p)
- Aspect ratios: 16:9, 9:16, 1:1, 4:3, 3:4 (default 16:9)
- fps: not documented
- Audio: no generated audio documented; driving `audio_url` input
- Prompt: required, max 20000; `negative_prompt` supported
- Media reference limits: `audio_url` audio audio 0–1, wav
- Other exposed params: `prompt_extend` (boolean, default false), `seed` (seed 1–2147483646)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: Stored schema title says "Wan 2.6 Playground"; endpoint and docs page are Wan 2.7. | Negative prompt max length not documented (Vidra caps at 2000). | Driving-audio length limits not documented. | No generated-audio toggle documented.

## Wan 2.7 · Image to video

- Provider: Higgsfield
- Model id: `higgsfield:wan/v2.7/image-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/wan/v2.7/image-to-video`
- Workflow: image-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/wan-2-7/image-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 2–15 s, integer, step 1, default 5; no `auto`
- Resolution: 720p, 1080p (default 720p)
- Aspect ratios: no field (framing follows input media)
- fps: not documented
- Audio: no generated audio documented; driving `audio_url` input
- Prompt: optional, max 20000; `negative_prompt` supported
- Media reference limits: `image_url` image start_frame 1–1 (required), jpeg/jpg/png/webp/gif; `end_image_url` image end_frame 0–1, jpeg/jpg/png/webp/gif; `audio_url` audio audio 0–1, wav
- Other exposed params: `prompt_extend` (boolean, default false), `seed` (seed 1–2147483646)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: No aspect_ratio field. | Stored schema title says "Wan 2.6 Playground"; endpoint and docs page are Wan 2.7. | Negative prompt max length not documented (Vidra caps at 2000). | Driving-audio length limits not documented. | No generated-audio toggle documented. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Wan 2.7 · Reference to video

- Provider: Higgsfield
- Model id: `higgsfield:wan/v2.7/reference-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/wan/v2.7/reference-to-video`
- Workflow: reference-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/wan-2-7/reference-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 2–10 s, integer, step 1, default 5; no `auto`
- Resolution: 720p, 1080p (default 720p)
- Aspect ratios: 16:9, 9:16 (default 16:9)
- fps: not documented
- Audio: no generated audio documented
- Prompt: required, max 20000; `negative_prompt` supported
- Media reference limits: `image_urls` image reference 0–5, jpeg/jpg/png/webp/gif; `video_urls` video reference 0–5, mp4
- Other exposed params: `prompt_extend` (boolean, default false), `seed` (seed 1–2147483646)
- Rules: `needs-ref` (Add at least one reference image or video.); `ref-total` (At most 5 references in total.)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: Per-file reference video duration limits not documented. | Negative prompt max length not documented (Vidra caps at 2000). | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Wan 3.0 · Text to video

- Provider: Higgsfield
- Model id: `higgsfield:alibaba/wan-3.0/text-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/alibaba/wan-3.0/text-to-video`
- Workflow: text-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/wan-3/text-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 2–30 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p (default 1080p)
- Aspect ratios: adaptive, 16:9, 4:3, 1:1, 3:4, 9:16 (default adaptive)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: required, max 20000
- Media reference limits: none (no media inputs)
- Other exposed params: `generate_audio` (boolean, default true), `enable_thinking` (boolean, default false), `seed` (seed 1–2147483647)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: Seed 0 is accepted by the schema but not forwarded; Vidra starts at 1. | Explore and model-page prices for Wan 3.0 conflict; rely on /estimate.

## Wan 3.0 · Image to video

- Provider: Higgsfield
- Model id: `higgsfield:alibaba/wan-3.0/image-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/alibaba/wan-3.0/image-to-video`
- Workflow: image-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/wan-3/image-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 2–30 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p (default 1080p)
- Aspect ratios: adaptive, 16:9, 4:3, 1:1, 3:4, 9:16 (default adaptive)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: required, max 20000
- Media reference limits: `image_url` image start_frame 1–1 (required), jpeg/jpg/png/webp/gif; `end_image_url` image end_frame 0–1, jpeg/jpg/png/webp/gif
- Other exposed params: `generate_audio` (boolean, default true), `enable_thinking` (boolean, default false), `seed` (seed 1–2147483647)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: Seed 0 is accepted by the schema but not forwarded; Vidra starts at 1. | Explore and model-page prices for Wan 3.0 conflict; rely on /estimate. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Wan 3.0 · Reference to video

- Provider: Higgsfield
- Model id: `higgsfield:alibaba/wan-3.0/reference-to-video`
- Exact endpoint: `POST https://api.higgsfield.ai/alibaba/wan-3.0/reference-to-video`
- Workflow: reference-to-video (video)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/wan-3/reference-to-video
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Duration (verified): 2–30 s, integer, step 1, default 5; no `auto`
- Resolution: 480p, 720p, 1080p (default 1080p)
- Aspect ratios: adaptive, 16:9, 4:3, 1:1, 3:4, 9:16 (default adaptive)
- fps: not documented
- Audio: `generate_audio` boolean, default true
- Prompt: required, max 20000
- Media reference limits: `image_urls` image reference 0–10, jpeg/jpg/png/webp/gif; `video_urls` video reference 0–5, ≤30 s each, mp4; `audio_urls` audio audio 0–5, ≤30 s each, wav/mp3
- Other exposed params: `generate_audio` (boolean, default true), `enable_thinking` (boolean, default false), `seed` (seed 1–2147483647)
- Rules: `needs-ref` (Add at least one reference image, video or audio.)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: Docs make references optional (only prompt required); Vidra requires at least one reference on this endpoint. | file_url (docx/xlsx/pptx/pdf/md) and link_url (web page) references not exposed; they force deep thinking. | 30 s total video/audio budgets are enforced by the provider, not Vidra. | Upload endpoint lists only audio/wav; MP3 upload is not confirmed. | Seed 0 is accepted by the schema but not forwarded; Vidra starts at 1. | Explore and model-page prices for Wan 3.0 conflict; rely on /estimate. | Media must be public URLs; asset:// references are rejected. Per-file size limits are not documented.

## Soul 2 · Text to image

- Provider: Higgsfield
- Model id: `higgsfield:higgsfield-ai/soul/v2/standard`
- Exact endpoint: `POST https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard`
- Workflow: text-to-image (image)
- Input schema version/date: schema title `SoulV2ParamsSchema`; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/soul-2/generate
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency; `custom_reference_id` must belong to the account and be trained
- Resolution tiers: 720p, 1080p (default 720p)
- Aspect ratios: 1:1, 9:16, 16:9, 4:3, 3:4, 2:3, 3:2 (default 1:1)
- Image output count: `batch_size` 1 or 4 (max 4)
- Prompt: required, max 20000
- Media reference limits: none (no media inputs)
- Other exposed params: `batch_size` (enum: 1/4, default 1), `enhance_prompt` (boolean, default false), `seed` (seed 1–1000000)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Soul 2 from $0.003/image (2026-10-11).
- Unsupported/unverified: style_id / style_strength not exposed (style_strength currently has no effect per docs). | custom_reference_id / custom_reference_strength (trained Soul ID) not exposed. | Short prompts may be auto-enhanced even when enhance_prompt=false. | Prompt maximum length not documented.

## Qwen Image 3 · Text to image

- Provider: Higgsfield
- Model id: `higgsfield:alibaba/qwen-image-3/text-to-image`
- Exact endpoint: `POST https://api.higgsfield.ai/alibaba/qwen-image-3/text-to-image`
- Workflow: text-to-image (image)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/qwen-image-3/text-to-image
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Resolution tiers: 1k, 2k (default 1k)
- Aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 7:9, 9:7, 9:16, 16:9, 21:9 (default 1:1)
- Image output count: 1 per request (no count field)
- Prompt: required, max 20000; `negative_prompt` supported
- Media reference limits: none (no media inputs)
- Other exposed params: `prompt_extend` (boolean, default true), `enable_thinking` (boolean, default true), `prompt_extend_mode` (enum: direct/agent, default direct), `seed` (seed 0–2147483647)
- Rules: `thinking-needs-extend` (Deep thinking requires prompt enhancement. Turn both off to disable.)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: Output is PNG; 2k square is 1536×1536. | Prompt has no schema max (4500-token advisory). | Negative prompt max length not documented (Vidra caps at 2000). | Price not mapped from explore; rely on /estimate.

## Qwen Image 3 · Edit

- Provider: Higgsfield
- Model id: `higgsfield:alibaba/qwen-image-3/edit`
- Exact endpoint: `POST https://api.higgsfield.ai/alibaba/qwen-image-3/edit`
- Workflow: image-edit (image)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/qwen-image-3/edit
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Resolution tiers: 1k, 2k (default 1k)
- Aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 7:9, 9:7, 9:16, 16:9, 21:9 (default 1:1)
- Image output count: 1 per request (no count field)
- Prompt: required, max 20000; `negative_prompt` supported
- Media reference limits: `image_urls` image reference 1–3 (required), jpeg/jpg/png/webp/gif
- Other exposed params: `prompt_extend` (boolean, default true), `enable_thinking` (boolean, default true), `prompt_extend_mode` (enum: direct, default direct), `seed` (seed 0–2147483647)
- Rules: `thinking-needs-extend` (Deep thinking requires prompt enhancement. Turn both off to disable.)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings).
- Unsupported/unverified: Output is PNG; 2k square is 1536×1536. | Prompt has no schema max (4500-token advisory). | Negative prompt max length not documented (Vidra caps at 2000). | Price not mapped from explore; rely on /estimate.

## Z-Image Turbo

- Provider: Higgsfield
- Model id: `higgsfield:z-image/turbo`
- Exact endpoint: `POST https://api.higgsfield.ai/z-image/turbo`
- Workflow: text-to-image (image)
- Input schema version/date: no version is exposed; schema as published on 2026-10-11
- Docs URL: https://docs.higgsfield.ai/docs/models/z-image-turbo/generate
- Verification timestamp: 2026-10-11 (docs only)
- Availability: documented; not verified for an account
- Account restrictions: none documented beyond per-account access and concurrency
- Resolution tiers: 1k, 2k (default 1k)
- Aspect ratios: 1:1, 2:3, 3:2, 3:4, 4:3, 7:9, 9:7, 9:16, 16:9, 21:9 (default 1:1)
- Image output count: 1 per request (no count field)
- Prompt: required, max 800
- Media reference limits: none (no media inputs)
- Other exposed params: `prompt_extend` (boolean, default false), `seed` (seed 0–2147483647)
- Pricing source: provider estimate API (https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md); Exact cost comes from POST /estimate/<endpoint> (credits and USD strings). Explore lists Z-Image Turbo at $0.015/image; prompt_extend uses a higher tier (2026-10-11).
- Unsupported/unverified: Text-to-image only; no references.

## Gaps

- No account-level availability, price or latency was checked. That would need a key and paid or estimate calls.
- fps, per-file size limits and output resolutions in pixels (except the Qwen 2k square) are not documented.
- Kling multi-shot (`multi_shots`, `multi_prompt`) and `elements`, the Soul style and character reference fields, and Wan 3.0 `file_url`/`link_url` are documented but not exposed.
- Some limits are only stated as totals (for example, the 30 s audio/video budgets and the 15 s Seedance 2.0 audio total). Vidra cannot express a duration total, so the provider enforces them.


## Replicate model audit (manifest 2026.10.11.1)

Verified 2026-10-11 against each model's own official schema page
(`https://replicate.com/{owner}/{name}/api/schema`, embedded OpenAPI `Input`/`Output`)
and the billing table that page publishes (also shown on `https://replicate.com/{owner}/{name}`).
No API key was used; no prediction was run. Replicate has no pricing API.

Common to every model:

- Provider: `replicate`. Endpoint: `POST /v1/models/{owner}/{name}/predictions` (official model, no version in body). Poll `GET /v1/predictions/{id}`, cancel `POST /v1/predictions/{id}/cancel`.
- Availability: public, `is_official: true`, callable (`disabled_for_predictions: false`).
- Restrictions: API prediction data is deleted after 1 hour; outputs on `replicate.delivery`. Max prompt length is not documented by any schema (Vidra caps at 5000 / negative prompt 2500).
- Media inputs are URI strings (HTTP URL or data URI); no file size limits are documented in the schemas.
- Pricing: `status: verified`, `verifiedAt 2026-10-11`, `pricingPageUrl https://replicate.com/pricing`, `source https://replicate.com/{owner}/{name}`.

## Video

| Model | Workflow | Schema version | Duration (s) | Resolution | Aspect ratio | FPS | Audio | Media inputs | Output | Pricing |
|---|---|---|---|---|---|---|---|---|---|---|
| google/veo-3 | text-to-video (+ optional start image) | 5e80c737…5464 | enum 4, 6, 8 (default 8) | 720p, 1080p (1080p) | 16:9, 9:16 | not exposed | `generate_audio` (default true) | `image` start frame ×1 | `output` (URI) | per_second $0.40 with audio, $0.20 without |
| google/veo-3-fast | same as above | 368d4063…c2ec | enum 4, 6, 8 (8) | 720p, 1080p (1080p) | 16:9, 9:16 | not exposed | yes (default true) | `image` ×1 | `output` | per_second $0.15 audio / $0.10 no audio |
| google/veo-3.1 (added) | text-to-video, start/end frame, reference-to-video | 9c6ca0c2…ad4d | enum 4, 6, 8 (8) | 720p, 1080p (1080p) | 16:9, 9:16 | not exposed | yes (default true) | `image` ×1, `last_frame` ×1, `reference_images` 1–3 | `output` | per_second $0.40 / $0.20 |
| kwaivgi/kling-v2.1 | image-to-video (start image required) | daad218f…8f69 | enum 5, 10 (5) | via `mode`: standard 720p, pro 1080p | follows image | 24 (fixed, doc text) | no | `start_image` required, `end_image` ×1 | `output` | per_second $0.05 standard, $0.09 pro |
| kwaivgi/kling-v2.5-turbo-pro (added) | text-to-video (+ optional start/end) | a3ccc392…36b5 | enum 5, 10 (5) | not exposed | 16:9, 9:16, 1:1 (ignored with start image) | not exposed | no | `start_image`, `end_image` | `output` | per_second $0.07 |
| minimax/hailuo-02 | text-to-video (+ optional first/last frame) | baaadb88…2fd9 | enum 6, 10 (6) | 512p, 768p, 1080p (1080p) | follows first frame | not exposed | no | `first_frame_image`, `last_frame_image` | `output` | per_output (per video): 512p 6s $0.10, 512p 10s $0.15, 768p 6s $0.27, 768p 10s $0.45, 1080p 6s $0.48 |
| bytedance/seedance-1-pro | text-to-video (+ optional start/end) | a5fd5508…cb36 | integer 2–12 (default 5) | 480p, 720p, 1080p (1080p) | 16:9, 4:3, 1:1, 3:4, 9:16, 21:9, 9:21 (ignored with image) | enum [24] | no | `image`, `last_frame_image` | `output` | per_second 480p $0.03, 720p $0.06, 1080p $0.15 |
| luma/ray-2-720p | text-to-video (+ optional start/end) | 3ca2bc35…4dc4 | enum 5, 9 (5) | 720p (fixed by model) | 1:1, 3:4, 4:3, 9:16, 16:9, 9:21, 21:9 | not exposed | no | `start_image`, `end_image` | `output` | per_second $0.18 |

Rules encoded:

- veo-3.1: `last_frame` requires `image`; `reference_images` forces 16:9 + 8 s and forbids `last_frame` (schema: last frame is ignored with references); max 3 references.
- kling-v2.1: `end_image` requires `mode = pro`.
- hailuo-02: duration 10 is not allowed at 1080p.
- seedance-1-pro: `last_frame_image` requires `image`.

Other inputs exposed: seed (Veo, Seedance), negative prompt (Veo, Kling), `prompt_optimizer` (Hailuo), `camera_fixed` (Seedance), `loop` (Ray 2).

## Image

| Model | Workflow | Schema version | Aspect ratio | Size controls | Outputs | Formats | Other inputs | Output | Pricing |
|---|---|---|---|---|---|---|---|---|---|
| black-forest-labs/flux-1.1-pro | text-to-image | 609793a6…7f2b | custom, 1:1, 16:9, 3:2, 2:3, 4:5, 5:4, 9:16, 3:4, 4:3 (1:1) | width/height 256–1440, step 32, only with `custom` | 1 | webp, jpg, png; quality 0–100 | `image_prompt` (Redux; jpeg/png/gif/webp), safety_tolerance 1–6 (2), prompt_upsampling, seed | `output` | per_output $0.04 |
| black-forest-labs/flux-1.1-pro-ultra (added) | text-to-image | 551f15a1…2aaf | 21:9 … 9:21 (11 values, 1:1) | none | 1 | jpg, png | image_prompt + strength 0–1 (0.1), raw, safety_tolerance 1–6, seed | `output` | per_output $0.06 |
| black-forest-labs/flux-schnell | text-to-image | c846a699…fe51e | 11 values incl. 21:9 / 9:21 (1:1) | megapixels "1" / "0.25" | 1–4 (`num_outputs`) | webp, jpg, png; quality 0–100 | steps 1–4 (4), go_fast, disable_safety_checker, seed | `output[]` | per_output $0.003 ($3 / 1000 images) × num_outputs |
| black-forest-labs/flux-kontext-pro | image-edit (input image optional) | 897a70f5…e462 | match_input_image + 13 ratios incl. 2:1, 1:2 | none | 1 | jpg, png | `input_image` (jpeg/png/gif/webp), safety_tolerance 0–6 (max 2 with input image, encoded as rule), prompt_upsampling, seed | `output` | per_output $0.04 |
| google/imagen-4 | text-to-image | 238bcc93…9471 | 1:1, 9:16, 16:9, 3:4, 4:3 | image_size 1K, 2K | 1 | jpg, png | safety_filter_level (3 values) | `output` | per_output $0.04 |

flux-1.1-pro rules: `aspect_ratio = custom` requires width and height; width/height forbidden otherwise.

## Unsupported / unverified

- Prompt max length: not documented by any schema.
- luma/ray-2-720p `concepts` (array of camera-concept strings): not exposed, manifest v2 has no multi-select string parameter type. Deprecated `*_url` inputs not exposed.
- kling-v2.5-turbo-pro: deprecated `image` and unused `guidance_scale` not exposed; whether `end_image` works without `start_image` is undocumented.
- hailuo-02: schema text says 10 s only at 768p, but the billing table also prices 512p 10 s; 512p 10 s left allowed. Whether last frame requires first frame is undocumented.
- flux-1.1-pro: width+height being mandatory under `custom` is inferred from the field descriptions.
- Kling v2.1 fps (24) and Ray 2 resolution (720p) are model-fixed, not inputs.
- No input file size / duration limits are documented in these schemas.
- No live call was made, so behavior is verified from the schema only.

## Changes from v1

- Converted to format v2; one entry per model (the former `#image-to-video` variants of veo-3-fast, hailuo-02 and seedance-1-pro are merged: the start frame is an optional media input of the text-to-video entry).
- Added google/veo-3.1, kwaivgi/kling-v2.5-turbo-pro, black-forest-labs/flux-1.1-pro-ultra.
- Dropped: none.


## Kling manifest audit

- Manifest: `packages/core/manifests/kling.json`, format v2, version `2026.10.11.1`
- Verified: 2026-10-11, against the official docs only (`https://kling.ai/document-api/llms.txt` and the pages it links). No live or paid calls were made.
- Pricing is in Kling resource-package units (`currency: "credits"`, `unitName: "Kling units"`). Vidra never converts units to USD. The docs also show USD equivalents, and the manifest ignores them.
- Base URL example in the docs: `https://api-singapore.klingai.com`. Task polling goes to `GET /tasks`. Result URLs expire after 30 days.
- Concurrency and package limits: the model pages do not document any. Billing comes from the account's resource package (`charge_type` is `unit` or `cash`).

## 1. Kling 3.0: text to video

| Field | Value |
|---|---|
| Provider / model id | kling / `text-to-video/kling-3.0` |
| Endpoint | `POST /text-to-video/kling-3.0` (new API design) |
| Workflow | text-to-video |
| Schema/doc version | 3.0 & 3.0 Omni page, fetched 2026-10-11 |
| Docs | https://kling.ai/document-api/api/video/3-0-omni/text-to-video.md |
| Availability | available |
| Prompt | top-level `prompt`, required, at most 3072 characters (2500 recommended) |
| Duration | integer 3–15 s, step 1, default 5 |
| Resolutions | 720p (default), 1080p, 4k |
| Aspect ratios | 16:9 (default), 9:16, 1:1 |
| FPS | not documented |
| Audio | `settings.audio`: `native` or `off` (default off) |
| Multi-shot | `settings.multi_shot` boolean, default true |
| Outputs | 1 video, `data.outputs[].url` |
| Pricing (units/s) | 720p/1080p/4K: 0.6/0.8/3.0 with no audio, 0.9/1.2/3.0 with native audio (no voice control). Source: https://kling.ai/document-api/pricing/base/video.md |
| Not exposed | voice control, watermark/callback options |

## 2. Kling 3.0: image to video

| Field | Value |
|---|---|
| Model id | `image-to-video/kling-3.0` |
| Endpoint | `POST /image-to-video/kling-3.0` |
| Docs | https://kling.ai/document-api/api/video/3-0-omni/image-to-video.md |
| Input | `contents[]`: prompt (at most 3072 chars), `first_frame` (required), `last_frame` (optional), `element` (at most 3, not exposed) |
| Frame limits | jpg/jpeg/png, at most 50 MB, at least 300 px per side, aspect 1:2.5 to 2.5:1, URL or Base64 |
| Rule | a last frame alone is not supported, so `end_image` requires `image` |
| Duration | integer 3–15 s, default 5 |
| Resolutions | 720p, 1080p, 4k |
| Aspect ratio | no setting on this endpoint |
| Audio / multi-shot | native or off; multi_shot default true |
| FPS | not documented |
| Pricing | same as Kling 3.0 above |
| Unverified | the Base64 `data:` prefix rule is not documented for the new API (the legacy image API forbids the prefix), so inline references are unverified live; it is not stated whether the prompt item is mandatory |

## 3. Kling 2.5 Turbo: image to video (new in this manifest)

| Field | Value |
|---|---|
| Model id | `image-to-video/kling-2.5-turbo` |
| Endpoint | `POST /image-to-video/kling-2.5-turbo` |
| Docs | https://kling.ai/document-api/api/video/2-5-turbo/image-to-video.md |
| Input | prompt (at most 2500 chars), `first_frame` (required), `last_frame` (optional); same frame limits as 3.0 (jpg/png, at most 50 MB, at least 300 px, 1:2.5 to 2.5:1) |
| Duration | enum 5 or 10 s, default 5 |
| Resolutions | 720p (default), 1080p |
| Conditional rules | `last_frame` requires `first_frame`; first plus last frame works only at 1080p |
| Aspect ratio / audio / multi-shot | none documented |
| FPS | not documented |
| Pricing (units/s) | 0.3 at 720p, 0.5 at 1080p (no native audio) |

## 4. Kling Image 3.0: text to image

| Field | Value |
|---|---|
| Model id | `v1/images/generations#kling-v3` (fixed `model_name: kling-v3`) |
| Endpoint | `POST /v1/images/generations` (legacy design) |
| Docs | https://kling.ai/document-api/api/image/3-0-omni/image-generation.md, plus the image capability map |
| Prompt / negative | at most 2500 characters each |
| Aspect ratios | 16:9 (API default, now also the manifest default; it was 1:1), 9:16, 1:1, 4:3, 3:4, 3:2, 2:3, 21:9 |
| Resolutions | 1k (default), 2k |
| Image count | `n` 1–9 |
| Output | `data.task_result.images[].url` |
| Pricing | 8 units per image (1K and 2K). Source: https://kling.ai/document-api/pricing/base/image.md |
| Not exposed | `element_list`, watermark/callback |

## 5. Kling Image 3.0 Reference: image to image

Uses the same endpoint, model, aspect ratios, resolutions, `n` and pricing as model 4.

- Reference `image`: jpg/jpeg/png, at most 10 MB, at least 300 px, aspect 1:2.5 to 2.5:1. It can be a URL or Base64, and Base64 must not have a `data:` prefix.
- The negative prompt is not supported when `image` is set, as documented, so it is omitted.
- `image_reference` (subject/face) is not exposed because the docs do not say kling-v3 supports it.
- `image_fidelity` and `human_fidelity` are kling-v2-1 only, so they are omitted.

## Changes from v1

- Moved to format v2 and added rules, capabilities and verified unit pricing for every model. Image pricing was "unknown" before and is now verified at 8 units per image.
- Added the `multi_shot` setting (3.0) and media limits (maxSizeMb/formats). Added the rule that a last frame needs a first frame.
- Added Kling 2.5 Turbo image to video with the 1080p first-plus-last-frame rule.
- Changed the image aspect-ratio default to 16:9 to match the API.

## Documented but not added

- **Kling 3.0 Omni** (`POST /omni-video/kling-3.0-omni`): references are indexed in the prompt, there is a third audio mode (`original`), and pricing depends on whether a video is input. These cannot be expressed with the current conventions without guessing.
- **Kling 3.0 Turbo, Kling 2.6, Kling 2.5 Turbo text to video, Kling O1, motion control, Image 3.0 Omni**: not audited in this pass. They are candidates for a follow-up.

