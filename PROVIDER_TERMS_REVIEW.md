# Provider terms review

> **This is not legal advice, not written authorization from any provider,
> and not a definitive legal clearance.** It records how the maintainer
> (Tolga İleri) reads each provider's published terms for Vidra Studio
> v0.1, and which remaining questions are open. Terms were read on
> 2026-10-11. Clause excerpts and sources are in `docs/providers/<provider>.md`.

## Independent project

Vidra Studio is an independent open-source AI creation application. It is not
affiliated with, endorsed by, or sponsored by Higgsfield, Kling AI
(Kuaishou), Replicate, fal.ai or any other provider. Provider names appear
only to describe which official APIs the app can call. No provider logos are
used.

## How Vidra Studio handles provider access

- **Bring your own key, local only.** Each user enters their own
  credentials. They are stored only in that user's Windows Credential
  Manager and read only by Vidra's native code on that computer.
- **Direct local-to-provider communication.** Requests go from the user's
  computer straight to the provider's official API host. There is no Vidra
  server, relay, proxy, shared key or resale.
- **Credentials never leave the device.** They are never written to logs,
  the local database, backups, exports or crash reports, and there are no
  crash reports or telemetry.
- **Users can only spend their own balance.** Paid requests need an
  explicit Generate action, an optional cost confirmation, and
  acknowledgement when the price is unknown.

## Per provider

### Higgsfield — included in v0.1 (interpretation, not clearance)

| Topic | Terms (summary) | Vidra's position |
| --- | --- | --- |
| API keys (§11.3) | Keep keys confidential. Don't share, publish or embed them. The key holder is responsible for all activity on the key. | Each user is the key holder and enters their own key, which stays on their machine and is sent only to `api.higgsfield.ai`. |
| Branding (§11.8) | No use of the name or logos to imply endorsement without consent. | Plain-text compatibility naming, a non-affiliation disclaimer, and no logo. |
| Competing services (§5.1) | No using the Service or outputs to build competing AI. | Vidra is a client and does not train models. |

**Open question:** the terms do not explicitly address third-party desktop
clients into which users enter their own keys.
**Recommendation:** obtain written clarification from Higgsfield.

### Kling AI — included in v0.1 (interpretation, not clearance)

| Topic | Terms (summary) | Vidra's position |
| --- | --- | --- |
| Keys (Paid Service Terms §3.8–3.9) | Keys must not be disclosed or transferred to third parties. | Keys stay on the key holder's own machine and are sent only to Kling's official API host. |
| Trademarks (§6.2) | Use needs prior written consent. | Plain factual compatibility statement only, and no logo. |

**Open question:** the terms do not address BYOK client applications.
**Recommendation:** obtain written clarification from Kling AI.

### Replicate — included in v0.1, subject to this compliance review

| Topic | Terms (summary) | Vidra's position |
| --- | --- | --- |
| Credentials (§2.3, §2.7(c)(ii)) | Keep credentials confidential and don't share them. | Each user uses their own token, which stays local. |
| No resale / SaaS (§2.7(c)(iii)) | Don't make the Services available to others as a service. | Vidra is a local client with no hosted relay. Each user is Replicate's customer. |
| Acceptable use (§2.7(a)) | Users must follow the AUP. | Linked from the Providers screen. Users are responsible for their content. |
| Trademarks | No published policy found. | Plain-text naming, a disclaimer, and no logo. |

**Assessment:** the local BYOK client model is consistent with the published
terms as read. Replicate deletes API outputs after about 1 hour, which is why
Vidra downloads Replicate outputs immediately.

### fal.ai — EXCLUDED from v0.1

fal's Terms of Service §6(e)(9) state that building scripts or applications
that integrate with the Services requires fal's written authorization. No such
authorization has been obtained, so the fal integration (adapter and models)
is **not part of this repository or release**. The Providers screen lists fal.ai
under Planned as "Pending provider authorization". It will only be added after
written authorization from fal.

## Summary for the release gate

| Provider | Status in v0.1 | Blocking? |
| --- | --- | --- |
| Higgsfield | Included | No. Ambiguity documented; written clarification recommended. |
| Kling AI | Included | No. Ambiguity documented; written clarification recommended. |
| Replicate | Included | No. Consistent with the published terms as read. |
| fal.ai | Excluded | Not applicable. Excluded pending written authorization. |
