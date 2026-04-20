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

- Postgres `localhost:5433`
- Redis `localhost:6380`
- Backend (full-stack profile) `localhost:3002`
- Mailpit SMTP `localhost:1026`, UI `http://localhost:8026`

Infra only (recommended — run `bun dev` against it):

```bash
docker compose up -d postgres redis mailpit
```

Full stack (backend + worker inside containers):

```bash
docker compose --profile full up -d --build
```

## Documentation Layout

`docs/` core files (keep up-to-date):
- `ARCHITECTURE.md` — tech stack + architecture
- `IMPLEMENTATION_PLAN.md` — current implementation plan
- `SELF_HOST.md` — self-hosting guide
- `PUBLISHING.md` — release / publishing notes

Topic folders: `docs/{features,technical,implementation,stability,backend-fixes,performance,archive}/`.
New docs use the `YYYY-MM-DD_name.md` prefix. Never create `.md` files at the repo
root (besides `README.md`) or inside `apps/*` / `packages/*/src/`.
