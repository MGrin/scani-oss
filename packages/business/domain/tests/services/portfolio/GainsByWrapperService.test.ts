import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { HISTORY_REBUILD_JOB_NAME } from '@scani/shared';
import { eq } from 'drizzle-orm';
import {
  type GainsByWrapper,
  GainsByWrapperService,
} from '../../../src/services/portfolio/GainsByWrapperService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

// SC-1645: per HOLDING, realized is its last valued row before the window
// subtracted from its last valued row in it, and unrealized is the latter,
// grouped by the bucket of the account's wrapper. Per holding and not per
// account because an account row drops a holding with no value that day,
// taking its lifetime realized gain with it (feeds, bus #24470).

const service = new GainsByWrapperService();
const NOW = new Date('2026-09-30T12:00:00.000Z');
const WINDOW = {
  kind: 'custom' as const,
  from: new Date('2026-09-01T00:00:00.000Z'),
  to: new Date('2026-09-30T00:00:00.000Z'),
};

async function world(tx: DatabaseTransaction) {
  const usd = await makeToken(tx);
  const user = await makeUser(tx, { baseCurrencyId: usd.id });
  const institution = await makeInstitution(tx);
  const typeId = async (code: string) => {
    const [row] = await tx
      .select({ id: schema.accountTypes.id })
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, code));
    if (!row) throw new Error(`account type ${code} not seeded`);
    return row.id;
  };
  /** An account holding one token; returns the holding. */
  const holding = async (
    wrapper: string | null,
    code = 'investment',
    extra: Partial<typeof schema.accounts.$inferInsert> = {}
  ) => {
    const account = await makeAccount(tx, {
      userId: user.id,
      institutionId: institution.id,
      typeId: await typeId(code),
      wrapper,
      ...extra,
    });
    const token = await makeToken(tx);
    const made = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
    });
    return { ...made, account };
  };
  const row = (
    holdingId: string,
    date: string,
    realized: string,
    unrealized: string,
    opts: { valued?: boolean; baseCurrencyId?: string } = {}
  ) =>
    tx.insert(schema.portfolioValueDaily).values({
      userId: user.id,
      scopeKind: 'holding',
      scopeId: holdingId,
      snapshotDate: date,
      baseCurrencyId: opts.baseCurrencyId ?? usd.id,
      totalValue: opts.valued === false ? '0' : '1000',
      coverageQuality: opts.valued === false ? 'unknown' : 'full',
      holdingsWithKnownValue: opts.valued === false ? 0 : 1,
      holdingsTotal: 1,
      realizedPnl: realized,
      unrealizedPnl: unrealized,
    });
  const compute = async (): Promise<Extract<GainsByWrapper, { status: 'ok' }>> => {
    const result = await service.compute(user.id, WINDOW, NOW, tx);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    return result;
  };
  return { usd, user, holding, row, compute };
}

type Ok = Extract<GainsByWrapper, { status: 'ok' }>;
const bucket = (result: Ok, treatment: string) =>
  result.buckets.find((b) => b.treatment === treatment);

