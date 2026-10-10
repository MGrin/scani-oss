/**
 * A refresh writes what the cron for its source writes when a balance is
 * unchanged (SC-1601, feeds' ruling #23106). The app-open refresh made every
 * wallet re-stamp an observation the hourly sync had stopped writing: 435 rows
 * in a day, all unchanged. What each mode then writes is the sync helper's,
 * tested there; this holds which mode the refresh hands it.
 *
 * The account, wallet and institution rows are committed: the use case reads
 * them through the process-wide handle. The provider and the sync are stubbed.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db';
import * as schema from '@scani/db/schema';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../src/repositories/FeedInputRepository';
import { HoldingRepository } from '../../src/repositories/HoldingRepository';
import {
  HoldingsSyncHelper,
  type ProcessSnapshotsForAccountInput,
} from '../../src/services/holdings/HoldingsSyncHelper';
import { IntegrationCredentialsService } from '../../src/services/users/IntegrationCredentialsService';
import { WalletDiscoveryService } from '../../src/services/users/WalletDiscoveryService';
import { RefreshAccountBalanceUseCase } from '../../src/use-cases/RefreshAccountBalanceUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeWalletAccount } from '../../test/helpers/factories-extra';

restoreContainerAfterAll();

type Tx = Parameters<typeof makeUser>[0];
const handle = db as unknown as Tx;
const users: string[] = [];
const institutions: string[] = [];

afterAll(async () => {
  if (users.length > 0) {
    await db.delete(schema.accounts).where(inArray(schema.accounts.userId, users));
    await db.delete(schema.userWallets).where(inArray(schema.userWallets.userId, users));
    await db.delete(schema.users).where(inArray(schema.users.id, users));
  }
  if (institutions.length > 0) {
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
  }
});

async function refresh(kind: 'wallet' | 'exchange') {
  const user = await makeUser(handle);
  const institution = await makeInstitution(handle);
  users.push(user.id);
  institutions.push(institution.id);
  const owner = { userId: user.id, institutionId: institution.id };
  const account =
    kind === 'wallet' ? await makeWalletAccount(handle, owner) : await makeAccount(handle, owner);

  const handed: Array<ProcessSnapshotsForAccountInput['unchangedCheckpoint']> = [];
  Container.set(WalletDiscoveryService, {
    resolveInstitutionCode: async () => 'ethereum',
  } as unknown as WalletDiscoveryService);
  Container.set(ProviderRegistry, {
    getBalanceFetcher: () => ({
      fetchBalances: async () => [
        {
          externalId: 'native',
          balance: '1.5',
          capturedAt: new Date(),
          tokenIdentity: { symbol: 'ETH' },
        },
      ],
    }),
  } as unknown as ProviderRegistry);
  Container.set(FeedInputRepository, {
    findByUser: async () => [],
  } as unknown as FeedInputRepository);
  Container.set(HoldingRepository, {
    findByUserWithFullDetails: async () => [],
  } as unknown as HoldingRepository);
  Container.set(IntegrationCredentialsService, {
    getDecryptedCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
  } as unknown as IntegrationCredentialsService);
  Container.set(HoldingsSyncHelper, {
    processSnapshotsForAccount: async (input: ProcessSnapshotsForAccountInput) => {
      handed.push(input.unchangedCheckpoint);
      return { updated: 0, created: 0, removed: 0, createdTokenIds: [], observationsWritten: 0 };
    },
  } as unknown as HoldingsSyncHelper);

  const useCase = new RefreshAccountBalanceUseCase();
  await useCase.execute({ userId: user.id, accountId: account.id });
  return handed;
}

describe('RefreshAccountBalanceUseCase — an unchanged balance (SC-1601)', () => {
  test('a wallet refresh skips the observation, as the hourly wallet sync does', async () => {
    expect(await refresh('wallet')).toEqual(['skip-observation']);
  });

  test('an exchange refresh skips the observation too, and so still stamps last_updated', async () => {
    expect(await refresh('exchange')).toEqual(['skip-observation']);
  });
});
