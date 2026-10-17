# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.3.0] - 2026-10-18

### Added

- **Video Editor** (Phase 1), a general-purpose nonlinear editor that works without any provider:
  - Import video, audio and images (MP4, MOV, M4V, WebM, MKV, AVI, MP3, WAV, AAC, M4A, FLAC, OGG, Opus, PNG, JPEG, WebP) from a file dialog, by dropping files on the window, or with "Open in Video Editor" from the archive. Damaged files are reported per file.
  - Multitrack timeline: layered video tracks and audio tracks, drag to move (also between tracks), trim, split at the playhead, ripple delete, duplicate, copy/paste, multi-select, snapping, zoom, frame stepping, undo/redo, thumbnails and waveforms.
  - Per clip: volume (0–200%), mute, fade in/out, speed (0.25–4×), opacity, scaling (fit, fill, blurred background), size and position (picture-in-picture, logos). Per track: mute, hide, lock.
  - Project formats 16:9, 9:16, 1:1, 4:5 and custom; changing the format keeps every edit. Safe-area guides for Reels, TikTok, Shorts and TV.
  - Live preview driven by the same render plan as the export.
  - Export to H.264 MP4 with AAC audio at 720p, 1080p, 1440p or 4K, software or hardware encoding, with progress, cancellation and FFprobe validation before the file is written.
  - Projects (`.vidraproj`, versioned JSON): new, open, save, save as, recent projects, autosave with crash recovery, and relinking of moved media. Source files are never modified.
- Uses FFmpeg/FFprobe installed on the computer (chosen folder, next to the app, or PATH). FFmpeg is not bundled; see docs/editor/ARCHITECTURE.md for the licensing decision.

### Fixed

- Browser e2e tests used whatever server was already on port 1420; they now start their own on a dedicated port.

### Security

- Dependency advisories published since 0.2.0 are fixed: rustls 0.23.46 (RUSTSEC-2026-0346/0347/0348/0349) and zip 9 for backups (RUSTSEC-2026-0367/0368/0369). The updater's optional zip support is disabled; Windows updates are signed `.exe` installers, so the zip extraction path (and zip 4.6.1) is no longer compiled in.

## [0.2.0] - 2026-10-13

### Added

- **Visual references** in the Video Studio ("Referans Görseller"): drag-and-drop or pick PNG/JPG/WebP images, name them, and mark each as character/mascot, product, style, scene, first frame or last frame. Images are placed into the model's documented inputs (reference-image arrays, start/end frames); nothing is sent through undocumented parameters.
- A local **reference library**: save an image once (stored under the archive folder, moved with it) and reuse it across generations. Saved images are re-uploaded to the provider each time, because provider upload storage is temporary.
- **Keep character consistency**: appends explicit, visible guidance to the prompt asking the model to keep the referenced character's identity, and sends the same images with every scene. Labelled as guidance; no provider guarantees exact preservation.
- Models that cannot take the chosen references show a warning with the exact reason and offer compatible models. References are never discarded silently; generating is blocked until they fit or are removed.
- Each generation records its references (parameter, name, type, hash, library id) and the consistency setting; regenerate re-uploads them.
- Native checks: every declared reference must actually be present in the request parameters; staged uploads are cleaned up after a day.

### Changed

- Image inputs of video models are managed by the reference panel instead of the generic settings form (the form keeps video and audio inputs).
- The Video Studio layout stacks on narrow (phone-width) viewports.

## [0.1.5] - 2026-10-12

### Fixed

- Higgsfield: a key pasted as one `KEY_ID:KEY_SECRET` string into the secret field was not split when the ID field held something else (often the key's display name), so Higgsfield rejected it. The full string in the secret field now always wins.
- Credential errors now name the field and the problem (e.g. "API key ID can't contain spaces. Paste the key itself, not its name.") instead of the generic "Some values are not accepted by this model".

## [0.1.4] - 2026-10-11

First release delivered through the in-app updater.

### Added

- A test that keeps the app version (shown in Settings) and the updater version identical.

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
