/**
 * SC-1545. A statement uploaded for an account the user no longer has is
 * refused by the feed write, and the refusal used to leave this processor as
 * the plain Error it arrived as: retried once under RETRY_HEAVY, then copied
 * to the dead-letter queue with both ids in its message.
 *
 * Beside `file-import.test.ts` rather than in it, because that file runs the
 * import against Postgres and this one needs none: the store, the catalog, the
 * transaction and the feed write are stubbed, so the only thing exercised is
 * what the processor makes of the refusal.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { getDb } from '@scani/db';
import { TokenRepository } from '@scani/domain/repositories';
import {
  CsvColumnDetectionService,
  FeedIngestService,
  RecordNotAccessibleError,
  UploadedFileService,
} from '@scani/domain/services';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import type { FileImportJob } from '@scani/jobs';
import { type ProcessorContext, UnrecoverableError, userFacingMessage } from '@scani/queue';
import { Container } from 'typedi';
import { describeRefusedRecord } from '../../src/lib/request-refusal';
import { FileImportProcessor } from '../../src/processors/file-import';

restoreContainerAfterAll();

const STATEMENT = [
  'Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance,id',
  'CARD_PAYMENT,Current,2026-08-01T10:00:00Z,2026-08-01T10:00:00Z,Salary ACME,1000.00,0.00,EUR,COMPLETED,1000.00,',
].join('\n');

const JOB: FileImportJob = {
  userId: 'user-1',
  requestId: 'req-1',
  r2Key: 'temp/file-import/user-1/statement.csv',
  fileType: 'csv',
  accountId: 'acct-1',
};

const CTX = {
  job: { id: 'job-1' },
  reportProgress: async () => undefined,
  reportStatus: async () => undefined,
} as unknown as ProcessorContext;

class TestableProcessor extends FileImportProcessor {
  run(data: FileImportJob) {
    return this.handle(data, CTX);
  }
}

const restores: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore();
});

async function failureOf(error: unknown): Promise<unknown> {
  Container.set(StorageFacade, {
    read: async () => Buffer.from(STATEMENT),
  } as unknown as StorageFacade);
  Container.set(UploadedFileService, {
    record: async () => null,
  } as unknown as UploadedFileService);
  Container.set(CsvColumnDetectionService, {
    detectColumns: async () => null,
  } as unknown as CsvColumnDetectionService);
  // The catalog knows the statement's currency, so the import reaches the write.
  Container.set(TokenRepository, {
    findBySymbol: async () => ({ id: 'token-eur', symbol: 'EUR' }),
  } as unknown as TokenRepository);
  Container.set(FeedIngestService, {
    ingest: async () => {
      throw error;
    },
  } as unknown as FeedIngestService);
  const db = getDb();
  restores.push(
    spyOn(db, 'transaction').mockImplementation(((fn: (tx: unknown) => unknown) =>
      fn({})) as unknown as typeof db.transaction)
  );
  try {
    await new TestableProcessor().run(JOB);
  } catch (err) {
    return err;
  }
  throw new Error('expected the processor to throw');
}

describe('FileImportProcessor error classification', () => {
  test('a statement for an account the user does not have fails on the first attempt, with no id in the sentence', async () => {
    const err = await failureOf(
      new RecordNotAccessibleError(
        'account',
        'FeedIngestService: user user-1 has no account acct-1'
      )
    );
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(describeRefusedRecord('account'));
    expect((err as Error).message).not.toContain('acct-1');
    expect((err as Error).message).not.toContain('user-1');
  });

  test('CONTROL: a write that failed for any other reason keeps its class, so it is still retried', async () => {
    const err = await failureOf(new Error('socket hang up'));
    expect(err).not.toBeInstanceOf(UnrecoverableError);
    expect((err as Error).message).toBe('socket hang up');
    expect(userFacingMessage(err)).toBeNull();
  });
});

describe('FileImportProcessor: a spreadsheet the parser refuses (SC-1734)', () => {
  async function refusalOf(bytes: Uint8Array, fileType: 'xls' | 'xlsx'): Promise<unknown> {
    Container.set(StorageFacade, {
      read: async () => Buffer.from(bytes),
    } as unknown as StorageFacade);
    Container.set(UploadedFileService, {
      record: async () => null,
    } as unknown as UploadedFileService);
    try {
      await new TestableProcessor().run({
        ...JOB,
        fileType,
        r2Key: `temp/file-import/user-1/s.${fileType}`,
      });
    } catch (err) {
      return err;
    }
    throw new Error('expected the processor to throw');
  }

  test('a binary .xls fails once, telling the owner to save it as .xlsx or CSV', async () => {
    const ole = new Uint8Array([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      0xa1,
      0xb1,
      0x1a,
      0xe1,
      ...new Uint8Array(504),
    ]);
    const err = await refusalOf(ole, 'xls');
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(
      'This is an old binary Excel file, which Scani cannot read. Save it as .xlsx or CSV and upload again. Nothing was imported.'
    );
  });

  test('a zip that is not a workbook fails once, with the same way out', async () => {
    const err = await refusalOf(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]), 'xlsx');
    expect(err).toBeInstanceOf(UnrecoverableError);
    expect(userFacingMessage(err)).toBe(
      'Scani could not read this file as a spreadsheet. Save it as .xlsx or CSV and upload again. Nothing was imported.'
    );
  });
});
