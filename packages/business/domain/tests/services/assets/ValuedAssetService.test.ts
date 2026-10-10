import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { ValuedAssetService } from '../../../src/services/assets/ValuedAssetService';
import { BalanceAtTimeService } from '../../../src/services/pricing/BalanceAtTimeService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { CreateValuedAssetUseCase } from '../../../src/use-cases/CreateValuedAssetUseCase';
import { NothingHeldThenError } from '../../../src/use-cases/HandValuedHoldingUseCase';
import { withTestDb } from '../../../test/helpers/db';
import { makeUser } from '../../../test/helpers/factories';

/**
 * A valued asset (SC-1643): one holding of one unit, opened at its purchase
 * date, whose price per unit is its value. Every reading below goes through
 * the readers the rest of the product uses, not through the new classes.
 */

const _day = (iso: string) => new Date(`${iso}T00:00:00Z`);

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

const utcDay = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

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

describe('ValuedAssetService (SC-1643)', () => {
  test('a valuation dated before the purchase is refused', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const { holdingId } = await new CreateValuedAssetUseCase().execute(flat, user, tx);
      await expect(
        new ValuedAssetService().addValuation(
          { holdingId, occurredOn: '2020-01-01', value: '1' },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(NothingHeldThenError);
    });
  });

  test('two valuations on one day: the later is the value, the earlier is replaced', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const eur = await fiat(tx, 'EUR');
      const service = new ValuedAssetService();
      const { holdingId, tokenId } = await new CreateValuedAssetUseCase().execute(flat, user, tx);
      await service.addValuation(
        { holdingId, occurredOn: '2023-06-01', value: '330000' },
        user.id,
        tx
      );
      await service.addValuation(
        { holdingId, occurredOn: '2023-06-01', value: '333000' },
        user.id,
        tx
      );

      expect(await valueAt(tx, holdingId, tokenId, eur, new Date('2023-06-01T12:00:00Z'))).toBe(
        333000
      );
      const history = await service.history(holdingId, user.id, tx);
      const june = history.valuations.filter((v) => v.on === '2023-06-01');
      expect(june.map((v) => [v.value, v.replaced])).toEqual([
        ['330000', true],
        ['333000', false],
      ]);
      expect(history.purchase).toEqual({ on: '2021-04-12', price: '310000' });
      expect(history.current).toBe('355000');
      expect(history.gain).toBe('45000');
      expect(history.details).toEqual(flat.details);
    });
  });

  test("another user's asset reads as not found", async () => {
    await withTestDb(async (tx) => {
      const owner = await eurUser(tx);
      const other = await eurUser(tx);
      const { holdingId } = await new CreateValuedAssetUseCase().execute(flat, owner, tx);
      await expect(new ValuedAssetService().history(holdingId, other.id, tx)).rejects.toThrow();
    });
  });

  test('updateDetails renames it and replaces its details', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const service = new ValuedAssetService();
      const { holdingId } = await new CreateValuedAssetUseCase().execute(flat, user, tx);
      await service.updateDetails(
        { holdingId, name: 'Home', details: { kind: 'property', areaSqm: 80 } },
        user.id,
        tx
      );
      const history = await service.history(holdingId, user.id, tx);
      expect(history.details).toEqual({ kind: 'property', areaSqm: 80 });
      expect(history.name).toBe('Home');
    });
  });

  // Review I2: with no current value, the create wrote a purchase-price row
  // stamped now, which hid every valuation dated before the create day.
  test('with no current value, a backdated valuation becomes the value', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const eur = await fiat(tx, 'EUR');
      const service = new ValuedAssetService();
      const { currentValue: _, ...noCurrent } = flat;
      const { holdingId, tokenId } = await new CreateValuedAssetUseCase().execute(
        noCurrent,
        user,
        tx
      );
      await service.addValuation(
        { holdingId, occurredOn: utcDay(-30), value: '355000' },
        user.id,
        tx
      );

      expect(await valueAt(tx, holdingId, tokenId, eur, new Date())).toBe(355000);
      const history = await service.history(holdingId, user.id, tx);
      expect(history.current).toBe('355000');
      expect(history.valuations.map((v) => v.on)).toEqual(['2021-04-12', utcDay(-30)]);
    });
  });

  // Operator #23621: a correction entered at 10:00 must beat an original
  // stamped 18:00 the same day — it is stamped after the day's latest row,
  // never at the time of day it was typed.
  test('a 10:00 correction beats an 18:00 original on the same day', async () => {
    await withTestDb(async (tx) => {
      const user = await eurUser(tx);
      const eur = await fiat(tx, 'EUR');
      const service = new ValuedAssetService();
      const { holdingId, tokenId } = await new CreateValuedAssetUseCase().execute(flat, user, tx);
      await tx.insert(schema.tokenPrices).values({
        tokenId,
        baseTokenId: eur,
        price: '340000',
        timestamp: new Date('2023-06-01T18:00:00Z'),
        granularity: 'intraday',
        source: 'manual',
      } as typeof schema.tokenPrices.$inferInsert);

      await service.addValuation(
        { holdingId, occurredOn: '2023-06-01', value: '338000' },
        user.id,
        tx
      );

      expect(await valueAt(tx, holdingId, tokenId, eur, new Date('2023-06-01T23:00:00Z'))).toBe(
        338000
      );
      const june = (await service.history(holdingId, user.id, tx)).valuations.filter(
        (v) => v.on === '2023-06-01'
      );
      expect(june.map((v) => [v.value, v.replaced])).toEqual([
        ['340000', true],
        ['338000', false],
      ]);
    });
  });
});
