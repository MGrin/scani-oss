# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in Scani, please
report it privately rather than opening a public issue.

- **Email:** security@scani.xyz
- **Encrypted:** PGP key fingerprint TBD — request a key in your first
  message and we'll send it via reply.
- Do **not** open a public GitHub issue for anything resembling a
  vulnerability.

We aim to acknowledge new reports within **two business days** and to
ship a fix or a clear remediation plan within **30 days** of triage,
faster for actively-exploited findings.

## Scope

In scope:

- The code in this repository — backend services, the frontend app, and
  the shared packages.
- Authentication / authorization flows (Better-Auth, HMAC-signed
  endpoints).
- Multi-tenant data isolation.

Out of scope:

- Denial-of-service findings that require a high request rate from a
  single IP — those are rate-limited at the edge.
- Vulnerabilities in third-party dependencies — please report those to
  the upstream project.
- Findings against a specific self-hosted deployment's infrastructure
  (the hosting provider, database, network) rather than this code.

## Safe-harbour

We won't pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data
  destruction, and service disruption.
- Only access the minimum data necessary to demonstrate the issue.
- Give us reasonable time to remediate before public disclosure.
- Don't exfiltrate data or use findings for anything other than
  disclosure to us.

## Telemetry & data the project receives

**Scani's OSS distribution collects no telemetry.** A self-hosted Scani
install does not send installation IDs, anonymous usage counts, error
breadcrumbs, version pings, or any other signal back to the project. We
do not operate a telemetry endpoint for the OSS distribution; there is
nothing to opt out of because there is nothing to opt out of.

Two narrow exceptions exist and are operator-controlled:

- **Sentry**, when `SENTRY_DSN` (or `VITE_SENTRY_DSN`) is set. The
  resulting reports go to **your** Sentry project, not ours — we have
  no access to them. With no DSN, the SDK is a complete no-op.
- **Outbound calls to whatever you configure `SCANI_CLOUD_URL` to point
  at.** By default that's `http://data-provider:8082` on the same
  Docker network as your install, so no traffic leaves your machine. If
  you point it at a hosted data-provider, that operator sees the
  requests — which is the whole reason to use Tier 2.

The OSS code includes no other outbound signal. We will not add one
silently. Any future change to this stance will:

1. Be opt-in, default-off.
2. Document the exact payload schema, transport, retention, and
   opt-out in this file before merge.
3. Land in its own pull request with a clear title (e.g.
   `feat: opt-in anonymous self-host telemetry`) so reviewers can read
   the entire change without context.

If you find an outbound call from a self-hosted Scani that doesn't
match this policy, **treat it as a security vulnerability and report
it via the disclosure flow at the top of this document.**
