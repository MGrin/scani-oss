process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { formatCurrency } from '@scani/shared';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { WeeklyDigestService } from '../../../src/services/digest/WeeklyDigestService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValueCache } from '../../../src/services/portfolio/PortfolioValueCache';
import { PricingService } from '../../../src/services/pricing/PricingService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

/**
 * SC-1228. The weekly digest quoted a large holding the app leaves out of its
 * total. The digest read the rollup's user-scope row, which is the
 * rollup's own sum; the dashboard applies `isIncludedInTotal`. So these tests
 * compare the digest with the dashboard itself, on real rows, and write the
 * user-scope row the way a stale or inactive-counting rollup leaves it — with
 * the excluded holding IN it — so a digest that still reads that row fails.
 */

const NOW = new Date('2026-08-19T09:00:00.000Z');
const BASELINE = '2026-08-11';
const AS_OF = '2026-08-18';

/** The visible holding, in the base currency so the dashboard needs no price. */
const VISIBLE = { balance: '1000', baseline: '900' };
/** The large holding, priced at 1 by the stub below. */
const LARGE = { balance: '500000', baseline: '400000' };

type Flags = { holdingHidden?: boolean; holdingInactive?: boolean; accountHidden?: boolean };

interface Seeded {
  userId: string;
  baseCurrencyId: string;
  /** The digest formats in the base token's own symbol. */
  baseSymbol: string;
}

const suffix = randomUUID().slice(0, 6);
const cleanup = {
  userIds: [] as string[],
  tokenIds: [] as string[],
  tokenTypeId: '',
  institutionTypeId: '',
  institutionId: '',
  accountTypeId: '',
};
let largeTokenId = '';

async function seed(flags: Flags): Promise<Seeded> {
  const [base] = await db
    .insert(schema.tokens)
    .values({
      symbol: `DGUSD${randomUUID().slice(0, 6)}`,
      name: 'USD',
      typeId: cleanup.tokenTypeId,
    })
    .returning();
  if (!base) throw new Error('base token insert failed');
  cleanup.tokenIds.push(base.id);

  const [user] = await db
    .insert(schema.users)
    .values({
      email: `digest-scope-${randomUUID().slice(0, 8)}@scani.local`,
      name: 'Digest Scope',
      baseCurrencyId: base.id,
    })
    .returning();
  if (!user) throw new Error('user insert failed');
  cleanup.userIds.push(user.id);

  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: cleanup.institutionId,
      name: 'Digest Scope Account',
      typeId: cleanup.accountTypeId,
      isHidden: flags.accountHidden ?? false,
    })
    .returning();
  if (!account) throw new Error('account insert failed');

  const [visible, large] = await db
    .insert(schema.holdings)
    .values([
      { userId: user.id, accountId: account.id, tokenId: base.id, balance: VISIBLE.balance },
      {
        userId: user.id,
        accountId: account.id,
        tokenId: largeTokenId,
        balance: LARGE.balance,
        isHidden: flags.holdingHidden ?? false,
        isActive: !(flags.holdingInactive ?? false),
      },
    ])
    .returning();
  if (!visible || !large) throw new Error('holding insert failed');

  const row = (scopeKind: string, scopeId: string, snapshotDate: string, totalValue: string) => ({
    userId: user.id,
    scopeKind,
    scopeId,
    snapshotDate,
    baseCurrencyId: base.id,
    totalValue,
    coverageQuality: 'full',
    holdingsWithKnownValue: scopeKind === 'user' ? 2 : 1,
    holdingsTotal: scopeKind === 'user' ? 2 : 1,
  });
  const sum = (a: string, b: string) => String(Number(a) + Number(b));
  await db
    .insert(schema.portfolioValueDaily)
    .values([
      row('user', user.id, BASELINE, sum(VISIBLE.baseline, LARGE.baseline)),
      row('user', user.id, AS_OF, sum(VISIBLE.balance, LARGE.balance)),
      row('holding', visible.id, BASELINE, VISIBLE.baseline),
      row('holding', visible.id, AS_OF, VISIBLE.balance),
      row('holding', large.id, BASELINE, LARGE.baseline),
      row('holding', large.id, AS_OF, LARGE.balance),
    ]);

  return { userId: user.id, baseCurrencyId: base.id, baseSymbol: base.symbol };
}

