---
title: Adding a database migration
description: How to write, register, and verify a Drizzle migration against the Scani schema.
sidebar:
  order: 7
---

Schema changes happen through **Drizzle migrations** in
`packages/infra/db/src/migrations/`. The flow is mostly handled by
Drizzle Kit; the points where it isn't are documented here.

## The flow

1. **Edit the schema** in `packages/infra/db/src/schema/<file>.ts`.
   Drizzle introspects this when generating migrations.

2. **Generate the migration:**
   ```sh
   bun run --cwd packages/infra/db drizzle-kit generate
   ```
   This writes a new `NNNN_<name>.sql` file under
   `packages/infra/db/src/migrations/` and updates
   `meta/_journal.json`.

3. **Inspect the generated SQL.** Drizzle Kit handles most cases
   well, but:
   - **Expression indexes over jsonb paths** can't be generated.
     Write them in raw SQL within the same migration file.
   - **`COALESCE`-based unique constraints** (e.g. the tokens
     3-tuple) can't be expressed in Drizzle's builder; write them
     in raw SQL.
   - **Data backfills** (rewriting existing rows after a column
     type change) belong in the migration explicitly — Drizzle
     doesn't generate them.

4. **Add the migration to `meta/_journal.json`** if you wrote a
   custom SQL file by hand rather than generating one. The
   migration runner reads the journal, not the directory listing,
   so unjournaled files are silently skipped.

5. **Run it locally** against the dev Postgres:
   ```sh
   docker compose --profile migrate run --rm migrate
   ```
   Or, if you're running apps on the host:
   ```sh
   bun run packages/infra/db/src/migrate.ts
   ```

6. **Update tests.** Repository tests that use `withTestDb` pick
   up the new schema automatically. If you added a column / table,
   add tests covering it.

7. **Verify the round-trip.** A common foot-gun: Drizzle Kit
   regenerates a "no-op" migration if the schema and DB diverge
   subtly. Make sure
   ```sh
   bun run --cwd packages/infra/db drizzle-kit check
   ```
   passes after your migration applies cleanly.

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
- **Naming.** Drizzle picks names automatically; if you write a
  custom migration, prefix with the next sequential number and a
  descriptive snake-case suffix:
  `0061_add_market_segment_to_tokens.sql`.

## What the migration runner does

`packages/infra/db/src/migrate.ts`:

- Loads `DATABASE_URL` from `.env` (or `ROOT_ENV` override).
- Auto-detects SSL mode (`sslmode=disable` for localhost,
  `require` for remote).
- Opens a single Postgres connection (`max: 1`).
- Runs each unapplied migration from `meta/_journal.json` in
  order. Records each in `__drizzle_migrations`.
- Exits 0 on success, 1 on error.

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

Register the file in `meta/_journal.json`.

### Backfilling data

For a non-trivial backfill (more than a few thousand rows), prefer
a separate one-shot script over a migration — migrations should
finish in seconds.

For small backfills:

```sql
UPDATE holdings SET created_source = 'manual' WHERE source = 'manual';
```

## What not to do

- **Don't edit a migration after it's merged.** Once applied
  anywhere, the hash is recorded. Editing it makes the migrate
  runner believe the file is unapplied (different hash), which
  re-runs and likely fails. Add a *new* migration instead.
- **Don't drop and recreate a table to "fix" a migration.** All
  data in that table is lost.
- **Don't introduce a `down` migration.** Drizzle's runner
  doesn't use them; they encourage a workflow that's actively
  dangerous in production.

## See also

- [Engineering conventions](/contributing/conventions/)
- [Backup & restore](/self-hosting/tier1/backup-restore/)
- [Database schema](/reference/database-schema/)
