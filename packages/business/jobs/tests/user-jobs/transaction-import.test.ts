import { describe, expect, test } from 'bun:test';
import { TRANSACTION_IMPORT } from '../../src/user-jobs/transaction-import';

describe('TRANSACTION_IMPORT descriptor', () => {
  test('jobId dedup key is (user, account, source, requestId)', () => {
    const data = {
      userId: 'u1',
      requestId: 'r1',
      accountId: '00000000-0000-0000-0000-000000000001',
      source: 'etherscan',
    };
    expect(TRANSACTION_IMPORT.computeJobId(data)).toBe(TRANSACTION_IMPORT.computeJobId(data));
  });

  test('jobId differs across sources (same account, different ingester)', () => {
    const base = {
      userId: 'u',
      requestId: 'r',
      accountId: '00000000-0000-0000-0000-000000000001',
    };
    expect(TRANSACTION_IMPORT.computeJobId({ ...base, source: 'etherscan' })).not.toBe(
      TRANSACTION_IMPORT.computeJobId({ ...base, source: 'kraken-api' })
    );
  });

  test('zod schema requires accountId to be a UUID', () => {
    expect(() =>
      TRANSACTION_IMPORT.schema.parse({
        userId: 'u',
        requestId: 'r',
        accountId: 'not-a-uuid',
        source: 'etherscan',
      })
    ).toThrow();
  });

  test('summary surfaces ledger context (accountId, source, institutionId, since)', () => {
    const summary = TRANSACTION_IMPORT.summarizePayload({
      userId: 'u',
      requestId: 'r',
      accountId: '00000000-0000-0000-0000-000000000001',
      source: 'etherscan',
      institutionId: 'inst-9',
      since: '2024-01-01T00:00:00.000Z',
    });
    expect(summary).toEqual({
      accountId: '00000000-0000-0000-0000-000000000001',
      source: 'etherscan',
      institutionId: 'inst-9',
      since: '2024-01-01T00:00:00.000Z',
    });
  });
});
