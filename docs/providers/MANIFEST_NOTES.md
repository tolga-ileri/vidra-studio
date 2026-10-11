# Bundled manifest notes (version 2026.10.11)

The manifests in `packages/core/manifests/*.json` were written from the provider notes in this folder (`higgsfield.md`, `fal.md`, `replicate.md`, `kling.md`), which in turn come from official docs. No third-party template code was used. Every model has `lastVerified: 2026-10-11`. Prices are indicative list prices ("from" figures). `usd: null` means no official USD price was published or verified.

Conventions: shared param keys (`duration`, `aspect_ratio`, `resolution`, `seed`, `generate_audio`, `image`, `end_image`, `reference_images`, `reference_videos`, `video`, `num_images`, `output_format`, `cfg_scale`). Negative prompts use `negativePrompt`, not params.

## Higgsfield (12 models: 8 video, 4 image)

| Workflow | Models |
|---|---|
| text-to-video | Seedance 2.0, Kling 3.0 std, Wan 2.7 |
| image-to-video (start + end frame) | Seedance 2.0 I2V, Kling 3.0 std I2V (`last_image_url`), Wan 2.7 I2V |
| reference-to-video | Seedance 2.0 reference (`image_urls` required, `video_urls` optional) |
| video-edit | Seedance 2.5 video edit |
| text-to-image | Soul 2, Qwen Image 3, Z-Image Turbo |
| image-edit | Qwen Image 3 edit |

- Kling `sound` is encoded `on`/`off`.
- Skipped: Seedance 2.5 T2V/I2V/reference, Wan 3.0, Wan 2.7 reference (kept the set small; all verified and can be added). Kling 3.0 pro/4k/turbo, MiniMax H3, LTX, Grok, Hailuo: fields not verified. Soul standard (v1): only in the partial OpenAPI.
- Skipped fields: `audio_urls` (reference audio), `multi_shots`/`multi_prompt` (array of objects), `elements`, `style_id`, `custom_reference_id`, `bitrate_mode`, `enable_thinking`.
- Unverified / inferred: Seedance 2.5 video-edit `resolution` values (the notes give only the default 720p; 480p/720p/1080p assumed from the 2.5 family). Seedance 2.5 edit `image_urls` allows 30 but the schema caps `maxItems` at 20. Per-model doc URLs other than Kling 3 were not recorded, so `docsUrl` points at the docs index `https://docs.higgsfield.ai/docs/llms.txt`. Prompt max lengths, apart from Kling (2500) and Z-Image (800), are not documented; 5000 is used.

## fal (10 models: 7 video, 3 image)

| Workflow | Models |
|---|---|
| text-to-video | Kling 3.0 Pro, Veo 3.1, Seedance 2.0, Wan 3.0 (`audio` field), MiniMax H3 |
| image-to-video (start + end frame) | Kling 3.0 Pro I2V (`start_image_url`), Seedance 2.0 I2V |
| text-to-image | FLUX.1 [dev], Nano Banana Pro, Seedream 4.5 |

- Skipped: `fal-ai/veo3.1/fast/image-to-video` (fal says it will be deprecated on 2026-10-22). LTX 2.3 (inconsistent pricing). Recraft v4, FLUX.2 Pro (custom `image_size` objects; presets only would be possible).
- **Gap:** no image-edit / image-to-image or reference/video-to-video endpoints were verified in the fal notes.
- Unverified: prices for Kling 3.0 Pro I2V and Seedance 2.0 I2V (`kind: unknown`). Defaults for FLUX dev `image_size` (landscape_4_3) and Nano Banana `output_format` (png) are UI choices, not documented defaults. Prompt max lengths are capped at 20000 where fal allows more.

## Replicate (13 models: 9 video, 4 image)

