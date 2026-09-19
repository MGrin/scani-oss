import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { UserJobRepository } from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';
import { makeAuthedCaller } from '../../helpers/test-caller';

// SC-1276: Settings could empty an account but never close it. The two
// mutations enqueue the same job; only `deleteAccount` asks the worker to
// remove the login too, and each one only ever names the CALLER.

restoreContainerAfterAll();

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';

function fakeUser(id: string): typeof schema.users.$inferSelect {
  return { id, email: `${id}@scani.local` } as typeof schema.users.$inferSelect;
}

type Unfinished = { jobId: string; state: string; userFacingError: string | null } | null;

function stubJobs(unfinished: Unfinished = null) {
  const dismissed: string[] = [];
  Container.set(UserJobRepository, {
    findUnfinishedAccountDeletion: async () => unfinished,
    dismissFailed: async (_userId: string, jobId: string) => {
      dismissed.push(jobId);
      return true;
    },
  } as unknown as UserJobRepository);
  return dismissed;
}

function stubQueue() {
  stubJobs();
  const payloads: unknown[] = [];
  Container.set(BullMqEnqueueService, {
    add: async (_descriptor: unknown, payload: unknown) => {
      payloads.push(payload);
      return 'job-1';
    },
  } as unknown as BullMqEnqueueService);
  return payloads;
}

describe('users.deleteAccount', () => {
  test('enqueues an account deletion for the caller', async () => {
    const payloads = stubQueue();
    const result = await makeAuthedCaller(fakeUser('user-a')).users.deleteAccount({
      requestId: REQUEST_ID,
    });
    expect(result).toEqual({ jobId: 'job-1' });
    expect(payloads).toEqual([{ userId: 'user-a', requestId: REQUEST_ID, deleteAccount: true }]);
  });

  test('deleteAllData still keeps the account', async () => {
    const payloads = stubQueue();
    await makeAuthedCaller(fakeUser('user-a')).users.deleteAllData({ requestId: REQUEST_ID });
    expect(payloads).toEqual([{ userId: 'user-a', requestId: REQUEST_ID }]);
  });
});

describe('users.accountDeletion', () => {
  test('is null when nothing is outstanding, the normal case', async () => {
    stubJobs(null);
    expect(await makeAuthedCaller(fakeUser('user-a')).users.accountDeletion()).toBeNull();
  });

  test('reports a failed deletion with the words written for its owner', async () => {
    stubJobs({ jobId: 'del-1', state: 'failed', userFacingError: 'Contact support' });
    expect(await makeAuthedCaller(fakeUser('user-a')).users.accountDeletion()).toEqual({
      jobId: 'del-1',
      failed: true,
      message: 'Contact support',
    });
  });

  test('retrying dismisses the failure it replaces, and only a failure', async () => {
    stubQueue();
    const dismissed = stubJobs({ jobId: 'del-1', state: 'failed', userFacingError: null });
    await makeAuthedCaller(fakeUser('user-a')).users.deleteAccount({ requestId: REQUEST_ID });
    expect(dismissed).toEqual(['del-1']);

    const none = stubJobs({ jobId: 'del-2', state: 'queued', userFacingError: null });
    await makeAuthedCaller(fakeUser('user-a')).users.deleteAccount({ requestId: REQUEST_ID });
    expect(none).toEqual([]);
  });
});
