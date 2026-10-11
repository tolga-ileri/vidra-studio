# Kling manifest audit

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
