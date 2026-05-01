import { describe, expect, test } from 'bun:test';
import { WALLET_IMPORT } from '../../src/user-jobs/wallet-import';

describe('WALLET_IMPORT descriptor', () => {
  test('jobId is deterministic across calls', () => {
    const data = {
      userId: 'u1',
      requestId: 'r1',
      chain: 'ethereum',
      address: '0xABC',
    };
    expect(WALLET_IMPORT.computeJobId(data)).toBe(WALLET_IMPORT.computeJobId(data));
  });

  test('jobId lowercases the address (case-insensitive dedup)', () => {
    const id1 = WALLET_IMPORT.computeJobId({
      userId: 'u',
      requestId: 'r',
      chain: 'ethereum',
      address: '0xAbCdEf',
    });
    const id2 = WALLET_IMPORT.computeJobId({
      userId: 'u',
      requestId: 'r',
      chain: 'ethereum',
      address: '0xabcdef',
    });
    expect(id1).toBe(id2);
  });

  test('jobId differs across requestIds (legitimate re-imports get fresh ids)', () => {
    const base = { userId: 'u', chain: 'ethereum', address: '0xABC' };
    expect(WALLET_IMPORT.computeJobId({ ...base, requestId: 'r1' })).not.toBe(
      WALLET_IMPORT.computeJobId({ ...base, requestId: 'r2' })
    );
  });

  test('summary redacts the address and only allowlists chain/address/label', () => {
    const summary = WALLET_IMPORT.summarizePayload({
      userId: 'u',
      requestId: 'r',
      chain: 'ethereum',
      address: '0x1234567890abcdef1234567890abcdef12345678',
      label: 'My ETH',
      detectedInstitutionIds: ['inst-1'], // not surfaced
    });
    expect(summary).toEqual({
      chain: 'ethereum',
      address: '0x1234…5678',
      label: 'My ETH',
    });
    expect(summary).not.toHaveProperty('detectedInstitutionIds');
    expect(summary).not.toHaveProperty('userId');
  });

  test('zod schema rejects payloads missing required fields', () => {
    const bad = { userId: 'u', requestId: 'r' /* missing chain + address */ };
    expect(() => WALLET_IMPORT.schema.parse(bad)).toThrow();
  });

  test('zod schema accepts well-formed payloads', () => {
    const good = { userId: 'u', requestId: 'r', chain: 'ethereum', address: '0xABC' };
    expect(() => WALLET_IMPORT.schema.parse(good)).not.toThrow();
  });

  test('defaultOpts has retry budget + cleanup limits', () => {
    expect(WALLET_IMPORT.defaultOpts.attempts).toBe(3);
    expect(WALLET_IMPORT.defaultOpts.removeOnComplete).toBe(100);
    expect(WALLET_IMPORT.defaultOpts.removeOnFail).toBe(500);
  });
});
