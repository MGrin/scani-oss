/**
 * SC-1665. A refresh reads the balance, then the ledger, and writes both in
 * one transaction, so a balance never lands without the rows that explain it.
 *
 * The real feed write runs against committed rows; only the two provider
 * reads are stubbed. The ledger read stands in for `AccountLedgerSync.read`
 * and hands the real coordinator's `write` and `finish` the events it is
 * given, so what is under test is the order and the single transaction.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db';
import * as schema from '@scani/db/schema';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { HoldingSnapshot, TransactionEvent } from '@scani/providers/core/types';
import Decimal from 'decimal.js';
import { and, eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../src/repositories/HoldingBalanceObservationRepository';
import {
  AccountLedgerSync,
  type LedgerRead,
} from '../../src/services/transactions/AccountLedgerSync';
import {
  type FetchedLedger,
  TransactionImportCoordinator,
} from '../../src/services/transactions/TransactionImportCoordinator';
import { IntegrationCredentialsService } from '../../src/services/users/IntegrationCredentialsService';
import { WalletDiscoveryService } from '../../src/services/users/WalletDiscoveryService';
import { RefreshAccountBalanceUseCase } from '../../src/use-cases/RefreshAccountBalanceUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount } from '../../test/helpers/factories-extra';

restoreContainerAfterAll();

type Tx = Parameters<typeof makeUser>[0];
const handle = db as unknown as Tx;
const users: string[] = [];
const institutions: string[] = [];

afterAll(async () => {
  if (users.length > 0) {
    await db
      .delete(schema.holdingTransactions)
      .where(inArray(schema.holdingTransactions.userId, users));
    await db.delete(schema.accounts).where(inArray(schema.accounts.userId, users));
    await db.delete(schema.users).where(inArray(schema.users.id, users));
  }
  if (institutions.length > 0) {
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
  }
});

const usd = { symbol: 'USD', name: 'USD', providerMetadata: { airwallex: { currency: 'USD' } } };

function usdEvent(id: string, quantity: string, occurredAt: Date): TransactionEvent {
  return {
    externalId: id,
    occurredAt,
    kind: new Decimal(quantity).isNegative() ? 'withdraw' : 'deposit',
    primary: { tokenIdentity: usd, quantity },
    rawPayload: { id },
  } as TransactionEvent;
}

async function seedAccount() {
  const user = await makeUser(handle);
  const institution = await makeInstitution(handle, { name: 'Airwallex' });
  users.push(user.id);
  institutions.push(institution.id);
  const account = await makeAccount(handle, { userId: user.id, institutionId: institution.id });
  return { userId: user.id, accountId: account.id };
}

/**
 * One refresh: the provider reports `balance`; the ledger read, which runs
 * after the balance read, returns whatever `events` builds at that moment.
 */
async function refresh(
  owner: { userId: string; accountId: string },
  balance: string,
  events: (() => TransactionEvent[]) | null
) {
  Container.set(WalletDiscoveryService, {
    resolveInstitutionCode: async () => 'airwallex',
  } as unknown as WalletDiscoveryService);
  Container.set(IntegrationCredentialsService, {
    getDecryptedCredentials: async () => ({ clientId: 'c', apiKey: 'k' }),
  } as unknown as IntegrationCredentialsService);
  Container.set(ProviderRegistry, {
    getBalanceFetcher: () => ({
      fetchBalances: async (): Promise<HoldingSnapshot[]> => [
        {
          externalId: 'USD',
          tokenIdentity: usd,
          balance,
          capturedAt: new Date(),
          tokenType: 'fiat',
        },
      ],
    }),
  } as unknown as ProviderRegistry);
  const coordinator = Container.get(TransactionImportCoordinator);
  Container.set(AccountLedgerSync, {
    read: async (): Promise<LedgerRead> => {
      if (!events) return { kind: 'skipped', reason: 'never-read' };
      // A real ledger read is a network round trip after the balance read. Without
      // this a row stamped "now" can share the balance anchor's millisecond and
      // fall inside the interval the anchor closes.
      await Bun.sleep(2);
      const fetched: FetchedLedger = {
        userId: owner.userId,
        accountId: owner.accountId,
        source: 'airwallex-api',
        since: new Date(Date.now() - 60 * 60 * 1000),
        routerResult: {
          events: events(),
          fetchedAt: new Date(),
          horizonMs: undefined,
          warnings: [],
          warningDetails: [],
          hasCompleteTxHistory: false,
          historyRetractions: [],
          historyStartsAt: null,
        } as unknown as FetchedLedger['routerResult'],
      };
      return { kind: 'read', fetched };
    },
    write: (fetched: FetchedLedger, tx: Parameters<AccountLedgerSync['write']>[1]) =>
      coordinator.write(fetched, tx),
    finish: (...args: Parameters<AccountLedgerSync['finish']>) => coordinator.finish(...args),
  } as unknown as AccountLedgerSync);
  return new RefreshAccountBalanceUseCase().execute(owner);
}

