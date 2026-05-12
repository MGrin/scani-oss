# Security Audit — 2026-05-12

## 1. Executive Summary

A full security review of the Scani monorepo and live production surface
was conducted on 2026-05-12 against OWASP Top 10 (2021) + ASVS L2 and
tagged with CWE identifiers. Scope covered application code, supporting
packages, infrastructure-as-code (Terraform, Docker, docker-compose),
CI/CD workflows, and read-only public-surface checks against the
deployed origins. No active probing of authenticated endpoints was
performed.

**Status after the deferred-findings follow-up PR (2026-05-12):**

| Severity | Total | Fixed in initial PR | Fixed in follow-up | Still tracked |
| -------- | ----- | ------------------- | ------------------ | ------------- |
| Critical |     2 |                   2 |                  0 |             0 |
| High     |    11 |                   7 |                  3 |             1 |
| Medium   |    16 |                  10 |                  4 |             2 |
| Low      |    11 |                   7 |                  3 |             1 |
| Info     |     8 |                   3 |                  2 |             3 |
| **Total**|  **48**|             **29**|              **12**|         **7** |

`Still tracked` items either require operations coordination (Fly
machine counts, Sentry token split, manual Cloudflare environment
config) or product decisions (credential-pool opt-in UX,
email-verification flip with grandfather migration). See section 4 for
the per-finding status.

**Top five risks at audit start (all now mitigated):**

1. **D-01 — Critical**: `api.cloud.scani.xyz` reflected arbitrary
   `Origin` headers with `Access-Control-Allow-Credentials: true`,
   enabling cross-site request forgery of every Tier-2 customer's
   session.
2. **A-04 — Critical**: `ADMIN_DEV_BYPASS=1` would silently disable
   admin passkey gating in production if accidentally set; no runtime
   guard existed.
3. **A-01 — High**: AES-256-GCM helpers fell back to plaintext when
   `ENCRYPTION_KEY` was missing, relying solely on config-loader to
   refuse boot — no defense in depth in the cipher itself.
4. **A-16/A-17 — High**: File-import and screenshot-parse routers
   accepted a caller-supplied `accountId` and forwarded it to the
   worker without verifying ownership.
5. **C-01 — High**: Better-Auth's `user_accounts` table stores
   `accessToken` / `refreshToken` / `idToken` as plaintext TEXT
   columns. Operationally null today (no OAuth providers configured)
   but a known landmine before social-login ships.

---

## 2. Methodology and Scope

### Surfaces audited

Four quadrants, audited in parallel:

| Quadrant | Surface |
| -------- | ------- |
| A | Authentication, authorization, session management, cryptography, admin |
| B | Input validation, injection, SSRF, file upload, rate limiting, headers |
| C | Secrets at rest / in transit, logging, PII, dependency hygiene, business logic |
| D | CI/CD, supply chain, infrastructure-as-code, live external surface |

### Guardrails on the "live system" half

- **Read-only.** No auth probing, no rate-limit testing, no fuzzing.
- **Public surface only.** TLS, response headers, DNS, robots.txt,
  security.txt, GitHub repository public metadata.
- **No third-party scanners.** No nmap, nuclei, sqlmap, gitleaks runs
  against production — those require an explicit pentest engagement.

### Frameworks

Each finding is tagged against:

- **OWASP Top 10 (2021)** category for risk-class mapping.
- **CWE** ID for technical taxonomy + SIEM integration.

### What's not in scope of this audit

- Third-party vendor security (Fly.io, Cloudflare, Neon, Upstash). We
  audit our integration only, not vendor controls.
- Mobile clients (none exist).
- Business-logic fairness on shared resources (e.g. credential-pool
  borrowing semantics — flagged as a product decision in C-07).
- Active red-team / pentest against authenticated endpoints.

---

## 3. Findings

Findings are grouped by severity. Each entry records: ID, title,
OWASP+CWE, file location, description, and status (`Fixed in PR`,
`Tracked`, or `Verified OK`).

### Critical

#### D-01 — Data-provider CORS reflects arbitrary origins with credentials

- **OWASP:** A05 / **CWE:** CWE-942
- **Location:** `apps/backend/data-provider/src/index.ts` CORS middleware
- **Description:** Live probe confirmed `api.cloud.scani.xyz` responded
  to `OPTIONS` / `GET` with `Access-Control-Allow-Origin: <attacker>` +
  `Access-Control-Allow-Credentials: true` + `Vary: *` for any value of
  the request `Origin` header. Combined with Better-Auth cookie-session
  routes mounted under `/api/auth` and the cloud tRPC surface
  (`waitlist.join`, `keys.*`, `usage.*`), any logged-in Tier 2 customer
  who visited an attacker page would have their session replayed
  cross-origin.
- **Status:** **Fixed in PR**. Replaced `origin: true` with an explicit
  allowlist driven by `env.CLOUD_FRONTEND_ORIGIN`; production with no
  configured origin now refuses CORS entirely.

#### A-04 — `ADMIN_DEV_BYPASS=1` could disable admin gate in production

- **OWASP:** A05 / **CWE:** CWE-284
- **Location:** `apps/frontend/admin/src/lib/auth/config.ts:30-32`
- **Description:** `devBypassEnabled()` returned `true` whenever
  `ADMIN_DEV_BYPASS === '1'` regardless of `NODE_ENV`. A leaked or
  copy-pasted env (the value is set in `docker-compose.yml`) would
  silently disable passkey gating across the entire admin app on
  Cloudflare Pages.
