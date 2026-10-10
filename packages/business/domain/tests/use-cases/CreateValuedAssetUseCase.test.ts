import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { ValuedAssetService } from '../../src/services/assets/ValuedAssetService';
import { PnLAtTimeService } from '../../src/services/portfolio/PnLAtTimeService';
import { BalanceAtTimeService } from '../../src/services/pricing/BalanceAtTimeService';
import { CostBasisService } from '../../src/services/pricing/CostBasisService';
import { PriceReader } from '../../src/services/pricing/PriceReader';
import { CreateValuedAssetUseCase } from '../../src/use-cases/CreateValuedAssetUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeUser } from '../../test/helpers/factories';

/**
 * A valued asset (SC-1643): one holding of one unit, opened at its purchase
 * date, whose price per unit is its value. Every reading below goes through
 * the readers the rest of the product uses, not through the new classes.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

async function fiat(tx: DatabaseTransaction, symbol: string): Promise<string> {
  const [row] = await tx
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
    .where(and(eq(schema.tokens.symbol, symbol), eq(schema.tokenTypes.code, 'fiat')));
  if (!row) throw new Error(`fiat ${symbol} is not seeded`);
  return row.id;
}

async function eurUser(tx: DatabaseTransaction) {
  return makeUser(tx, { baseCurrencyId: await fiat(tx, 'EUR') });
}

const flat = {
  name: 'Lisbon flat',
  currencyCode: 'EUR',
  purchaseDate: '2021-04-12',
  purchasePrice: '310000',
  currentValue: '355000',
  details: { kind: 'property' as const, address: 'Rua X 1', areaSqm: 72 },
};

async function valueAt(
  tx: DatabaseTransaction,
  holdingId: string,
  tokenId: string,
  base: string,
  at: Date
) {
  const { balance } = await new BalanceAtTimeService().getBalance(holdingId, at, tx);
  if (balance === null || Number(balance) === 0) return 0;
  const price = (await new PriceReader().at([tokenId], base, at, tx)).get(tokenId);
  return price ? Number(balance) * Number(price.price) : null;
}

describe('CreateValuedAssetUseCase (SC-1643)', () => {
  test('nothing before the purchase date, the purchase price on it, the current value today', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const eur = await fiat(tx, 'EUR');
      const { holdingId, tokenId, fromDay } = await new CreateValuedAssetUseCase().execute(
        flat,
        user,
        tx
      );

      expect(fromDay).toBe('2021-04-12');
      expect(await valueAt(tx, holdingId, tokenId, eur, day('2021-04-11'))).toBe(0);
      expect(await valueAt(tx, holdingId, tokenId, eur, new Date('2021-04-12T12:00:00Z'))).toBe(
        310000
      );
      expect(await valueAt(tx, holdingId, tokenId, eur, new Date())).toBe(355000);

      const [type] = await tx
        .select({ code: schema.tokenTypes.code })
        .from(schema.tokens)
        .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
        .where(eq(schema.tokens.id, tokenId));
      expect(type?.code).toBe('property');
    });
  });

  // Q5 (operator #23634, feeds #23644): an opening buy of one unit at the
  // purchase price, at the opening instant, so the engine's basis is the
  // purchase price and a gain is never read as 0%.
  test('its cost basis is the purchase price, from one opening buy', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const eur = await fiat(tx, 'EUR');
      const { holdingId } = await new CreateValuedAssetUseCase().execute(flat, user, tx);
      const basis = await new CostBasisService().getCostBasis(holdingId, new Date(), eur, { tx });
      expect(basis.basisQuality).toBe('known');
      expect(basis.costBasis.toNumber()).toBe(310000);
      expect(basis.openQty.toNumber()).toBe(1);

      const ledger = await tx
        .select()
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.holdingId, holdingId));
      expect(ledger.map((r) => [r.kind, r.quantity, r.occurredAt.toISOString()])).toEqual([
        ['buy', '1', '2021-04-12T00:00:00.000Z'],
      ]);
      // No double count: the buy explains the opening observation.
      const now = await new BalanceAtTimeService().getBalance(holdingId, new Date(), tx);
      expect(Number(now.balance)).toBe(1);
    });
  });

  test('a 310k purchase now valued at 400k reads +90k in PnL', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const eur = await fiat(tx, 'EUR');
      await new CreateValuedAssetUseCase().execute({ ...flat, currentValue: '400000' }, user, tx);
      const pnl = await new PnLAtTimeService().getPnL(user.id, new Date(), eur, { tx });
      expect(pnl.totalValueInBase.toNumber()).toBe(400000);
      expect(pnl.totalCostBasis.toNumber()).toBe(310000);
      expect(pnl.totalUnrealizedPnl.toNumber()).toBe(90000);
    });
  });

  test('with no current value it stays at the purchase price, with no gain', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const eur = await fiat(tx, 'EUR');
      const { currentValue: _, ...noCurrent } = flat;
      const { holdingId, tokenId } = await new CreateValuedAssetUseCase().execute(
        noCurrent,
        user,
        tx
      );
      expect(await valueAt(tx, holdingId, tokenId, eur, new Date())).toBe(310000);
      const history = await new ValuedAssetService().history(holdingId, user.id, tx);
      expect(history.gain).toBe('0');
    });
  });

  test('a euro asset values through FX for a dollar-base user', async () => {
    await withTestDb(async (tx) => {
      const usd = await fiat(tx, 'USD');
      const eur = await fiat(tx, 'EUR');
      const user = await makeUser(tx, { baseCurrencyId: usd });
      await tx.insert(schema.tokenPrices).values({
        tokenId: eur,
        baseTokenId: usd,
        price: '1.1',
        timestamp: new Date(Date.now() - 60_000),
        granularity: 'intraday',
        source: 'test',
      } as typeof schema.tokenPrices.$inferInsert);
      const { holdingId, tokenId } = await new CreateValuedAssetUseCase().execute(flat, user, tx);
      const value = await valueAt(tx, holdingId, tokenId, usd, new Date());
      expect(value).toBeCloseTo(355000 * 1.1, 2);
    });
  });
});
