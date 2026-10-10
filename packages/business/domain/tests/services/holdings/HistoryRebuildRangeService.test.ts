import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { desc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HistoryRebuildRangeService } from '../../../src/services/holdings/HistoryRebuildRangeService';
import { withTestDb } from '../../../test/helpers/db';
import { seedHoldingCache } from '../../../test/helpers/engine-guard';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeObservations,
  makeToken,
} from '../../../test/helpers/factories-extra';

// SC-1607: an edit rebuilt the user's whole history. These are the days an
// edit can move, and nothing later than them may be named as the start.
const service = () => Container.get(HistoryRebuildRangeService);
const at = (day: string) => new Date(`${day}T12:00:00.000Z`);

async function holdingWith(
  tx: DatabaseTransaction,
  opts: { createdAt: string; observations: Array<[string, string]>; balance?: string }
) {
  const user = await makeUser(tx);
  const account = await makeAccount(tx, {
    userId: user.id,
    institutionId: (await makeInstitution(tx)).id,
  });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: opts.balance ?? '100',
    createdAt: at(opts.createdAt),
  });
  await makeObservations(
    tx,
    opts.observations.map(([day, balance]) => ({
      userId: user.id,
      holdingId: holding.id,
      balance,
      observedAt: at(day),
      source: 'statement-close',
      role: 'checkpoint',
      authority: 'statement',
    }))
  );
  return { user, account, token, holding };
}

describe('HistoryRebuildRangeService.fromEdit (SC-1607)', () => {
  test('an edit between observations reaches back to the observation before it', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await holdingWith(tx, {
        createdAt: '2025-01-01',
        observations: [
          ['2025-03-01', '100'],
          ['2025-06-01', '120'],
          ['2025-09-01', '150'],
        ],
      });
      expect(await service().fromEdit([holding.id], at('2025-07-15'), tx)).toBe('2025-06-01');
    });
  });

  test('an edit before the first observation moves the projection from the first record', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await holdingWith(tx, {
        createdAt: '2025-04-01',
        observations: [['2025-06-01', '120']],
      });
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        kind: 'deposit',
        quantity: '10',
        occurredAt: at('2025-02-10'),
      });
      expect(await service().fromEdit([holding.id], at('2025-05-01'), tx)).toBe('2025-02-10');
    });
  });

  test('a holding that can go below zero is moved whole, because its floor reads every day', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await holdingWith(tx, {
        createdAt: '2025-01-01',
        observations: [
          ['2025-03-01', '-5'],
          ['2025-09-01', '20'],
        ],
      });
      expect(await service().fromEdit([holding.id], at('2025-10-01'), tx)).toBe('2025-01-01');
    });
  });

  test('a transfer moves both holdings: the earlier start wins', async () => {
    await withTestDb(async (tx) => {
      const a = await holdingWith(tx, {
        createdAt: '2025-01-01',
        observations: [['2025-08-01', '100']],
      });
      const b = await holdingWith(tx, {
        createdAt: '2025-01-01',
        observations: [['2025-05-01', '100']],
      });
      expect(await service().fromEdit([a.holding.id, b.holding.id], at('2025-09-01'), tx)).toBe(
        '2025-05-01'
      );
    });
  });

  test('a holding that cannot be read rebuilds the whole window', async () => {
    await withTestDb(async (tx) => {
      expect(await service().fromEdit([randomUUID()], at('2025-09-01'), tx)).toBeUndefined();
    });
  });

  test('control: the edit day itself bounds a start with no earlier observation to reach', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await holdingWith(tx, {
        createdAt: '2025-01-01',
        observations: [['2025-09-20', '100']],
      });
      expect(await service().fromEdit([holding.id], at('2025-09-20'), tx)).toBe('2025-09-20');
    });
  });
});

