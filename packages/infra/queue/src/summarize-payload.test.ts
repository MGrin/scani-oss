import { describe, expect, test } from 'bun:test';
import { JOB_NAMES } from './queue-names';
import { sanitizeResult } from './sanitize-result';
import { summarizePayload } from './summarize-payload';

// Defense-in-depth: the payload summary is rendered in the /jobs list UI
// and saved to `user_jobs.payload_summary`. Any field that ends up here
// is visible to the user and persisted forever. Pin the allowlist so a
// careless addition (e.g. adding a raw API key to a job payload and
// spreading it into the summary) gets caught in CI.

describe('summarizePayload', () => {
  test('wallet-import: keeps chain + redacted address + label; drops userId/requestId', () => {
    const summary = summarizePayload(JOB_NAMES.walletImport, {
      userId: 'user-uuid-should-not-leak',
      requestId: 'req-should-not-leak',
      chain: 'ethereum',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      label: 'primary',
    });
    expect(summary).toEqual({
      chain: 'ethereum',
      address: '0x1234…5678',
      label: 'primary',
    });
    expect(summary).not.toHaveProperty('userId');
    expect(summary).not.toHaveProperty('requestId');
  });

  test('screenshot-parse: counts files instead of listing signed r2 keys', () => {
    const summary = summarizePayload(JOB_NAMES.screenshotParse, {
      userId: 'u',
      requestId: 'r',
      r2Keys: ['temp/a/b.png?signature=redacted', 'temp/c/d.png?signature=redacted'],
      provider: 'openai',
      accountType: 'wallet',
      expectedCurrency: 'USD',
      accountId: 'acct-1',
    });
    expect(summary.fileCount).toBe(2);
    // The exact r2 keys MUST NOT appear — they're signed URLs and leaking
    // them in the /jobs UI is effectively handing out upload tokens.
    expect(JSON.stringify(summary)).not.toContain('signature');
  });

  test('exchange-import: never spreads the payload (no credentials leak)', () => {
    const summary = summarizePayload(JOB_NAMES.exchangeImport, {
      userId: 'u',
      requestId: 'r',
      institutionId: 'inst-1',
      provider: 'binance',
    });
    expect(summary).toEqual({ institutionId: 'inst-1', provider: 'binance' });
  });

  test('file-import: keeps fileType + accountId, strips r2Key', () => {
    const summary = summarizePayload(JOB_NAMES.fileImport, {
      userId: 'u',
      requestId: 'r',
      r2Key: 'temp/xyz.csv?signature=secret',
      fileType: 'csv',
      accountId: 'acct-1',
      enrich: true,
    });
    expect(summary).toEqual({ fileType: 'csv', accountId: 'acct-1', enrich: true });
    expect(JSON.stringify(summary)).not.toContain('signature');
  });
});

describe('sanitizeResult', () => {
  test('passes small objects through unchanged', () => {
    const result = { accountsCreated: 2, holdingsCreated: 7, errors: [] };
    expect(sanitizeResult(JOB_NAMES.walletImport, result)).toEqual(result);
  });

  test('truncates oversized top-level object fields in place', () => {
    const huge = 'x'.repeat(64 * 1024);
    const input = { keptSmall: 'ok', bloated: huge };
    const out = sanitizeResult(JOB_NAMES.walletImport, input) as Record<string, unknown>;
    expect(out.keptSmall).toBe('ok');
    expect(out.bloated).toEqual({ _truncated: true, originalBytes: expect.any(Number) });
  });

  test('returns null / undefined unchanged', () => {
    expect(sanitizeResult(JOB_NAMES.walletImport, null)).toBeNull();
    expect(sanitizeResult(JOB_NAMES.walletImport, undefined)).toBeUndefined();
  });
});
