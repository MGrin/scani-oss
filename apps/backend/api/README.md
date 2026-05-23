# @scani/backend (apps/backend/api)

The Scani tRPC API on Elysia. HTTP receiver for the SPA + the `@scani/cloud-client` server-side calls. BullMQ producer; never consumes jobs (that's `apps/backend/worker`).

## Layout

```
src/
├── index.ts            boot orchestrator (Sentry → env → container → providers → Elysia → SIGTERM)
├── auth/
│   └── better-auth.ts  better-auth wiring: Drizzle adapter + emailOTP + magic-link + session + default-base-currency
├── config/
│   ├── env.ts          zod schema for app-owned env (PORT, BACKEND_URL, BETTER_AUTH_*, …); package-owned env stays in its package
│   └── container.ts    typedi bootstrap — imports @scani/domain barrels for side-effect @Service() registration
├── lib/
│   └── idempotency.ts  TTL'd in-memory dedup for mutation handlers (`withIdempotency`)
├── utils/
│   └── error-mapping.ts  `toTRPCError(err)` — translates upstream errors to TRPCError codes
├── presentation/
│   ├── trpc.ts                tRPC bootstrap (context shape, `protectedProcedure`, request-cache)
│   ├── router.ts              composes all sub-routers into one app router
│   ├── middleware/auth.ts     `requireAuth(ctx)` — pulls Better-Auth session, throws UNAUTHORIZED
│   └── routers/               21 sub-routers (accounts, holdings, dashboard, integrations, wallet, …)
└── types.ts            public type re-exports for the cloud-client typed RPC surface
```

## Boot order (load-bearing)

`src/index.ts` runs in this exact order; reordering any line here breaks something subtle:

1. `import 'reflect-metadata'` — typedi class-decorator metadata.
2. Sentry init — so any subsequent boot-time failure lands in Sentry.
3. `loadEnv()` — fail-fast on missing required env. Zod schema in `config/env.ts`.
4. `initializeContainer()` — imports `@scani/domain/repositories` and `@scani/domain/services` barrels for side-effect `@Service()` registration. After this, `Container.get(X)` resolves any domain class.
5. `buildProviderRegistry()` — wires the `@scani/providers` registry. Cloud or direct mode based on env.
6. Better-Auth handler created.
7. Elysia app constructed; routes mounted.
8. Pre-warm currency-conversion cache (background, non-blocking).
9. SIGTERM/SIGINT handlers wire `Sentry.flush(2s)` then `process.exit`.

## Decision rules

**When to add a new tRPC router vs. extend an existing one** — one router per top-level resource (`accounts`, `holdings`, `vaults`, …). New conceptual entity = new router. New action on an existing entity = new procedure on that router.

**When to call a use-case directly vs. wrap it** — a procedure that's pure CRUD on a single entity goes straight to the appropriate `@scani/domain/services` (e.g. `Container.get(HoldingService).updateHolding(...)`). A procedure that orchestrates multiple services + lifecycle events (creating an account + the institution it belongs to + initial holdings) goes through a `@scani/domain/use-cases` use case (e.g. `CreateHoldingsWithDependenciesUseCase`).

**Where business logic does NOT belong** — never in the routers themselves. The router validates input via zod, calls a service or use case, emits a `realtime` event, and returns. If you find yourself writing `if`-branches over domain state inside a router, that logic belongs in `@scani/domain`.

**Idempotency** — mutations that the SPA might retry on a flaky connection (account create, batch updates) should wrap their handler in `withIdempotency(userId, idempotencyKey, () => …)` from `lib/idempotency.ts`. The SPA generates the key.

## Auth flow

Browser request → Elysia `.onRequest()` bridges to Better-Auth's WinterCG handler when the path matches `/api/auth/*`. tRPC procedures pull the session via `requireAuth(ctx)` middleware, which reads the Better-Auth cookie + builds a `dbUser` context. `protectedProcedure` (`presentation/trpc.ts`) is the base every authenticated procedure extends.

## Local dev

```bash
# from repo root — full stack (Postgres, Redis, MinIO, Mailpit, plus the worker + frontend)
bun run dev:stack

# OR host-side: infra in Docker, api in process
docker compose up -d postgres redis mailpit minio
bun dev:api          # http://localhost:3001
```

## Deploy

Compiled to a single binary via `bun build --compile` (see `package.json` `build` script + `Dockerfile`). Runtime image is `debian:bookworm-slim` + `/app/server` + curl for the healthcheck. Deploy the image to any container host; run database migrations before rolling out a new version.

## Tests

Most testable logic lives in `@scani/domain` (repositories, services, use cases — tested in `packages/business/domain/tests/`). Local tests under `apps/backend/api/tests/` cover presentation-layer hotspots only:

- `tests/lib/idempotency.test.ts` — TTL eviction, dedup, concurrent calls.
- `tests/utils/error-mapping.test.ts` — status-code branches in `toTRPCError`.

Run them:

```bash
bun test apps/backend/api --timeout 30000
```
