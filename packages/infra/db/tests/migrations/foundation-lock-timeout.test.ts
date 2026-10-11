import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import path from 'node:path';
import postgres from 'postgres';
import { sqlWithoutComments } from '../../src/migration-reconciliation';
import { applyMigrations } from '../../src/migration-runner';

/**
 * The runner applies every pending migration in one transaction, each file as
 * one multi-statement query (`applyMigrations`). An `ALTER TABLE holdings`
 * that queues behind a long open transaction would otherwise hold every later
 * query on `holdings` behind it with no bound, while the transaction already
 * blocks writes to the tables locked before it. Each foundation migration sets
 * the bound first, so a contended deploy fails loudly and is retried.
 */
const FOUNDATION_MIGRATIONS = [
  '20261001075512_foundation_feeds_inputs_rules_decisions_outbox.sql',
  '20261001080323_foundation_evidence_columns.sql',
  '20261001082312_foundation_engine_writer_guard_disabled.sql',
  '20261001142145_foundation_engine_shadow_reports.sql',
  '20261002114109_feed_input_windows_unique_per_fetch.sql',
  '20261002220617_holding_transactions_unique_per_input.sql',
  '20261007143836_engine_writer_guard_compares_values_on_three_columns.sql',
  '20261008134839_engine_writer_guard_enabled.sql',
  '20261008174525_holding_hidden_balance.sql',
  '20261009091400_user_backups.sql',
  '20261009113611_budget_app_imports.sql',
  '20261009115442_feed_input_windows_shape.sql',
  '20261009145654_agent_writes_carry_an_idempotency_key.sql',
  '20261009163407_households_members_invites_account_shares.sql',
];
const BOUND = "SET LOCAL lock_timeout = '5s';";
const EVIDENCE_COLUMNS = FOUNDATION_MIGRATIONS[1] as string;

const DATABASE_URL = process.env.DATABASE_URL;

let runner: postgres.Sql;
let holder: postgres.Sql;
const schemas: string[] = [];

beforeAll(() => {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for migration lock tests');
  runner = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  holder = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
});

afterAll(async () => {
  for (const schema of schemas) await runner.unsafe(`drop schema if exists "${schema}" cascade`);
  await runner.end();
  await holder.end();
});

function migration(name: string): Promise<string> {
  return Bun.file(new URL(`../../src/migrations/${name}`, import.meta.url)).text();
}

/** The evidence-columns migration, alone in a folder, pending against a tracking table of its own. */
async function applyEvidenceColumns(): Promise<{ code: string | undefined; elapsedMs: number }> {
  const dir = path.join(process.env.TMPDIR ?? '/tmp', `scani-lock-${crypto.randomUUID()}`);
  await Bun.write(path.join(dir, EVIDENCE_COLUMNS), await migration(EVIDENCE_COLUMNS));
  const schema = `mig_${crypto.randomUUID().replace(/-/g, '')}`;
  schemas.push(schema);
  const started = Date.now();
  try {
    await applyMigrations(runner, {
      folder: dir,
      schema,
      table: 'applied',
      legacyTable: 'legacy_drizzle',
      declarations: [],
    });
  } catch (err) {
    return { code: (err as { code?: string }).code, elapsedMs: Date.now() - started };
  }
  return { code: undefined, elapsedMs: Date.now() - started };
}

describe('foundation migrations bound their lock waits', () => {
  test('each sets lock_timeout before its first statement', async () => {
    for (const name of FOUNDATION_MIGRATIONS) {
      const statements = sqlWithoutComments(await migration(name)).trim();
      expect({ name, first: statements.slice(0, BOUND.length) }).toEqual({ name, first: BOUND });
    }
  });

  test('a migration queued behind an open transaction on holdings gives up within the bound', async () => {
    // CONTROL: the session has no bound of its own, so one seen below is the file's.
    const [setting] = await runner`SHOW lock_timeout`;
    expect(setting?.lock_timeout).toBe('0');

    const outcome = await holder.begin(async (h) => {
      await h`LOCK TABLE holdings IN ACCESS SHARE MODE`;
      return applyEvidenceColumns();
    });

    expect(outcome.code).toBe('55P03');
    expect(outcome.elapsedMs).toBeGreaterThanOrEqual(4_500);
    expect(outcome.elapsedMs).toBeLessThan(15_000);
  });

  test('CONTROL: uncontended, the same run reaches the statement at once', async () => {
    // The columns exist in this already-migrated database, so the ALTER that
    // waited above now runs and is refused for a reason of its own.
    const outcome = await applyEvidenceColumns();

    expect(outcome.code).toBe('42701');
    expect(outcome.elapsedMs).toBeLessThan(4_500);
  });
});