describe('HistoryRebuildRangeService.fromWholeHoldings (SC-1607)', () => {
  test('hide, unhide, delete or a scam verdict start at the earliest record', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await holdingWith(tx, {
        createdAt: '2025-04-01',
        observations: [['2025-06-01', '120']],
      });
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        kind: 'deposit',
        quantity: '10',
        occurredAt: at('2025-03-03'),
      });
      expect(await service().fromWholeHoldings([holding.id], tx)).toBe('2025-03-03');
    });
  });

  test('no holdings to move rebuilds nothing before today', async () => {
    await withTestDb(async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      expect(await service().fromWholeHoldings([], tx)).toBe(today);
    });
  });
});

describe('HistoryRebuildRangeService — accounts, tokens, gap answers (SC-1607)', () => {
  test('an account delete moves every holding in it, hidden ones included, whole', async () => {
    await withTestDb(async (tx) => {
      const { user, account, holding } = await holdingWith(tx, {
        createdAt: '2025-05-01',
        observations: [],
      });
      const hidden = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        isHidden: true,
        createdAt: at('2024-11-11'),
      });
      expect(hidden.id).not.toBe(holding.id);
      expect(await service().fromAccounts(user.id, [account.id], tx)).toBe('2024-11-11');
    });
  });

  test('a scam verdict moves every holding of that token, and only those', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token } = await holdingWith(tx, {
        createdAt: '2025-05-01',
        observations: [],
      });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: (await makeToken(tx)).id,
        createdAt: at('2023-01-01'),
      });
      expect(await service().fromTokenHoldings(user.id, token.id, tx)).toBe('2025-05-01');
    });
  });

  test('a gap answer moves the gap from the observation that opens it, and the arrival holding from its own before that', async () => {
    await withTestDb(async (tx) => {
      const gap = await holdingWith(tx, {
        createdAt: '2025-01-01',
        observations: [
          ['2025-03-01', '100'],
          ['2025-06-01', '60'],
        ],
      });
      const arrival = await holdingWith(tx, {
        createdAt: '2025-01-01',
        observations: [
          ['2025-02-01', '10'],
          ['2025-04-01', '10'],
        ],
      });
      const [closing] = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, gap.holding.id))
        .orderBy(desc(schema.holdingBalanceObservations.observedAt))
        .limit(1);
      expect(await service().fromGapAnswer(closing!.id, null, tx)).toBe('2025-03-01');
      expect(await service().fromGapAnswer(closing!.id, arrival.holding.id, tx)).toBe('2025-02-01');
    });
  });
});

// Feeds (#22804): the floor is min(0, lowest observation, balance). An edit
// that RAISES a negative balance with no negative observation behind it lifts
// the floor to 0, and every day of the holding moves. Read after the write,
// the floor is already 0, so the floor has to be read before it too.
describe('HistoryRebuildRangeService.fromFloor (SC-1607)', () => {
  test('a balance below zero before the edit moves the holding whole', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await holdingWith(tx, {
        createdAt: '2025-01-01',
        balance: '-5',
        observations: [['2025-06-01', '20']],
      });
      const before = await service().fromFloor([holding.id], tx);
      await seedHoldingCache(tx, (calculator) =>
        calculator
          .update(schema.holdings)
          .set({ balance: '30' })
          .where(eq(schema.holdings.id, holding.id))
      );
      const after = await service().fromEdit([holding.id], at('2025-09-01'), tx);
      expect(before).toBe('2025-01-01');
      expect(after).toBe('2025-06-01');
    });
  });

  test('control: a holding that never went below zero adds no start', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await holdingWith(tx, {
        createdAt: '2025-01-01',
        observations: [['2025-06-01', '20']],
      });
      expect(await service().fromFloor([holding.id], tx)).toBeNull();
    });
  });

  test('a holding that cannot be read rebuilds the whole window', async () => {
    await withTestDb(async (tx) => {
      expect(await service().fromFloor([randomUUID()], tx)).toBeUndefined();
    });
  });
});