async function balanceOf(accountId: string): Promise<string> {
  const [row] = await db
    .select({ balance: schema.holdings.balance })
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId));
  return new Decimal(row?.balance ?? 'NaN').toString();
}

/** Every interval's drift the ledger does not explain, zeros dropped. */
async function unexplained(userId: string): Promise<string[]> {
  const candidates = await Container.get(
    HoldingBalanceObservationRepository
  ).findGapCandidatesForUser(userId, undefined, { includeExplained: true });
  return candidates
    .map((c) => new Decimal(c.balance).sub(c.previousBalance).sub(c.explained).toString())
    .filter((drift) => drift !== '0');
}

/** An instant strictly after every anchor written so far, and before the next one. */
async function afterAnAnchor(): Promise<Date> {
  await Bun.sleep(5);
  const at = new Date();
  await Bun.sleep(5);
  return at;
}

describe('a refresh writes the balance and its ledger together (SC-1665)', () => {
  test('the rows that explain a balance land with it, and the gap reads zero', async () => {
    const owner = await seedAccount();
    await refresh(owner, '406.98', null);
    const paidOut = await afterAnAnchor();
    const result = await refresh(owner, '320.52', () => [usdEvent('ftx-out', '-86.46', paidOut)]);

    expect(result.ledger?.transactions).toBe(1);
    expect(await balanceOf(owner.accountId)).toBe('320.52');
    // The ledger already moved the engine to the new balance, so the refresh
    // sees no change to observe: there is no interval left to ask about.
    expect(await unexplained(owner.userId)).toEqual([]);
  });

  test('a row posted between the two reads counts once, never twice (Q-1)', async () => {
    const owner = await seedAccount();
    await refresh(owner, '406.98', null);
    const paidOut = await afterAnAnchor();
    let late: Date | undefined;
    // The ledger is read AFTER the balance, so this deposit is dated after the
    // balance anchor that does not yet include it.
    await refresh(owner, '320.52', () => {
      late = new Date();
      return [usdEvent('ftx-out', '-86.46', paidOut), usdEvent('ftx-late', '100', late)];
    });
    await afterAnAnchor();
    // The next hour's balance includes the deposit, and its overlap re-reads both rows.
    await refresh(owner, '420.52', () => [
      usdEvent('ftx-out', '-86.46', paidOut),
      usdEvent('ftx-late', '100', late ?? new Date()),
    ]);

    expect(await balanceOf(owner.accountId)).toBe('420.52');
    expect(await unexplained(owner.userId)).toEqual([]);
    const rows = await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .innerJoin(schema.holdings, eq(schema.holdings.id, schema.holdingTransactions.holdingId))
      .where(
        and(
          eq(schema.holdings.accountId, owner.accountId),
          eq(schema.holdingTransactions.source, 'airwallex-api')
        )
      );
    expect(rows).toHaveLength(2);
  });

  test('control: with no ledger read, the same balance leaves the gap open', async () => {
    const owner = await seedAccount();
    await refresh(owner, '406.98', null);
    await refresh(owner, '320.52', null);
    expect(await unexplained(owner.userId)).toEqual(['-86.46']);
  });
});
