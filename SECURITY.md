# Security policy

Vidra Studio handles credentials that can spend real money. Security reports
are welcome and taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use
[GitHub private vulnerability reporting](https://github.com/tolga-ileri/vidra-studio/security/advisories/new).
Include steps to reproduce and the impact. Never include a real API key; if
one was exposed, revoke it with the provider first.

I aim to acknowledge reports within 7 days.

## Supported versions

Only the latest release receives security fixes.

## Security model (summary)

See `docs/architecture.md` for the full design.

| Asset or threat | Control |
| --- | --- |
| Provider credentials | Stored in Windows Credential Manager through the `keyring` crate. Only native Rust code reads them. They never reach the webview and are never written to SQLite, logs, backups or exports. |
| Unauthorized or duplicate paid jobs | Generation needs an explicit click. Optional cost confirmation and app-level budget limits apply. Idempotency keys are used where the provider supports them. Otherwise a submit is never retried automatically, and an uncertain result is reported to the user. |
| Request forgery from the UI | Every native command validates its arguments. The renderer sends a model ID and parameter values. Rust builds the provider request from bundled manifests and calls only fixed provider base URLs. There is no generic proxy. |
| SSRF and hostile output URLs | Downloads require https on port 443 to a public hostname. DNS answers are checked against private, loopback and link-local ranges. Every redirect hop is re-validated. |
| Malicious files | Reference files must pass a size limit and a magic-byte check. Downloads are size-capped, type-checked and hashed, then moved into place atomically. |
| Path traversal | All archive files are resolved under the archive root and checked after canonicalization. The renderer cannot pass file paths: references come from native dialogs or native drag-drop tokens. |
| Backup import (zip) | Entry names must match an allowlist; no `..`, absolute paths or symlinks. Size and entry-count limits apply. Each file's sha256 is checked against the manifest. Files are staged before commit. |
| Webview | Strict CSP, `withGlobalTauri: false`, and minimal capabilities (no fs or shell plugins in the renderer). The asset protocol is scoped to the archive folder at runtime. |
| Supply chain | Lockfiles. pnpm `minimumReleaseAge`, `trustPolicy` and `blockExoticSubdeps`. `cargo audit` and `pnpm audit`. Gitleaks, Semgrep and CodeQL in CI. GitHub Actions pinned to commit SHAs. |
| Releases | Built by GitHub Actions from tags. SHA-256 checksums are published. The installer is **unsigned** unless a code-signing certificate is configured, and the release notes say which. |

## Known limitations

- Unsigned Windows installers trigger SmartScreen warnings. Verify the
  SHA-256 checksum from the release page before installing.
- Budget limits are application-level estimates. They are not billing caps
  enforced by the providers.
- An attacker with code execution as your Windows user can read entries in
  the Windows Credential Manager. That is outside this app's threat model.
