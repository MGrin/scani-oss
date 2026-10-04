/**
 * An exchange import whose user, credential or institution is gone (SC-1545).
 *
 * All three are permanent: the job is enqueued only after its credential row is
 * committed, so a missing one at run time means the user disconnected or was
 * deleted in between, and a retry reads the same absence. They were plain
 * Errors, so the worker retried them and then filed them in the dead-letter
 * queue as failures. The class is what lets the worker tell them from a lookup
 * that FAILED, which must still be retried — the control in each block.
 *
 * Seeds are committed: `execute()` reads through the module-level connection.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { ImportTargetGoneError } from '../../src/lib/import-target-gone';
import { IntegrationCredentialsService, WalletDiscoveryService } from '../../src/services';
import { ImportExchangeAccountsUseCase } from '../../src/use-cases/ImportExchangeAccountsUseCase';
import { ImportIbkrAccountsUseCase } from '../../src/use-cases/ImportIbkrAccountsUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';
import { makeUser } from '../../test/helpers/factories';

restoreContainerAfterAll();

const realCredentials = Container.get(IntegrationCredentialsService);
const realDiscovery = Container.get(WalletDiscoveryService);
const realRegistry = Container.get(ProviderRegistry);
const createdUsers: string[] = [];

afterEach(() => {
  Container.set(IntegrationCredentialsService, realCredentials);
  Container.set(WalletDiscoveryService, realDiscovery);
  Container.set(ProviderRegistry, realRegistry);
});

afterAll(async () => {
  if (createdUsers.length > 0) {
    await getDb().delete(schema.users).where(inArray(schema.users.id, createdUsers));
  }
});

async function seedUser(): Promise<string> {
  const user = await getDb().transaction((tx) => makeUser(tx, { email: `${randomUUID()}@x.test` }));
  createdUsers.push(user.id);
  return user.id;
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the import to fail');
}

/** The venue answered with one balance, so the import reaches its institution lookup. */
function stubAVenueThatAnswers(): void {
  Container.set(IntegrationCredentialsService, {
    getDecryptedCredentials: async () => ({ apiKey: 'k', apiSecret: 's' }),
  });
  Container.set(WalletDiscoveryService, { resolveInstitutionCode: async () => 'kraken' });
  Container.set(ProviderRegistry, {
    getBalanceFetcher: () => ({ fetchBalances: async () => [{ symbol: 'ZZZ', balance: '1' }] }),
    getAccountDiscoverer: () => null,
  });
}

describe.each([
  ['exchange', () => new ImportExchangeAccountsUseCase()],
  ['IBKR', () => new ImportIbkrAccountsUseCase()],
] as const)('%s import: what it names is gone', (_name, build) => {
  test('a user that does not exist', async () => {
    const error = await failureOf(
      build().execute({ userId: randomUUID(), institutionId: randomUUID() })
    );

    expect(error).toBeInstanceOf(ImportTargetGoneError);
    expect((error as ImportTargetGoneError).missing).toBe('user');
    expect((error as Error).message).toBe('User not found');
  });

  test('a credential that is no longer stored', async () => {
    const userId = await seedUser();

    const error = await failureOf(build().execute({ userId, institutionId: randomUUID() }));

    expect(error).toBeInstanceOf(ImportTargetGoneError);
    expect((error as ImportTargetGoneError).missing).toBe('credentials');
    expect((error as Error).message).toBe('No credentials found for this institution');
  });

  test('an institution that went after the venue answered', async () => {
    const userId = await seedUser();
    const institutionId = randomUUID();
    stubAVenueThatAnswers();

    const error = await failureOf(build().execute({ userId, institutionId }));

    expect(error).toBeInstanceOf(ImportTargetGoneError);
    expect((error as ImportTargetGoneError).missing).toBe('institution');
    expect((error as Error).message).toBe(`Institution not found: ${institutionId}`);
  });

  test('CONTROL: a credential lookup that fails is not a refusal', async () => {
    const userId = await seedUser();
    const lookupFailed = new Error('Failed query: select from "user_integration_credentials"');
    Container.set(IntegrationCredentialsService, {
      getDecryptedCredentials: async () => {
        throw lookupFailed;
      },
    });

    const error = await failureOf(build().execute({ userId, institutionId: randomUUID() }));

    expect(error).toBe(lookupFailed);
    expect(error).not.toBeInstanceOf(ImportTargetGoneError);
  });
});