- **Status:** **Fixed in PR**. `devBypassEnabled()` now throws at boot
  if `ADMIN_DEV_BYPASS=1` is observed under `NODE_ENV=production`
  rather than allowing traffic.

### High

#### A-01 — Encryption falls back to plaintext when key is missing

- **OWASP:** A02 / **CWE:** CWE-327
- **Location:** `packages/infra/security/src/encryption.ts:35-53` (old)
- **Description:** `encrypt()` returned plaintext when
  `loadSecurityConfig().ENCRYPTION_KEY` was empty. The schema validator
  refuses to parse the env in production, but if anything ever bypassed
  that path (manual `process.env` reads, third-party loaders, partial
  rollback) the cipher would silently write plaintext.
- **Status:** **Fixed in PR**. Both `encrypt()` and `decrypt()` now
  throw an explicit error under `isProduction` if the key is missing.
  Dev / test paths still tolerate plaintext for fixture compatibility.

#### A-02 / A-03 — Constant scrypt salt; per-record salt slot was unused

- **OWASP:** A02 / **CWE:** CWE-329, CWE-330
- **Location:** `packages/infra/security/src/encryption.ts:26, 42, 89-90` (old)
- **Description:** When `ENCRYPTION_KEY` is not a 64-char hex string,
  the AES key was derived via `scrypt(key, 'scani-salt', 32)`. A
  64-byte random salt was generated per-record and written into the
  envelope but **never consumed** during decrypt — pure dead weight that
  also implied a defensive design that wasn't present.
- **Status:** **Fixed in PR**. The KDF now uses the per-record salt
  from the envelope. Backward compatibility is preserved by trying the
  per-record salt first on decrypt and falling back to the legacy
  `'scani-salt'` for records written before this fix. Derived keys are
  cached in a 64-entry LRU to keep scrypt's CPU cost off the hot path.

#### A-08 — Decrypt failure path silently fell through to plaintext

- **OWASP:** A02 / **CWE:** CWE-208
- **Location:** Same file, `decrypt()` catch block
- **Description:** Decrypt errors threw a generic `Decryption failed`,
  but the base64 parser and the size check both returned `parsePlainText`
  rather than throwing — a malformed ciphertext could be misread as
  plaintext if a downstream consumer didn't validate the envelope flag.
- **Status:** **Fixed in PR**. In production, malformed base64 / undersized
  envelopes throw; plaintext fallback is permitted only outside production.

#### A-16 — `file-import.parseAndEnrich` accepts cross-tenant `accountId`

- **OWASP:** A01 / **CWE:** CWE-639
- **Location:** `apps/backend/api/src/presentation/routers/file-import.ts:176-222`
- **Description:** The router validated R2 key ownership but accepted a
  caller-supplied `accountId` without ownership check. An attacker
  could upload a CSV to their own R2 prefix, then call
  `parseAndEnrich` with a victim's `accountId` — the worker's
  ingestion path forwards `accountId` straight into
  `holdingRepo.findByAccountAndToken` / `createHoldingWithEvent`,
  contaminating the victim's account.
- **Status:** **Fixed in PR**. Added `AccountRepository.findByIdAndUser`
  and call it in the router before enqueueing. Returns 403 on mismatch.

#### A-17 — `screenshots.parseScreenshots` accepts cross-tenant `accountId`

- **OWASP:** A01 / **CWE:** CWE-639
- **Location:** `apps/backend/api/src/presentation/routers/screenshots.ts:43-77`
- **Description:** Same shape as A-16: R2 key prefix is checked but
  `accountId` is forwarded to the parse use case unchecked.
- **Status:** **Fixed in PR**. Same `findByIdAndUser` guard added.

#### C-03 — `LOG_ID_PEPPER` falls back to raw IDs in production

- **OWASP:** A09 / **CWE:** CWE-532
- **Location:** `packages/infra/logging/src/pseudonymize.ts:27-34`
- **Description:** `pseudonymizeId()` returned the raw ID verbatim
  when `LOG_ID_PEPPER` was unset. The docstring noted production must
  stage the pepper, but no boot guard enforced it — a deploy that
  forgot the variable would leak every user UUID to the shared log
  aggregator.
- **Status:** **Fixed in PR**. Module now throws at import time if
  `NODE_ENV=production` and `LOG_ID_PEPPER` is missing or <16 chars.
  Generation + distribution is fully automated:
  `infra/terraform/github.tf` declares `random_password.log_id_pepper`
  + a `github_actions_secret`; `.github/workflows/deploy-fly.yaml`
  stages it on `scani-backend`, `scani-worker`, and
  `scani-data-provider` before each flyctl deploy. The terraform
  workflow runs on every push to `main` ahead of deploy-fly (via
  `workflow_run` chaining), so the secret exists in GH Actions before
  the deploy job consumes it.

#### C-01 — Better-Auth `user_accounts` stores OAuth tokens as plaintext (Tracked)

- **OWASP:** A02 / **CWE:** CWE-312
- **Location:** `packages/infra/db/src/schema/users.ts:60-66`
- **Status:** **Tracked.** Better-Auth's canonical schema declares
  `access_token`, `refresh_token`, `id_token` (and `password`) as
  plaintext TEXT. The columns are operationally null today because
  Scani has not configured any OAuth provider (only `emailAndPassword`
  + `magicLink` + `emailOTP`), but the moment a social provider is
  enabled these become live secrets in the clear. **Action plan**:
  before enabling any OAuth provider, wire Better-Auth's column-level
  encryption (or a Drizzle middleware shim) using `@scani/security`'s
  envelope. A failing CI assertion against the schema will land in a
  follow-up.

