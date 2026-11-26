import { expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { BackupRestorer } from '../../../src/services/backup/BackupRestorer';
import type { BackupRecord } from '../../../src/services/backup/BackupWriter';
import { BACKED_UP_TABLES, BACKUP_VERSION } from '../../../src/services/backup/backup-plan';
import { USER_DATA_TABLE_DISPOSITIONS } from '../../../src/use-cases/user-data-deletion-manifest';

const name = (t: PgTable) => getTableConfig(t).name;

test('format4 budgets belong to both data manifests, after categories on export and before on erasure', () => {
  expect(BACKUP_VERSION).toBe(4);
  const backup = BACKED_UP_TABLES.map((e) => name(e.table));
  const erase = USER_DATA_TABLE_DISPOSITIONS.map((e) => name(e.table));
  expect(backup).toContain('monthly_category_budgets');
  expect(backup.indexOf('monthly_category_budgets')).toBeGreaterThan(
    backup.indexOf('transaction_categories')
  );
  expect(erase).toContain('monthly_category_budgets');
  expect(erase.indexOf('monthly_category_budgets')).toBeLessThan(
    erase.indexOf('transaction_categories')
  );
});

test('root eligibility is a non-null native composite foreign key', () => {
  const table = (schema as unknown as Record<string, PgTable>).monthlyCategoryBudgets;
  expect(table).toBeDefined();
  const config = getTableConfig(table!);
  const columns = getTableColumns(table!);
  for (const key of ['userId', 'categoryId', 'requiresRoot', 'tokenId', 'month', 'limit'])
    expect(columns[key]?.notNull).toBe(true);
  const fk = config.foreignKeys.find(
    (f) => name(f.reference().foreignTable) === 'transaction_categories'
  );
  expect(fk?.reference().columns.map((c) => c.name)).toEqual([
    'category_id',
    'user_id',
    'requires_root',
  ]);
  expect(fk?.onDelete).toBe('restrict');
  expect(fk?.onUpdate).toBe('restrict');
});

for (const version of [1, 2, 3, 4]) {
  test(`A refuses a budget-bearing format${version} before any database access`, async () => {
    const records: BackupRecord[] = [
      {
        type: 'header',
        format: 'scani-backup',
        version,
        exportedAt: '2026-11-25T00:00:00Z',
        notIncluded: [],
      },
      { type: 'row', table: 'monthly_category_budgets', row: { id: 'invalid-on-purpose' } },
      { type: 'end', records: 3, counts: { monthly_category_budgets: 1 } },
    ];
    await expect(
      new BackupRestorer().restore('no-database-user', async function* () {
        yield* records;
      })
    ).rejects.toMatchObject({ reason: 'budgets-not-supported' });
  });
}

for (const version of [0, -1, 1.5, Number.NaN]) {
  test(`invalid format version ${version} is refused before database access`, async () => {
    await expect(
      new BackupRestorer().restore('no-database-user', async function* () {
        yield {
          type: 'header',
          format: 'scani-backup',
          version,
          exportedAt: '2026-11-25T00:00:00Z',
          notIncluded: [],
        };
        yield { type: 'end', records: 2, counts: {} };
      })
    ).rejects.toMatchObject({ reason: 'not-a-backup' });
  });
}

test('compatibility A has no API, worker, domain or UI budget producer references', async () => {
  const repo = new URL('../../../../../../', import.meta.url).pathname;
  const references: string[] = [];
  let inspected = 0;
  for (const pattern of [
    'packages/business/domain/src/**/*.ts',
    'apps/**/src/**/*.ts',
    'apps/**/src/**/*.tsx',
  ]) {
    for await (const path of new Bun.Glob(pattern).scan(repo)) {
      inspected++;
      const source = await Bun.file(`${repo}${path}`).text();
      if (/monthlyCategoryBudgets|monthly_category_budgets|categories\.budgets/.test(source))
        references.push(path);
    }
  }
  expect(inspected).toBeGreaterThan(3);
  expect(references.sort()).toEqual([
    'packages/business/domain/src/services/backup/BackupRestorer.ts',
    'packages/business/domain/src/services/backup/backup-plan.ts',
    'packages/business/domain/src/use-cases/user-data-deletion-manifest.ts',
  ]);
});
