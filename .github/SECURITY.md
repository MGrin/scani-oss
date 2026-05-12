# Security Policy

## Reporting a Vulnerability

If you believe you've found a security vulnerability in Scani, please
report it privately rather than opening a public issue.

- **Email:** security@scani.xyz
- **Encrypted:** PGP key fingerprint TBD — request a key in your first
  message and we'll send it via reply.
- **Out-of-scope GitHub issues are public**; do **not** open one for
  anything resembling a vulnerability.

We aim to acknowledge new reports within **two business days** and to
ship a fix or a clear remediation plan within **30 days** of triage,
faster for actively-exploited findings.

## Scope

In scope:

- `*.scani.xyz` production surface (api, app, admin, cloud, landing,
  data-provider).
- The code in this repository (`mgrin/scani`) — backend services,
  frontend apps, infrastructure-as-code, CI/CD workflows.
- Authentication / authorization flows (Better-Auth, passkey, HMAC).
- Multi-tenant data isolation between Scani users.

Out of scope:

- Denial-of-service findings that require >100 req/min from a single
  IP — those are rate-limited at the edge.
- Vendor infrastructure (Fly.io, Cloudflare, Neon, Upstash) — please
  report those to the vendor directly.
- Brute-force / credential-stuffing against accounts we don't own.
- Social engineering of Scani staff or customers.
- Findings against forks, third-party deployments, or self-hosted
  installations not run by the Scani team.

## Safe-harbour

We won't pursue legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data
  destruction, and service disruption.
- Only access the minimum data necessary to demonstrate the issue.
- Give us reasonable time to remediate before public disclosure.
- Don't exfiltrate user data, run automated scanners at high volume,
  or use findings for anything other than disclosure to us.

## Acknowledgements

Confirmed reporters are listed in `docs/SECURITY_ACK.md` at their
preference (or kept anonymous if requested). We don't currently run a
paid bug bounty, but we'll happily send a thank-you and merch when
budget allows.
