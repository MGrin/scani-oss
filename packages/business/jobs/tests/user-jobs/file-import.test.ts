import { describe, expect, test } from 'bun:test';
import { FILE_IMPORT } from '../../src/user-jobs/file-import';

describe('FILE_IMPORT descriptor', () => {
  const job = { userId: 'u', requestId: 'r', r2Key: 'temp/file-import/u/a.sta', accountId: 'a' };

  test('takes every statement format a parser reads (SC-1726)', () => {
    for (const fileType of ['csv', 'ofx', 'qif', 'mt940', 'camt053', 'xlsx', 'xls']) {
      expect(FILE_IMPORT.schema.safeParse({ ...job, fileType }).success).toBe(true);
    }
  });

  test('control: a format with no statement parser is refused', () => {
    expect(FILE_IMPORT.schema.safeParse({ ...job, fileType: 'pdf' }).success).toBe(false);
  });
});
