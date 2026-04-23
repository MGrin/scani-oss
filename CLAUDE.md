# Scani Development Guidelines

## Before Pushing

Always run these checks before pushing to main:

```bash
# Type check (all apps + packages)
bun run type-check

# Lint + auto-fix (repo-wide via Biome)
bun lint:fix

# Tests
bun test --preload ./packages/domain/test-preload.ts packages/ --timeout 30000
```

## Working in Conductor

- **PR-before-push**: before `git push`, run
  `gh pr list --head "$(git branch --show-current)" --state open --json number,url`.
  If a PR is open, push to it. If not, either open a new PR for the current branch
  or create a new branch (prefix `MGrin/`, under 30 chars, concrete/specific name) and
  start fresh — never push blindly.
- **No force-push** without explicit user approval. Never force-push to `main`.
- **Infrastructure secrets** live in `/Users/mgrin/.secrets` (single file, mode 600).
  Covers Fly / Neon / Upstash / Cloudflare / R2 / Fastmail / GitHub tokens plus
  `ADMIN_SESSION_SECRET` and `ADMIN_JOBS_HMAC_SECRET`. `.env.example` at repo root
  documents what's needed; actual values come from `/Users/mgrin/.secrets`. Read
  individual values on demand — never commit contents, echo to logs, or paste into PRs.
- **Workspace scratch**: `.context/` (gitignored) is for cross-agent notes/handoffs
  inside the Conductor workspace. Don't put secrets there. Don't rely on it across
  workspaces.
- **Target branch**: PRs go to `main` unless told otherwise.
- **Before finishing a task**: run the "Before pushing" checks. For UI changes,
  exercise the feature in a browser — type-check doesn't verify UX.
- **Common gotchas**:
  - CI's `check-ci-status` job skips deploy-time validation when the PR CI already
    passed — don't re-push just to re-trigger.
  - Terraform at `infra/terraform/` is the source of truth for Cloudflare / Fly /
    Neon / Upstash / GitHub. Don't click-configure in vendor dashboards.
  - Queue jobs are consumed by `apps/worker`, not by backend request handlers.
    Local queue work needs the worker running (or `docker compose --profile full up`).

## Repo Layout

Bun workspaces monorepo.

**Apps:**
- `apps/backend` — tRPC API on Elysia; hosts BullMQ *producers*
- `apps/worker` — BullMQ *consumer* for async jobs (Fly)
- `apps/cron` — scheduled jobs
- `apps/frontendV2` — React + Vite SPA, main frontend (code under `src/v2/`)
- `apps/admin` — passkey-gated infra dashboard on Cloudflare Pages (Next.js; includes BullMQ queue admin)
- `apps/landing` — marketing site at scani.xyz (Vite + React, Cloudflare Pages)

**Packages:**
- `packages/core` — business logic, database, services, use cases, repositories
- `packages/integrations` — external integrations (Plaid, Binance, Kraken, etc.)
- `packages/shared` — Zod schemas, Decimal helpers
- `packages/rate-limiter` — shared rate-limiter utility

## Key Paths

- tRPC routers: `apps/backend/src/presentation/routers/`
- Queue client / enqueue helpers: `apps/backend/src/queues/{client,enqueue}.ts`
- Queue names: `packages/core/src/queues/queue-names.ts`
- Worker processors: `apps/worker/src/processors/`
- Core business logic: `packages/core/src/`
- AI providers: `packages/core/src/external-services/ai/`
- File import: `packages/core/src/external-services/file-import/`
- Admin service routes: `apps/admin/src/app/services/{bullmq,fly,cloudflare,github,neon,upstash,fastmail}/`
- Admin auth middleware: `apps/admin/src/middleware.ts`
- Database schema: `packages/core/src/database/schema.ts`
- Drizzle migrations: `packages/core/src/database/migrations/` (register custom SQL in `meta/_journal.json`)

## Infrastructure

- **Backend + worker** → Fly.io (Docker multi-stage Bun builds; `apps/*/fly.toml`)
- **frontendV2, admin, landing** → Cloudflare Pages
- **Postgres** → Neon (serverless)
- **Redis** → Upstash (BullMQ backing store in prod; local Redis via docker-compose)
- **Object storage** → Cloudflare R2
- **Email** → Fastmail JMAP API or SMTP
- **Auth** → Better-Auth (replaces prior Supabase Auth)

Terraform at `infra/terraform/` manages Cloudflare / Fly / Neon / Upstash / GitHub.

## CI / CD

Workflows in `.github/workflows/`:
- `ci.yml` — lint, type-check, tests, secret scan
- `deploy-fly.yaml` — path-based change detection; runs DB migrations; deploys
  backend + worker to Fly and frontendV2 + landing + admin to Cloudflare Pages.
  A `check-ci-status` job skips deploy-time re-validation when the PR CI already passed.
