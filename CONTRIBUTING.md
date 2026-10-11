# Contributing to Vidra Studio

Thank you for helping. Please read this first.

## Ground rules

1. **Original work only.** Do not paste code from projects whose license is
   unknown or incompatible with MIT. That includes provider SDK internals
   unless their license allows it. Note any third-party code in
   `THIRD_PARTY_LICENSES.md`.
2. **Official APIs only.** Provider integrations must follow the provider's
   public documentation. No reverse-engineered or private endpoints. Cite
   your sources in `docs/providers/<provider>.md`.
3. **Never commit credentials**, real API keys or personal media. Tests use
   local mock servers.
4. **Paid calls are opt-in.** Live provider tests must be skipped unless the
   developer explicitly enables them.
5. **No fake data in the product.** Every visible control must perform a
   real action.

## Development setup

You need Node.js 22+, pnpm, Rust (stable, MSVC on Windows) and WebView2.
Visual Studio Build Tools provide the C++ toolchain.

```bash
pnpm install
pnpm dev             # runs the desktop app with hot reload
pnpm check           # typecheck + lint + unit tests + Rust tests
```

Browser-only UI preview (with a mock backend):
`pnpm --filter @vidra/desktop dev`, then open http://localhost:1420.

## Adding or updating a model

Edit `packages/core/manifests/<provider>.json`. Every parameter must exist in
the provider's official API schema. Update `lastVerified` and `docsUrl`. Run
`pnpm --filter @vidra/core test`: the manifest tests validate the schema and
the cross-references.

## Adding a provider

1. Document the API in `docs/providers/<id>.md`, citing official sources.
2. Implement the `Provider` trait in
   `apps/desktop/src-tauri/src/providers/<id>.rs` with explicit capability
   flags.
3. Add contract tests against a local mock server.
4. Add a manifest and register the provider ID in
   `packages/core/src/registry.ts`.

## Pull requests

- Keep each PR focused and include tests.
- Run `pnpm check` and make sure it passes.
- Put user-facing strings in both `en.ts` and `tr.ts`.
- Use short, imperative commit messages.

By contributing, you agree your contributions are licensed under the MIT
License.
