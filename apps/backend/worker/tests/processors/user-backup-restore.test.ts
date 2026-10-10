import { describe, expect, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { BackupRestorer, RestoreRefused, type RestoreReport } from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { UserBackupRestoreJob } from '@scani/jobs';
import { BullMqEnqueueService, type ProcessorContext, userFacingMessage } from '@scani/queue';
import { Container } from 'typedi';
import { UserBackupRestoreProcessor } from '../../src/processors/user-backup-restore';

restoreContainerAfterAll();

class Exposed extends UserBackupRestoreProcessor {
  run(data: UserBackupRestoreJob) {
    return this.handle(data, {
      job: { id: 'job-1' },
      reportStatus: async () => {},
    } as unknown as ProcessorContext);
  }
}

const job: UserBackupRestoreJob = { userId: 'u1', requestId: 'r1', r2Key: 'temp/backup/u1/a.gz' };

function setUp(restore: () => Promise<RestoreReport>) {
  const deleted: string[] = [];
  const enqueued: Array<{ name: string; data: Record<string, unknown> }> = [];
  Container.set(StorageFacade, {
    read: async () => Buffer.from([]),
    delete: async (key: string) => {
      deleted.push(key);
    },
  } as unknown as StorageFacade);
  Container.set(BackupRestorer, { restore } as unknown as BackupRestorer);
  Container.set(BullMqEnqueueService, {
    add: async (descriptor: { name: string }, data: Record<string, unknown>) => {
      enqueued.push({ name: descriptor.name, data });
      return 'job-2';
    },
  } as unknown as BullMqEnqueueService);
  return { processor: new Exposed(), deleted, enqueued };
}

const report = (fields: Partial<RestoreReport> = {}): RestoreReport => ({
  rows: { holdings: 2, holding_transactions: 5 },
  balanceDifferences: [],
  unmatchedTokens: 0,
  earliestEvidenceAt: new Date('2021-08-23T00:00:00Z'),
  tokenIds: ['t1'],
  ids: new Map(),
  ...fields,
});

describe('user-backup-restore processor (SC-1649)', () => {
  test('restores, deletes the upload, and rebuilds history back to the oldest evidence', async () => {
    const { processor, deleted, enqueued } = setUp(async () => report());

    const result = await processor.run(job);

    expect(result).toEqual({
      rows: 7,
      holdings: 2,
      unmatchedTokens: 0,
      balanceDifferences: 0,
      differences: [],
    });
    expect(deleted).toEqual([job.r2Key]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.data.tokenIds).toEqual(['t1']);
    // Five years back, not the chart's default window.
    expect(enqueued[0]?.data.lookbackDays as number).toBeGreaterThan(1800);
  });

  test('a refusal fails at once with its reason, and the upload is kept', async () => {
    const { processor, deleted } = setUp(async () => {
      throw new RestoreRefused('not-empty', 'This account already has data.');
    });

    const error = await processor.run(job).catch((e: unknown) => e);

    expect(userFacingMessage(error)).toBe('This account already has data. Nothing was restored.');
    expect(deleted).toEqual([]);
  });

  test('any other failure is left to retry, not dressed as a sentence', async () => {
    const { processor } = setUp(async () => {
      throw new Error('connection reset');
    });
    const error = await processor.run(job).catch((e: unknown) => e);
    expect(userFacingMessage(error)).toBeNull();
  });
});
