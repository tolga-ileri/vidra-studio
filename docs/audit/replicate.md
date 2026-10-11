# Replicate model audit (manifest 2026.10.11.1)

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
