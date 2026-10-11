# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.3] - 2026-10-11

### Added

- In-app automatic updates. Vidra checks GitHub Releases at startup and shows an "update available" notice. Nothing is downloaded or installed until you approve it in the update dialog. The installer's minisign signature is verified against the key embedded in the app before it runs, and Vidra restarts afterwards.
- If generations or downloads are in progress, installing asks for a second confirmation with their counts (enforced natively). Active work is never interrupted silently.
- `scripts/verify-update-signature.mjs` is an independent signature verifier. The release workflow refuses to publish when the signature does not verify.

### Changed

- The credential namespace and default archive folder now follow the app identity. Vidra Studio keeps `dev.tolgaileri.vidra` and `Videos\Vidra Studio`, guarded by a test; differently identified test builds stay isolated.

### Fixed

- Rust tests left their temporary database folders behind on Windows (the test environment deleted the folder before closing SQLite).
- Releases are published automatically from version tags, with a signed `latest.json` updater manifest.

## [0.1.2] - 2026-10-11

### Fixed

- Saving a Higgsfield key pasted as one `KEY_ID:KEY_SECRET` string into one field (with the other left empty) failed with "Some values are not accepted by this model". It is now split into both fields.

## [0.1.1] - 2026-10-11

### Fixed

- Higgsfield key check: a valid key was reported as "Some values are not accepted by this model". Only 401/403 now count as a rejected key.
- Higgsfield keys pasted as one `KEY_ID:KEY_SECRET` string, or with surrounding spaces, are accepted.

## [0.1.0] - 2026-10-11

First public release.

### Added

- Independent implementation of Vidra Studio (Tauri 2 + React + Rust + SQLite).
- Provider adapters for Higgsfield, Replicate and Kling AI, written from official API documentation (44 models). fal.ai is excluded pending provider authorization.
- Model manifests (format v2) with conditional rules, per-model durations up to 30 s where documented, resolutions, aspect ratios, FPS, audio, references and output counts. Rules are shared by the UI and the native side and checked by parity tests.
- Signed (Ed25519) model registry with automatic and manual sync, last-known-good fallback and *Update required* status.
- Transparent pricing: provider estimate APIs, published rates with source and verification date, credits kept as credits, and an explicit acknowledgement when a price can't be verified.
- Video Studio and Image Studio with forms generated from each model's manifest.
- Permanent local archive: verified media files, a resumable download queue, thumbnails, projects, favorites, tags, trash, duplicate detection and backup/restore.
- User-controlled storage: any folder or drive, copy-verify-confirm archive moves, and a reconnect banner when the archive folder is unavailable.
- Prompt Library with categories, template variables, version history, model presets and import/export.
- Analytics that keep estimated and confirmed costs separate, with budget limits and CSV export.
- Provider credentials stored in Windows Credential Manager.
- Full English and Turkish user interface with onboarding.
- Per-user NSIS installer (no administrator rights) and a portable executable.

### Known limitations

- Integrations are tested against local mock servers only; no live provider calls have been made.
- Windows binaries are not code-signed.