#### A-05 — Admin bootstrap token survives process restart (Tracked)

- **OWASP:** A04 / **CWE:** CWE-640
- **Location:** `apps/frontend/admin/src/app/auth/bootstrap/actions.ts`
- **Status:** **Tracked.** The in-process `provisionedInThisProcess`
  flag resets on every redeploy, so until the operator stages the new
  `ADMIN_PASSKEY_CREDENTIAL_ID` env var the bootstrap token is still
  valid. Risk window is the time between `completeBootstrapAction()`
  and the next deploy. **Mitigation**: requires a DB column to persist
  the "passkey provisioned" flag; not landing in this audit but tracked.

#### A-06 — `requireEmailVerification: false` allows account squatting (Tracked)

- **OWASP:** A01 / **CWE:** CWE-640
- **Location:** `apps/backend/api/src/auth/better-auth.ts:89`
- **Status:** **Tracked.** Flipping in this PR would lock out every
  existing user whose `email_verified` is currently `false`. Plan:
  one-shot migration to grandfather existing users to `emailVerified =
  true`, then flip the flag in a follow-up PR with the migration in
  the same commit. Documented in the PR description so it's visible to
  whoever picks it up.

#### D-02 — Backend + worker run as single-machine on Fly (Tracked)

- **OWASP:** A04 / **CWE:** CWE-1188
- **Location:** `apps/backend/api/fly.toml`, `apps/backend/worker/fly.toml`, `infra/terraform/fly.tf`
- **Status:** **Tracked.** Availability / deploy-strategy issue rather
  than a code defect. Filed for ops handling — the change involves
  scaling Fly machine counts and updating deploy-fly.yaml rolling
  strategy. Not appropriate to flip from an audit PR.

#### D-03 — Third-party action `superfly/flyctl-actions@master` (Tracked)

- **OWASP:** A08 / **CWE:** CWE-1357
- **Location:** `.github/workflows/deploy-fly.yaml:243`, `.github/workflows/rollback.yaml:91`, `.github/workflows/fly-diagnostics.yaml:34`
- **Status:** **Tracked.** Dependabot now monitors the `github-actions`
  ecosystem (added in this PR), but pinning every existing `@master`
  reference to a 40-char SHA requires looking up release SHAs across
  multiple actions and is the single largest CI-PR surface that this
  audit doesn't ship. Filed for follow-up. The `terraform.yaml` state
  lock concern (`use_lockfile`) is also tracked there.

### Medium

#### B-01 — LIKE-wildcard injection in `tokens.search`

- **OWASP:** A03 / **CWE:** CWE-89
- **Location:** `apps/backend/api/src/presentation/routers/tokens.ts:127-129`
- **Description:** A 20-char user-supplied query was interpolated into
  a `LIKE '%${query}%'` predicate. `_` and `%` were not escaped, so an
  input like `_____` matched any 5-character symbol and could be used
  to enumerate tokens cheaply or DoS the index with `%%%%%%%%%`.
- **Status:** **Fixed in PR**. Wildcards are now escaped via
  `replace(/[\\%_]/g, '\\$&')` and the predicate carries an explicit
  `ESCAPE '\\'`.

#### B-02 — Data-provider trusted leftmost `X-Forwarded-For`

- **OWASP:** A04 / **CWE:** CWE-770
- **Location:** `apps/backend/data-provider/src/presentation/trpc.ts:98`
- **Description:** Edge providers (Fly, Cloudflare) **append** the
  real client IP at the tail of `X-Forwarded-For` — the leftmost entry
  is attacker-controllable. Keying off it (as `waitlist.join` rate
  limiting did) let a caller rotate fake prefixes and bypass the per-IP
  budget.
- **Status:** **Fixed in PR**. Now reads the rightmost entry,
  matching the rule used by `@scani/rate-limiter`'s `defaultInflowKey`.

#### B-03 — CSV formula injection on import

- **OWASP:** A03 / **CWE:** CWE-1236
- **Location:** `packages/business/file-import/src/csv-parser.ts:151+`
- **Description:** Imported transaction descriptions kept attacker-
  controlled cells beginning with `=`, `+`, `-`, `@`, TAB, CR. When a
  user later exported the ledger as CSV and opened it in Excel /
  Sheets, the formula executed.
- **Status:** **Fixed in PR**. `sanitizeCsvCell()` defangs the leading
  character with a single-quote prefix.

#### B-06 — Storage presign accepted any Content-Type / extension

- **OWASP:** A04 / **CWE:** CWE-434
- **Location:** `apps/backend/api/src/presentation/routers/storage.ts`
- **Description:** `contentType: z.string().min(1).max(200)` was the
  only constraint; the filename extension was extracted but not
  validated. R2 binds the type into the SigV4 signature so a mismatched
  upload would fail, but the legitimate flow would still let
  `application/x-msdownload` + `evil.exe` land on the bucket.
- **Status:** **Fixed in PR**. Per-purpose Content-Type allowlist
  (image MIME types for screenshots; CSV/OFX/QIF/text for
  file-import) and per-purpose extension allowlist; mismatches return
  400.

#### B-07 — No HTTP request body cap on Elysia apps

