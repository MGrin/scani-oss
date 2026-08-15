# @scani/db

Database infrastructure layer. Owns:

- The Drizzle schema (every table, pgEnum, relation, type) under `src/schema/`
- `connection.ts` — postgres.js connection, pool config, prepared-statement caching
- `connection-monitor.ts` — per-request pool tracking surfaced on the admin /services dashboard
- `transaction.ts` — typed transaction helper
- `base-repository.ts` — abstract `BaseRepository<TEntity>` that every domain repository extends
- `migrate.ts` — production migration runner (used by `bun run db:migrate`)
- `migrations/` — Drizzle-generated SQL plus hand-authored RLS / index migrations registered in `meta/_journal.json`

Domain logic lives in `@scani/domain`; this package is intentionally
domain-free — a DB-shaped API surface, not a business-rules layer.

## Schema layout

The schema is split one file per logical entity bundle. Each file holds
the table(s), pgEnums, relations, and inferred types that travel
together.

| File | Contains |
|---|---|
| `schema/users.ts` | `users` (app user) + Better-Auth tables (`user_sessions`, `user_accounts`, `user_verifications`) + relations + types |
| `schema/institutions.ts` | `institution_types` enum table + `institutions` + `institution_blockchain_mappings` + relations + types |
| `schema/tokens.ts` | `token_types` enum table + `tokens` + `token_prices` + `token_price_edit_history` + `TokenMetadata` interface + relations + types |
| `schema/accounts.ts` | `account_types` enum table + `accounts` + relations + types |
| `schema/holdings.ts` | `holdings` + `holding_transactions` + `holding_balance_observations` + `holding_coverage` + `holding_apy_configs` + relations + types |
| `schema/portfolio.ts` | `portfolio_value_daily` (rollup cache) + relations + types |
| `schema/user-wallets.ts` | `user_wallets` + relations + types |
| `schema/user-integration-credentials.ts` | `credentials_import_status` pgEnum + `user_integration_credentials` + `credential_pool_state` + `credential_pool_borrow_log` + relations + types |
| `schema/user-jobs.ts` | `user_job_state` pgEnum + `user_jobs` (durable BullMQ mirror) + types |
| `schema/groups.ts` | `groups` + `holding_groups` + `account_groups` (junctions) + relations + types |
| `schema/vaults.ts` | `vaults` + `vault_holdings` (junction) + relations + types |
| `schema/admin-audit-log.ts` | `admin_audit_log` + types |
| `schema/cloud.ts` | All `cloud_*` tables (data-provider Better-Auth + API keys + usage events) + types |
| `schema/index.ts` | Barrel — `export *` from every file above |

### Why one file per entity bundle (not one file per table)

Tables that always travel together stay together:

- The 4 Better-Auth tables (`users`, `user_sessions`, `user_accounts`,
  `user_verifications`) are one logical concept — Better-Auth manages
  them as a unit.
- `holdings` + `holding_transactions` + `holding_balance_observations`
  + `holding_coverage` + `holding_apy_configs` are five tables but one
  domain (a position with its full history and metadata).
- `groups` + the two `*_groups` junction tables are a single
  many-to-many concept.
- All `cloud_*` tables share the same lifecycle (Tier 2/3 only) and
  one migration path.

Splitting these would just add navigation friction without buying
isolation.

### Why the dynamic enum tables live with their parent entity

`institution_types` is just an admin-extensible catalog of institution
"kinds" — it has no meaning without `institutions`. Same for
`account_types` ↔ `accounts` and `token_types` ↔ `tokens`. Co-location
keeps the FK + relation in a single file.

### How relations work across files

Drizzle's `relations(table, callback)` defers callback evaluation until
the schema is fully loaded, so cross-file references like
`many(holdings)` from `usersRelations` work even when both files
import each other for types. The columns themselves use the lazy
`references(() => otherTable.id)` form which resolves at query time.

If you ever hit a circular-import error at boot, the fallback is to
move the offending relation into a centralized `relations.ts` — but
the current per-entity layout has been verified clean across all
workspaces.

## Adding a new table

1. **Drop a new file in `src/schema/`** (or extend an existing one if
   the table belongs to an existing entity bundle).