describe('GainsByWrapperService (SC-1645)', () => {
  test('realized is end minus start, unrealized is at the end, per bucket', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const isa = await w.holding('isa');
      const plain = await w.holding(null);
      await w.row(isa.id, '2026-08-31', '100', '20');
      await w.row(isa.id, '2026-09-30', '250', '40');
      await w.row(plain.id, '2026-08-31', '0', '5');
      await w.row(plain.id, '2026-09-30', '30', '-10');

      const result = await w.compute();
      expect(result.buckets.map((b) => b.treatment)).toEqual([
        'general',
        'deferred',
        'exempt',
        'advantaged',
      ]);
      expect(bucket(result, 'exempt')).toEqual({
        treatment: 'exempt',
        realized: '150',
        unrealized: '40',
        accountCount: 1,
      });
      expect(bucket(result, 'general')).toEqual({
        treatment: 'general',
        realized: '30',
        unrealized: '-10',
        accountCount: 1,
      });
      expect(bucket(result, 'deferred')).toEqual({
        treatment: 'deferred',
        realized: '0',
        unrealized: '0',
        accountCount: 0,
      });
      expect(result.anyWrapped).toBe(true);
      expect(result.carriedHoldings).toBe(0);
    });
  });

  test('an account opened inside the window counts from zero', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const isa = await w.holding('isa');
      await w.row(isa.id, '2026-09-10', '5', '1');
      await w.row(isa.id, '2026-09-30', '20', '7');

      expect(bucket(await w.compute(), 'exempt')).toMatchObject({
        realized: '20',
        unrealized: '7',
        accountCount: 1,
      });
    });
  });

  test('no price on the last day keeps the lifetime gain, and says so', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const isa = await w.holding('isa');
      await w.row(isa.id, '2026-08-31', '100', '10');
      await w.row(isa.id, '2026-09-29', '120', '15');
      // The rollup writes a holding it cannot value with no realized gain.
      await w.row(isa.id, '2026-09-30', '0', '0', { valued: false });

      const result = await w.compute();
      expect(bucket(result, 'exempt')).toMatchObject({ realized: '20', unrealized: '15' });
      expect(result.carriedHoldings).toBe(1);
    });
  });

  test('no price on the day before the window does not book the lifetime gain', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const isa = await w.holding('isa');
      await w.row(isa.id, '2026-08-30', '100', '10');
      await w.row(isa.id, '2026-08-31', '0', '0', { valued: false });
      await w.row(isa.id, '2026-09-30', '130', '12');

      expect(bucket(await w.compute(), 'exempt')).toMatchObject({ realized: '30' });
    });
  });

  test('the wrapper read today groups the whole window', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const moved = await w.holding('isa');
      await w.row(moved.id, '2026-08-31', '0', '0');
      await w.row(moved.id, '2026-09-30', '12', '3');
      await tx
        .update(schema.accounts)
        .set({ wrapper: 'sipp' })
        .where(eq(schema.accounts.id, moved.account.id));

      const result = await w.compute();
      expect(bucket(result, 'deferred')).toMatchObject({ realized: '12', accountCount: 1 });
      expect(bucket(result, 'exempt')).toMatchObject({ realized: '0', accountCount: 0 });
    });
  });

  test('liability accounts are in no bucket', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const loan = await w.holding(null, 'loan');
      await w.row(loan.id, '2026-08-31', '0', '0');
      await w.row(loan.id, '2026-09-30', '-50', '-9');

      const result = await w.compute();
      expect(result.buckets.every((b) => b.accountCount === 0)).toBe(true);
      expect(bucket(result, 'general')).toMatchObject({ realized: '0', unrealized: '0' });
    });
  });

  test("the buckets sum to every asset account's figures", async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const holdings = [
        await w.holding('isa'),
        await w.holding('roth_ira'),
        await w.holding('sipp'),
        await w.holding('hsa'),
        await w.holding(null),
        await w.holding('tfsa', 'investment', { isActive: false }),
        await w.holding(null, 'investment', { isHidden: true }),
      ];
      let realized = 0;
      let unrealized = 0;
      for (const [i, h] of holdings.entries()) {
        await w.row(h.id, '2026-08-31', String(i), '0');
        await w.row(h.id, '2026-09-30', String(i * 3 + 1), String(i - 2));
        realized += i * 2 + 1;
        unrealized += i - 2;
      }

      const result = await w.compute();
      const sum = (key: 'realized' | 'unrealized') =>
        result.buckets.reduce((total, b) => total + Number(b[key]), 0);
      expect(sum('realized')).toBe(realized);
      expect(sum('unrealized')).toBe(unrealized);
      expect(result.buckets.reduce((n, b) => n + b.accountCount, 0)).toBe(holdings.length);
    });
  });

  test('a hidden, inactive or scam holding is in no bucket, as in Returns', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const kept = await w.holding('isa');
      const hidden = await w.holding('isa');
      const inactive = await w.holding('isa');
      const scam = await w.holding('isa');
      await tx
        .update(schema.holdings)
        .set({ isHidden: true, hiddenBy: 'user' })
        .where(eq(schema.holdings.id, hidden.id));
      await tx
        .update(schema.holdings)
        .set({ isActive: false })
        .where(eq(schema.holdings.id, inactive.id));
      await tx
        .update(schema.tokens)
        .set({ isScamProbability: 0.9 })
        .where(eq(schema.tokens.id, scam.tokenId));
      for (const h of [kept, hidden, inactive, scam]) {
        await w.row(h.id, '2026-08-31', '0', '0');
        await w.row(h.id, '2026-09-30', '10', '1');
      }

      expect(bucket(await w.compute(), 'exempt')).toMatchObject({
        realized: '10',
        unrealized: '1',
      });
    });
  });

  test('anyWrapped is false when no account has a wrapper', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const plain = await w.holding(null);
      await w.row(plain.id, '2026-09-30', '1', '1');

      expect((await w.compute()).anyWrapped).toBe(false);
    });
  });

  test('a history rebuild in flight withholds the figures', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const isa = await w.holding('isa');
      await w.row(isa.id, '2026-09-30', '10', '2');
      await tx.insert(schema.userJobs).values({
        jobId: `rebuild-${w.user.id}`,
        userId: w.user.id,
        jobName: HISTORY_REBUILD_JOB_NAME,
        state: 'active',
      });

      expect(await service.compute(w.user.id, WINDOW, NOW, tx)).toEqual({
        status: 'rebuilding',
        anyWrapped: true,
      });
    });
  });

  test('rollup arithmetic dust reads as zero, not as -1e-24', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const isa = await w.holding('isa');
      await w.row(isa.id, '2026-08-31', '0', '0');
      await w.row(isa.id, '2026-09-30', '0', '-1e-24');

      expect(bucket(await w.compute(), 'exempt')).toMatchObject({
        realized: '0',
        unrealized: '0',
      });
    });
  });

  test('CONTROL: rows in another base currency are not read', async () => {
    await withTestDb(async (tx) => {
      const w = await world(tx);
      const eur = await makeToken(tx);
      const isa = await w.holding('isa');
      await w.row(isa.id, '2026-09-30', '10', '2');
      await w.row(isa.id, '2026-09-30', '999', '999', { baseCurrencyId: eur.id });

      expect(bucket(await w.compute(), 'exempt')).toMatchObject({
        realized: '10',
        unrealized: '2',
      });
    });
  });
});
