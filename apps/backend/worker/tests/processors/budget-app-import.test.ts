import { describe, expect, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import {
  type BudgetAppImportOutcome,
  BudgetAppImportRefused,
  type BudgetAppImportRequest,
  BudgetAppImportService,
  type BudgetAppUndoOutcome,
  LearnedCategoryRules,
} from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { BudgetAppAccount } from '@scani/file-import';
import type { BudgetAppImportJob, BudgetAppImportUndoJob } from '@scani/jobs';
import { BullMqEnqueueService, type ProcessorContext, userFacingMessage } from '@scani/queue';
import { Container } from 'typedi';
import {
  BudgetAppImportProcessor,
  BudgetAppImportUndoProcessor,
} from '../../src/processors/budget-app-import';

restoreContainerAfterAll();

const ctx = {
  job: { id: 'job-1', timestamp: Date.parse('2026-10-09T12:00:00Z') },
  reportStatus: async () => {},
} as unknown as ProcessorContext;

class ExposedImport extends BudgetAppImportProcessor {
  run(data: BudgetAppImportJob) {
    return this.handle(data, ctx);
  }
}

class ExposedUndo extends BudgetAppImportUndoProcessor {
  run(data: BudgetAppImportUndoJob) {
    return this.handle(data, ctx);
  }
}

const REGISTER = [
  '"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"',
  '"Checking","","08/14/2026","Shop","","","","","$10.00","$0.00","Cleared"',
].join('\n');

const job: BudgetAppImportJob = {
  userId: 'u1',
  requestId: 'r1',
  r2Key: 'temp/file-import/u1/a.csv',
  app: 'ynab',
  currency: 'usd',
  accounts: [{ name: 'Checking', target: { kind: 'new', typeCode: 'checking' } }],
};

const outcome: BudgetAppImportOutcome = {
  importId: 'i1',
  summary: {
    app: 'ynab',
    currency: 'USD',
    accounts: [],
    transfersPaired: 0,
    transfersUnpaired: 0,
    skippedRows: [],
    budgetsDropped: true,
  },
  holdingIds: ['h1'],
  tokenIds: ['t1'],
  earliestChangedAt: new Date('2021-08-14T00:00:00Z'),
};

function setUp(file: string, service: Partial<BudgetAppImportService>) {
  const enqueued: Array<{ name: string; data: Record<string, unknown> }> = [];
  const learned: string[] = [];
  Container.set(LearnedCategoryRules, {
    afterImport: async (userId: string) => {
      learned.push(userId);
    },
  } as unknown as LearnedCategoryRules);
  Container.set(StorageFacade, {
    read: async () => Buffer.from(file, 'utf8'),
  } as unknown as StorageFacade);
  Container.set(BudgetAppImportService, service as BudgetAppImportService);
  Container.set(BullMqEnqueueService, {
    add: async (descriptor: { name: string }, data: Record<string, unknown>) => {
      enqueued.push({ name: descriptor.name, data });
      return 'job-2';
    },
  } as unknown as BullMqEnqueueService);
  return { enqueued, learned };
}

describe('budget-app-import processor (SC-1649)', () => {
  test('parses the file, imports the mapping, and rebuilds history back to the oldest row', async () => {
    const calls: Array<{ request: BudgetAppImportRequest; parsed: BudgetAppAccount[] }> = [];
    const { enqueued, learned } = setUp(REGISTER, {
      importRegister: async (request, parsed) => {
        calls.push({ request, parsed: [...parsed] });
        return outcome;
      },
    });

    const result = await new ExposedImport().run(job);
    expect(learned).toEqual(['u1']);

    expect(result).toEqual({ importId: 'i1', summary: outcome.summary });
    expect(calls[0]!.request).toMatchObject({
      currency: 'USD',
      uploadRef: job.r2Key,
      fetchedAt: new Date('2026-10-09T12:00:00Z'),
      accounts: job.accounts,
    });
    expect(calls[0]!.parsed.map((a) => [a.name, a.rows.length])).toEqual([['Checking', 1]]);
    expect(enqueued[0]?.data.tokenIds).toEqual(['t1']);
    expect(enqueued[0]?.data.lookbackDays as number).toBeGreaterThan(1800);
  });

  test('a file that is not a register fails at once, naming what to upload', async () => {
    let called = false;
    setUp('"Month","Budgeted"\n"Aug 2026","10"', {
      importRegister: async () => {
        called = true;
        return outcome;
      },
    });

    const error = await new ExposedImport().run(job).catch((e: unknown) => e);

    expect(userFacingMessage(error)).toContain('not a YNAB register');
    expect(called).toBe(false);
  });

  test("an Actual export is read with Actual's parser and imported as Actual", async () => {
    const calls: Array<{ request: BudgetAppImportRequest; parsed: BudgetAppAccount[] }> = [];
    setUp(
      [
        'Account,Date,Payee,Notes,Category_Group,Category,Amount,Split_Amount,Cleared',
        'Checking,2026-08-14,Shop,,,,-10,0,Cleared',
        'Checking,2026-08-15,Shop,(SPLIT INTO 2),,,0,-5,Cleared',
        'Checking,2026-08-15,Shop,(SPLIT 1 OF 2),,,-3,0,Cleared',
        'Checking,2026-08-15,Shop,(SPLIT 2 OF 2),,,-2,0,Cleared',
      ].join('\n'),
      {
        importRegister: async (request, parsed) => {
          calls.push({ request, parsed: [...parsed] });
          return outcome;
        },
      }
    );

    await new ExposedImport().run({ ...job, app: 'actual' });

    expect(calls[0]!.request).toMatchObject({ app: 'actual' });
    expect(calls[0]!.request.skippedRows).toEqual([{ line: 3, reason: 'split-parent' }]);
    expect(calls[0]!.parsed[0]!.rows.map((r) => r.amount)).toEqual(['-10', '-3', '-2']);
  });

  test('a Mint export is imported as Mint, its unsigned amounts signed by their type', async () => {
    const calls: Array<{ request: BudgetAppImportRequest; parsed: BudgetAppAccount[] }> = [];
    setUp(
      [
        'Date,Description,Original Description,Amount,Transaction Type,Category,Account Name,Labels,Notes',
        '9/01/2026,Employer,,100.00,credit,Paycheck,Checking,,',
        '9/03/2026,Grocer,,7.50,debit,Groceries,Checking,,',
      ].join('\n'),
      {
        importRegister: async (request, parsed) => {
          calls.push({ request, parsed: [...parsed] });
          return outcome;
        },
      }
    );

    await new ExposedImport().run({ ...job, app: 'mint' });

    expect(calls[0]!.request).toMatchObject({ app: 'mint' });
    expect(calls[0]!.parsed[0]!.rows.map((r) => r.amount)).toEqual(['100', '-7.5']);
  });

  test('a YNAB file sent as Actual fails at once, naming the Actual export', async () => {
    setUp(REGISTER, { importRegister: async () => outcome });

    const error = await new ExposedImport().run({ ...job, app: 'actual' }).catch((e: unknown) => e);

    expect(userFacingMessage(error)).toContain('not an Actual Budget export');
  });

  test('a refused account fails at once with its reason', async () => {
    setUp(REGISTER, {
      importRegister: async () => {
        throw new BudgetAppImportRefused('provider-fed', 'Checking');
      },
    });
    const error = await new ExposedImport().run(job).catch((e: unknown) => e);
    expect(userFacingMessage(error)).toContain('fed by a connected provider');
  });
});

describe('budget-app-import-undo processor (SC-1649)', () => {
  const undoJob: BudgetAppImportUndoJob = { userId: 'u1', requestId: 'r1', importId: 'i1' };

  test('undoes the upload and rebuilds history from its oldest row', async () => {
    const undone: BudgetAppUndoOutcome = {
      rowsRemoved: 4,
      accountsRemoved: 2,
      accountsKept: 0,
      holdingIds: ['h1'],
      earliestChangedAt: new Date('2021-08-14T00:00:00Z'),
    };
    const { enqueued } = setUp('', { undo: async () => undone });

    expect(await new ExposedUndo().run(undoJob)).toEqual(undone);
    expect(enqueued).toHaveLength(1);
  });

  test('an upload already undone, or not theirs, fails at once', async () => {
    setUp('', { undo: async () => null });
    const error = await new ExposedUndo().run(undoJob).catch((e: unknown) => e);
    expect(userFacingMessage(error)).toContain('already undone');
  });
});
