/**
 * SC-1545. Three user jobs reached the dead-letter queue in production for a
 * request that was refused, not for a failure: an account that was somebody
 * else's, an account that was gone, a holding that was gone. Each refusal left
 * the domain layer as a plain `Error`, so the worker could not tell it from a
 * dropped socket, retried it, and filed it for a post-mortem.
 *
 * These pin the throw sites, and two things about each. The class, because it
 * is the only thing the worker can read. And the message, because the API
 * routers show it and it must not move.
 *
 * No database: every lookup is stubbed, so a wrong class cannot hide behind a
 * connection error.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import type { User } from '@scani/db/schema';
import { parseStatement } from '@scani/file-import';
import { StatementTransactionIngester } from '@scani/ingesters';
import { Container } from 'typedi';
import { RecordNotAccessibleError } from '../../src/lib/record-not-accessible';
import { AccountRepository } from '../../src/repositories/AccountRepository';
import { HoldingCoverageRepository } from '../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../src/repositories/HoldingRepository';
import { InstitutionRepository } from '../../src/repositories/InstitutionRepository';
import { AccountService } from '../../src/services/accounts/AccountService';
import { FeedIngestService } from '../../src/services/feeds/FeedIngestService';
import { legacyStatementBatch } from '../../src/services/feeds/legacy/statement-batch';
import { TransactionImportCoordinator } from '../../src/services/transactions/TransactionImportCoordinator';
import { CreateHoldingsWithDependenciesUseCase } from '../../src/use-cases/CreateHoldingsWithDependenciesUseCase';
import { RefreshAccountBalanceUseCase } from '../../src/use-cases/RefreshAccountBalanceUseCase';
import { UpdateHoldingPriceUseCase } from '../../src/use-cases/UpdateHoldingPriceUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

restoreContainerAfterAll();

const USER = 'user-1';
const STRANGER = 'user-2';
const ACCOUNT = 'acct-1';
const HOLDING = 'holding-1';

const restores: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore();
});

/** Answers the one `select … from … where … limit` these two classes run by hand. */
function accountQueryReturns(rows: unknown[]): void {
  restores.push(
    spyOn(db, 'select').mockImplementation((() => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    })) as unknown as typeof db.select)
  );
}

function holdingLookupReturns(row: unknown): void {
  Container.set(HoldingRepository, {
    findById: async () => row,
    findUnsyncedByAccountAndTokens: async () => [],
  } as unknown as HoldingRepository);
}

async function refusalOf(run: () => Promise<unknown>): Promise<RecordNotAccessibleError> {
  const failure = await run().then(
    () => null,
    (error: unknown) => error
  );
  expect(failure).toBeInstanceOf(RecordNotAccessibleError);
  return failure as RecordNotAccessibleError;
}

describe('AccountService.getAccountById', () => {
  const serviceOver = (row: unknown) => {
    Container.set(AccountRepository, { findById: async () => row } as unknown as AccountRepository);
    return new AccountService();
  };

  test('an account that does not exist', async () => {
    const refusal = await refusalOf(() => serviceOver(null).getAccountById(USER, ACCOUNT));
    expect(refusal.record).toBe('account');
    expect(refusal.message).toBe(`Account with ID ${ACCOUNT} not found`);
  });

  test("somebody else's account", async () => {
    const refusal = await refusalOf(() =>
      serviceOver({ id: ACCOUNT, userId: STRANGER }).getAccountById(USER, ACCOUNT)
    );
    expect(refusal.record).toBe('account');
    expect(refusal.message).toBe('Access denied to this account');
  });

  test("CONTROL: the requester's own account is returned", async () => {
    const own = { id: ACCOUNT, userId: USER };
    expect(await serviceOver(own).getAccountById(USER, ACCOUNT)).toBe(own as never);
  });
});

// SC-1558. A manual entry that names an institution which is gone, or is
// another user's own, was a plain Error out of `createAccount`: the job has no
// retries, so it was dead-lettered and alerted on as a defect.
describe('AccountService.createAccount', () => {
  const INSTITUTION = 'inst-1';
  const NEW_ACCOUNT = { institutionId: INSTITUTION, name: 'Everyday', typeId: 'type-1' };
  const serviceOver = (isVisibleTo: () => Promise<boolean>) => {
    Container.set(InstitutionRepository, { isVisibleTo } as unknown as InstitutionRepository);
    return new AccountService();
  };

  test('an institution that is gone, or is not theirs', async () => {
    const refusal = await refusalOf(() =>
      serviceOver(async () => false).createAccount(NEW_ACCOUNT as never, USER)
    );
    expect(refusal.record).toBe('institution');
    expect(refusal.message).toBe(`Institution with ID ${INSTITUTION} not found`);
  });

  test('CONTROL: a visibility lookup that fails is not a refusal', async () => {
    const lookupFailed = new Error('Failed query: select from "institutions"');
    const failure = await serviceOver(async () => {
      throw lookupFailed;
    })
      .createAccount(NEW_ACCOUNT as never, USER)
      .then(
        () => null,
        (error: unknown) => error
      );
    expect(failure).toBe(lookupFailed);
    expect(failure).not.toBeInstanceOf(RecordNotAccessibleError);
  });
});

