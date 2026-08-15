import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { TokenRepository } from '../../src/repositories/TokenRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeToken } from '../../test/helpers/factories-extra';

/**
 * `findNeverPricedInCooldownTokenIds` decides which holdings stop counting
 * against the net-worth chart's coverage figure, so the fixture below is
 * the production shape rather than a minimal one (SC-146).
 *
 * The row that matters most is `USDT`: on the real account it carries
 ***REMOVED***
 ***REMOVED***
 * catches the spam removes Tether from the portfolio. A test without that
 * row would have passed the naive fix.
 */

const repo = () => Container.get(TokenRepository);

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-08-14T12:00:00Z');
const IN_COOLDOWN = new Date(NOW.getTime() + 24 * HOUR);

async function priceIt(
  tx: DatabaseTransaction,
  tokenId: string,
  baseTokenId: string
): Promise<void> {
  await tx.insert(schema.tokenPrices).values({
    tokenId,
    baseTokenId,
    price: '1',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    granularity: 'daily',
  });
}

describe('TokenRepository.findNeverPricedInCooldownTokenIds', () => {
  test('matches airdrop dust exactly and leaves priced tokens alone', async () => {
    await withTestDb(async (tx) => {
      const usd = await makeToken(tx, { symbol: 'USDX', isScamProbability: 0 });

      // A normal asset: clean score, priced, no cooldown.
      const btc = await makeToken(tx, { symbol: 'BTCX', isScamProbability: 0 });
      await priceIt(tx, btc.id, usd.id);

      // The trap. Same 0.3 score as the spam below, but it has prices —
      // and, to make the point sharper than production does, a live
      // cooldown too. Prices alone must be enough to save it.
      const usdt = await makeToken(tx, {
        symbol: 'USDTX',
        isScamProbability: 0.3,
        unpriceableUntil: IN_COOLDOWN,
      });
      await priceIt(tx, usdt.id, usd.id);

      // The dust: unsolicited, never quoted once, cooling down.
      const spam: string[] = [];
      for (const symbol of ['AC0R', 'BDR', 'CLOUD', 'DISCOPUSSY']) {
        const t = await makeToken(tx, {
          symbol,
          isScamProbability: 0.3,
          unpriceableUntil: IN_COOLDOWN,
        });
        spam.push(t.id);
      }

      // Never priced, but the cooldown has lapsed — we are about to try
      // again, so it is "not priced yet", not "unpriceable".
      const lapsed = await makeToken(tx, {
        symbol: 'LAPSED',
        isScamProbability: 0.3,
        unpriceableUntil: new Date(NOW.getTime() - HOUR),
      });

      // Never priced and never attempted — a token added minutes ago.
      const fresh = await makeToken(tx, { symbol: 'FRESH', isScamProbability: 0 });

      const held = [btc.id, usdt.id, ...spam, lapsed.id, fresh.id];
      const found = await repo().findNeverPricedInCooldownTokenIds(held, NOW, tx);

      expect([...found].sort()).toEqual([...spam].sort());
      expect(found.has(usdt.id)).toBe(false);
      expect(found.has(btc.id)).toBe(false);
      expect(found.has(lapsed.id)).toBe(false);
      expect(found.has(fresh.id)).toBe(false);
    });
  });

  test('a price row in any base currency disqualifies the token', async () => {
    await withTestDb(async (tx) => {
      const eur = await makeToken(tx, { symbol: 'EURX' });
      // Priced only against EUR while the user's base is USD. The token
      // has a market; whether we can convert it today is the price
      // graph's problem, not grounds for erasing the holding from the
      // denominator.
      const token = await makeToken(tx, { symbol: 'ONLYEUR', unpriceableUntil: IN_COOLDOWN });
      await priceIt(tx, token.id, eur.id);

      const found = await repo().findNeverPricedInCooldownTokenIds([token.id], NOW, tx);
      expect(found.size).toBe(0);
    });
  });

  test('scopes to the ids it is given and no-ops on an empty list', async () => {
    await withTestDb(async (tx) => {
      const dust = await makeToken(tx, { symbol: 'DUSTX', unpriceableUntil: IN_COOLDOWN });

      // Someone else's dust must not appear in this user's count.
      expect((await repo().findNeverPricedInCooldownTokenIds([], NOW, tx)).size).toBe(0);
      expect((await repo().findNeverPricedInCooldownTokenIds([dust.id], NOW, tx)).size).toBe(1);
    });
  });
});
