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
