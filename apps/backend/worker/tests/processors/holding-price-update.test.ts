/**
 * SC-1545. A price refresh for a holding that had been deleted threw the use
 * case's plain `Holding not found`, was retried three times against a row
 * that was never coming back, and was then copied to the dead-letter queue.
 *
 * The lock and the use case are stubbed: what is under test is what the
 * processor makes of the refusal, and that it still lets go of the lock.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { RecordNotAccessibleError, UpdateHoldingPriceUseCase } from '@scani/domain';
import { PortfolioValueCache, VaultService } from '@scani/domain/services';
import {
  dropPricesOf,
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  pricingStack,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import type { HoldingPriceUpdateJob } from '@scani/jobs';
import {
  PostgresResourceLock,
  type ProcessorContext,
  UnrecoverableError,
  userFacingMessage,
} from '@scani/queue';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { Container } from 'typedi';
import { describeRefusedRecord } from '../../src/lib/request-refusal';
import { HoldingPriceUpdateProcessor } from '../../src/processors/holding-price-update';

restoreContainerAfterAll();

const JOB: HoldingPriceUpdateJob = {
  userId: 'user-1',
  requestId: 'req-1',
  holdingId: 'holding-1',
  priceUsd: 0,
  priceSource: 'manual-refresh',
};

const CTX = { job: { id: 'job-1' } } as unknown as ProcessorContext;

class TestableProcessor extends HoldingPriceUpdateProcessor {
  run(data: HoldingPriceUpdateJob) {
    return this.handle(data, CTX);
  }

  // Reads the user's base currency from the database, which is not the subject.
  protected override async resolveBaseToken(): Promise<Token> {
    return { id: 'token-usd', symbol: 'USD' } as Token;
  }
}

let released = 0;
afterEach(() => {
  released = 0;
});

async function failureOf(error: unknown): Promise<unknown> {
  Container.set(PostgresResourceLock, {
    acquire: async () => ({
      ok: true,
      release: async () => {
        released += 1;
      },
    }),
  } as unknown as PostgresResourceLock);
  Container.set(UpdateHoldingPriceUseCase, {
    execute: async () => {
      throw error;
    },
  } as unknown as UpdateHoldingPriceUseCase);
  try {
    await new TestableProcessor().run(JOB);
  } catch (err) {
    return err;
  }
  throw new Error('expected the processor to throw');
}

describe('HoldingPriceUpdateProcessor error classification', () => {
  test.each([
    ['a holding that is gone', 'Holding not found'],
    ['a holding that is not theirs', 'Unauthorized: Holding does not belong to user'],
  ])('%s fails on the first attempt, in words written for the owner', async (_name, message) => {
    const err = await failureOf(new RecordNotAccessibleError('holding', message));
    // RETRY_FAST allows three attempts; only this class skips the other two.
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('holding'));
    expect(released).toBe(1);
  });

  test('CONTROL: a failed price fetch keeps its class, so it is still retried', async () => {
    const err = await failureOf(new Error('socket hang up'));
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('socket hang up');
    expect(userFacingMessage(err)).toBeNull();
    expect(released).toBe(1);
  });
});

/**
 * Foundation A3, Task 7. The processor reads the user's base currency through
 * the global connection, so these rows are committed and removed after each
 * test. The use case is stubbed where what is under test is the base it is
 * handed, and real where it is the row the refresh writes.
 */