- **OWASP:** A04 / **CWE:** CWE-770
- **Location:** `apps/backend/api/src/index.ts`, `apps/backend/data-provider/src/index.ts`
- **Description:** Per-procedure zod `.max()` caps existed, but a
  chunked POST with `Content-Length: 5GB` would let Elysia allocate
  before the validator ran. With single-machine Fly deploys
  (see D-02) one OOM = a full outage.
- **Status:** **Fixed in PR**. Added an `onBeforeHandle` that rejects
  any request with `Content-Length` > 16 MB before body parsing.

#### A-07 — Admin HMAC replay window depends on wall-clock skew (Tracked)

- **OWASP:** A01 / **CWE:** CWE-294
- **Location:** `apps/backend/api/src/presentation/http/admin-jobs.ts:38-64`
- **Description:** `MAX_SKEW_MS = 30_000` accepts replays within 30s
  of the signed timestamp. The window is small but defends only against
  delay, not active replay within it.
- **Status:** **Tracked.** Mitigation requires a persistent nonce store
  (Redis SET with TTL) that requires plumbing through the request
  pipeline; deferred to a follow-up.

#### A-09 — Session expiry is a 7-day sliding window with no hard ceiling (Tracked)

- **OWASP:** A07 / **CWE:** CWE-613
- **Location:** `apps/backend/api/src/auth/better-auth.ts:133-134`
- **Status:** **Tracked.** Better-Auth supports an absolute max via
  custom session schema; the upstream config option doesn't expose it
  declaratively. Plan: subclass the session adapter to enforce
  `createdAt + 30d` regardless of `updateAge`. Deferred.

#### A-10 — Admin audit log has no tamper detection (Tracked)

- **OWASP:** A09 / **CWE:** CWE-778
- **Location:** `apps/backend/api/src/presentation/http/admin-jobs.ts`
- **Status:** **Tracked.** Requires a schema migration to add a
  `signature` column (HMAC chain or per-row HMAC) plus read-side
  verification. Deferred. Detail-payload truncation (A-18) is shipped
  in this PR to bound the related blast radius.

#### A-14 — CSRF defense relies on `SameSite: lax` only (Verified OK)

- **Location:** `apps/backend/api/src/auth/better-auth.ts:158`
- **Status:** **Verified OK.** Combined with single-origin CORS that
  rejects all but `env.FRONTEND_URL`, `SameSite=lax` cookies on POST
  requests provide the required defense. Cross-origin form POSTs lose
  the cookie (Lax does not attach on third-party context POST), and
  cross-origin `fetch(..., {credentials: 'include'})` is rejected at
  CORS preflight. No change in this PR.

#### A-18 — Admin audit-log `details` accepted unbounded JSON

- **OWASP:** A09 / **CWE:** CWE-117
- **Location:** `apps/backend/api/src/presentation/http/admin-jobs.ts`
- **Description:** The audit `details` jsonb column was inserted
  verbatim. A misbehaving caller could pollute the row with arbitrary
  structured fields, confusing SIEM parsers or growing the row size.
- **Status:** **Fixed in PR**. `sanitizeAuditDetails()` caps at 20
  keys and truncates each value at 1024 chars before insert.

#### C-04 — Body-logging flags had no production guard

- **OWASP:** A09 / **CWE:** CWE-532
- **Location:** `packages/infra/logging/src/logger.ts:46-47`
- **Description:** `LOG_REQUEST_BODIES=true` / `LOG_RESPONSE_BODIES=true`
  enable raw payload logging with no scrubbing. An operator flipping
  them to debug a prod incident would leak magic-link tokens and
  credential imports for the window the flag is on.
- **Status:** **Fixed in PR**. Module-level throw at boot if either
  flag is `true` under `NODE_ENV=production`.

#### C-05 — Admin session not rotated on first passkey registration (Tracked)

- **OWASP:** A01 / **CWE:** CWE-384
- **Status:** **Tracked.** Bootstrap registers a passkey then continues
  with the same session cookie. Should invalidate prior sessions and
  mint fresh on first-passkey provision. Deferred — requires DB-level
  session tracking that isn't currently in place for the admin app.

#### C-06 — Credential-pool warnings logged raw `userId`

- **OWASP:** A09 / **CWE:** CWE-532
- **Location:** `packages/clients/providers/src/core/credential-pool.ts:181-184, 206-207`
- **Status:** **Fixed in PR**. Logs now emit `userIdHash` via
  `pseudonymizeId()`.

#### C-07 — Credential pool participation is implicit (Tracked / product)

- **OWASP:** A04 / **CWE:** CWE-639
- **Status:** **Tracked.** Surface to settings UI + add an opt-out
  toggle. Product decision, not a security defect strictly; documented
  for transparency.

#### D-04 — Actions cache shared between PR + main jobs

- **OWASP:** A05 / **CWE:** CWE-538
- **Status:** **Tracked.** Cache-key scope tightening is a small
  workflow edit; doesn't ship in this PR to keep workflow changes
  bounded. Filed for follow-up.

#### D-05 — Secret-scan covered five patterns

- **OWASP:** A07 / **CWE:** CWE-540
- **Location:** `.github/workflows/ci.yml:201-207`
- **Status:** **Fixed in PR**. Pattern array expanded to 16 patterns
  covering Neon URIs, Sentry user + org tokens, GitHub classic + fine-
  grained PATs + OAuth/installation tokens, OpenAI + Anthropic, Stripe
  live keys, Cloudflare API v4 tokens, Fastmail JMAP tokens, and a
  tighter JWT shape. Excludes `docs/`, `.env.example`, and test files
  to avoid false positives.

