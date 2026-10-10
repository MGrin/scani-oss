import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { BudgetAppImportService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';
import { makeAuthedCaller, makeUnauthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

const REQUEST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const IMPORT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function user(id: string): typeof schema.users.$inferSelect {
  return {
    id,
    email: `${id}@scani.local`,
    name: 'Test User',
    baseCurrencyId: null,
    image: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.users.$inferSelect;
}

function captureEnqueues() {
  const enqueued: Array<{ name: string; data: Record<string, unknown> }> = [];
  Container.set(BullMqEnqueueService, {
    add: async (descriptor: { name: string }, data: Record<string, unknown>) => {
      enqueued.push({ name: descriptor.name, data });
      return 'job-1';
    },
  } as unknown as BullMqEnqueueService);
  return enqueued;
}

const start = (r2Key: string, accounts: Array<{ name: string; target: unknown }>) => ({
  r2Key,
  requestId: REQUEST,
  app: 'ynab' as const,
  currency: 'USD',
  accounts: accounts as never,
});

describe('budgetAppImports.start (SC-1649)', () => {
  test('queues the import of the caller’s own upload with the mapping', async () => {
    const enqueued = captureEnqueues();
    const accounts = [{ name: 'Checking', target: { kind: 'new', typeCode: 'checking' } }];

    const result = await makeAuthedCaller(user('u-1')).budgetAppImports.start(
      start('temp/file-import/u-1/a.csv', accounts)
    );

    expect(result).toEqual({ jobId: 'job-1' });
    expect(enqueued).toEqual([
      {
        name: 'budget-app-import',
        data: {
          userId: 'u-1',
          requestId: REQUEST,
          r2Key: 'temp/file-import/u-1/a.csv',
          app: 'ynab',
          currency: 'USD',
          accounts,
        },
      },
    ]);
  });

  test('queues an Actual Budget import the same way', async () => {
    const enqueued = captureEnqueues();
    const accounts = [
      { name: 'Checking', target: { kind: 'skip' } },
      { name: 'Cash', target: { kind: 'new', typeCode: 'checking' } },
    ];

    await makeAuthedCaller(user('u-1')).budgetAppImports.start({
      ...start('temp/file-import/u-1/a.csv', accounts),
      app: 'actual',
    });

    expect(enqueued[0]?.data).toMatchObject({ app: 'actual' });
  });

  test('refuses another account’s upload, and queues nothing', async () => {
    const enqueued = captureEnqueues();
    await expect(
      makeAuthedCaller(user('u-1')).budgetAppImports.start(
        start('temp/file-import/u-2/a.csv', [{ name: 'A', target: { kind: 'skip' } }])
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(enqueued).toEqual([]);
  });

  test('refuses a mapping that skips every account', async () => {
    const enqueued = captureEnqueues();
    await expect(
      makeAuthedCaller(user('u-1')).budgetAppImports.start(
        start('temp/file-import/u-1/a.csv', [{ name: 'A', target: { kind: 'skip' } }])
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(enqueued).toEqual([]);
  });

  test('refuses two of the file’s accounts into one scani account', async () => {
    const enqueued = captureEnqueues();
    const into = { kind: 'existing', accountId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
    await expect(
      makeAuthedCaller(user('u-1')).budgetAppImports.start(
        start('temp/file-import/u-1/a.csv', [
          { name: 'A', target: into },
          { name: 'B', target: into },
        ])
      )
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(enqueued).toEqual([]);
  });

  test('rejects an unauthenticated caller', async () => {
    await expect(
      makeUnauthedCaller().budgetAppImports.start(
        start('temp/file-import/u-1/a.csv', [{ name: 'A', target: { kind: 'skip' } }])
      )
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('budgetAppImports.undo and list (SC-1649)', () => {
  test('undo queues a job scoped to the caller', async () => {
    const enqueued = captureEnqueues();
    await makeAuthedCaller(user('u-1')).budgetAppImports.undo({
      importId: IMPORT_ID,
      requestId: REQUEST,
    });
    expect(enqueued).toEqual([
      {
        name: 'budget-app-import-undo',
        data: { userId: 'u-1', requestId: REQUEST, importId: IMPORT_ID },
      },
    ]);
  });

  test('list counts the accounts and rows each upload wrote, asking about the caller', async () => {
    const asked: string[] = [];
    Container.set(BudgetAppImportService, {
      listImports: async (userId: string) => {
        asked.push(userId);
        return [
          {
            id: IMPORT_ID,
            app: 'ynab',
            createdAt: new Date('2026-10-09T12:00:00Z'),
            undoneAt: null,
            summary: {
              accounts: [
                { name: 'A', accountId: 'a1', rowsInserted: 3 },
                { name: 'B', accountId: 'a2', rowsInserted: 2 },
                { name: 'C', accountId: null, rowsInserted: 0 },
              ],
            },
          },
        ];
      },
    } as unknown as BudgetAppImportService);

    const result = await makeAuthedCaller(user('u-1')).budgetAppImports.list();

    expect(asked).toEqual(['u-1']);
    expect(result).toEqual([
      {
        id: IMPORT_ID,
        app: 'ynab',
        createdAt: '2026-10-09T12:00:00.000Z',
        undoneAt: null,
        accounts: 2,
        rows: 5,
      },
    ]);
  });
});
