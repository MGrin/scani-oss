import { describe, expect, test } from 'bun:test';
import { SCREENSHOT_PARSE } from '../../src/user-jobs/screenshot-parse';

describe('SCREENSHOT_PARSE descriptor', () => {
  test('jobId hashes r2Keys list — same files = same id', () => {
    const a = SCREENSHOT_PARSE.computeJobId({
      userId: 'u',
      requestId: 'r',
      r2Keys: ['k1', 'k2'],
      provider: 'openai',
      accountType: 'broker',
      expectedCurrency: 'USD',
    });
    const b = SCREENSHOT_PARSE.computeJobId({
      userId: 'u',
      requestId: 'r',
      r2Keys: ['k1', 'k2'],
      provider: 'openai',
      accountType: 'broker',
      expectedCurrency: 'USD',
    });
    expect(a).toBe(b);
  });

  test('jobId differs when the file set differs', () => {
    const base = {
      userId: 'u',
      requestId: 'r',
      provider: 'openai',
      accountType: 'broker',
      expectedCurrency: 'USD',
    };
    expect(SCREENSHOT_PARSE.computeJobId({ ...base, r2Keys: ['k1'] })).not.toBe(
      SCREENSHOT_PARSE.computeJobId({ ...base, r2Keys: ['k2'] })
    );
  });

  test('summary surfaces fileCount + provider/accountType/expectedCurrency/accountId only', () => {
    const summary = SCREENSHOT_PARSE.summarizePayload({
      userId: 'u',
      requestId: 'r',
      r2Keys: ['k1', 'k2', 'k3'],
      provider: 'openai',
      accountType: 'broker',
      expectedCurrency: 'USD',
      accountId: 'acc-1',
      context: 'sensitive context not for ui',
      minConfidence: 0.9,
    });
    expect(summary).toEqual({
      fileCount: 3,
      provider: 'openai',
      accountType: 'broker',
      expectedCurrency: 'USD',
      accountId: 'acc-1',
    });
    expect(summary).not.toHaveProperty('context');
    expect(summary).not.toHaveProperty('minConfidence');
  });

  test('zod schema rejects empty file list', () => {
    expect(() =>
      SCREENSHOT_PARSE.schema.parse({
        userId: 'u',
        requestId: 'r',
        r2Keys: [],
        provider: 'openai',
        accountType: 'broker',
        expectedCurrency: 'USD',
      })
    ).toThrow();
  });

  test('zod schema rejects more than 10 files (DoS guard)', () => {
    expect(() =>
      SCREENSHOT_PARSE.schema.parse({
        userId: 'u',
        requestId: 'r',
        r2Keys: Array.from({ length: 11 }, (_, i) => `k${i}`),
        provider: 'openai',
        accountType: 'broker',
        expectedCurrency: 'USD',
      })
    ).toThrow();
  });
});
