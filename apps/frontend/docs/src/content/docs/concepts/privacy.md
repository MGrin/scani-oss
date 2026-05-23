---
title: Privacy & telemetry
description: Scani's OSS distribution sends no telemetry. Here's exactly what does and doesn't leave a self-hosted box.
---

**Scani's OSS distribution sends no telemetry, ever.**

Self-hosted installs do not phone home. No install ID, no anonymous usage
counters, no feature-flag pings, no version-check beacons. The only outbound
calls a self-hosted stack makes are the ones you explicitly configure —
exchange APIs you connect, the pricing / chain providers whose keys you set
in `.env`, and your email transport.

## Two opt-in exceptions

Both are **default off**. Both require explicit configuration to send any
data anywhere.

### Sentry — error monitoring

`SENTRY_DSN` (backend) and `VITE_SENTRY_DSN` (frontend) control Sentry error
reporting. With no DSN set, the SDK is a no-op — nothing leaves the process.

Even when Sentry is enabled, payloads are scrubbed by
[`packages/business/shared/src/utils/sentry-scrubber.ts`](https://github.com/MGrin/scani-oss/blob/main/packages/business/shared/src/utils/sentry-scrubber.ts)
before send. The scrubber strips known credential-shaped fields (API keys,
tokens, encryption keys, session cookies) regardless of where they appear in
the payload.

### `SCANI_CLOUD_URL` — outbound 3rd-party calls

By default this points at the bundled `data-provider` container on the same
host. **All outbound provider calls fan out from there.** In Tier 1, that's
your machine.

If you point `SCANI_CLOUD_URL` at a third-party hosted data-provider instead
(Tier 2 — see [Tier model](/self-hosting/tier-model/)), upstream
requests fan out from the hosted endpoint. The OSS code makes no such call
by default.

## What we're not collecting

We are not collecting usage analytics for the OSS project itself. We don't
plan to.

If we ever change our mind, the new feature will be:

1. **Opt-in, default-off.**
2. **Fully documented in
   [`.github/SECURITY.md`](https://github.com/MGrin/scani-oss/blob/main/.github/SECURITY.md).**
3. **Shipped as a separate PR** you can read end-to-end before deciding.

That's the contract.

## Security disclosures

Security findings should go to **security@scani.xyz**, not a public issue.
See
[`.github/SECURITY.md`](https://github.com/MGrin/scani-oss/blob/main/.github/SECURITY.md)
for the full disclosure flow.
