# Vidra Studio architecture

Vidra Studio is a local-first Windows desktop app: a Tauri 2 shell, a React +
TypeScript renderer, and a Rust backend that owns credentials, provider
calls, the SQLite database and the media archive. There is no Vidra server.

```
apps/desktop/src          React renderer (no secrets, no filesystem, no network to providers)
apps/desktop/src-tauri    Rust: commands, provider adapters, jobs worker, downloads, archive, backup
packages/core             Portable TypeScript: model registry schema + manifests, params,
                          budget, analytics, prompt templates/import-export, archive state
packages/core/manifests   Versioned provider model manifests (JSON), read by TS and Rust
docs/providers/*.md       Verified provider API notes with official sources
```

## Trust boundaries

| Boundary | Rule |
| --- | --- |
| Renderer → Rust | Only the commands in §3. Every argument is validated in Rust (UUIDs, enums, length caps, numbers bounded). Errors are `{ code, message }` with user-safe messages. |
| Rust → providers | Fixed base URLs per provider (§4). Request paths come from the bundled manifests, never from the renderer. The renderer sends a model **id** and parameter **values**. Rust validates the values against the manifest and builds the body itself. |
| Credentials | Windows Credential Manager through the `keyring` crate, under service `dev.tolgaileri.vidra` and account `<provider>:<field>`. Rust never returns them to the renderer, never logs them and never stores them in SQLite or backups. |
| Files | All media lives under the archive root. Paths are relative in SQLite and resolved with canonicalize + `starts_with(root)`. Reference files reach Rust only from a native file dialog or a native drag-drop event, so the renderer cannot ask Rust to read an arbitrary path. |
| Downloads | Provider output URLs must be https on port 443, have a public hostname (no IP literals, no local names) and resolve only to public IPs (custom DNS resolver). Redirects are handled manually, at most 5, and each hop is re-validated. |
| Webview | Strict CSP, `withGlobalTauri: false`, capabilities limited to `core:default` plus the app commands. No shell or fs plugins in the renderer. The asset protocol is scoped at runtime to the archive root only. |

## 1. Storage

```
%APPDATA%\dev.tolgaileri.vidra\vidra.sqlite3     metadata (WAL, foreign_keys=ON, user_version migrations)
<archiveRoot>  (default %USERPROFILE%\Videos\Vidra Studio)
  media\YYYY\MM\<assetId>.<ext>
  thumbs\<assetId>.jpg
  .tmp\                                          partial downloads, import staging
```

## 2. SQLite schema (migration 1)

```sql
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE TABLE prompt_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, built_in INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE prompts (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
  category_id TEXT REFERENCES prompt_categories(id) ON DELETE SET NULL,
  tags_json TEXT NOT NULL, favorite INTEGER NOT NULL DEFAULT 0,
  preferred_model_ids_json TEXT NOT NULL, parameters_json TEXT NOT NULL,
  variable_defaults_json TEXT NOT NULL, version INTEGER NOT NULL, built_in INTEGER NOT NULL DEFAULT 0,
  source_job_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE prompt_versions (
  id TEXT PRIMARY KEY, prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, tags_json TEXT NOT NULL,
  preferred_model_ids_json TEXT NOT NULL, parameters_json TEXT NOT NULL,
  variable_defaults_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(prompt_id, version));
CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL, model_name TEXT NOT NULL,
  workflow TEXT NOT NULL, output TEXT NOT NULL, provider_request_id TEXT, status TEXT NOT NULL,
  prompt TEXT NOT NULL, negative_prompt TEXT, params_json TEXT NOT NULL,
  requested_duration_sec REAL, estimated_cost_usd REAL, estimate_source TEXT, confirmed_cost_usd REAL,
  error_code TEXT, error_message TEXT,
  prompt_id TEXT REFERENCES prompts(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE, poll_url TEXT, result_url TEXT, cancel_url TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
  UNIQUE(provider, provider_request_id));
CREATE TABLE media_assets (
  id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  output_index INTEGER NOT NULL, kind TEXT NOT NULL, original_url TEXT NOT NULL, local_path TEXT,
  filename TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER, sha256 TEXT, duration_sec REAL,
  width INTEGER, height INTEGER, thumbnail_path TEXT, download_status TEXT NOT NULL,
  duplicate_of_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL, UNIQUE(job_id, output_index));
CREATE INDEX media_assets_sha256 ON media_assets(sha256);
CREATE TABLE archive_items (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, custom_title TEXT,
  favorite INTEGER NOT NULL DEFAULT 0, tags_json TEXT NOT NULL DEFAULT '[]', deleted_at INTEGER);
CREATE TABLE download_tasks (
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE REFERENCES media_assets(id) ON DELETE CASCADE,
  status TEXT NOT NULL, bytes_downloaded INTEGER NOT NULL DEFAULT 0, total_bytes INTEGER,
  validator TEXT, accept_ranges INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER, last_error TEXT, last_error_code TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE providers (id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
  verification TEXT NOT NULL DEFAULT 'unknown', last_verified_at INTEGER, last_error TEXT,
  region TEXT);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
```