2. **Define the table + relations + inferred types** in that file:
   ```ts
   import { relations } from 'drizzle-orm';
   import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
   import { users } from './users';

   export const myThings = pgTable('my_things', {
     id: uuid('id').defaultRandom().primaryKey(),
     userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
     name: text('name').notNull(),
     createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
   });

   export const myThingsRelations = relations(myThings, ({ one }) => ({
     user: one(users, { fields: [myThings.userId], references: [users.id] }),
   }));

   export type MyThing = typeof myThings.$inferSelect;
   export type NewMyThing = typeof myThings.$inferInsert;
   ```
3. **Add `export * from './my-things'`** to `src/schema/index.ts`.
4. **Generate the migration**: `bun --cwd packages/infra/db run db:generate`.
   Drizzle-kit reads the barrel via `drizzle.config.ts` and emits a
   new SQL file under `src/migrations/`.
5. **Hand-author any expression indexes / RLS / triggers** that
   Drizzle's builder can't express — register them by name in
   `meta/_journal.json` so the migrator picks them up.
6. **Run the migration locally**: `bun --cwd packages/infra/db run db:migrate`
   (against the docker-compose Postgres on `localhost:5433`).

## Public API surface

```ts
// Most code imports the schema namespace:
import * as schema from '@scani/db/schema';
db.select().from(schema.holdings).where(eq(schema.holdings.userId, uid));

// Or named imports of tables + types:
import { holdings, type Holding } from '@scani/db';

// The connection layer:
import { db, getDb, client } from '@scani/db/connection';

// Repository pattern (domain repos extend this):
import { BaseRepository } from '@scani/db/base-repository';
```

The `./schema`, `./connection`, `./transaction`, `./base-repository`,
and `./migrate` subpath exports are listed in `package.json`. The root
`./index.ts` re-exports the schema + connection + base-repository so
most consumers can do `import { ... } from '@scani/db'`.

## BaseRepository

Every domain repository in `@scani/domain/repositories/` extends
`BaseRepository<TEntity, TNewEntity>` and provides:

- `protected readonly table` — the Drizzle table this repo wraps
- `protected readonly tableName: string` — used for log scoping

The base provides generic `findById`, `findMany`, `insert`, `update`,
`delete`, `bulkInsert`, etc. against the shared connection. Domain
repos override or add table-specific queries on top.

`@Service()` class-field DI — see `packages/business/domain/src/repositories/UserJobRepository.ts`
for a canonical example.

## Migrations

- **Schema-first generation**: `bun run db:generate` introspects the
  Drizzle schema and emits SQL diffs.
- **Hand-authored migrations** for expression indexes, partial
  indexes, RLS, triggers, or jsonb path expressions Drizzle can't
  express. Drop the file in `src/migrations/` and register it in
  `meta/_journal.json` (Drizzle reads the journal in order).
- **Production migrate**: `bun run db:migrate` (used by the deploy
  workflow before the api/worker boot — see
  `.github/workflows/deploy-fly.yaml`).
- **Drizzle Studio**: `bun run db:studio` opens a GUI against the
  configured DATABASE_URL.

## Connection pool

`connection.ts` builds a postgres.js pool with:

- Prepared statements (`prepare: true`) — Render/Neon/Fly all give us
  direct DB connections, not PgBouncer, so prepared statements actually
  cache.
- `fetch_types: true` — type cache populated once per connection.
- Configurable pool size via env (defaults: 10 workers, 5 web).
- Automatic `statement_timeout=120000` injection when `IS_CRON_JOB=true`
  (cron processors should not hang indefinitely).

`connection-monitor.ts` tracks per-request acquire/release/query counts
in an `AsyncLocalStorage` so the admin dashboard can show "this request
held 3 connections for 240ms across 8 queries."

## Tests

`bun test --preload ./packages/business/domain/test-preload.ts packages/business/domain --timeout 30000`

The schema itself has no logic to test — tables are declarations. The
domain layer's repository tests in `@scani/domain/tests/repositories/`
exercise the schema indirectly: each repo test inserts rows, queries
them, and asserts the constraints hold. A regression in any schema
file breaks the matching repo test.

Run a single repo test in isolation if the parallel suite shows
flakes (Postgres connection race when 35 test files contend for
`localhost:5433`).
