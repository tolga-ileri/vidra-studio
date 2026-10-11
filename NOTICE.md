# Notices

## Independent implementation

Vidra Studio was written from scratch. The project's earlier prototype,
"Higgsfield API Studio", was scaffolded from an upstream template that has no
license. **No source file, component, style, asset or model catalog from that
template, or from that prototype's template-derived code, was copied into
this repository.** The prototype served only as a list of requirements
(features, user workflows, and security findings from its audit).

Provider integrations were written from each provider's public API
documentation. The sources are listed in `docs/providers/*.md`. Model
parameters in `packages/core/manifests/` are factual API descriptions taken
from that documentation, each with its source URL and verification date.

## Starter scaffolding

`apps/desktop` was initially generated with `create-tauri-app` (Tauri
Programme within The Commons Conservancy, MIT OR Apache-2.0). UI primitives
in `apps/desktop/src/components/ui` were generated with the shadcn/ui CLI (MIT).
Both licenses permit this use. See `THIRD_PARTY_LICENSES.md`.

## Trademarks

Higgsfield, fal, Replicate, Kling and other provider names are trademarks of
their respective owners. Vidra Studio uses them only to say which services
it can connect to. It does not use their logos and makes no claim of
affiliation, endorsement or sponsorship.

The Vidra Studio name and mark (`branding/`) are original to this project.
