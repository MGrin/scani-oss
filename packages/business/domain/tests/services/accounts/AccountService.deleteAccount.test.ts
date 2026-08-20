process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { Account } from '@scani/db/schema';
import { Container } from 'typedi';
import { AccountRepository } from '../../../src/repositories/AccountRepository';
import { AccountService } from '../../../src/services/accounts/AccountService';
import { IntegrationCredentialsService } from '../../../src/services/users/IntegrationCredentialsService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const INSTITUTION_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '33333333-3333-3333-3333-333333333333';

function makeAccountRepoStub(remainingActive: number): AccountRepository {
  return {
    findById: async () =>
      ({
        id: ACCOUNT_ID,
        userId: USER_ID,
        institutionId: INSTITUTION_ID,
        metadata: {},
      }) as unknown as Account,
    delete: async () => true,
    countActiveByUserAndInstitution: async () => remainingActive,
  } as unknown as AccountRepository;
}

function makeCredentialsStub(hasCredential: boolean): {
  service: IntegrationCredentialsService;
  disconnected: string[];
} {
  const disconnected: string[] = [];
  const service = {
    getCredentials: async () => (hasCredential ? { id: 'cred-1' } : null),
    deleteCredentials: async (userId: string, institutionId: string) => {
      disconnected.push(`${userId}:${institutionId}`);
    },
  } as unknown as IntegrationCredentialsService;
  return { service, disconnected };
}

function makeService(remainingActive: number, hasCredential: boolean) {
  const creds = makeCredentialsStub(hasCredential);
  Container.set(AccountRepository, makeAccountRepoStub(remainingActive));
  Container.set(IntegrationCredentialsService, creds.service);
  const instance = new AccountService();
  Container.set(AccountService, instance);
  return { service: instance, disconnected: creds.disconnected };
}

describe('AccountService.deleteAccount — credential disconnection (SC-248)', () => {
  test('disconnects the credential when the last active account is removed', async () => {
    const { service, disconnected } = makeService(0, true);
    await service.deleteAccount(ACCOUNT_ID, USER_ID);
    expect(disconnected).toEqual([`${USER_ID}:${INSTITUTION_ID}`]);
  });

  test('keeps the credential while another active account remains', async () => {
    const { service, disconnected } = makeService(1, true);
    await service.deleteAccount(ACCOUNT_ID, USER_ID);
    expect(disconnected).toEqual([]);
  });

  test('is a no-op for an account whose institution has no credential', async () => {
    const { service, disconnected } = makeService(0, false);
    await service.deleteAccount(ACCOUNT_ID, USER_ID);
    expect(disconnected).toEqual([]);
  });

  test('still deletes the account when disconnecting the credential throws', async () => {
    // Deleting the account is what the user asked for. Bookkeeping failing
    // must not fail it — and an orphan that survives is now reported by
    // findStaleSyncTargets rather than being silent.
    Container.set(AccountRepository, makeAccountRepoStub(0));
    Container.set(IntegrationCredentialsService, {
      getCredentials: async () => ({ id: 'cred-1' }),
      deleteCredentials: async () => {
        throw new Error('credential store unavailable');
      },
    } as unknown as IntegrationCredentialsService);
    const service = new AccountService();
    Container.set(AccountService, service);

    await expect(service.deleteAccount(ACCOUNT_ID, USER_ID)).resolves.toBe(true);
  });
});