describe('UpdateHoldingPriceUseCase', () => {
  const useCaseOver = (row: unknown) => {
    holdingLookupReturns(row);
    return new UpdateHoldingPriceUseCase();
  };

  test('a holding that does not exist', async () => {
    const refusal = await refusalOf(() => useCaseOver(null).execute(HOLDING, USER, 'USD'));
    expect(refusal.record).toBe('holding');
    expect(refusal.message).toBe('Holding not found');
  });

  test("somebody else's holding", async () => {
    const refusal = await refusalOf(() =>
      useCaseOver({ id: HOLDING, userId: STRANGER }).execute(HOLDING, USER, 'USD')
    );
    expect(refusal.record).toBe('holding');
    expect(refusal.message).toBe('Unauthorized: Holding does not belong to user');
  });
});

describe('CreateHoldingsWithDependenciesUseCase, a balance update naming a holding', () => {
  const updateOver = (row: unknown) => {
    holdingLookupReturns(row);
    Container.set(AccountService, {
      getAccountById: async () => ({ id: ACCOUNT, userId: USER, institutionId: null }),
    } as unknown as AccountService);
    return new CreateHoldingsWithDependenciesUseCase().execute(
      { accountId: ACCOUNT, holdings: [], updateHoldings: [{ holdingId: HOLDING, balance: '10' }] },
      { id: USER, baseCurrencyId: 'token-usd' } as User,
      // Caller-owned, so the use case opens no transaction of its own.
      {} as DatabaseTransaction
    );
  };

  test('a holding that does not exist', async () => {
    const refusal = await refusalOf(() => updateOver(null));
    expect(refusal.record).toBe('holding');
    expect(refusal.message).toBe(`Holding ${HOLDING} not found`);
  });

  test("somebody else's holding", async () => {
    const refusal = await refusalOf(() => updateOver({ id: HOLDING, userId: STRANGER }));
    expect(refusal.record).toBe('holding');
    expect(refusal.message).toBe(`Holding ${HOLDING} does not belong to the user`);
  });
});

describe('RefreshAccountBalanceUseCase', () => {
  test('a holding that does not exist, or is not theirs', async () => {
    holdingLookupReturns(null);
    const refusal = await refusalOf(() =>
      new RefreshAccountBalanceUseCase().execute({ userId: USER, holdingId: HOLDING })
    );
    expect(refusal.record).toBe('holding');
    expect(refusal.message).toBe('Holding not found or not owned by user');
  });

  test('an account that does not exist, or is not theirs', async () => {
    accountQueryReturns([]);
    const refusal = await refusalOf(() =>
      new RefreshAccountBalanceUseCase().execute({ userId: USER, accountId: ACCOUNT })
    );
    expect(refusal.record).toBe('account');
    expect(refusal.message).toBe(`Account ${ACCOUNT} not found or not owned by user`);
  });
});

describe('TransactionImportCoordinator', () => {
  const importOver = (rows: unknown[]) => {
    accountQueryReturns(rows);
    // A failed run retracts the account's complete-history claim; that write is
    // not the subject and has no database to reach here.
    Container.set(HoldingCoverageRepository, {
      retractCompleteHistoryClaim: async () => 0,
    } as unknown as HoldingCoverageRepository);
    return new TransactionImportCoordinator().execute({
      userId: USER,
      accountId: ACCOUNT,
      source: 'bybit-api',
    });
  };

  test('an account that does not exist', async () => {
    const refusal = await refusalOf(() => importOver([]));
    expect(refusal.record).toBe('account');
    expect(refusal.message).toBe(`TransactionImport: account ${ACCOUNT} not found`);
  });

  test("somebody else's account", async () => {
    const refusal = await refusalOf(() => importOver([{ id: ACCOUNT, userId: STRANGER }]));
    expect(refusal.record).toBe('account');
    expect(refusal.message).toBe(
      `TransactionImport: account ${ACCOUNT} does not belong to user ${USER}`
    );
  });
});

describe('FeedIngestService', () => {
  // The batch a statement upload builds, so the validator passes it and the
  // ownership question is the first thing that can refuse.
  const STATEMENT = [
    'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance,id',
    'CARD_PAYMENT,Current,2026-08-01T10:00:00Z,2026-08-01T10:00:00Z,Salary ACME,1000.00,0.00,EUR,COMPLETED,1000.00,',
  ].join('\n');

  test('a batch for an account the user does not have', async () => {
    Container.set(AccountRepository, {
      findByIdAndUser: async () => null,
    } as unknown as AccountRepository);
    const result = Container.get(StatementTransactionIngester).ingest({
      accountId: ACCOUNT,
      parseResult: await parseStatement(STATEMENT, 'import.csv'),
    });
    const batch = legacyStatementBatch({
      userId: USER,
      accountId: ACCOUNT,
      result,
      uploadRef: 'upload-1',
      fetchedAt: new Date(),
    });

    const refusal = await refusalOf(() => new FeedIngestService().ingest(batch));
    expect(refusal.record).toBe('account');
    expect(refusal.message).toBe(`FeedIngestService: user ${USER} has no account ${ACCOUNT}`);
  });
});
