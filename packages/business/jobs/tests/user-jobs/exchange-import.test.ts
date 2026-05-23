import { describe, expect, test } from 'bun:test';
import { EXCHANGE_IMPORT } from '../../src/user-jobs/exchange-import';

describe('EXCHANGE_IMPORT descriptor', () => {
  test('jobId is deterministic across (userId, institutionId, requestId)', () => {
    const data = {
      userId: 'u1',
      requestId: 'r1',
      institutionId: 'inst-9',
      provider: 'kraken',
    };
    expect(EXCHANGE_IMPORT.computeJobId(data)).toBe(EXCHANGE_IMPORT.computeJobId(data));
  });

  test('jobId differs across institutions', () => {
    const base = { userId: 'u', requestId: 'r', provider: 'kraken' };
    expect(EXCHANGE_IMPORT.computeJobId({ ...base, institutionId: 'a' })).not.toBe(
      EXCHANGE_IMPORT.computeJobId({ ...base, institutionId: 'b' })
    );
  });

  test('summary surfaces only institutionId + provider', () => {
    const summary = EXCHANGE_IMPORT.summarizePayload({
      userId: 'u-secret',
      requestId: 'r-secret',
      institutionId: 'inst-9',
      provider: 'kraken',
    });
    expect(summary).toEqual({ institutionId: 'inst-9', provider: 'kraken' });
    expect(summary).not.toHaveProperty('userId');
    expect(summary).not.toHaveProperty('requestId');
  });
});