| Workflow | Models |
|---|---|
| text-to-video | Veo 3, Veo 3 Fast, Hailuo 02, Seedance 1 Pro |
| image-to-video | Veo 3 Fast (`#image-to-video`), Kling 2.1 (start + end), Hailuo 02 (`#image-to-video`, first + last), Seedance 1 Pro (`#image-to-video`, first + last), Ray 2 720p (start + end) |
| text-to-image | FLUX 1.1 Pro, FLUX Schnell (`output[]`), Imagen 4 |
| image-edit | FLUX Kontext Pro |

- Variants (`#image-to-video`) reuse the same Replicate model with the start frame made required, so the UI can offer a clean I2V entry.
- Skipped: `minimax/video-01` (flat $0.50, older), Wan 2.2 fast (uses `num_frames`, not seconds), Recraft v3 and Ideogram v3 turbo (huge enum lists that should be read from the live schema), FLUX 1.1 Pro `custom` aspect ratio with width/height.
- Unverified: Replicate schemas change in place; the app should prefer the live schema. Veo prices are the "without audio" rates. Prompt max lengths are not documented (5000 used).

## Kling official API (3 models: 1 video, 2 image)

| Workflow | Models |
|---|---|
| text-to-video | Kling 3.0 (new API, `POST /text-to-video/kling-3.0`, fields under `settings.*`, `settings.audio` encoded `native`/`off`, output `outputs[].url`) |
| text-to-image | Kling Image 3.0 (legacy `POST /v1/images/generations`, `model_name: kling-v3` fixed, output `task_result.images[].url`) |
| image-to-image | Kling Image 3.0 with a required `image` reference |

- `outputPath` is relative to the response `data` object, as in the notes.
- Video pricing is published in units, not USD, so `usd` is null with the unit rates in `notes`. Image pricing was not read.
- Skipped: `image_reference`/`image_fidelity`/`element_list` for images; multi-shot; 3.0 Turbo, 2.6 and Motion Control (slugs not captured); legacy `/v1/videos/*` (not re-verified).

### Schema blocker: Kling new-API `contents[]`

Kling 3.0 image-to-video (`/image-to-video/kling-3.0`), 2.5 Turbo I2V and 3.0 Omni (`/omni-video/kling-3.0-omni`) take inputs as a typed array of objects:

```json
"contents": [
  {"type": "prompt", "text": "..."},
  {"type": "first_frame", "url": "..."},
  {"type": "last_frame", "url": "..."},
  {"type": "refer_image", "url": "...", "id": "image_1"},
  {"type": "base_video", "url": "..."}
]
```

The media `shape` (`url` / `url_array`) cannot express this, and the prompt must also go into `contents`. Proposed, backward-compatible change to `registry.ts`:

```ts
// prompt: allow the prompt to be emitted as a contents item
prompt: z.object({
  apiField,
  required: z.boolean(),
  maxLength: z.number().int().positive().max(20000),
  /** Emit as an item {type, text} appended to this array field instead of a plain string. */
  asItem: z.object({ type: z.string(), textField: z.string().default("text") }).optional(),
}),

// media param: new shape "typed_items"
shape: z.enum(["url", "url_array", "typed_items"]).default("url"),
/** For shape "typed_items": each URL is appended to `apiField` (an array) as
    { [typeField]: itemType, [urlField]: url, ...(idPrefix ? { id: `${idPrefix}${n}` } : {}) }. */
item: z.object({
  itemType: z.string(),          // "first_frame" | "last_frame" | "refer_image" | "base_video" | ...
  typeField: z.string().default("type"),
  urlField: z.string().default("url"),
  idPrefix: z.string().optional(), // "image_" -> "image_1", "image_2"
}).optional(),
```

`parseManifest` would also need to let several params share one `apiField` when every one of them uses `shape: "typed_items"` (they append to the same array), and the Rust request builder would need to support it. With that, Kling 3.0 I2V would be `contents` + first_frame (required) + last_frame, and Omni would cover reference-to-video and video-edit.

## Seed prompts

`packages/core/seed/prompts.json`: 12 categories, 36 original prompts (3 per category), all with `{snake_case}` variables that have defaults. `preferredModelIds` point only at models in these manifests (checked by `test/manifests.test.ts`).
