> Superseded for release decisions by [PROVIDER_TERMS_REVIEW.md](../../PROVIDER_TERMS_REVIEW.md).

# Provider terms review (release gate)

> This is a summary for the maintainer. It is not legal advice. Sources are
> the providers' official terms, read on 2026-10-11. Excerpts and clause
> numbers are in `docs/providers/<provider>.md`.

Vidra Studio's model is **bring your own key, local only**:

- Each user enters their own credentials.
- The credentials stay in that user's Windows Credential Manager.
- They are sent only to that provider's own API hosts.
- No Vidra server, relay or shared key exists.

| Provider | Credential clauses | Integration / reselling clauses | Trademark | Assessment | Action before public release |
| --- | --- | --- | --- | --- | --- |
| Higgsfield | §11.3: keep keys confidential; don't share or embed them | §5.1: no competing AI. No clause on third-party clients. | §11.8: no implied endorsement without consent | BYOK local use fits §11.3. Vidra's name and branding contain no Higgsfield marks. | Plain-text naming and the non-affiliation disclaimer are in place. **Optional:** ask Higgsfield to confirm that third-party BYOK desktop clients are acceptable. |
| fal.ai | §5(a) | §6(e)(9) written authorization | §12 | **EXCLUDED from v0.1** pending written authorization | See PROVIDER_TERMS_REVIEW.md |
| Replicate | §2.3, §2.7(c)(ii): keep credentials confidential | §2.7(c)(iii): no making the Services available to others "as a service" | No policy found | A local BYOK client does not resell or host the service. Fits. | Keep it local only and never offer a hosted relay. Non-affiliation disclaimer. |
| Kling AI | Paid Service Terms §3.8–3.9: don't disclose keys to third parties | Not addressed | §6.2: trademarks need prior written consent | Each user holds their own key, but the terms don't address third-party clients. | Plain factual naming only. Recommended: ask Kling to confirm. |

## Status

- **Blocking:** fal §6(e)(9) needs written authorization, or a documented
  decision by the maintainer to accept the risk.
- **Non-blocking but recommended:** confirmation from Higgsfield and Kling.
- **Satisfied in the product:**
  - no provider logos (`docs/legal/brand-review.md` check)
  - plain-text compatibility naming
  - non-affiliation disclaimers in the README, the About screen and NOTICE
  - local-only key storage
  - no shared keys
  - no hosted relay
