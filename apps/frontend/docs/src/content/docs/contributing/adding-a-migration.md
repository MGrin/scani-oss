---
title: Adding a database migration
description: How to write, register, and verify a Drizzle migration against the Scani schema.
sidebar:
  order: 7
---

Schema changes happen through SQL files in
`packages/infra/db/src/migrations/`. A migration is **one file and
nothing else** — no index to pick, no registry to edit.

## The flow

1. **Create the file:**
   ```sh
   bun run db:new "what it does"
   ```
   That writes `packages/infra/db/src/migrations/<UTC
   stamp>_<slug>.sql` — for example
   `20260817143012_holding_label.sql` — and prints the path.

2. **Write the SQL.** If the change is a plain schema edit, mirror
   it in `packages/infra/db/src/schema/<file>.ts` so the ORM model
   and the database agree. Separate statements with
   `--> statement-breakpoint` if any of them must not share a
   prepared batch.

3. **Run it locally** against the dev Postgres:
   ```sh
   docker compose --profile migrate run --rm migrate
   ```
   Or, if you're running apps on the host:
   ```sh
   bun run db:migrate
   ```

4. **Update tests.** Repository tests that use `withTestDb` pick
   up the new schema automatically. If you added a column / table,
   add tests covering it.

## Why the filename is a timestamp

Migrations used to be numbered `0001`, `0002`, … and registered in
`meta/_journal.json`. Both were **shared, contended resources**, and
four migrations collided in a single day because of it: a branch
reads the highest number when it starts, `main` moves while it
works, and by the time the pull request opens the number is stale.
Checking again does not help — the correct answer depends on which
of the open branches merges first, which has not happened yet.

A timestamp is not a claim about what else exists, so nothing can
invalidate it. Two people adding a migration each add exactly one
file; the merge is clean in either order. `meta/_journal.json` is
generated on demand (`bun run db:journal`) for Drizzle Kit and is
not tracked in git.

`0000`–`0050` keep their four-digit names permanently: they are
applied in production, and renaming an applied migration is worse
than the problem this fixed. A new file in that range is rejected
by the build.

## Conventions

- **Additive whenever possible.** New columns are nullable (or
  have defaults) so the old code can keep writing. Drop a column
  in a *separate, later* migration after every deployment has
  rolled forward.
- **Index changes are non-blocking by default in Postgres 16.**
  But for large tables, prefer `CREATE INDEX CONCURRENTLY` in a
  raw-SQL migration; Drizzle Kit doesn't generate `CONCURRENTLY`.
- **Migrations are forward-only.** There's no `down` step. Roll
  back by `pg_restore` from a pre-migration backup.
- **Naming.** `bun run db:new "<what it does>"` picks it. Don't
  hand-write a filename — the slug is lower-snake-case and the
  prefix is a UTC timestamp, and the build rejects anything else.

## What the migration runner does

`packages/infra/db/src/migrate.ts`:

- Loads `DATABASE_URL` from `.env` (or `ROOT_ENV` override).
- Auto-detects SSL mode (`sslmode=disable` for localhost,
  `require` for remote).
- Opens a single Postgres connection (`max: 1`).
- Reads the migrations **folder**, in filename order, and applies
  every file whose name is not already recorded in
  `drizzle.__scani_migrations`. One row per migration — so
  "already applied" is a fact about that migration, never about
  the newest one.
- Takes a Postgres advisory lock first, so two overlapping deploys
  queue rather than race.
- Refuses, rather than guessing, when the tree and the database
  disagree: an applied migration whose file was edited, and an
  applied migration whose file is gone, are both hard stops that
  name the migration.
- Exits 0 on success, 1 on error.

On first run against a database migrated before this change, it
adopts the rows already in `drizzle.__drizzle_migrations` and
reports any migration whose file has since been edited. If that
table is unavailable (a restored dump), name the last applied
migration explicitly:

```sh
bun run db:migrate -- --assume-applied-through 0050_sc357_rekey_solana_to_net_per_token
```

## Common patterns

### Adding a column with a default

```ts
// schema/holdings.ts
export const holdings = pgTable('holdings', {
  // ...
  notes: text('notes'),                                    // nullable, no default
  createdSource: text('created_source').notNull().default('manual'),
});
```

Then `drizzle-kit generate`. The migration uses `ALTER TABLE ...
ADD COLUMN ...` which is non-blocking in Postgres 16 for nullable
columns and columns with constant defaults.

### Adding an index

```ts
export const holdings = pgTable(
  'holdings',
  { /* ... */ },
  (table) => ({
    notesIdx: index('idx_holdings_notes').on(table.notes),
  })
);
```

For large tables, replace with raw SQL:

```sql
CREATE INDEX CONCURRENTLY idx_holdings_notes ON holdings (notes);
```

### Adding a jsonb expression index

Drizzle can't generate this. Write the migration by hand:

```sql
CREATE INDEX idx_tokens_etherscan_contract
  ON tokens ((provider_metadata->'etherscan'->>'contractAddress'))
  WHERE provider_metadata->'etherscan'->>'contractAddress' IS NOT NULL;
```

### Backfilling data

For a non-trivial backfill (more than a few thousand rows), prefer
a separate one-shot script over a migration — migrations should
finish in seconds.

For small backfills:

```sql
UPDATE holdings SET created_source = 'manual' WHERE source = 'manual';
```

## What not to do

- **Don't edit a migration after it's merged.** The runner records
  the hash of every migration it applies and **refuses to run** if
  a file has changed since — because the edit would change nothing
  on any database that already has it, which is the silent version
  of the same problem. Add a *new* migration instead.
- **Don't rename or delete an applied migration.** Same refusal,
  from the other direction: the database is the record of what ran.
- **Don't drop and recreate a table to "fix" a migration.** All
  data in that table is lost.
- **Don't introduce a `down` migration.** Drizzle's runner
  doesn't use them; they encourage a workflow that's actively
  dangerous in production.

## See also

- [Engineering conventions](/contributing/conventions/)
- [Backup & restore](/self-hosting/tier1/backup-restore/)
- [Database schema](/reference/database-schema/)
