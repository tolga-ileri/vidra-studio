# Higgsfield model audit

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
