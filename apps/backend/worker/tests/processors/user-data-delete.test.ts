import { afterEach, describe, expect, test } from 'bun:test';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { DeleteAccountUseCase, DeleteAllUserDataUseCase } from '@scani/domain/use-cases';
import type { UserDataDeleteJob } from '@scani/jobs';
import type { ProcessorContext } from '@scani/queue';
import { userFacingMessage } from '@scani/queue';
import { Container } from 'typedi';
import { UserDataDeleteProcessor } from '../../src/processors/user-data-delete';

restoreContainerAfterAll();

/**
 * One job, two scopes (SC-1276). "Delete all my data" empties the account and
 * keeps the login; "Delete my account" removes the login too. Each case below
 * has its opposite beside it: a processor that always ran the account deletion
 * would pass the first test and erase every user who only wanted a fresh start.
 */

class TestableProcessor extends UserDataDeleteProcessor {
  readonly captured: Array<Record<string, string>> = [];

  protected override capture(_err: unknown, tags: Record<string, string>): void {
    this.captured.push(tags);
  }

  run(data: UserDataDeleteJob) {
    return this.handle(data, { job: { id: 'job-1' } } as unknown as ProcessorContext);
  }
}

const realData = Container.get(DeleteAllUserDataUseCase);
const realAccount = Container.get(DeleteAccountUseCase);
afterEach(() => {
  Container.set(DeleteAllUserDataUseCase, realData);
  Container.set(DeleteAccountUseCase, realAccount);
});

function stub(account: () => Promise<{ deleted: boolean }> = async () => ({ deleted: true })) {
  const calls: string[] = [];
  Container.set(DeleteAllUserDataUseCase, {
    execute: async (userId: string) => {
      calls.push(`data:${userId}`);
      return { success: true };
    },
  } as unknown as DeleteAllUserDataUseCase);
  Container.set(DeleteAccountUseCase, {
    execute: async (userId: string) => {
      calls.push(`account:${userId}`);
      return account();
    },
  } as unknown as DeleteAccountUseCase);
  return calls;
}

describe('the delete job runs the scope it was asked for', () => {
  test('a plain job empties the data and keeps the account', async () => {
    const calls = stub();
    await new TestableProcessor().run({ userId: 'u1', requestId: 'r1' });
    expect(calls).toEqual(['data:u1']);
  });

  test('an account job removes the account, and runs nothing else', async () => {
    const calls = stub();
    await new TestableProcessor().run({ userId: 'u1', requestId: 'r1', deleteAccount: true });
    expect(calls).toEqual(['account:u1']);
  });

  test('a refused account deletion reaches the user as a sentence, not "Unknown error"', async () => {
    stub(async () => {
      throw new Error('Account u1 edited a global token price; its attribution is kept');
    });
    const err = await new TestableProcessor()
      .run({ userId: 'u1', requestId: 'r1', deleteAccount: true })
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(userFacingMessage(err)).toContain('could not be deleted');
  });

  test('a failed account deletion reaches Sentry tagged job=account-delete; a success does not', async () => {
    stub(async () => {
      throw new Error('boom');
    });
    const failing = new TestableProcessor();
    await failing.run({ userId: 'u1', requestId: 'r1', deleteAccount: true }).catch(() => {});
    expect(failing.captured).toEqual([
      { component: 'worker', job: 'account-delete', kind: 'account-delete-failed', userId: 'u1' },
    ]);

    stub();
    const passing = new TestableProcessor();
    await passing.run({ userId: 'u1', requestId: 'r1', deleteAccount: true });
    expect(passing.captured).toEqual([]);
  });
});
