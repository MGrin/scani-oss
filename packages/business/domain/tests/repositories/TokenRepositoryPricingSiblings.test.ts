import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { TokenRepository } from '../../src/repositories/TokenRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeToken } from '../../test/helpers/factories-extra';

/**
 * SC-198. One asset is routinely spread across several token rows — USDC is
 * held on `evm:1`, `evm:8453` and a `(generic)` row — and only some of them
 * accumulate prices, so a holding on the wrong row shows no value while an
 * identical holding beside it shows one. `findPricingSiblings` is what lets
 * the unpriced row borrow from its twin.
 *
 * The KEY is the whole design, and these tests exist because the wrong key
 * is both obvious and catastrophic. Keying on the symbol would be a smaller
 * query and would put a real dollar figure on a user's net worth derived
 * from a coin they do not hold.
 */
const repo = () => Container.get(TokenRepository);

describe('findPricingSiblings', () => {
  test('rows sharing a coingecko id are siblings', async () => {
    await withTestDb(async (tx) => {
      const a = await makeToken(tx, {
        symbol: 'USDCA',
        providerMetadata: { coingecko: { id: 'usd-coin' } },
      });
      const b = await makeToken(tx, {
        symbol: 'USDCB',
        providerMetadata: { coingecko: { id: 'usd-coin' } },
      });

      const siblings = await repo().findPricingSiblings([a.id], tx);
      expect(siblings.get(a.id)).toContain(b.id);
      // Never itself — a row cannot borrow its own missing price.
      expect(siblings.get(a.id)).not.toContain(a.id);
    });
  });

  /**
   * THE HONEST COLLISION. Production holds two rows with symbol `TRUMP`:
   *
   *   OFFICIAL TRUMP  (generic)            369 prices
   *   DogTrump        evm:8453:0x62f8…       0 prices, HELD
   *
   * They are different coins. A symbol-keyed fallback would have priced a
   * DogTrump holding as Official Trump — no attacker involved, just two
   * projects choosing the same ticker.
   *
   * Neither row carries a `coingecko.id`, so the correct outcome is that
   * the held row borrows NOTHING and stays visibly unpriced. That is not a
   * gap in the feature; it is the feature declining to invent a number.
   */
  test('a shared SYMBOL is not a sibling — different assets collide on tickers', async () => {
    await withTestDb(async (tx) => {
      const held = await makeToken(tx, { symbol: 'TRUMP', name: 'DogTrump' });
      const other = await makeToken(tx, {
        symbol: 'TRUMP',
        name: 'OFFICIAL TRUMP',
        marketSegment: 'generic-official',
      });

      const siblings = await repo().findPricingSiblings([held.id], tx);
      expect(siblings.get(held.id)).toBeUndefined();
      expect(siblings.has(other.id)).toBe(false);
    });
  });

  /**
   * THE ATTACK, same conclusion by a different route. Nine production rows
   * exist whose entire purpose is to carry a symbol matching another
   * token's. A quarantined row must never DONATE a price: handing `UЅDС`
   * the real USDC figure would give a fake holding a credible value, which
   * is worse than showing nothing.
   *
   * Asserted as a test rather than left to the `lookalike_of IS NULL`
   * clause, because a bare WHERE clause reads as a performance filter to
   * the next person and deleting it would not fail anything.
   */
  test('a quarantined lookalike row is never a donor, even sharing the id', async () => {
    await withTestDb(async (tx) => {
      const real = await makeToken(tx, {
        symbol: 'USDCREAL',
        providerMetadata: { coingecko: { id: 'usd-coin-x' } },
      });
      const impostor = await makeToken(tx, {
        symbol: 'USDCFAKE',
        lookalikeOf: 'USDC',
        providerMetadata: { coingecko: { id: 'usd-coin-x' } },
      });

      // The real row does not see the impostor as a source...
      expect(
        await repo()
          .findPricingSiblings([real.id], tx)
          .then((m) => m.get(real.id))
      ).toBeUndefined();
      // ...and the impostor is not itself a borrower either, so it cannot
      // acquire the real row's price by the reverse route.
      expect(
        await repo()
          .findPricingSiblings([impostor.id], tx)
          .then((m) => m.get(impostor.id))
      ).toBeUndefined();
    });
  });

  test('a row with no coingecko id has no siblings at all', async () => {
    await withTestDb(async (tx) => {
      const orphan = await makeToken(tx, { symbol: 'ORPHAN' });
      await makeToken(tx, {
        symbol: 'OTHER',
        providerMetadata: { coingecko: { id: 'something' } },
      });
      const siblings = await repo().findPricingSiblings([orphan.id], tx);
      expect(siblings.get(orphan.id)).toBeUndefined();
    });
  });

  test('an empty request does no work', async () => {
    await withTestDb(async (tx) => {
      expect((await repo().findPricingSiblings([], tx)).size).toBe(0);
    });
  });
});
