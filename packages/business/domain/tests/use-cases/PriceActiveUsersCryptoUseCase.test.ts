/**
 * Seeds are committed: the use case reads through the module-level
 * connection. PricingService is stubbed so the test sees exactly what the
 * provider would have been asked for, and with which window.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { recordRefusal } from '@scani/providers/core/refusals';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { CacheWriteCounter } from '../../src/services/feeds/CacheWriteCounter';
import { PricingService } from '../../src/services/pricing/PricingService';
import { ACTIVE_PRICE_WINDOW_MS } from '../../src/services/pricing/price-windows';
import { PriceActiveUsersCryptoUseCase } from '../../src/use-cases/PriceActiveUsersCryptoUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

restoreContainerAfterAll();

const NOW = new Date('2026-10-07T12:18:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);
const users: string[] = [];
const tokens: string[] = [];
const institutions: string[] = [];

async function seed() {
  return getDb().transaction(async (tx) => {
    const institution = await makeInstitution(tx);
    institutions.push(institution.id);
    const [stockType] = await tx
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'stock'));
    if (!stockType) throw new Error('no stock token type');
    const shared = await makeToken(tx);
    const onlyIdle = await makeToken(tx);
    const stock = await makeToken(tx, { typeId: stockType.id });
    const hidden = await makeToken(tx);
    const emptied = await makeToken(tx);
    tokens.push(shared.id, onlyIdle.id, stock.id, hidden.id, emptied.id);

    const person = async (
      appSeenAt: Date | null,
      held: Array<{ id: string; hidden?: boolean; balance?: string }>
    ) => {
      const user = await makeUser(tx, { appSeenAt });
      users.push(user.id);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      for (const token of held) {
        await makeHolding(tx, {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          isHidden: token.hidden ?? false,
          balance: token.balance ?? '100',
        });
      }
    };
    await person(minutesAgo(5), [
      { id: shared.id },
      { id: stock.id },
      { id: hidden.id, hidden: true },
      { id: emptied.id, balance: '0' },
    ]);
    await person(minutesAgo(19), [{ id: shared.id }]);
    await person(minutesAgo(25), [{ id: onlyIdle.id }]);
    await person(null, [{ id: onlyIdle.id }]);
    return { shared, onlyIdle, stock, hidden, emptied };
  });
}

let counted: Array<[string, number]> = [];

function stubPricing(asked: number) {
  counted = [];
  Container.set(CacheWriteCounter, {
    add: async (trigger: string, writes: number) => {
      counted.push([trigger, writes]);
    },
  } as unknown as CacheWriteCounter);
  const calls: Array<{ tokenIds: string[]; at: Date; windowMs: number | undefined }> = [];
  Container.set(PricingService, {
    fetchUnlessCurrent: async (ts: Token[], at: Date, windowMs?: number) => {
      calls.push({ tokenIds: ts.map((t) => t.id), at, windowMs });
      return { asked, cacheWrites: asked * 3 };
    },
  } as unknown as PricingService);
  return calls;
}

afterAll(async () => {
  const db = getDb();
  await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokens));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
});

describe('PriceActiveUsersCryptoUseCase (SC-1602)', () => {
  // The refusal record is process-wide; a 429 another file provoked must not make these back off.
  beforeEach(() => recordRefusal('coingecko', 0));

  test('asks once, for the visible crypto of users seen in the last 20 minutes, in the active window', async () => {
    const { shared } = await seed();
    const calls = stubPricing(1);

    const result = await new PriceActiveUsersCryptoUseCase().execute(NOW);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.tokenIds).toEqual([shared.id]);
    expect(calls[0]?.windowMs).toBe(ACTIVE_PRICE_WINDOW_MS);
    expect(result).toEqual({
      backedOff: false,
      activeUsers: 2,
      tokensHeld: 1,
      tokensAsked: 1,
      cacheWrites: 3,
    });
    expect(counted).toEqual([['active', 3]]);
  });

  test('with nobody seen in the last 20 minutes, the provider is not asked', async () => {
    const calls = stubPricing(0);
    const result = await new PriceActiveUsersCryptoUseCase().execute(minutesAgo(-60));
    expect(calls).toHaveLength(0);
    expect(result.activeUsers).toBe(0);
  });
  test('after a CoinGecko refusal it stands aside for an hour, then asks again', async () => {
    const at = minutesAgo(-120);
    const calls = stubPricing(0);
    recordRefusal('coingecko', at.getTime() - 59 * 60_000);
    expect((await new PriceActiveUsersCryptoUseCase().execute(at)).backedOff).toBe(true);
    expect(calls).toHaveLength(0);
    recordRefusal('coingecko', at.getTime() - 61 * 60_000);
    expect((await new PriceActiveUsersCryptoUseCase().execute(at)).backedOff).toBe(false);
  });
});
