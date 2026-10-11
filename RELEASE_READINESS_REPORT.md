# Release readiness report: Vidra Studio v0.1.0

Date: 2026-10-11 · Platform: Windows 11 x64

## Decision

**GO for a public v0.1.0 pre-release.** The known limitations are listed
below and in the README.

## Scope

| Area | Status |
| --- | --- |
| Providers | Higgsfield (26 models), Replicate (13), Kling AI (5): **44 models**. fal.ai is excluded pending provider authorization (see [PROVIDER_TERMS_REVIEW.md](PROVIDER_TERMS_REVIEW.md)). |
| Studios | Video Studio and Image Studio, with forms generated from manifest v2 (durations up to 30 s where documented, resolutions, aspect ratios, FPS, audio, references, conditional rules). |
| Model sync | Signed (Ed25519) registry, automatic and manual sync, last-known-good fallback with no downgrade, *Update required* status. |
| Pricing | Provider estimate API, or published rates with source and date; credits stay credits; "Pricing unavailable" requires explicit acknowledgement; budgets. |
| Archive and storage | Permanent local archive, resumable downloads, any folder or drive, copy-verify-confirm moves, unavailable-folder banner with reconnect. |
| Other | Prompt Library, analytics with CSV, projects, backup/restore, onboarding, full English and Turkish. |
| Installer | Per-user NSIS installer (no administrator rights) and a portable exe. |

## Test results (local run, 2026-10-11)

| Suite | Result |
| --- | --- |
| Core unit and parity tests (Vitest) | 77 / 77 passed |
| Renderer unit tests (Vitest) | 62 / 62 passed |
| Renderer browser E2E (Playwright, mock IPC) | 10 / 10 passed |
| **Native desktop E2E** (real Tauri app over CDP, real Credential Manager, SQLite and filesystem, mock provider) | **20 / 20 passed on 4 consecutive runs** |
| Rust unit and integration tests (incl. host-safety and TS↔Rust parity vectors) | 88 / 88 passed (default and `e2e-mock` features) |
| `cargo fmt --check`, `cargo clippy -D warnings` (both feature sets) | clean |
| TypeScript `tsc -b`, ESLint | clean |
| Release binary `--smoke-test` (database, keyring, manifests, archive root) | passed |
| Release binary scan for test hooks (`VIDRA_E2E`, `__VIDRA_MOCK__`, mock IPC) | none found |

The native journey covers:

- Turkish onboarding: an invalid key, then a valid one, stored in Windows Credential Manager.
- Language persistence across restarts.
- Generation with the downloaded file verified by SHA-256.
- Playback and an identical export.
- Resume after a dropped connection, and after the app was killed mid-download.
- Persistence across both a hard kill and a graceful close.
- Offline playback.
- Duplicate detection.
- Trash and restore, and the prompt link.
- Regenerate.
- Permanent delete.
- An expired provider URL.
- Image-to-video upload.
- A 30-second request.
- Analytics CSV and backup with no secrets in the output.
- An archive move that copies, verifies and keeps the old copy.
- An unavailable archive folder with its banner and reconnect.
- Credential removal.

## Security and compliance gates

| Gate | Result |
| --- | --- |
| `pnpm audit` (all dependencies) | 0 known vulnerabilities |
| License check (`scripts/licenses.mjs`) | passed: 89 npm packages, 330 Rust crates, no disallowed licenses |
| Secrets | Keys only in Windows Credential Manager; native E2E asserts that no key bytes reach the DB, logs, backups or exports. The repository is scanned with gitleaks before push and in CI. |
| Excluded material | fal.ai adapter, manifest and notes are kept in the git-ignored `.private/`; registry signing key in the git-ignored `.signing/` |
| Provider terms | See [PROVIDER_TERMS_REVIEW.md](PROVIDER_TERMS_REVIEW.md). Kling AI and Higgsfield are kept with disclosure, and that review is not legal clearance. Written clarification is recommended. |
| Assets | Original branding; no provider logos; screenshots and the demo show a mock demo profile with local paths blurred |
| CI | typecheck, lint, tests, browser E2E, Rust fmt/clippy/tests, cargo audit, gitleaks, Semgrep, CodeQL; actions pinned to commit SHAs |

## Fixed during this pass

- A missing custom archive folder was silently recreated at startup, which
  hid an unplugged drive. Startup now never creates a custom root, and the
  unavailable-folder banner appears as designed.
- Mixed language: model workflow names ("Text to video") and the native date
  inputs (which followed the Windows locale) now follow the UI language.
- The analytics monthly axis now shows the full year.

## Known limitations

- **No live provider testing.** Every integration follows the official
  documentation and is tested against local mocks only. No paid calls were made.
- **Unsigned binaries.** SmartScreen may warn. SHA-256 checksums are published
  with the release.
- **Installer run not exercised on this machine.** Installing would write a
  per-user uninstall entry and Start-menu shortcut outside the project folder,
  which was not approved for this environment. The packaged binary passes its
  smoke test, and the installer is built by the release workflow on a clean
  runner.
- Kling AI has no cancel API, so a running Kling job cannot be cancelled.
- Windows only (x64).