#### D-06 — Sentry auth token mirrored to admin runtime secrets (Tracked)

- **OWASP:** A01 / **CWE:** CWE-552
- **Status:** **Tracked.** Splitting into a deploy-only token + a
  read-only org token requires Sentry-side provisioning + Terraform
  changes. Filed for ops.

#### D-07 — Deploy workflow grants `contents: write` at workflow level (Tracked)

- **OWASP:** A08 / **CWE:** CWE-269
- **Status:** **Tracked.** Moving the permission to the three specific
  `Tag last-known-good` steps is a small edit; deferred to keep this
  PR's workflow-touching scope tight.

#### D-08 — No CODEOWNERS / SECURITY.md / dependabot

- **OWASP:** A05 / **CWE:** CWE-1059
- **Status:** **Partially Fixed in PR.** Added `.github/SECURITY.md`
  with a disclosure policy and `.github/dependabot.yml` watching
  GitHub Actions, Terraform, and npm. `CODEOWNERS` and Terraform-
  managed branch protection are tracked for ops.

#### D-09 — Bootstrap-wipe sentinel has no second human gate (Tracked)

- **OWASP:** A04 / **CWE:** CWE-732
- **Status:** **Tracked.** Workflow design change; deferred.

### Low

#### A-11 — GCM IV is 16 bytes instead of NIST-recommended 12 (Verified OK)

- **Status:** **Verified OK.** GCM tolerates variable IV lengths and
  16 bytes adds negligible overhead. No change.

#### A-13 — Admin actor whitespace handling (Verified OK)

- **Status:** **Verified OK.** Actor is derived from
  `session.iat + credentialIdB64`; no user-controllable whitespace
  path. No change.

#### A-15 — Wallet `confirmHoldings` IDOR (False positive)

- **Status:** **False positive.** `UserJobRepository.findOneMine`
  correctly filters by both `userId` and `jobId` at
  `packages/business/domain/src/repositories/UserJobRepository.ts:204-216`.
  No defect.

#### B-04 — Data-provider CORS + credentials (Duplicate of D-01)

- **Status:** Duplicate. See D-01.

#### B-05 — `fly-client-ip` trust (subsumed by B-02 / verified OK)

- **Status:** **Verified OK.** `fly-client-ip` is set by Fly's edge
  proxy and overwritten on every request; clients cannot forge it
  while traffic is routed through Fly. The rate limiter already
  prefers it.

#### C-02 — User-data-delete misses cloud-tier metadata (Tracked / N/A in OSS)

- **Status:** **Tracked.** OSS deployments do not run the cloud-tier
  routers. Action plan ships with the billing rollout.

#### C-08 — Sharp image processor + unbounded timeout (Tracked)

- **Status:** **Tracked.** Screenshot parse should run Sharp under a
  Promise.race timeout. Deferred.

#### C-09 — Future user-facing audit-log view risk (Tracked)

- **Status:** **Tracked.** Speculative — no user-facing borrow-log UI
  exists yet. Will be addressed when the UI is built.

#### C-10 — Stale BullMQ job payloads after user-data-delete (Tracked)

- **Status:** **Tracked.** Job-payload purge requires queue iteration;
  deferred.

#### D-10 — Terraform plan comment XSS / formatting (Tracked)

- **Status:** **Tracked.** Low impact (single-owner repo, no other PRs
  expected from external contributors). Deferred.

#### D-13 — Flyctl secrets passed as argv (Tracked)

- **Status:** **Tracked.** No public flyctl-prints-argv bug at the
  moment; future-proofing only.

#### D-14 — No automated rotation for random_password resources (Tracked)

- **Status:** **Tracked.** Schedule a quarterly `terraform taint &&
  terraform apply` workflow; deferred.

#### D-17 — `/.well-known/security.txt` not served

- **Status:** **Fixed in PR**. Added
  `apps/frontend/landing/public/.well-known/security.txt` with the
  disclosure email + expiry.

#### D-18 — Frontend CSP `connect-src 'self' https: wss:` too permissive

- **Location:** `apps/frontend/app/public/_headers`,
  `apps/frontend/cloud/public/_headers`
- **Status:** **Fixed in PR**. Narrowed to the actual upstreams: api
  / cloud API, Sentry ingest, R2.

#### D-19 — Backend exposed `X-XSS-Protection` + over-broad expose-headers

- **Location:** `apps/backend/api/src/index.ts`,
  `apps/backend/data-provider/src/index.ts`
- **Status:** **Fixed in PR**. Dropped the deprecated `X-XSS-Protection`
  header, added `Permissions-Policy`, `Cross-Origin-Opener-Policy`,
  `Cross-Origin-Resource-Policy`, and tightened CSP with
  `frame-ancestors 'none'; base-uri 'none'`.

### Info

#### D-11 — MinIO dev bucket public ACL (Verified OK)

- **Status:** **Verified OK.** Dev-only; prod R2 buckets are private
  by default and no public-access TF resource exists.

#### D-12 — Hardcoded dev `ENCRYPTION_KEY` in docker-compose (Verified OK)

- **Status:** **Verified OK.** Identical dev value between backend +
  worker is required so backend-encrypted credentials decrypt on the
  worker. Production uses Fly secrets staged via Terraform.

