import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import {
  HIDE_CLOSED_HOLDINGS_STALE_DAYS,
  HideClosedHoldingsUseCase,
} from '../../src/use-cases/HideClosedHoldingsUseCase';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

/**
 * The sweep is one raw `WITH … UPDATE … RETURNING` naming five columns across
 * `holdings`, `holding_transactions` and `tokens` by string, so neither the
 * type-checker nor `/health/deep`'s declared-column drift check sees them.
 * Running it against the migrated database is the only thing that does
 * (SC-1239, found in SC-1134).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

async function holdingFixture(
  tx: DatabaseTransaction,
  balance: string,
  latestTxDaysAgo: number | null
): Promise<string> {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance,
  });
  if (latestTxDaysAgo !== null) {
    await makeHoldingTransaction(tx, {
      userId: user.id,
      holdingId: holding.id,
      tokenId: token.id,
      occurredAt: new Date(Date.now() - latestTxDaysAgo * DAY_MS),
    });
  }
  return holding.id;
}

async function isHidden(tx: DatabaseTransaction, holdingId: string): Promise<boolean | undefined> {
  const [row] = await tx
    .select({ isHidden: schema.holdings.isHidden })
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  return row?.isHidden;
}

describe('HideClosedHoldingsUseCase — the raw sweep against the migrated schema', () => {
  const stale = HIDE_CLOSED_HOLDINGS_STALE_DAYS + 3;
  const recent = 1;

  test('hides a zero balance whose newest transaction is older than the threshold', async () => {
    await withTestDb(async (tx) => {
      const id = await holdingFixture(tx, '0', stale);
      const summary = await new HideClosedHoldingsUseCase().execute(tx);
      expect(await isHidden(tx, id)).toBe(true);
      expect(summary.hidden).toBeGreaterThanOrEqual(1);
    });
  });

  test('hides a zero balance with no transactions at all', async () => {
    await withTestDb(async (tx) => {
      const id = await holdingFixture(tx, '0', null);
      await new HideClosedHoldingsUseCase().execute(tx);
      expect(await isHidden(tx, id)).toBe(true);
    });
  });

  test('keeps a zero balance whose newest transaction is recent', async () => {
    await withTestDb(async (tx) => {
      const id = await holdingFixture(tx, '0', recent);
      await new HideClosedHoldingsUseCase().execute(tx);
      expect(await isHidden(tx, id)).toBe(false);
    });
  });

  test('keeps a non-zero balance however old its transactions are', async () => {
    await withTestDb(async (tx) => {
      const id = await holdingFixture(tx, '5', stale);
      await new HideClosedHoldingsUseCase().execute(tx);
      expect(await isHidden(tx, id)).toBe(false);
    });
  });
});