Built-in prompt categories use stable IDs of the form `builtin-<slug>`:
cinematic-advertising, product-commercials, social-media-reels,
character-animation, realistic-human-scenes, educational-videos,
storytelling, nature-landscapes, sports, fashion, music-videos and
animation. Built-in prompt templates are seeded from
`packages/core/seed/prompts.json` and are editable copies (`built_in = 1`).

**Deletion invariants.**

- Deleting an archive item or job never deletes prompts.
- Trashing or deleting never cancels any job.
- Permanent deletion removes the files under the root, then the rows.

## 3. Commands (renderer → Rust)

See `apps/desktop/src/lib/ipc.ts` for the typed client. It is authoritative
for names, argument and return shapes. Groups:

- **App:** `app_info`, `get_settings`, `update_settings`, `check_for_updates`, `open_external_url`, `save_text_file`.
- **Storage:** `storage_status`, `plan_archive_move`, `start_archive_move`, `finalize_archive_move`, `cancel_archive_move`, `reconnect_archive_root`, `choose_export_dir`.
- **Catalog:** `catalog_status`, `list_catalog`, `sync_catalog` (signed registry, see `registry/` and `scripts/registry/build.mjs`).
- **Providers:** `list_providers`, `set_provider_credentials`, `remove_provider_credentials`, `verify_provider`, `set_provider_enabled`.
- **Models:** `list_models` returns the merged manifest models (bundled, or synchronized where discovery exists).
- **References:** `pick_reference` opens a native dialog. `upload_dropped_reference` only accepts a token issued for a natively dropped file. Both validate type, size and signature, upload to the provider's storage, and return `{ url, kind, name, previewDataUrl? }`.
- **Generation:** `estimate_generation`, `submit_generation`, `cancel_generation`, `retry_generation`, `list_jobs`, `get_job`, `delete_job`.
- **Archive:** `list_archive`, `rename_item`, `set_favorite`, `set_tags`, `move_to_project`, `trash_items`, `restore_items`, `delete_permanently`, `verify_files`, `storage_stats`, `media_path`, `thumbnail_path`, `save_thumbnail`, `export_media`, `open_file_location`.
- **Projects:** `list_projects`, `create_project`, `rename_project`, `delete_project`.
- **Downloads:** `list_downloads`, `retry_download`, `pause_download`, `resume_download`.
- **Prompts:** `list_prompts`, `get_prompt`, `create_prompt`, `update_prompt`, `duplicate_prompt`, `delete_prompt`, `set_prompt_favorite`, `list_prompt_versions`, `restore_prompt_version`, `list_categories`, `create_category`, `rename_category`, `delete_category`, `export_prompts`, `import_prompts`, `save_prompt_from_job`.
- **Backup:** `export_archive`, `preview_import`, `confirm_import`, `cancel_import`.

Events: `vidra://store` carries a `StoreEvent` payload (`packages/core/src/types.ts`).

## 4. Provider adapters (Rust trait `Provider`)

| | Higgsfield | Replicate | Kling AI |
| --- | --- | --- | --- |
| Base | `https://api.higgsfield.ai` | `https://api.replicate.com/v1` | `https://api-singapore.klingai.com` |
| Auth | `Key <id>:<secret>` | `Bearer <token>` | `Bearer <api key>` |
| Validate | estimate call (documented) | `GET /account` | `GET /account/costs` |
| Discovery | manifest only | `GET /v1/models/{o}/{n}` schema (official) | manifest only |
| Estimate | `/estimate/<path>` (provider) | manifest published rate | manifest published rate |
| Upload | signed upload URL + PUT | `POST /files` multipart | inline base64 / URL |
| Cancel | queued only | `POST /predictions/{id}/cancel` | not supported |
| Idempotent submit | `Idempotency-Key` header | **no**: same rule | `external_task_id` (looked up before any resubmit) |