async function readBoth(s: Seeded) {
  const outcome = await Container.get(WeeklyDigestService).buildFor(
    { id: s.userId, baseCurrencyId: s.baseCurrencyId },
    NOW
  );
  const dashboard = await Container.get(PortfolioValuationService).getUserPortfolioValue(s.userId);
  const money = (n: number) => formatCurrency(n, s.baseSymbol);
  return { digest: outcome.digest, dashboardTotal: Number(dashboard.totalValue), money };
}

beforeAll(async () => {
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `dgs-${suffix}`, name: 'Digest Scope Token Type' })
    .returning();
  cleanup.tokenTypeId = tokenType!.id;
  const [large] = await db
    .insert(schema.tokens)
    .values({ symbol: `DGBIG${suffix.toUpperCase()}`, name: 'Big', typeId: tokenType!.id })
    .returning();
  largeTokenId = large!.id;
  cleanup.tokenIds.push(large!.id);
  const [institutionType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `dgs-inst-${suffix}`, name: 'Digest Scope Institution Type' })
    .returning();
  cleanup.institutionTypeId = institutionType!.id;
  const [institution] = await db
    .insert(schema.institutions)
    .values({ name: 'Digest Scope Bank', typeId: institutionType!.id })
    .returning();
  cleanup.institutionId = institution!.id;
  const [accountType] = await db
    .insert(schema.accountTypes)
    .values({ code: `dgs-acct-${suffix}`, name: 'Digest Scope Account Type' })
    .returning();
  cleanup.accountTypeId = accountType!.id;

  Container.set(PricingService, {
    getCachedTokenPrices: async () => new Map([[largeTokenId, '1']]),
    resolveFiatRatesToBase: async () => new Map(),
  } as unknown as PricingService);
  Container.set(PortfolioValueCache, {
    getOrCompute: async (_key: string, factory: () => Promise<unknown>) => factory(),
    bust: async () => {},
  } as unknown as PortfolioValueCache);
  Container.set(PortfolioValuationService, new PortfolioValuationService());
  Container.set(WeeklyDigestService, new WeeklyDigestService());
});

afterAll(async () => {
  if (cleanup.userIds.length > 0) {
    await db.delete(schema.users).where(inArray(schema.users.id, cleanup.userIds));
  }
  if (cleanup.tokenIds.length > 0) {
    await db.delete(schema.tokens).where(inArray(schema.tokens.id, cleanup.tokenIds));
  }
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, cleanup.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, cleanup.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, cleanup.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, cleanup.institutionTypeId));
});

const largeSymbol = () => `DGBIG${suffix.toUpperCase()}`;

describe('WeeklyDigestService — the total is the dashboard total (SC-1228)', () => {
  test.each([
    ['hidden', { holdingHidden: true }],
    ['inactive', { holdingInactive: true }],
  ] as const)('a %s holding is in neither the headline nor the movers', async (_name, flags) => {
    const { digest, dashboardTotal, money } = await readBoth(await seed(flags));
    expect(dashboardTotal).toBe(1000);
    expect(digest?.netWorth).toBe(money(dashboardTotal));
    expect(digest?.change?.amount).toBe(`+${money(100)}`);
    expect(digest?.movers.map((m) => m.symbol)).not.toContain(largeSymbol());
  });

  // The control: the same fixture with no flag. Without it, a digest that
  // dropped the large holding for any reason would pass the case above.
  test('with no flag set, both holdings count, in the digest and on the dashboard', async () => {
    const { digest, dashboardTotal, money } = await readBoth(await seed({}));
    expect(dashboardTotal).toBe(501000);
    expect(digest?.netWorth).toBe(money(dashboardTotal));
    expect(digest?.movers[0]?.symbol).toBe(largeSymbol());
  });

  // `accounts.is_hidden` is not part of `isIncludedInTotal`, and the dashboard
  // does not read it, so the digest follows the dashboard here too. Whether a
  // hidden account should leave every total is a separate decision, and it
  // would change the shared rule, not this service.
  test('a hidden account moves the digest exactly as it moves the dashboard', async () => {
    const { digest, dashboardTotal, money } = await readBoth(await seed({ accountHidden: true }));
    expect(digest?.netWorth).toBe(money(dashboardTotal));
  });
});
