import { describe, expect, test } from 'bun:test';
import { BackupTooLargeError, UserBackupService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { UserBackupJob } from '@scani/jobs';
import type { ProcessorContext } from '@scani/queue';
import { userFacingMessage } from '@scani/queue';
import { Container } from 'typedi';
import { UserBackupProcessor } from '../../src/processors/user-backup';

restoreContainerAfterAll();

class Exposed extends UserBackupProcessor {
  run(data: UserBackupJob) {
    return this.handle(data, {
      job: { id: 'job-1' },
      reportStatus: async () => {},
    } as unknown as ProcessorContext);
  }
}

function processor(create: (userId: string) => Promise<unknown>): Exposed {
  Container.set(UserBackupService, { create } as unknown as UserBackupService);
  return new Exposed();
}

describe('user-backup processor (SC-1649)', () => {
  test('returns the stored backup, which the download names', async () => {
    const result = await processor(async (userId) => ({
      id: `backup-of-${userId}`,
      byteSize: 10,
      recordCount: 4,
      counts: { holdings: 1 },
    })).run({ userId: 'u1', requestId: 'r1' });

    expect(result).toEqual({
      backupId: 'backup-of-u1',
      byteSize: 10,
      recordCount: 4,
      counts: { holdings: 1 },
    });
  });

  test('a backup over the limit fails with a sentence the person can read', async () => {
    const run = processor(async () => {
      throw new BackupTooLargeError(1);
    }).run({ userId: 'u1', requestId: 'r1' });

    const error = await run.catch((e: unknown) => e);
    expect(userFacingMessage(error)).toContain('Nothing was stored');
  });

  test('any other failure is left to retry, not dressed as a sentence', async () => {
    const error = await processor(async () => {
      throw new Error('connection reset');
    })
      .run({ userId: 'u1', requestId: 'r1' })
      .catch((e: unknown) => e);
    expect(userFacingMessage(error)).toBeNull();
  });
});
