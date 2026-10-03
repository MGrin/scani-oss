/**
 * The feed half of `HoldingResolver` (foundation A2 D-4). `account-token` is
 * the statement path's match: the account's oldest visible holding of the
 * token, as `findByAccountAndToken` has always chosen it. A holding it creates
 * is a feed one, starting at the write's earliest instant, keyed by the asset's
 * key, with an empty cache and no observation (D-6).
 */

import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingResolver } from '../../../src/services/feeds/HoldingResolver';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

const resolver = () => Container.get(HoldingResolver);

const AT = new Date('2026-08-01T00:00:00Z');

async function accountWithToken(tx: DatabaseTransaction) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  const token = await makeToken(tx);
  return { userId, accountId: account.id, tokenId: token.id };
}

describe('HoldingResolver.resolveFeedHolding', () => {
  test('account-token finds the oldest visible holding of the token and creates nothing', async () => {
    await withTestDb(async (tx) => {
      const owner = await accountWithToken(tx);
      const hidden = await makeHolding(tx, {
        ...owner,
        isHidden: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const oldest = await makeHolding(tx, {
        ...owner,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      });
      await makeHolding(tx, { ...owner, createdAt: new Date('2026-03-01T00:00:00Z') });

      const resolved = await resolver().resolveFeedHolding(
        {
          ...owner,
          key: null,
          match: 'account-token',
          create: { source: 'statement-import', arrival: 'user_confirmed' },
          at: AT,
        },
        tx
      );

      expect(resolved?.created).toBe(false);
      expect(resolved?.holding.id).toBe(oldest.id);
      expect(resolved?.holding.id).not.toBe(hidden.id);
      const rows = await tx
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, owner.accountId));
      expect(rows).toHaveLength(3);
    });
  });

  test('a holding it creates is feed, starts at the instant, carries the key, a zero cache and no observation', async () => {
    await withTestDb(async (tx) => {
      const owner = await accountWithToken(tx);

      const resolved = await resolver().resolveFeedHolding(
        {
          ...owner,
          key: 'acct-7:EUR',
          match: 'account-token',
          create: { source: 'statement-import', arrival: 'user_confirmed' },
          at: AT,
        },
        tx
      );

      expect(resolved?.created).toBe(true);
      const [row] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, resolved?.holding.id ?? ''));
      expect({
        userId: row?.userId,
        accountId: row?.accountId,
        tokenId: row?.tokenId,
        kind: row?.kind,
        startsAt: row?.startsAt,
        externalId: row?.externalId,
        balance: row?.balance,
        source: row?.source,
        arrival: row?.arrival,
      }).toEqual({
        ...owner,
        kind: 'feed',
        startsAt: AT,
        externalId: 'acct-7:EUR',
        balance: '0',
        source: 'statement-import',
        arrival: 'user_confirmed',
      });
      const observations = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, resolved?.holding.id ?? ''));
      expect(observations).toEqual([]);
    });
  });

  test('a null arrival leaves the column default', async () => {
    await withTestDb(async (tx) => {
      const owner = await accountWithToken(tx);
      const resolved = await resolver().resolveFeedHolding(
        {
          ...owner,
          key: null,
          match: 'account-token',
          create: { source: 'statement-import', arrival: null },
          at: AT,
        },
        tx
      );
      expect(resolved?.holding.arrival).toBe('unattributed');
    });
  });

  test('with nothing to find and no create it returns null and writes nothing', async () => {
    await withTestDb(async (tx) => {
      const owner = await accountWithToken(tx);
      const resolved = await resolver().resolveFeedHolding(
        { ...owner, key: null, match: 'account-token', create: null, at: AT },
        tx
      );
      expect(resolved).toBeNull();
      const rows = await tx
        .select({ id: schema.holdings.id })
        .from(schema.holdings)
        .where(eq(schema.holdings.accountId, owner.accountId));
      expect(rows).toEqual([]);
    });
  });
});
