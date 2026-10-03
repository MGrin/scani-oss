import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  KeptHoldingNotFoundError,
  UnpriceableAirdropService,
} from '../../../src/services/holdings/UnpriceableAirdropService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

/**
 * Which wallet tokens the Review item offers to hide (SC-1469), against the
 * database rather than stubs: every exclusion below is a different column, and
 * a stub would only test that the stub was written the right way round.
 */

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-10-01T12:00:00Z');
const IN_COOLDOWN = new Date(NOW.getTime() + 24 * HOUR);

async function priceIt(tx: DatabaseTransaction, tokenId: string, baseTokenId: string) {
  await tx.insert(schema.tokenPrices).values({
    tokenId,
    baseTokenId,
    price: '1',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    granularity: 'daily',
  });
}

describe('UnpriceableAirdropService.listPending', () => {
  test('lists visible wallet tokens never priced and in cooldown, and nothing else', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const other = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const wallet = await makeAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
        name: 'MetaMask',
      });
      const otherWallet = await makeAccount(tx, {
        userId: other.id,
        institutionId: institution.id,
      });
      const usd = await makeToken(tx);

      const holdingOf = async (
        symbol: string,
        token: Partial<typeof schema.tokens.$inferInsert>,
        holding: Partial<typeof schema.holdings.$inferInsert> = {}
      ) => {
        const made = await makeToken(tx, { symbol: `${symbol}${crypto.randomUUID()}`, ...token });
        const row = await makeHolding(tx, {
          userId: user.id,
          accountId: wallet.id,
          tokenId: made.id,
          source: 'blockchain',
          ...holding,
        });
        return { token: made, holding: row };
      };

      const first = await holdingOf('AAA', { unpriceableUntil: IN_COOLDOWN });
      const second = await holdingOf('BBB', { unpriceableUntil: IN_COOLDOWN });

      // Priced once: it has a number, so nothing is left to ask.
      const priced = await holdingOf('PRICED', { unpriceableUntil: IN_COOLDOWN });
      await priceIt(tx, priced.token.id, usd.id);
      // Already hidden: it has been answered.
      await holdingOf('HIDDEN', { unpriceableUntil: IN_COOLDOWN }, { isHidden: true });
      // A human was shown it and kept it: that is an answer too.
      await holdingOf('KEPT', { unpriceableUntil: IN_COOLDOWN }, { arrival: 'user_confirmed' });
      // Typed in by the owner, not delivered by a sync.
      await holdingOf('MANUAL', { unpriceableUntil: IN_COOLDOWN }, { source: 'manual' });
      // Never priced, but the backfill has not given up on it yet.
      await holdingOf('FRESH', { unpriceableUntil: null });
      // Cooldown lapsed: about to be tried again.
      await holdingOf('LAPSED', { unpriceableUntil: new Date(NOW.getTime() - HOUR) });
      // The same kind of token in somebody else's wallet.
      const theirs = await makeToken(tx, { unpriceableUntil: IN_COOLDOWN });
      await makeHolding(tx, {
        userId: other.id,
        accountId: otherWallet.id,
        tokenId: theirs.id,
        source: 'blockchain',
      });

      const listed = await new UnpriceableAirdropService().listPending(user.id, tx, NOW);

      expect(listed.map((row) => row.holdingId).sort()).toEqual(
        [first.holding.id, second.holding.id].sort()
      );
      expect(listed[0]).toMatchObject({
        accountName: 'MetaMask',
        balance: '100',
        tokenTypeCode: 'crypto',
      });
    });
  });

  test('a token hidden or priced since it was listed leaves the list', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const wallet = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const usd = await makeToken(tx);
      const listedOne = async () => {
        const token = await makeToken(tx, { unpriceableUntil: IN_COOLDOWN });
        const holding = await makeHolding(tx, {
          userId: user.id,
          accountId: wallet.id,
          tokenId: token.id,
          source: 'blockchain',
        });
        return { token, holding };
      };
      const toHide = await listedOne();
      const toPrice = await listedOne();
      const service = new UnpriceableAirdropService();
      expect(await service.listPending(user.id, tx, NOW)).toHaveLength(2);

      await tx
        .update(schema.holdings)
        .set({ isHidden: true })
        .where(eq(schema.holdings.id, toHide.holding.id));
      await priceIt(tx, toPrice.token.id, usd.id);
      expect(await service.listPending(user.id, tx, NOW)).toEqual([]);
    });
  });

  test('a kept token is never listed again, so the count drops', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const wallet = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const listedOne = async () => {
        const token = await makeToken(tx, { unpriceableUntil: IN_COOLDOWN });
        return makeHolding(tx, {
          userId: user.id,
          accountId: wallet.id,
          tokenId: token.id,
          source: 'blockchain',
          arrival: 'auto_discovered',
        });
      };
      const toKeep = await listedOne();
      const stillAsked = await listedOne();
      const service = new UnpriceableAirdropService();
      expect(await service.listPending(user.id, tx, NOW)).toHaveLength(2);

      expect(await service.keep(user.id, [toKeep.id], tx)).toEqual([toKeep.id]);

      expect((await service.listPending(user.id, tx, NOW)).map((row) => row.holdingId)).toEqual([
        stillAsked.id,
      ]);
      const [kept] = await tx
        .select({ arrival: schema.holdings.arrival, isHidden: schema.holdings.isHidden })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, toKeep.id));
      // Kept is not hidden: it stays on every list, it just stops being asked about.
      expect(kept).toEqual({ arrival: 'user_confirmed', isHidden: false });
    });
  });

  test("keep refuses another user's holding and writes nothing", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const other = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const mine = await makeHolding(tx, {
        userId: user.id,
        accountId: (await makeAccount(tx, { userId: user.id, institutionId: institution.id })).id,
        tokenId: (await makeToken(tx, { unpriceableUntil: IN_COOLDOWN })).id,
        source: 'blockchain',
        arrival: 'auto_discovered',
      });
      const theirs = await makeHolding(tx, {
        userId: other.id,
        accountId: (await makeAccount(tx, { userId: other.id, institutionId: institution.id })).id,
        tokenId: (await makeToken(tx, { unpriceableUntil: IN_COOLDOWN })).id,
        source: 'blockchain',
        arrival: 'auto_discovered',
      });
      const service = new UnpriceableAirdropService();

      // One foreign id refuses the whole batch, including the owner's own row.
      await expect(service.keep(user.id, [mine.id, theirs.id], tx)).rejects.toBeInstanceOf(
        KeptHoldingNotFoundError
      );
      const arrivals = await tx
        .select({ id: schema.holdings.id, arrival: schema.holdings.arrival })
        .from(schema.holdings)
        .where(inArray(schema.holdings.id, [mine.id, theirs.id]));
      expect(arrivals.map((row) => row.arrival)).toEqual(['auto_discovered', 'auto_discovered']);
    });
  });
});