describe('HoldingPriceUpdateProcessor base currency', () => {
  const made = { users: [] as string[], tokens: [] as string[], institutions: [] as string[] };

  afterEach(async () => {
    const db = getDb();
    // Users first: their holdings are what keep the tokens restricted.
    const users = made.users.splice(0);
    if (users.length > 0) await db.delete(schema.users).where(inArray(schema.users.id, users));
    const tokens = made.tokens.splice(0);
    await dropPricesOf(tokens);
    if (tokens.length > 0) await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
    const institutions = made.institutions.splice(0);
    if (institutions.length > 0) {
      await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
    }
  });

  /** The seeded fiat token of a symbol: the fiat type and no market segment. */
  async function fiat(symbol: string): Promise<Token> {
    const [row] = await getDb()
      .select({ token: schema.tokens })
      .from(schema.tokens)
      .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(
        and(
          eq(schema.tokens.symbol, symbol),
          eq(schema.tokenTypes.code, 'fiat'),
          isNull(schema.tokens.marketSegment)
        )
      );
    if (!row) throw new Error(`the fiat ${symbol} is seeded by migration`);
    return row.token;
  }

  const fiatUsd = () => fiat('USD');

  async function commitToken(overrides: { symbol?: string; name?: string } = {}): Promise<Token> {
    const token = await getDb().transaction((tx) => makeToken(tx, overrides));
    made.tokens.push(token.id);
    return token;
  }

  function freeLock(): void {
    Container.set(PostgresResourceLock, {
      acquire: async () => ({ ok: true, release: async () => {} }),
    } as unknown as PostgresResourceLock);
  }

  function runProcessor(data: HoldingPriceUpdateJob): Promise<unknown> {
    const processor = new HoldingPriceUpdateProcessor();
    return (
      processor as unknown as {
        handle: (data: HoldingPriceUpdateJob, ctx: ProcessorContext) => Promise<unknown>;
      }
    ).handle(data, CTX);
  }

  /** The base the real processor hands the use case for a user with this base currency. */
  async function baseHandedFor(baseCurrencyId: string | null): Promise<unknown> {
    // Created now, and so after the fiat.
    await commitToken({ symbol: 'USD', name: 'A coin named USD' });
    const user = await getDb().transaction((tx) => makeUser(tx, { baseCurrencyId }));
    made.users.push(user.id);
    const handed: unknown[] = [];
    freeLock();
    Container.set(UpdateHoldingPriceUseCase, {
      execute: async (_holdingId: string, _userId: string, base: unknown) => {
        handed.push(base);
        return { success: true, price: null, source: 'unknown', timestamp: '', fetched: false };
      },
    } as unknown as UpdateHoldingPriceUseCase);
    Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);

    await runProcessor({ ...JOB, userId: user.id });

    expect(handed).toHaveLength(1);
    return handed[0];
  }

  test('the refresh button hands the use case the user’s base token, not its symbol', async () => {
    const usd = await fiatUsd();

    expect(await baseHandedFor(usd.id)).toMatchObject({ id: usd.id, symbol: 'USD' });
  });

  test('a user with no base currency is refreshed against the fiat USD', async () => {
    const usd = await fiatUsd();

    expect(await baseHandedFor(null)).toMatchObject({ id: usd.id, symbol: 'USD' });
  });

  // The user's base is not USD here, so a processor that ignored it and fell
  // to USD fails as surely as one that looked the symbol up. The use case and
  // the pricing stack are real, over a provider that records what it is asked.
  test('a user banking in the fiat EUR is refreshed against it, not a later crypto token named EUR', async () => {
    const eur = await fiat('EUR');
    // Created now, and so after the fiat.
    await commitToken({ symbol: 'EUR', name: 'A coin named EUR' });
    const token = await commitToken();
    const user = await getDb().transaction((tx) => makeUser(tx, { baseCurrencyId: eur.id }));
    made.users.push(user.id);
    const holding = await getDb().transaction(async (tx) => {
      // Upserted onto a seeded code, so no institution type outlives the test.
      const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
      const institution = await makeInstitution(tx, { typeId: type.id });
      made.institutions.push(institution.id);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      return makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '2',
      });
    });
    const asks = pricingStack();
    Container.set(VaultService, {
      recalculateVaultsForHolding: async () => {},
    } as unknown as VaultService);
    Container.set(UpdateHoldingPriceUseCase, new UpdateHoldingPriceUseCase());
    Container.set(PortfolioValueCache, { bust: async () => {} } as unknown as PortfolioValueCache);
    freeLock();

    const result = await runProcessor({ ...JOB, userId: user.id, holdingId: holding.id });

    expect(result).toMatchObject({ success: true, price: '100', fetched: true });
    expect(asks).toEqual([{ tokenId: token.id, baseId: eur.id }]);
    const written = await getDb()
      .select({ baseTokenId: schema.tokenPrices.baseTokenId })
      .from(schema.tokenPrices)
      .where(eq(schema.tokenPrices.tokenId, token.id));
    expect(written.map((row) => row.baseTokenId)).toEqual([eur.id]);
  });
});
