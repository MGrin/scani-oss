---
title: Environment variables
description: The full annotated list. Grouped by ownership (app vs package) and by required vs optional.
sidebar:
  order: 2
---

This page is the **complete** list. For the must-set subset see
[Required environment variables](/self-hosting/tier1/required-env/);
for integration keys see
[Optional integration keys](/self-hosting/tier1/optional-keys/).
The annotated source of truth is
[`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example).

## Ownership model

Two layers:

- **App-level** (`apps/*/src/config/env.ts`) — vars the app itself
  cares about (bind port, DB URL, frontend origin, session signing).
  Each app validates with zod at boot.
- **Package-level** (`packages/infra/<pkg>/src/config.ts`) — vars
  that belong to a package (`@scani/security` owns `ENCRYPTION_KEY`,
  `@scani/storage` owns `S3_*`, `@scani/email` owns
  `FASTMAIL_API_TOKEN` / `SMTP_URL`, …).

Apps that depend on a package **do not redeclare** the package's
vars. The package's `loadXConfig()` validates and caches; the app
just sets the env var.

See [Engineering conventions](/contributing/conventions/) for the
ownership rule.

## Core (required for any deployment)

| Variable | Owner | What it does |
|---|---|---|
| `NODE_ENV` | app | `production` for any real deployment. |
| `DATABASE_URL` | app | Postgres 16+ connection string. |
| `POSTGRES_POOL_MAX` | app | Per-app pool size. Set to 5 behind a connection pooler. |
| `REDIS_URL` | app | Redis 7+ connection string. |
| `PORT` | app (api / data-provider) | HTTP bind port. |
| `HOST` | app | HTTP bind host. |
| `ALERT_STALE_SYNC_HOURS` | worker | How long an integration must have gone without syncing before its OWNER is emailed by `alert-sweep` (SC-459). Default 24. Deliberately far above `STALE_SYNC_THRESHOLD_HOURS`, which is the same measurement aimed at Sentry: 3h is two missed hourly cycles, the right moment to page us and the wrong moment to mail a user about a blip that clears itself. |
| `FRONTEND_URL` | app (api), worker | Browser-facing SPA URL. CORS + cookie scope on the api; where the weekly digest's "Open Scani" button goes, and where the integration alert's "Reconnect" button goes, on the worker (SC-460, SC-459). Optional on the worker — absent, both jobs log a refusal and send nothing. |
| `BACKEND_URL` | app (api), worker | Browser-facing api URL. Embedded in magic-link emails, and in the one-click unsubscribe links (`/e/u/:token` for the digest, `/e/a/:token` for alerts — SC-460, SC-459). Optional on the worker — absent, both jobs log a refusal and send nothing. |
| `COOKIE_DOMAIN` | app (api) | Cross-subdomain cookie scope. Leave unset for same-origin. |
| `BETTER_AUTH_SECRET` | app (api) | 32+ chars. Better-Auth session signing key. |
| `JOBS_HMAC_SECRET` | app (api) | 32+ chars. HMAC for operator job endpoints. |
| `SCREENSHOT_BOT_SECRET` | app (api) | 32+ chars. Screenshot-bot sign-in bearer. **Optional everywhere** — unset endpoint refuses with 403, feature disabled. Set if you use a screenshot-capture pipeline. |
| `ENCRYPTION_KEY` | **package** (`@scani/security`) | ≥32 chars (recommended: 64 hex chars from `openssl rand -hex 32`). AES-256-GCM. Must match api ↔ worker. |
| `LOG_ID_PEPPER` | **package** (`@scani/logging`) | 16+ chars. ID-hashing pepper. Required in production. |
| `WORKER_CONCURRENCY` | app (worker) | Max concurrent BullMQ jobs per worker. Default 4. |

## Tier wiring

| Variable | Owner | What it does |
|---|---|---|
| `SCANI_CLOUD_URL` | app (api, worker) | Where object storage, email, OG-metadata fetching and token search go. Tier 1: `http://data-provider:8082`. Tier 2/3: hosted endpoint. Pricing, AI and chain calls do **not** travel here — see the provider-keys table below. |
| `SCANI_CLOUD_API_KEY` | app (api, worker) | Bearer presented to the data-provider. |
| `DATA_PROVIDER_API_KEY` | app (data-provider) | Bearer the data-provider validates against. |
| `CLOUD_MANAGEMENT_ENABLED` | app (data-provider) | Tier 2/3 only. Enables cloud-management surface. |
| `BETTER_AUTH_URL` | app (data-provider) | Public URL of the data-provider for cloud-management cookies. |
| `CLOUD_FRONTEND_ORIGIN` | app (data-provider) | CORS origin for cloud-management console. |
| `CLOUD_QUOTA_HOURLY_DEFAULT` | app (data-provider) | Requests allowed per API key per rolling hour. Enforced per key (the limiter is keyed by apiKeyId); the value is one global default — `cloud_api_keys.quota_monthly_requests` is not read on the request path. **`0` or absent = no quota**, so every key gets an unbounded budget on *your* provider accounts. |
| `GLOBAL_HOURLY_USD_CAP` | app (data-provider) | Cumulative upstream USD per hour across all tenants. Trips a circuit breaker; further requests get 503 until the next hour-bucket. Decimals allowed. **`0` or absent = no cap.** |
| `VITE_DATA_PROVIDER_URL` | cloud + landing (frontend) | Where those SPAs send tRPC calls. Baked at build time. Empty is legal and means same-origin, which is how dev works through the Vite proxy. |
| `DATA_PROVIDER_PROXY_TARGET` | cloud (vite dev server) | What that dev proxy forwards to. Default `http://localhost:8082`. Dev only — the production build never reads it. |

## Admin dashboard

The passkey-gated infra console (`apps/frontend/admin`, Next.js). None
of these are needed to run Scani — the admin app is an operator tool and
a self-host deployment can skip it entirely.

| Variable | Owner | What it does |
|---|---|---|
| `ADMIN_ORIGIN` | admin | Public origin of the console. WebAuthn checks it, so a mismatch means every passkey assertion is rejected. |
| `ADMIN_RP_ID` | admin | WebAuthn Relying Party ID — the registrable domain of `ADMIN_ORIGIN`. |
| `ADMIN_PASSKEY_CREDENTIAL_ID` | admin | Base64 credential ID of the one enrolled passkey. |
| `ADMIN_PASSKEY_PUBLIC_KEY` | admin | Its public key. Together with the ID above, this *is* the user directory: there is no admin table. |
| `ADMIN_SESSION_SECRET` | admin | Signs the admin session cookie. |
| `ADMIN_BOOTSTRAP_TOKEN` | admin | One-time token that lets the first passkey enrol. Unset once a passkey exists — a live bootstrap token is a second way in. |
| `NEXT_PUBLIC_SENTRY_DSN` | admin | Browser + server Sentry for the console. Unset → no-op. |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | admin | Tag (`production`, `preview`). |
| `NEXT_PUBLIC_SENTRY_RELEASE` | admin | Release identifier. |
| `SENTRY_AUTH_TOKEN` | admin (build + API routes) | Uploads source maps at build time, and backs the console's "resolve issue" action. A write-scoped token, unlike the DSNs above. |
| `SENTRY_ORG` | admin (build) | Sentry organisation slug for that upload. |

## Storage

| Variable | Owner | What it does |
|---|---|---|
| `S3_ENDPOINT` | **package** (`@scani/storage`) | Server-side S3 endpoint. |
| `S3_PUBLIC_ENDPOINT` | package | URL baked into presigned URLs for the browser. Defaults to `S3_ENDPOINT` if unset; override when the bucket is fronted by a CDN with a different hostname. |
| `S3_ACCESS_KEY_ID` | package | |
| `S3_SECRET_ACCESS_KEY` | package | |
| `S3_BUCKET` | package | Bucket name. |
| `S3_REGION` | package | Optional. Defaults to `auto` (works for R2 + MinIO). Set explicitly for AWS S3 (e.g. `us-east-1`). |

## Email

| Variable | Owner | What it does |
|---|---|---|
| `FASTMAIL_API_TOKEN` | **package** (`@scani/email`) | Fastmail JMAP token. Takes precedence over SMTP. |
| `SMTP_URL` | package | `smtp://user:pass@host:port` for any SMTP server. |
| `SMTP_FROM` | package | The from address for outbound mail. |

## Logging

| Variable | Owner | What it does |
|---|---|---|
| `LOG_LEVEL` | package (`@scani/logging`) | `debug`, `info`, `warn`, `error`. Default `info`. |
| `LOG_PRETTY` | package | Pretty-print. Default `false` in production. |
| `LOG_COLORIZE` | package | Colourise pretty-printed logs. Default on in dev, off in prod. |
| `LOG_TIMESTAMP` | package | Include timestamps. Default on. Set `false` to defer to the log aggregator. |
| `LOG_SQL_QUERIES` | package | Log Drizzle queries. Default `false`. |
| `LOG_REQUEST_BODIES` | package | Log inbound HTTP request bodies. Dev only — refuses to start with this on in production. |
| `LOG_RESPONSE_BODIES` | package | Log outbound HTTP response bodies. Dev only. |
| `LOG_WEBSOCKET_MESSAGES` | package | Log WebSocket frames. Default on. |
| `SERVICE_NAME` | app | Set automatically by compose (`api`, `worker`, `data-provider`). |
| `SERVICE_VERSION` | app | Set automatically by the build; surfaces in log records. |
| `AI_DEFAULT_PROVIDER` | app (worker) | Optional. Which AI provider the worker picks first. Defaults to `openai`, which is also the only AI provider any backend service registers. |

## Provider keys (read by the api and worker)

**These are required on every tier**, including Tier 2/3. All three
backend services boot `buildProviderRegistry({ mode: 'direct' })` and
call these upstreams themselves; `mode` is a string literal that no
environment variable can change. Pointing `SCANI_CLOUD_URL` at a
hosted data-provider does not move them.

Missing keys degrade silently rather than failing at boot. Check what
your stack resolved with the `provider credentials:` boot line —
[How to tell what's
enabled](/self-hosting/tier1/optional-keys/#how-to-tell-whats-enabled).

| Variable | Provider | Unlocks |
|---|---|---|
| `COINGECKO_API_KEY` | CoinGecko | Paid-tier crypto prices. |
| `FINNHUB_API_KEY` | Finnhub | Public-equity prices. |
| `OPENAI_API_KEY` | OpenAI | Screenshot and document parsing. Unset → throws on every call. |
| `PERPLEXITY_API_KEY` | Perplexity | Read by `aiPerplexityFactory`, which **no backend service registers**. No effect today. |
| `DEEPSEEK_API_KEY` | DeepSeek | Read by `aiDeepseekFactory`, which **no backend service registers**. No effect today. |
| `ETHERSCAN_API_KEY` | Etherscan V2 | All EVM wallet balances + transactions. |
| `HELIUS_API_KEY` | Helius | Solana balances + transactions. |
| `BINANCE_OAUTH_CLIENT_ID` | Binance | OAuth flow. |
| `BINANCE_OAUTH_CLIENT_SECRET` | Binance | OAuth flow. |
| `BINANCE_OAUTH_REDIRECT_URI` | Binance | OAuth callback URL (e.g. `https://api.your-domain.example.com/auth/binance/callback`). |
| `GOOGLE_SHEETS_ID` | Google Sheets | Sheet ID for manual-asset pricing fallback. Optional. |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google Sheets | Base64-encoded service-account JSON used to read the sheet above. Optional. |

## Observability

| Variable | Owner | What it does |
|---|---|---|
| `SENTRY_DSN` | app | Server-side Sentry. No DSN = no-op. |
| `SENTRY_ENVIRONMENT` | app | Tag (`production`, `staging`). |
| `SENTRY_RELEASE` | app | Release identifier. |
| `VITE_SENTRY_DSN` | app (frontend) | Browser-side Sentry. Baked at build time. |
| `VITE_SENTRY_ENABLED` | app (frontend) | Enable client-side reporting. |
| `VITE_API_URL` | app (frontend) | URL the SPA calls for `/api`. Bun-bundled image bakes `/api`. |
| `API_UPSTREAM` | app (frontend-app nginx) | Inside the prod `frontend-app` image, nginx reverse-proxies `/api/*` → `${API_UPSTREAM}`. Default `http://api:3001` (compose network). Override when running `frontend-app` outside compose. |
| `FRONTEND_PORT` | docker-compose.prod.yml | Host port for the `frontend-app` container. Default 8080. |
| `CSP_CONNECT_SRC` | app (frontend-app nginx) | `connect-src` for the Content-Security-Policy nginx sends. Default `'self'`, which is correct when the SPA reaches the API through the container's own `/api` proxy. Set it when you serve the SPA and the API from different origins, e.g. `'self' https://api.example.com wss://api.example.com` — the browser blocks XHR/WebSocket to any origin not listed. Leave the other CSP directives alone; they are fixed in the image. |

## API port shape across deployment layers

The number `3001` shows up in three places that mean different things;
trying to "fix" any one of them in isolation tends to break the other
two:

| Layer | Port | Notes |
|---|---|---|
| Host-side `bun dev:api` | `3001` | Default from `.env.example` (`PORT=3001`). |
| Dev compose `api` container | `8080` internal, `3011` host | Compose maps `3011:8080` and overrides `PORT=8080` so the dev SPA at `:5173` can reach the api at `http://localhost:3011`. |
| Prod compose `api` container | `3001` internal, **no host port** | nginx inside `frontend-app` proxies to `http://api:3001` over the compose network. Operators only expose `frontend-app`. |

`VITE_API_URL` follows the same split: `http://localhost:3001` in
host-dev, `http://localhost:3011` in dev compose (frontend container's
own env), `/api` baked into the prod `frontend-app` image so nginx
handles routing.

## Health-check endpoints

All exposed by `apps/backend/api` (and surfaced via nginx as
`/api/*` in prod compose):

| Path | What it does | When to use |
|---|---|---|
| `/health` | Process liveness. 200 if the api process is up. | Cheap k8s liveness probe. |
| `/readyz` | Readiness. 200 only if **DB + Redis + schema** are all healthy. Returns 503 (with a per-check breakdown) if migrations haven't been applied. | k8s readiness probe; load-balancer upstream check; `docker-compose.prod.yml` api healthcheck. |
| `/health/db` | DB ping + pool stats. | Operator debugging. |
| `/health/ws` | WebSocket stats. | Operator debugging. |
| `/health/deep` | DB + schema-drift + Redis + R2 + AI. 200 `ok` / 503 `degraded` with a per-check breakdown. Also reports `providerCredentials` — which platform provider keys are absent — and `costControls` — which of the two spend bounds are enforcing, distinguishing a bound set to `0` (`off`) from one that was never set (`unset`). Both are **reported, never gated**, so neither can 503 a deployment that simply has not bought a key or has no external callers to bound. | Deploy-time smoke test. NOT for traffic routing — slow. |

The `data-provider` exposes `/health` (process liveness) on its bind
port. The prod `frontend-app` image exposes `/healthz` (nginx alive),
not to be confused with `/api/health/*` (which goes through to the
api).

## Local development stack

Set by `scripts/dev-stack.ts` and by the e2e runner (`apps/e2e/scripts/run.ts`)
from the checkout's own path, so two checkouts can hold a stack at once
(SC-491, SC-493). Nobody sets them by hand — but a value already in the
environment wins, because a person driving several stacks has a reason.

| Variable | Read by | What it does |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `docker compose` | Namespaces a checkout's containers, volumes and networks. Left unset, compose names the project after the directory leaf — `scani` in every worktree and in the primary checkout — so a second `up` does not conflict with the first, it ADOPTS and recreates its containers, and a `down -v` deletes its volumes. |
| `SCANI_STACK_TAG` | compose files that pin the tag of a built image | One image tag per checkout, so the tree that built last does not decide which source every other stack runs. |
| `<SERVICE>_HOST_PORT` | `docker-compose.yml` | One host port per published service (`POSTGRES_HOST_PORT`, `API_HOST_PORT`, `FRONTEND_HOST_PORT`, …). The primary checkout keeps the documented defaults; a linked worktree is offset by a multiple of 100. |

## Demo mode

Read by the api and the worker of a **demo deployment** only
(`demo.scani.xyz`). On any other deployment both are unset and nothing
in this section applies.

A demo flag a production deployment could set is a data-exposure bug
rather than a feature toggle, so three independent things have to hold
before an anonymous visitor is served anything, and the flag is the
weakest of them. The **flag** must be exactly `1`. The **database** must
hold the demo persona and nothing else — the api reads every email in
`users` at boot and exits otherwise, which is what makes the flag
impossible to set against a real deployment rather than merely
inadvisable. An empty database is refused too: nothing about an empty
database proves it is a demo, and an unmigrated database, an empty
replica and a typo'd `DATABASE_URL` all look exactly like one. The
**identity** the api synthesizes is only ever the demo persona — no
header, cookie or input selects another — so a process that got past the
first two resolves to a user that does not exist and every user-scoped
read returns nothing.

The worker arms one schedule, `demo-reset`, and removes whatever a
previous boot armed. Every other schedule is wrong for a demo and two
are destructive: the hourly pricing job would overwrite the seeded price
series and take the dataset's determinism with it, and the nightly
rollup would recompute portfolio values over transactions nobody made.

| Variable | Read by | What it does |
|---|---|---|
| `SCANI_DEMO_MODE` | api, worker | When **exactly `1`**, the api serves one fictional portfolio to anonymous visitors with no session, refuses every tRPC mutation with `FORBIDDEN`, and does not mount `/api/auth/*`, the admin routes or the unsubscribe route at all. The worker arms the `demo-reset` schedule and **nothing else**. Any other value — `true`, `yes`, `0`, blank — is off. The flag alone grants nothing: the api reads every email in `users` at boot and **exits** unless the only account there is the demo persona, so setting this against a production database takes the process down instead of opening a demo. |
| `SCANI_DEMO_SIGNUP_URL` | api | Absolute URL the demo's "create your own account" link points at. Defaults to `https://app.scani.xyz`. |

## Testing-only

These vars are read **only** by the e2e test runner under `apps/e2e/`
and the related fixtures / scripts. They have no effect on a
production deployment — operators can ignore this section.

| Variable | Read by | What it does |
|---|---|---|
| `STUB_AI` | data-provider (`ai.parseScreenshot`) | When `1`, returns a fixed holdings payload instead of calling a real AI provider. Refused in production by the data-provider env schema. |
| `STUB_CHAIN_DATA` | api, worker, data-provider | When `1`, registers a fixture chain provider ahead of the real ones, so wallet-address activity probes and balance fetches resolve locally instead of calling blockchain.info / Etherscan / a Solana RPC / TronGrid / Toncenter. Only fixture addresses report activity. Refused in production by all three env schemas. |
| `ALLOW_REMOTE_TEST_DB` | `packages/business/domain/test-preload.ts` | Escape hatch for the guard that refuses to run the suite against a non-local `DATABASE_URL`. Repository tests truncate and roll back real tables, so pointing them at a remote branch is destructive — set to `1` only when you have deliberately provisioned a throwaway database. |
| `SCANI_ALLOW_SHARED_TEST_DB` | `packages/business/domain/test-preload.ts` | Escape hatch for the one-suite-per-database lock. The preload takes a Postgres advisory lock on the test database and refuses to start when another suite already holds it: two suites on one database interfere in ways the output attributes to neither run (SC-370, SC-372). Set to `1` only to share a database deliberately — the supported way to run two suites at once is to give each its own database: `docker compose exec -T postgres createdb -U scani scani_test_$$`, then `bun run db:migrate` and `bun run test` with `DATABASE_URL` pointed at it. |
| `API_BASE_URL` | e2e (Playwright fixtures) | Base URL the e2e suite hits for tRPC requests. Defaults to the dev-compose api at `http://localhost:3011`. |
| `PLAYWRIGHT_BASE_URL` | Playwright config | Base URL Playwright treats as the SPA origin. Defaults to `http://localhost:5173`. |
| `MAILPIT_URL` | e2e (magic-link helper) | Mailpit HTTP API used to read auth emails during sign-in. Default `http://localhost:8026`. |
| `POSTGRES_CONTAINER` | `apps/e2e/scripts/run.ts` | Name of the Postgres container the e2e suite `docker exec`s into. **No default** — the runner sets it in both modes, and `apps/e2e/fixtures/db.ts` refuses rather than guessing when it is absent. It used to fall back to a literal container name, which was correct on one machine and silently wrong everywhere else (SC-494). |
| `E2E_DB_NAME` | `apps/e2e/scripts/run.ts` | The database inside that container. Set beside `POSTGRES_CONTAINER` and subject to the same refusal. In Mode B the runner created the stack so it knows the name; in Mode A it reads the `DATABASE_URL` of whichever container publishes the api port, because the api that answered the health probe is the process under test and cannot disagree with itself. |
| `E2E_DB_UNRESOLVED` | `apps/e2e/scripts/run.ts` | Set INSTEAD of the two above when Mode A could not determine the stack's database — a host-side dev server with no container, or a docker that could not be asked. It carries the reason to the point of use, where the fixture throws it saying NO QUERY WAS MADE. Without that clause a reader assumes the query ran and returned nothing (SC-494). |
| `SCANI_DEV_DB` | `docker-compose.yml`, `apps/e2e/scripts/run.ts` | The per-worktree dev database, `scani_dev_<label>_<hash>` (SC-429). Compose defaults it to `scani`; `bun dev:stack` sets it. The e2e runner reads it only in Mode B, where it created the stack and therefore passed it. |
| `KEEP_STACK_ON_FAILURE` | `apps/e2e/scripts/run.ts` | When `1`, leaves the docker-compose stack running after a failed e2e run so the operator can poke at it. |
| `DATA_PROVIDER_URL` | `apps/e2e/scripts/wait-for-stack.ts` | Health endpoint the e2e runner polls before starting. Default `http://localhost:8082`. |
| `SHOT_FRESH` | `apps/e2e/fixtures/shots-setup.ts` | When `1`, ignores the stored browser session and signs in again before capturing screenshots. |
| `PW_VISUAL_WS` | `apps/e2e/fixtures/visual-setup.ts` | WebSocket endpoint of the Playwright browser server the visual-baseline suite attaches to. `apps/e2e/scripts/visual.ts` starts that server inside the Playwright Docker image and sets this; the fixture THROWS when it is unset rather than falling back to a local browser, because a macOS-rendered baseline does not match a Linux-rendered one and a silent fallback would produce baselines nobody can reproduce. |
| `VISUAL_FRESH` | `apps/e2e/fixtures/visual-setup.ts` | When `1`, ignores the stored session and reseeds a new user and portfolio before capturing baselines. Without it the suite reuses a valid stored session, so two runs compare the same portfolio rather than two different ones. |
| `SCANI_VISUAL_STALL_DATA` | `apps/e2e/visual/v3-screens.spec.ts` | When set, replaces `window.fetch` for the `/trpc` path with one that never settles and never opens a connection, so every screen renders its loading state while the network stays idle. It exists to make the calibration of `MIN_BASELINE_RATIO` re-takeable — a run under it writes twelve loading-state PNGs and is refused by name, and `git checkout visual/__screenshots__/` puts them back. Never set it on a run whose baselines you intend to keep. |
| `SCANI_ALLOW_BASELINE_SHRINK` | `apps/e2e/visual/capture-size.ts` | Comma-separated screen NAMES, clearing the SC-867 refusal for those screens only. That guard refuses a baseline rewritten to under 70% of the one it replaced, which is what a screen photographed while its data had not arrived measures. It takes names rather than `1` deliberately: a blanket flag set while looking at one red screen clears all twelve, and naming the screen is the smallest form of "I opened this image" a variable can carry. |
| `COLD_BOOT_API` | `apps/e2e/scripts/measure-cold-boot.ts` | Upstream the cold-boot harness proxies `/api` and `/trpc` to. Default `http://127.0.0.1:3099`. |
| `COLD_BOOT_API_LOG` | `apps/e2e/scripts/measure-cold-boot.ts` | Where that api writes its stdout. The harness reads the sign-in OTP out of it — an api started without an email transport prints the code rather than sending it. |
| `COLD_BOOT_DIST` | `apps/e2e/scripts/measure-cold-boot.ts` | A built `dist/` to serve instead of `apps/frontend/app/dist`. How a before/after sweep serves a baseline build from a second worktree. |

## Validation pattern

Every loader uses zod and the helpers from `@scani/config`:

- `isProduction` — `process.env.NODE_ENV === 'production'` at load.
- `urlSchema` / `httpsUrlInProduction` — URL with prod-only https
  requirement.
- `requiredInProd(schema, name)` — returns the schema unchanged in
  prod, `.optional()` everywhere else. Lets dev/test boot without
  the var; prod refuses to start without it.

On a parse failure, the loader throws with a message listing every
failing variable:

```
@scani/security env misconfigured:
  - ENCRYPTION_KEY: ENCRYPTION_KEY required in production
```

## Adding a new env var

1. **Where does it belong?** If it's about a package's behaviour
   (a new third-party API key, a logging knob), it goes in that
   package's `src/config.ts`. If it's about an app (a new bind
   address), it goes in `apps/*/src/config/env.ts`.
2. Add it to root `.env.example` with an annotation.
3. Add it to the relevant app's `.env.example` (so
   `scripts/sync-env.ts` propagates it to the per-app `.env`).
4. Validate it in the right loader.
5. Document it on this page and on
   [Required env](/self-hosting/tier1/required-env/) or
   [Optional keys](/self-hosting/tier1/optional-keys/).

## See also

- [Required environment variables](/self-hosting/tier1/required-env/)
- [Optional integration keys](/self-hosting/tier1/optional-keys/)
- [Engineering conventions](/contributing/conventions/) — env-var
  ownership rule.
- `.env.example` in the repo root for the canonical comments.