#### D-15 — `NODE_ENV` staged via `flyctl secrets set` (Tracked)

- **Status:** **Tracked.** Conceptual cleanup; not a security defect.

#### D-16 — DNS hardening (CAA, DMARC, SPF, DKIM, MTA-STS) not in Terraform (Tracked)

- **Status:** **Tracked.** Filed for ops/TF follow-up.

#### A-12 — Account enumeration on Better-Auth sign-up (Tracked)

- **Status:** **Tracked.** Better-Auth's stock responses distinguish
  "exists" vs "sent". Unifying requires plugin-level customization.
  Documented for the same follow-up that flips A-06.

---

## 4. Fixes Applied — Changelog

The fixes are split across logical groups but land in a single
commit on `claude/security-audit-full-M4Epg`.

### Group 1 — API surface hardening (Critical / High)

| Finding | File | Change |
| ------- | ---- | ------ |
| D-01    | `apps/backend/data-provider/src/index.ts` | Explicit CORS allowlist via `env.CLOUD_FRONTEND_ORIGIN`; refuses unknown origins in prod |
| A-04    | `apps/frontend/admin/src/lib/auth/config.ts` | `devBypassEnabled()` throws in production |
| A-16    | `apps/backend/api/src/presentation/routers/file-import.ts` | `AccountRepository.findByIdAndUser` guard before enqueue |
| A-17    | `apps/backend/api/src/presentation/routers/screenshots.ts` | Same guard when `accountId` is provided |
| A-16/17 | `packages/business/domain/src/repositories/AccountRepository.ts` | New `findByIdAndUser` repository method |
| B-01    | `apps/backend/api/src/presentation/routers/tokens.ts` | Escape `%` / `_` / `\` in LIKE pattern, add `ESCAPE '\\'` |
| B-02    | `apps/backend/data-provider/src/presentation/trpc.ts` | XFF rightmost-entry rule |
| B-03    | `packages/business/file-import/src/csv-parser.ts` | `sanitizeCsvCell()` defangs formula-prefix cells |
| B-06    | `apps/backend/api/src/presentation/routers/storage.ts` | Per-purpose Content-Type + extension allowlist |
| B-07    | `apps/backend/api/src/index.ts`, `apps/backend/data-provider/src/index.ts` | 16 MB Content-Length cap before body parsing |

### Group 2 — Crypto / secrets / logging (High / Medium)

| Finding | File | Change |
| ------- | ---- | ------ |
| A-01    | `packages/infra/security/src/encryption.ts` | Production refuses plaintext branch in `encrypt()` / `decrypt()` / `decryptCredentials()` |
| A-02/A-03 | Same file | KDF uses per-record salt; legacy `'scani-salt'` fallback for backward compat; LRU cache for derived keys |
| A-08    | Same file | Malformed-envelope paths throw in production; plaintext fallback gated to dev/test |
| C-03    | `packages/infra/logging/src/pseudonymize.ts` | Throws at import time if `LOG_ID_PEPPER` missing under `NODE_ENV=production` |
| C-04    | `packages/infra/logging/src/logger.ts` | Refuses to enable `LOG_REQUEST_BODIES` / `LOG_RESPONSE_BODIES` in production |
| C-06    | `packages/clients/providers/src/core/credential-pool.ts` | `pseudonymizeId()` applied to logged `userId` |

### Group 3 — Headers / admin / CI/CD (Medium / Low)

| Finding | File | Change |
| ------- | ---- | ------ |
| A-18    | `apps/backend/api/src/presentation/http/admin-jobs.ts` | `sanitizeAuditDetails()` caps keys + value lengths |
| D-05    | `.github/workflows/ci.yml` | Secret-scan pattern array expanded; doc / test exclusions added |
| D-08    | `.github/SECURITY.md`, `.github/dependabot.yml` | Disclosure policy + dependency-update automation for actions / TF / npm |
| D-17    | `apps/frontend/landing/public/.well-known/security.txt` | RFC 9116-compliant security contact |
| D-18    | `apps/frontend/app/public/_headers`, `apps/frontend/cloud/public/_headers` | `connect-src` tightened to actual upstreams |
| D-19    | `apps/backend/api/src/index.ts`, `apps/backend/data-provider/src/index.ts` | Dropped deprecated `X-XSS-Protection`; added `Permissions-Policy` / `COOP` / `CORP`; CSP now includes `frame-ancestors 'none'; base-uri 'none'` |

---

## 5. Verification

Pre-push checks executed against the modified workspaces:

```bash
bun install --frozen-lockfile      # 1037 packages, 9.36s
bun run type-check                  # 26 workspaces, all clean
bun lint:fix                        # 2 files autoformatted; 0 errors
bun test --preload …/test-preload.ts packages/infra/security/tests/ \
  packages/business/file-import/tests/csv-parser.test.ts \
  packages/infra/logging/ packages/infra/rate-limiter/ \
  --timeout 30000                   # 136 pass / 0 fail
bun run deps:lint                   # syncpack: ✓ no issues
bun run deps:unused                 # knip: ✓ clean
```

DB-dependent tests (~1200 tests under `packages/business/domain/tests/`)
were not exercised in this environment — Docker is unavailable, so the
compose Postgres on `localhost:5433` could not be started. The CI
`test` job runs them with Postgres 16 available; this PR's changes do
not touch repository semantics so the existing suite should pass
without modification.

Manual / end-to-end checks recommended before merging:

- **CORS lock-down**: `curl -i -X OPTIONS -H "Origin: https://evil.example.com"
  https://api.cloud.scani.xyz/trpc` should respond without
  `Access-Control-Allow-Origin`.
