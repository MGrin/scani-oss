import { describe, expect, test } from 'bun:test';
import type * as schema from '@scani/db/schema';
import { BackupRestorer, UserBackupService } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { BullMqEnqueueService } from '@scani/queue';
import { Container } from 'typedi';
import { makeAuthedCaller, makeUnauthedCaller } from '../../helpers/test-caller';

restoreContainerAfterAll();

const BACKUP_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function user(id: string): typeof schema.users.$inferSelect {
  return {
    id,
    email: `${id}@scani.local`,
    name: 'Test User',
    baseCurrencyId: null,
    image: null,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as typeof schema.users.$inferSelect;
}

function withPresign(outcome: Awaited<ReturnType<UserBackupService['presign']>>['outcome']) {
  const asked: Array<{ backupId: string; userId: string }> = [];
  Container.set(UserBackupService, {
    presign: async (backupId: string, userId: string) => {
      asked.push({ backupId, userId });
      if (outcome === 'ready') {
        return { outcome, url: 'https://signed.example/x', expiresAt: new Date(0), backup: {} };
      }
      return { outcome, backup: {} };
    },
  } as unknown as UserBackupService);
  return asked;
}

describe('backups router (SC-1649)', () => {
  test('signs a download for the caller, asking about the caller’s own id', async () => {
    const asked = withPresign('ready');
    const result = await makeAuthedCaller(user('u-1')).backups.downloadUrl({ backupId: BACKUP_ID });

    expect(result.url).toBe('https://signed.example/x');
    expect(asked).toEqual([{ backupId: BACKUP_ID, userId: 'u-1' }]);
  });

  test('another account’s backup reads as not found', async () => {
    withPresign('not-found');
    await expect(
      makeAuthedCaller(user('u-2')).backups.downloadUrl({ backupId: BACKUP_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('an expired backup says so, rather than not found', async () => {
    withPresign('expired');
    await expect(
      makeAuthedCaller(user('u-1')).backups.downloadUrl({ backupId: BACKUP_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  test('rejects an unauthenticated caller', async () => {
    await expect(
      makeUnauthedCaller().backups.downloadUrl({ backupId: BACKUP_ID })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

describe('backups.restore (SC-1649)', () => {
  const REQUEST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  function setUp(hasData: boolean) {
    const enqueued: Array<Record<string, unknown>> = [];
    Container.set(BackupRestorer, { hasData: async () => hasData } as unknown as BackupRestorer);
    Container.set(BullMqEnqueueService, {
      add: async (_descriptor: unknown, data: Record<string, unknown>) => {
        enqueued.push(data);
        return 'job-1';
      },
    } as unknown as BullMqEnqueueService);
    return enqueued;
  }

  test('queues a restore of the caller’s own upload into an empty account', async () => {
    const enqueued = setUp(false);
    const result = await makeAuthedCaller(user('u-1')).backups.restore({
      r2Key: 'temp/backup/u-1/a.gz',
      requestId: REQUEST,
    });
    expect(result).toEqual({ jobId: 'job-1' });
    expect(enqueued).toEqual([
      { userId: 'u-1', requestId: REQUEST, r2Key: 'temp/backup/u-1/a.gz' },
    ]);
  });

  test('refuses another account’s upload, and queues nothing', async () => {
    const enqueued = setUp(false);
    await expect(
      makeAuthedCaller(user('u-1')).backups.restore({
        r2Key: 'temp/backup/u-2/a.gz',
        requestId: REQUEST,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(enqueued).toEqual([]);
  });

  test('refuses an account that already has data, and queues nothing', async () => {
    const enqueued = setUp(true);
    await expect(
      makeAuthedCaller(user('u-1')).backups.restore({
        r2Key: 'temp/backup/u-1/a.gz',
        requestId: REQUEST,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(enqueued).toEqual([]);
  });

  test('says whether the account can take a restore', async () => {
    setUp(true);
    expect(await makeAuthedCaller(user('u-1')).backups.restorable()).toEqual({ empty: false });
  });
});
