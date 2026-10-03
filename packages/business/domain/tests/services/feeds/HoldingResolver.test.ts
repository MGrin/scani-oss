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
import {
  EXCHANGE_BALANCE_SYNC_SOURCE,
  WALLET_BALANCE_SYNC_SOURCE,
} from '../../../src/services/holdings/balance-sync-sources';
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

  test('external-id finds the holding at the key, hidden ones included, and a keyless request finds nothing', async () => {
    await withTestDb(async (tx) => {
      const owner = await accountWithToken(tx);
      await makeHolding(tx, { ...owner, source: 'manual' });
      const keyed = await makeHolding(tx, {
        ...owner,
        source: 'import_resolver-test',
        externalId: 'KEY',
        isHidden: true,
      });

      const find = (key: string | null) =>
        resolver().findFeedHolding({ ...owner, key, match: 'external-id' }, tx);

      expect((await find('KEY'))?.id).toBe(keyed.id);
      expect(await find('ELSE')).toBeNull();
      expect(await find(null)).toBeNull();
    });
  });

  test("the balance syncs' matches skip a person's row, see hidden ones, and take the last created", async () => {
    await withTestDb(async (tx) => {
      const owner = await accountWithToken(tx);
      await makeHolding(tx, {
        ...owner,
        source: EXCHANGE_BALANCE_SYNC_SOURCE,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const newer = await makeHolding(tx, {
        ...owner,
        source: EXCHANGE_BALANCE_SYNC_SOURCE,
        isHidden: true,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      });
      await makeHolding(tx, {
        ...owner,
        source: 'manual',
        createdAt: new Date('2026-03-01T00:00:00Z'),
      });

      const find = (match: 'token-id' | 'token-id-with-scam' | 'external-id-then-token-id') =>
        resolver().findFeedHolding({ ...owner, key: 'ANY', match }, tx);

      expect((await find('token-id'))?.id).toBe(newer.id);
      expect((await find('token-id-with-scam'))?.id).toBe(newer.id);
      expect((await find('external-id-then-token-id'))?.id).toBe(newer.id);
    });
  });

  test("token-id leaves out a scam token's holding, which the other two still find", async () => {
    await withTestDb(async (tx) => {
      const userId = (await makeUser(tx)).id;
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId, institutionId: institution.id });
      const scam = await makeToken(tx, { isScamProbability: 1 });
      const owner = { userId, accountId: account.id, tokenId: scam.id };
      const holding = await makeHolding(tx, { ...owner, source: WALLET_BALANCE_SYNC_SOURCE });

      const find = (match: 'token-id' | 'token-id-with-scam' | 'external-id-then-token-id') =>
        resolver().findFeedHolding({ ...owner, key: null, match }, tx);

      expect(await find('token-id')).toBeNull();
      expect((await find('token-id-with-scam'))?.id).toBe(holding.id);
      expect((await find('external-id-then-token-id'))?.id).toBe(holding.id);
    });
  });

  test('external-id-then-token-id prefers the holding at the key, else the last of the token', async () => {
    await withTestDb(async (tx) => {
      const owner = await accountWithToken(tx);
      const keyed = await makeHolding(tx, {
        ...owner,
        source: WALLET_BALANCE_SYNC_SOURCE,
        externalId: '0xabc',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const later = await makeHolding(tx, {
        ...owner,
        source: WALLET_BALANCE_SYNC_SOURCE,
        externalId: '0xdef',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      });

      const find = (key: string | null) =>
        resolver().findFeedHolding({ ...owner, key, match: 'external-id-then-token-id' }, tx);

      expect((await find('0xabc'))?.id).toBe(keyed.id);
      expect((await find('0xnone'))?.id).toBe(later.id);
      expect((await find(null))?.id).toBe(later.id);
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

describe('HoldingResolver.createFeedHolding', () => {
  test('inserts a feed holding at the instant, with a NULL key as given, a zero cache and no observation, beside any holding of the token', async () => {
    await withTestDb(async (tx) => {
      const owner = await accountWithToken(tx);
      const existing = await makeHolding(tx, { ...owner, source: WALLET_BALANCE_SYNC_SOURCE });

      const holding = await resolver().createFeedHolding(
        {
          ...owner,
          key: null,
          source: WALLET_BALANCE_SYNC_SOURCE,
          arrival: 'user_confirmed',
          at: AT,
        },
        tx
      );

      expect(holding.id).not.toBe(existing.id);
      const [row] = await tx
        .select()
        .from(schema.holdings)
        .where(eq(schema.holdings.id, holding.id));
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
        externalId: null,
        balance: '0',
        source: WALLET_BALANCE_SYNC_SOURCE,
        arrival: 'user_confirmed',
      });
      const observations = await tx
        .select()
        .from(schema.holdingBalanceObservations)
        .where(eq(schema.holdingBalanceObservations.holdingId, holding.id));
      expect(observations).toEqual([]);
    });
  });
});
