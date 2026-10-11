import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  InvalidLiabilityTerms,
  LiabilityAccountNotFound,
  LiabilityTermsOnAssetAccount,
  LiabilityTermsService,
  userToday,
} from '../../../src/services/liabilities/LiabilityTermsService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

const service = () => Container.get(LiabilityTermsService);

const loanTerms = {
  kind: 'loan' as const,
  annualRatePct: '3.5',
  termMonths: 360,
  startDate: '2026-01-15',
  originalPrincipal: '500000',
};

async function typeId(tx: DatabaseTransaction, code: string): Promise<string> {
  const [row] = await tx
    .select({ id: schema.accountTypes.id })
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, code));
  if (!row) throw new Error(`account type ${code} not seeded`);
  return row.id;
}

async function setup(tx: DatabaseTransaction, accountType: string) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, {
    userId: user.id,
    institutionId: institution.id,
    typeId: await typeId(tx, accountType),
  });
  return { user, account };
}

describe('LiabilityTermsService.set', () => {
  test('saves terms on a liability account and reads them back', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'mortgage');
      await service().set(user.id, account.id, loanTerms, tx);
      const read = await service().get(user.id, account.id, tx);
      expect(read?.termMonths).toBe(360);
      expect(read?.originalPrincipal).toBe('500000');
    });
  });

  test('refuses terms on an asset account', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'checking');
      await expect(service().set(user.id, account.id, loanTerms, tx)).rejects.toBeInstanceOf(
        LiabilityTermsOnAssetAccount
      );
    });
  });

  test("another user's account reads as not found", async () => {
    await withTestDb(async (tx) => {
      const { account } = await setup(tx, 'mortgage');
      const stranger = await makeUser(tx);
      await expect(service().set(stranger.id, account.id, loanTerms, tx)).rejects.toBeInstanceOf(
        LiabilityAccountNotFound
      );
    });
  });

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  for (const [name, patch] of [
    ['a rate over 100', { annualRatePct: '101' }],
    ['a zero-month term', { termMonths: 0 }],
    ['a term over 1200 months', { termMonths: 1201 }],
    ['a start date in the future', { startDate: tomorrow }],
  ] as const) {
    test(`refuses ${name}`, async () => {
      await withTestDb(async (tx) => {
        const { user, account } = await setup(tx, 'loan');
        await expect(
          service().set(user.id, account.id, { ...loanTerms, ...patch }, tx)
        ).rejects.toBeInstanceOf(InvalidLiabilityTerms);
      });
    });
  }
});

describe('LiabilityTermsService.projection', () => {
  async function fiatToken(tx: DatabaseTransaction) {
    const [fiat] = await tx
      .select({ id: schema.tokenTypes.id })
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'fiat'));
    if (!fiat) throw new Error('fiat token type not seeded');
    return makeToken(tx, { typeId: fiat.id, decimals: 2 });
  }

  test('owed is the negated fiat balance, and the schedule comes from the terms', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'mortgage');
      const token = await fiatToken(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance: '-480000',
      });
      await service().set(user.id, account.id, loanTerms, tx);
      const p = await service().projection(user.id, account.id, '2027-01-20', tx);
      expect(p.owed).toBe('480000');
      expect(p.currency).toBe(token.symbol);
      expect(p.schedule).toHaveLength(360);
      expect(p.projection?.converged).toBe(true);
      expect(p.card).toBeNull();
    });
  });

  test('terms missing the rate give no schedule rather than a wrong one', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'loan');
      await service().set(user.id, account.id, { ...loanTerms, annualRatePct: undefined }, tx);
      const p = await service().projection(user.id, account.id, '2027-01-20', tx);
      expect(p.schedule).toBeNull();
      expect(p.projection).toBeNull();
    });
  });

  test('with two currencies, the loan is the larger by base value, not by raw balance (SC-1672)', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'loan');
      const pounds = await fiatToken(tx);
      const yen = await fiatToken(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: pounds.id,
        balance: '-1000',
        valueBase: '-1270',
      });
      // More units, far less value: the raw balance would pick this one.
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: yen.id,
        balance: '-50000',
        valueBase: '-335',
      });
      const p = await service().projection(user.id, account.id, '2027-01-20', tx);
      expect(p.currency).toBe(pounds.symbol);
      expect(p.owed).toBe('1000');
    });
  });

  test('with no base value known, the raw balance still picks the currency', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'loan');
      const a = await fiatToken(tx);
      const b = await fiatToken(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: a.id,
        balance: '-10',
      });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: b.id,
        balance: '-900',
      });
      const p = await service().projection(user.id, account.id, '2027-01-20', tx);
      expect(p.currency).toBe(b.symbol);
    });
  });
});

describe("the user's own date (SC-1672)", () => {
  const instant = new Date('2026-10-09T11:00:00Z');

  test('a user at +14 is already on the next day', () => {
    expect(userToday(instant, 'Pacific/Kiritimati')).toBe('2026-10-10');
  });

  test('a user at -10 is still on the same day', () => {
    expect(userToday(instant, 'Pacific/Honolulu')).toBe('2026-10-09');
  });

  test('no timezone, or one Intl does not know, falls back to UTC', () => {
    expect(userToday(instant, null)).toBe('2026-10-09');
    expect(userToday(instant, 'Not/AZone')).toBe('2026-10-09');
  });

  test("a start date of the user's today is accepted while UTC is still on yesterday", async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await setup(tx, 'loan');
      const saved = await service().set(
        user.id,
        account.id,
        { ...loanTerms, startDate: '2026-10-10' },
        tx,
        '2026-10-10'
      );
      expect(saved.startDate).toBe('2026-10-10');
      await expect(
        service().set(
          user.id,
          account.id,
          { ...loanTerms, startDate: '2026-10-11' },
          tx,
          '2026-10-10'
        )
      ).rejects.toBeInstanceOf(InvalidLiabilityTerms);
    });
  });
});