- `terraform.yaml` — plan/apply for Cloudflare / Fly / Neon / Upstash / GitHub
- `backup-db.yaml` — scheduled DB backup

## Async Queue System (BullMQ)

Six producer routers on the backend enqueue to a Redis-backed BullMQ queue:
screenshot-parse, exchange-import, wallet-import, file-import, holding-price-update,
user-data-delete. `apps/worker` runs the consumer. Jobs aren't processed locally
unless the worker is running.

The admin app hosts a queue dashboard at `apps/admin/src/app/services/bullmq/`
(waiting / active / delayed / failed / completed) with retry + remove actions.
Admin → backend actions are HMAC-signed with `ADMIN_JOBS_HMAC_SECRET`.

## Local Development

`docker-compose.yml` uses non-default host ports to avoid clashes:

| Service | Host port | Notes |
|---|---|---|
| Postgres | `localhost:5433` | `scani-postgres` container |
| Redis | `localhost:6380` | `scani-redis` container |
| Mailpit SMTP | `localhost:1026` | Submit mail here |
| Mailpit UI | `http://localhost:8026` | Inspect dev emails |
| MinIO (S3) | `localhost:9000` | R2 replacement |
| MinIO console | `http://localhost:9001` | `minioadmin` / `minioadmin` |
| data-provider | `localhost:8082` | Tier-1 sidecar (incl. email.send tRPC) |
| backend | `localhost:3001` | Elysia API |
| frontendV2 | `http://localhost:5173` | Main SPA |
| landing | `http://localhost:5174` | |
| admin | `http://localhost:5175` | Passkey-gated; `ADMIN_DEV_BYPASS=1` in dev |
| cloud-frontend | `http://localhost:5176` | Tier-2 console |

### Starting the stack

Full stack (`backend` + `worker` + all frontends in containers, recommended):

```bash
bun dev:stack          # runs scripts/sync-env.ts, then `docker compose --profile full up -d --build`
bun dev:stack:down     # stops and removes compose containers (volumes preserved)
```

Infra only (run `bun dev` for apps on the host against containerized services):

```bash
docker compose up -d postgres redis mailpit minio
bun install
bun dev                # backend + frontendV2 concurrently; other apps via bun dev:admin / dev:cron / dev:data-provider
```

### Mail in dev

All auth emails (magic-link, OTP, verification) land in Mailpit at
`http://localhost:8026`. Flow: `backend → email.send tRPC → data-provider → SMTP → mailpit:1025`.

The `data-provider` service hardcodes `FASTMAIL_API_TOKEN: ""` in compose
to force SMTP even when your shell / root `.env` has a real Fastmail
token. To test Fastmail in dev, comment out that line in
`docker-compose.yml`. For host-side `bun dev`, add
`SMTP_URL=smtp://localhost:1026` and `SMTP_FROM=no-reply@scani.local`
to the root `.env` and re-run `bun scripts/sync-env.ts`.

### Gotchas

- **Container name conflicts across Conductor workspaces.** Every workspace's
  `docker-compose.yml` hardcodes `container_name: scani-*`, so starting the
  stack in workspace A and then again in workspace B fails with
  `"The container name /scani-env-sync is already in use"`. Fix: run
  `bun dev:stack:down` in the workspace that previously booted the stack,
  OR `docker rm $(docker ps -aq --filter "name=scani-")` to nuke all stopped
  scani containers. Named volumes (`postgres-data`, `redis-data`, `minio-data`)
  survive `down`, so no data loss.
- **One-shot containers linger after clean exit.** `env-sync`, `deps`,
  `migrate`, `minio-init` all `restart: "no"` and keep their names reserved
  after exiting. `bun dev:stack:down` removes them; `compose up` without
  prior `down` will hit the same name-conflict error.
- **Host-side `bun dev` needs SMTP in root `.env`.** The containerized stack
  overrides `SMTP_URL` via compose environment; host-side backend reads
  `apps/backend/.env` (generated from root `.env` by `scripts/sync-env.ts`),
  which will have no SMTP config unless you add it to root `.env` first.

## Documentation Layout

`docs/` core files (keep up-to-date):
- `ARCHITECTURE.md` — tech stack + architecture
- `IMPLEMENTATION_PLAN.md` — current implementation plan
- `SELF_HOST.md` — self-hosting guide
- `PUBLISHING.md` — release / publishing notes

Topic folders: `docs/{features,technical,implementation,stability,backend-fixes,performance,archive}/`.
New docs use the `YYYY-MM-DD_name.md` prefix. Never create `.md` files at the repo
root (besides `README.md`) or inside `apps/*` / `packages/*/src/`.