All capability flags are explicit (`ProviderCapabilities`). The UI hides
anything a provider does not support.

## 5. Generation lifecycle

1. `estimate_generation(modelId, prompt, negativePrompt, params)` builds the
   request in Rust and returns `{ usd, credits, source }`. It returns null
   when unknown.
2. `submit_generation(…, idempotencyKey, confirmedEstimateUsd, promptId, projectId)`
   proceeds in this order:
   1. Validate the inputs.
   2. Re-estimate.
   3. Run the budget check (same rules as `packages/core/src/budget.ts`).
   4. Require confirmation if enabled. A missing or lower confirmed estimate
      returns `confirmation_required` with the fresh estimate.
   5. Insert the job (`submitting`) and submit.
   6. Store the provider request ID and set the status to `queued`.

   Ambiguous network failures are retried once **only** where the provider
   supports idempotency. Otherwise the job is marked `failed` with
   `submit_uncertain` and a message telling the user to check the provider
   dashboard before retrying.
3. A worker polls non-terminal jobs every 4 s, backing off to 15 s. It runs
   at startup too, so jobs recover after a restart. On success it extracts
   output URLs with the model's `outputPath`. It creates the assets and
   archive items, plus download tasks when `autoSave` is on.
4. Download manager:
   - bounded concurrency (1–4)
   - `.part` files under `.tmp`, resumed with `Range` + `If-Range` when the
     server supports it
   - free-space checks with a 200 MB margin
   - a 4 GiB cap for video and 100 MB for images
   - content-type and magic-byte checks
   - sha256 computed while writing, then fsync and an atomic rename
   - duplicate detection by hash
   - exponential backoff (5 s × 2ⁿ, at most 6 attempts)
   - 403, 404 and 410 mean `expired`, with no retry and a clear message

   Thumbnails for images are generated in Rust (`image` crate). For video,
   the renderer captures a frame from the local file and sends it to
   `save_thumbnail`, which validates it. Assets reach `saved` only after the
   file is in place.
5. `cancel_generation` calls the provider cancel where supported. A rejection
   maps to `cancel_too_late`.

## 6. Backup format (`.vidra`, a zip)

`manifest.json` (format `vidra-archive`, version 1, file list with sha256 and
size), `metadata.json` (jobs, assets, items, projects, prompts, versions,
categories), `media/<assetId>.<ext>` and `thumbs/<assetId>.jpg`.

The backup never contains credentials, settings secrets or absolute paths.

On import, Vidra checks:

- an allowlist regex for entry names, and no symlinks
- at most 20 GiB and 100k entries
- every sha256 against the manifest
- free disk space

It stages the files, previews the result, then commits. Colliding IDs are
remapped and duplicate hashes are skipped.


> fal.ai is excluded from v0.1 pending provider authorization (PROVIDER_TERMS_REVIEW.md).

## Visual references

- `packages/core/src/references.ts` places reference images into a model's
  documented image inputs (`planReferences`): first/last frames go to the
  `start_frame`/`end_frame` inputs, character/product/style/scene images to
  the `reference` input, in order. Anything that does not fit is reported
  (`unplaced`) and `compatibleModels` ranks models that take all of them.
  `consistencyGuidance` builds the prompt text for "Keep character
  consistency"; prompts are documented inputs, so no provider parameter is
  invented.
- `apps/desktop/src-tauri/src/reference_library.rs` keeps picked files staged
  under the data directory by SHA-256 (cleaned after a day), stores saved
  references under `<archive>/references/` with a row in `reference_assets`,
  and re-uploads them to the provider on `attach_reference`. Archive moves and
  verification include these files (`managed_files`).
- `GenerationInput.references` lists the images in the request (parameter,
  name, type, hash, library id); `check_generation_references` rejects any
  reference that is not actually present in the request parameters. Jobs store
  them in `references_json` with `preserve_identity`.
