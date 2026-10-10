/**
 * SC-1640: what a loan or card owes is a negative fiat balance on a liability
 * account, and that is the ONLY place a holding may sit below zero. Feeds
 * confirmed the engine keeps a negative end to end (F1) and that an owed
 * edit is a `correction` (F2); these pin the refusal everywhere else.
 */

import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingCacheWriter } from '../../src/services/feeds/HoldingCacheWriter';
import {
  AccountClassService,
  NegativeBalanceRefused,
} from '../../src/services/liabilities/AccountClassService';
import {
  MovementExceedsBalanceError,
  RecordHoldingMovementUseCase,
} from '../../src/use-cases/RecordHoldingMovementUseCase';
import { UpdateHoldingUseCase } from '../../src/use-cases/UpdateHoldingUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeToken,
  seedReading,
} from '../../test/helpers/factories-extra';

async function accountTypeId(tx: DatabaseTransaction, code: string): Promise<string> {
  const [row] = await tx
    .select({ id: schema.accountTypes.id })
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, code));
  if (!row) throw new Error(`account type ${code} not seeded`);
  return row.id;
}

async function fiatTypeId(tx: DatabaseTransaction): Promise<string> {
  const [row] = await tx
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, 'fiat'));
  if (!row) throw new Error('token type fiat not seeded');
  return row.id;
}

/** A manual holding with a reading of `balance`, on an account of `accountType`. */
async function scaffold(
  tx: DatabaseTransaction,
  { accountType, fiat, balance }: { accountType: string; fiat: boolean; balance: string }
) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, {
    userId: user.id,
    institutionId: institution.id,
    typeId: await accountTypeId(tx, accountType),
  });
  const token = await makeToken(tx, fiat ? { typeId: await fiatTypeId(tx) } : {});
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance,
    source: 'manual',
  });
  await seedReading(tx, {
    userId: user.id,
    holdingId: holding.id,
    balance,
    at: new Date('2026-01-01T00:00:00Z'),
  });
  return { user, holding };
}

const engineBalance = (userId: string, holdingId: string, tx: DatabaseTransaction) =>
  Container.get(HoldingCacheWriter).engineBalance(userId, holdingId, tx);

describe('UpdateHoldingUseCase — what is owed (SC-1640)', () => {
  test('a liability fiat holding takes a negative balance as a correction', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, {
        accountType: 'mortgage',
        fiat: true,
        balance: '-480000',
      });
      await Container.get(UpdateHoldingUseCase).execute(
        holding.id,
        { balance: '-479000', editCause: 'correction' },
        user.id,
        tx
      );
      expect((await engineBalance(user.id, holding.id, tx)).toString()).toBe('-479000');
    });
  });

  // Review I1: the refusal lives on the person's edit, not in `execute`.
  // Undoing a declared transfer (SC-618) and an inflow into margin cash write
  // a negative through `execute` on purpose, and refusing them there trapped
  // the owner inside a transfer they could not reopen.
  test('a system write may still leave an asset holding below zero', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, {
        accountType: 'checking',
        fiat: true,
        balance: '100',
      });
      await Container.get(UpdateHoldingUseCase).execute(
        holding.id,
        { balance: '-300', editCause: 'correction' },
        user.id,
        tx
      );
      expect((await engineBalance(user.id, holding.id, tx)).toString()).toBe('-300');
    });
  });
});

describe('AccountClassService.refuseNegativeEdit (SC-1640)', () => {
  test('lets a loan or card be edited below zero', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, {
        accountType: 'mortgage',
        fiat: true,
        balance: '-480000',
      });
      await Container.get(AccountClassService).refuseNegativeEdit(
        user.id,
        holding.id,
        '-479000',
        tx
      );
    });
  });

  for (const [name, accountType, fiat] of [
    ['an asset account', 'checking', true],
    ['crypto on a liability account', 'credit_card', false],
  ] as const) {
    test(`refuses a negative edit on ${name}`, async () => {
      await withTestDb(async (tx) => {
        const { user, holding } = await scaffold(tx, { accountType, fiat, balance: '100' });
        await expect(
          Container.get(AccountClassService).refuseNegativeEdit(user.id, holding.id, '-500', tx)
        ).rejects.toBeInstanceOf(NegativeBalanceRefused);
      });
    });
  }

  test('a zero or positive edit is never refused', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, {
        accountType: 'checking',
        fiat: true,
        balance: '100',
      });
      await Container.get(AccountClassService).refuseNegativeEdit(user.id, holding.id, '0', tx);
    });
  });
});

describe('RecordHoldingMovementUseCase — borrowing more (SC-1640)', () => {
  test('an outflow from a liability fiat holding deepens the debt', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, {
        accountType: 'credit_card',
        fiat: true,
        balance: '-1500',
      });
      await Container.get(RecordHoldingMovementUseCase).execute(
        {
          holdingId: holding.id,
          direction: 'outflow',
          amount: '200',
          occurredAt: new Date().toISOString(),
          destination: 'left_control',
        },
        user.id,
        tx
      );
      expect((await engineBalance(user.id, holding.id, tx)).toString()).toBe('-1700');
    });
  });

  test('an asset outflow past zero is still refused', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, {
        accountType: 'checking',
        fiat: true,
        balance: '100',
      });
      await expect(
        Container.get(RecordHoldingMovementUseCase).execute(
          {
            holdingId: holding.id,
            direction: 'outflow',
            amount: '200',
            occurredAt: new Date().toISOString(),
            destination: 'left_control',
          },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(MovementExceedsBalanceError);
    });
  });
});