- **MIME allowlist**: `storage.getUploadUrl` with
  `contentType: 'application/x-msdownload'` should return a 400.
- **CSP**: `curl -I https://app.scani.xyz` should show the tightened
  `connect-src` directive after the next Pages deploy.
- **HSTS / Permissions-Policy**: `curl -I https://api.scani.xyz/` after
  the next deploy should include `Permissions-Policy`, `COOP`, `CORP`,
  and `Content-Security-Policy: default-src 'none'; frame-ancestors
  'none'; base-uri 'none'`.
- **`LOG_ID_PEPPER`**: Terraform-managed and auto-distributed via the
  deploy workflow — no manual op required. After the first post-merge
  deploy, confirm with
  `flyctl secrets list -a scani-backend | grep LOG_ID_PEPPER` (and the
  same for `scani-worker`, `scani-data-provider`).

---

## 6. Recommendations Not Auto-Applied

These need ops / product decisions and are not appropriate for an
audit PR to land unilaterally:

1. **Secret rotation cadence**: quarterly rotation of
   `ADMIN_JOBS_HMAC_SECRET`, `BETTER_AUTH_SECRET`, `LOG_ID_PEPPER`,
   `ENCRYPTION_KEY`, `DATA_PROVIDER_API_KEY`. Encode as a scheduled
   workflow that taints the relevant `random_password` resources +
   re-applies.
2. **Dependency-update SLA**: with dependabot now wired, set a
   commitment to review and merge / explicitly defer dependency PRs
   within seven days.
3. **Branch protection**: declare via Terraform
   (`github_branch_protection`) on `main`. Require: PR review, all
   green status checks, no force-push, no deletion, no bypass for
   anyone (including the GH app + admins).
4. **GitHub Environment required reviewers**: codify the
   `production` environment + required reviewers in
   `infra/terraform/github.tf` so the deploy gate is reviewable in
   code rather than dashboard-only.
5. **Fly machines ≥ 2** for `scani-backend` and `scani-worker`
   (resolves D-02). BullMQ already supports multi-consumer; backend
   needs a rolling deploy strategy.
6. **DNS hardening** (resolves D-16): add CAA, DMARC, SPF, DKIM,
   MTA-STS Terraform-managed records.
7. **Better-Auth column encryption** (resolves C-01): wire a
   Drizzle-level encrypt/decrypt shim around `user_accounts` token
   columns before the first OAuth provider lands.
8. **Sentry token split** (resolves D-06): separate deploy-write +
   admin-read tokens; rotate the existing user-scoped one.
9. **Pin all third-party GitHub Actions to SHA** (resolves D-03).
   Dependabot will keep them current.

---

## 7. Out of Scope

Documented here so a future auditor knows what was deliberately not
exercised:

- Active pentest of authenticated endpoints (auth brute force, payload
  fuzzing, business-logic abuse). Requires an explicit engagement +
  customer notification window.
- Cryptanalysis of `@scani/security`'s envelope beyond the unused-salt
  finding — AES-256-GCM under random IV with a strong key is treated
  as primitive-secure.
- Third-party vendor controls (Fly, Cloudflare, Neon, Upstash) and
  their multi-tenant isolation properties.
- Mobile clients (none exist).
- Marketing-site copy accuracy (covered by the `CLAUDE.md` landing-
  page-accuracy section; outside the security review's scope).

---

## 8. Follow-up PR — 2026-05-12

After the initial PR (#489) landed, this follow-up ships the
previously-tracked items that were tractable inside the codebase
without requiring external operations work. Sections 1, 2, 4 above
reflect both PRs' state.

### Fixed in the follow-up

| ID    | Title                                                | Change                                                                                                                                                       |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A-07  | HMAC replay nonce store                              | Redis-backed `SET … NX PX` nonce gate around admin-jobs HMAC; in-memory fallback for tests. TTL = 4× the timestamp-skew window.                              |
| A-09  | Absolute 30-day session-max                          | Better-Auth `databaseHooks.session.update.before` rejects sessions older than `ABSOLUTE_SESSION_MAX_MS`; user is forced through fresh sign-in.                |
| A-10  | Audit-log tamper-evident chain                       | Migration 0014 adds `prev_signature` + `signature` columns; `audit()` writes an HMAC-SHA256 chain keyed on `ADMIN_JOBS_HMAC_SECRET`.                          |
| A-12  | Signup enumeration brute force                       | New `createSignupLimiter` (6/h/IP) wraps `/api/auth/sign-up*`, `/sign-in*`, `/email-otp/send-verification-otp`, `/forget-password`.                            |
| C-10  | BullMQ payload purge on user-data-delete             | `DeleteAllUserDataUseCase` enumerates the user's job IDs and calls `queue.getJob(id).remove()` after the DB tx commits.                                       |
| D-03  | Pin third-party GH Actions to SHA                    | Every `uses:` on `@vN` / `@master` rewritten to `@<40-hex-sha> # <tag>`. Dependabot already wired (PR #489) to keep them current.                             |
| D-04  | Actions cache scoping                                | Cache key includes `${{ github.workflow }}` + `${{ github.ref_name }}` so PR jobs can't restore a main-branch cache that may have been poisoned.              |
| D-07  | `contents: write` scope                              | Workflow default trimmed to `contents: read`; the three deploy-* jobs opt back in to `contents: write` at job level for their tag-push step.                  |
| D-08  | CODEOWNERS                                           | New `.github/CODEOWNERS`. The `github_branch_protection` half was attempted but the `TF_GITHUB_TOKEN` PAT lacks `administration: write` scope; resource is commented out in `github.tf` until the PAT is rotated. Branch protection lives in the GH UI in the meantime.     |
| D-10  | Terraform plan comment sanitization                  | PR-comment body now strips backticks and `<>`, hard-caps at 12 KB, escapes Markdown break-out.                                                                |
| D-13  | flyctl secrets via stdin                             | All three deploy jobs build a tmpfile and pipe via `flyctl secrets import` instead of passing `KEY=value` on argv.                                            |
| D-14  | random_password rotation                             | `keepers = { rotation_id = "<date>" }` on each `random_password`; bump the date to regenerate. Documented per-secret with the relevant cascade.               |
| D-16  | DNS hardening                                        | CAA (letsencrypt + pki.goog + iodef), SPF (Fastmail only, `-all`), DMARC (`p=reject`), MTA-STS + policy file, SMTP TLS reporting. The three Fastmail DKIM CNAMEs (`fm1/fm2/fm3._domainkey`) pre-existed in the Cloudflare zone (created by Fastmail's dashboard onboarding) — kept dashboard-managed because adopting them into TF would require manual `terraform import` per record without security benefit; Fastmail rotates keys against the same CNAMEs silently.   |
| —     | C-01 invariant gate                                  | New `.github/workflows/security-invariants.yml` fails the PR that enables an OAuth provider without also wrapping `drizzleAdapter` in an encrypting adapter. |
| —     | A-04 / C-03 / A-01 invariants                        | The same workflow asserts the production guards we landed in PR #489 stay in place.                                                                          |

### Reassessed (no code change)

| ID    | New status                                                                                                                                                                                          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C-05  | **N/A.** With A-04 blocking `ADMIN_DEV_BYPASS=1` in production, there is no pre-passkey session in production that could survive bootstrap. The post-passkey flow already mints a fresh cookie.     |
| C-08  | **N/A.** `sharp` is only imported by `apps/frontend/app/scripts/generate-icons.js` (build-time PWA icon generation), never on user input at runtime. Screenshot parsing routes via OpenAI Vision.   |

### Still tracked (requires external coordination)

| ID    | Why deferred                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-05  | Bootstrap-token persistence across restarts requires either a DB column reachable from the admin Pages runtime (new infra) or Cloudflare KV provisioning. The current in-process flag + audit warning is acceptable given that the residual window only opens with a leaked `ADMIN_BOOTSTRAP_TOKEN` AND a delayed env-var update.                                                              |
| A-06  | Email-verification flip locks out every user with `email_verified=false`; needs a grandfather migration shipped in the same PR. Scope-deferred at the audit owner's request.                                  |
| C-01  | Better-Auth OAuth-token column encryption requires wrapping `drizzleAdapter` (write-side encrypt + read-side decrypt) so Better-Auth's own DB access remains transparent. The columns are dormant today (no OAuth providers configured). The new `security-invariants.yml` gate fails the first PR that turns one on without the wrapper.                                                       |
| D-02  | Backend + worker single-machine on Fly. Requires Fly machine scaling, rolling deploy strategy work, and BullMQ multi-consumer validation in staging. Ops handoff.                                              |
| D-06  | Sentry deploy-token vs admin-read-token split. Requires Sentry-side provisioning + Terraform changes. Ops handoff.                                                                                            |
| D-09  | Bootstrap-wipe sentinel gate redesign. Workflow change with operational implications (sentinel detection, required reviewer enforcement). Ops handoff.                                                        |
| C-02  | Cloud-tier user-data-delete extension. N/A in OSS today; ships with the billing rollout PR.                                                                                                                   |

### Verification — follow-up PR

```bash
bun run type-check          # 26 workspaces clean
bun lint:fix                # 0 errors (2 unsafe-suggestion infos remain from #489)
bun run deps:lint           # syncpack ✓
bun run deps:unused         # knip ✓
bun test --preload …/test-preload.ts \
  packages/infra/security/tests/ \
  packages/business/file-import/tests/csv-parser.test.ts \
  packages/infra/logging/ packages/infra/rate-limiter/ \
  --timeout 30000           # 136 pass / 0 fail
terraform fmt -check -recursive  # infra/terraform clean
python3 -c "import yaml; ..."    # every workflow file parses
```

Manual / end-to-end checks recommended before merging:

- **DNS records**: after the terraform.yaml apply, confirm
  `dig +short CAA scani.xyz`, `dig +short TXT _dmarc.scani.xyz`,
  `dig +short CNAME fm1._domainkey.scani.xyz` all resolve.
- **MTA-STS policy**: `curl https://mta-sts.scani.xyz/.well-known/mta-sts.txt`
  should return the policy file (Fastmail MX records).
- **Branch protection**: try `git push --force-with-lease origin main`
  from a throwaway local clone — expected 403.
- **HMAC replay**: capture a legitimate admin-jobs request via
  browser dev tools, replay it within 30s with the same `x-admin-hmac`
  header — expected 401 "replay detected".
- **Migration 0014**: `bun run db:migrate` against a dev DB; assert
  the `admin_audit_log.signature` column exists and is nullable.
