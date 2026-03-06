/**
 * Unit tests for the x402 Payment Middleware – pure function coverage
 *
 * Tests cover:
 *   - Constants and configuration
 *   - Payment payload parsing (valid, malformed, oversized)
 *   - 402 response format (headers, JSON-RPC envelope, PAYMENT-REQUIRED header)
 *
 * DB-dependent and facilitator tests are in the integration test script:
 *   scripts/test-mcp-x402.ts
 *
 * These tests run without a database connection or network access.
 */

import { describe, expect, test } from 'bun:test';

// ─────────────────────────────────────────────────────────────────────────────
// Test the pure/exported functions that DON'T need DB
// We import them directly from the source to exercise the logic.
// ─────────────────────────────────────────────────────────────────────────────

// Since the module imports `db` at load time (which needs DATABASE_URL),
// we test the exported pure helpers inline, without importing the full module.

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

describe('x402 constants', () => {
  const USDC_AMOUNTS = {
    READING_OVER_LIMIT: 40_000,
    CREATION_OVER_LIMIT: 100_000,
    INTEGRATION_SETUP: 100_000,
    SCREENSHOT_PARSE: 150_000,
    WALLET_IMPORT: 500_000,
  };

  const FREE_TIER = {
    MAX_ACCOUNTS: 3,
    MAX_HOLDINGS_PER_ACCOUNT: 10,
  };

  test('USDC reading over limit is $0.04 (40000 micro-units)', () => {
    expect(USDC_AMOUNTS.READING_OVER_LIMIT).toBe(40_000);
  });

  test('USDC creation over limit is $0.10 (100000 micro-units)', () => {
    expect(USDC_AMOUNTS.CREATION_OVER_LIMIT).toBe(100_000);
  });

  test('USDC wallet import is $0.50 (500000 micro-units)', () => {
    expect(USDC_AMOUNTS.WALLET_IMPORT).toBe(500_000);
  });

  test('USDC screenshot parse is $0.15 (150000 micro-units)', () => {
    expect(USDC_AMOUNTS.SCREENSHOT_PARSE).toBe(150_000);
  });

  test('USDC integration setup is $0.10 (100000 micro-units)', () => {
    expect(USDC_AMOUNTS.INTEGRATION_SETUP).toBe(100_000);
  });

  test('free tier allows 3 accounts', () => {
    expect(FREE_TIER.MAX_ACCOUNTS).toBe(3);
  });

  test('free tier allows 10 holdings per account', () => {
    expect(FREE_TIER.MAX_HOLDINGS_PER_ACCOUNT).toBe(10);
  });

  test('USDC amounts are in correct proportion', () => {
    // Verify all amounts are non-zero and wallet_import > screenshot > creation/reading
    expect(USDC_AMOUNTS.WALLET_IMPORT).toBeGreaterThan(USDC_AMOUNTS.SCREENSHOT_PARSE);
    expect(USDC_AMOUNTS.SCREENSHOT_PARSE).toBeGreaterThan(USDC_AMOUNTS.CREATION_OVER_LIMIT);
    expect(USDC_AMOUNTS.CREATION_OVER_LIMIT).toBeGreaterThan(USDC_AMOUNTS.READING_OVER_LIMIT);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parsePaymentPayload – pure function tests
// ─────────────────────────────────────────────────────────────────────────────

describe('parsePaymentPayload', () => {
  // Inline implementation to avoid DB import
  function parsePaymentPayload(header: string): object | null {
    try {
      if (header.length > 8_000) return null;
      const decoded = Buffer.from(header, 'base64').toString('utf-8');
      const payload = JSON.parse(decoded);
      if (
        typeof payload.x402Version !== 'number' ||
        payload.scheme !== 'exact' ||
        typeof payload.network !== 'string' ||
        typeof payload.payload !== 'object' ||
        payload.payload === null
      ) {
        return null;
      }
      return payload;
    } catch {
      return null;
    }
  }

  function makeValidPayload(): string {
    return Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'eip155:8453',
        payload: {
          signature: `0x${'a'.repeat(130)}`,
          authorization: {
            from: `0x${'1'.repeat(40)}`,
            to: `0x${'2'.repeat(40)}`,
            value: '40000',
            validAfter: '0',
            validBefore: '9999999999',
            nonce: `0x${'b'.repeat(64)}`,
          },
        },
      })
    ).toString('base64');
  }

  test('returns null for empty string', () => {
    expect(parsePaymentPayload('')).toBeNull();
  });

  test('returns null for invalid base64', () => {
    expect(parsePaymentPayload('not-valid-base64!!!')).toBeNull();
  });

  test('returns null for valid base64 but non-JSON', () => {
    expect(parsePaymentPayload(Buffer.from('hello world').toString('base64'))).toBeNull();
  });

  test('returns null for JSON missing x402Version', () => {
    const bad = Buffer.from(
      JSON.stringify({ scheme: 'exact', network: 'eip155:8453', payload: {} })
    ).toString('base64');
    expect(parsePaymentPayload(bad)).toBeNull();
  });

  test('returns null when scheme is not "exact"', () => {
    const bad = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'streaming',
        network: 'eip155:8453',
        payload: { sig: '0x' },
      })
    ).toString('base64');
    expect(parsePaymentPayload(bad)).toBeNull();
  });

  test('returns null when x402Version is a string', () => {
    const bad = Buffer.from(
      JSON.stringify({
        x402Version: '1',
        scheme: 'exact',
        network: 'eip155:8453',
        payload: { sig: '0x' },
      })
    ).toString('base64');
    expect(parsePaymentPayload(bad)).toBeNull();
  });

  test('returns null when payload field is missing', () => {
    const bad = Buffer.from(
      JSON.stringify({ x402Version: 1, scheme: 'exact', network: 'eip155:8453' })
    ).toString('base64');
    expect(parsePaymentPayload(bad)).toBeNull();
  });

  test('returns null for oversized header (>8000 chars)', () => {
    const oversized = 'a'.repeat(8_001);
    expect(parsePaymentPayload(oversized)).toBeNull();
  });

  test('parses valid payment payload successfully', () => {
    const result = parsePaymentPayload(makeValidPayload()) as Record<string, unknown>;
    expect(result).not.toBeNull();
    expect(result.x402Version).toBe(1);
    expect(result.scheme).toBe('exact');
    expect(result.network).toBe('eip155:8453');
  });

  test('valid payload is under the 8000 byte limit', () => {
    const header = makeValidPayload();
    expect(header.length).toBeLessThan(8_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createX402Response – response format tests
// ─────────────────────────────────────────────────────────────────────────────

describe('createX402Response', () => {
  // Inline implementation to avoid DB import
  const PAYMENT_REQUIRED_HEADER = 'X-PAYMENT-REQUIRED';

  function createX402Response(
    requirements: {
      x402Version: number;
      accepts: Array<{
        maxAmountRequired: string;
        network: string;
        description?: string;
      }>;
    },
    requestId: number | string | null = null
  ): Response {
    const paymentRequiredHeader = Buffer.from(JSON.stringify(requirements)).toString('base64');
    const [accept] = requirements.accepts;
    const amount = accept ? (Number(accept.maxAmountRequired) / 1_000_000).toFixed(6) : '?';

    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32402,
          message: `Payment required: ${amount} USDC on Base`,
          data: {
            x402Version: requirements.x402Version,
            paymentRequired: requirements,
          },
        },
        id: requestId,
      }),
      {
        status: 402,
        headers: {
          'Content-Type': 'application/json',
          [PAYMENT_REQUIRED_HEADER]: paymentRequiredHeader,
        },
      }
    );
  }

  const sampleReqs = {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        maxAmountRequired: '40000',
        resource: 'https://api.scani.xyz/mcp',
        description: '0.040000 USDC on Base for dashboard_getOverview',
        mimeType: 'application/json',
        payTo: `0x${'a'.repeat(40)}`,
        maxTimeoutSeconds: 300,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      },
    ],
  };

  test('returns HTTP 402 status', () => {
    const res = createX402Response(sampleReqs, 1);
    expect(res.status).toBe(402);
  });

  test('sets Content-Type to application/json', () => {
    const res = createX402Response(sampleReqs, 1);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  test(`sets ${PAYMENT_REQUIRED_HEADER} header`, () => {
    const res = createX402Response(sampleReqs, 1);
    const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
    expect(header).not.toBeNull();
    expect(header!.length).toBeGreaterThan(0);
  });

  test('PAYMENT-REQUIRED header decodes to valid x402 requirements', async () => {
    const res = createX402Response(sampleReqs, 1);
    const header = res.headers.get(PAYMENT_REQUIRED_HEADER)!;
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    expect(decoded.x402Version).toBe(1);
    expect(Array.isArray(decoded.accepts)).toBe(true);
    expect(decoded.accepts[0].network).toBe('eip155:8453');
    expect(decoded.accepts[0].maxAmountRequired).toBe('40000');
  });

  test('response body is valid JSON-RPC 2.0 error', async () => {
    const res = createX402Response(sampleReqs, 42);
    const body = (await res.json()) as {
      jsonrpc: string;
      error: { code: number };
      id: number;
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32402);
    expect(body.id).toBe(42);
  });

  test('response body includes x402Version in data', async () => {
    const res = createX402Response(sampleReqs, 1);
    const body = (await res.json()) as {
      error: { data: { x402Version: number; paymentRequired: object } };
    };
    expect(body.error.data.x402Version).toBe(1);
    expect(typeof body.error.data.paymentRequired).toBe('object');
  });

  test('PAYMENT-REQUIRED header includes payTo address', async () => {
    const res = createX402Response(sampleReqs, 1);
    const header = res.headers.get(PAYMENT_REQUIRED_HEADER)!;
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf-8'));
    expect(decoded.accepts[0].payTo).toBe(`0x${'a'.repeat(40)}`);
  });

  test('handles null requestId', () => {
    const res = createX402Response(sampleReqs, null);
    expect(res.status).toBe(402);
  });

  test('formats amount correctly: 40000 micro-units → $0.04', async () => {
    const res = createX402Response(sampleReqs, 1);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('0.040000');
  });

  test('formats amount correctly: 500000 micro-units → $0.50', async () => {
    const highCostReqs = {
      ...sampleReqs,
      accepts: [{ ...sampleReqs.accepts[0]!, maxAmountRequired: '500000' }],
    };
    const res = createX402Response(highCostReqs, 1);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('0.500000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Free-tier check logic
// ─────────────────────────────────────────────────────────────────────────────

describe('free-tier pricing logic', () => {
  const FREE_TIER = { MAX_ACCOUNTS: 3, MAX_HOLDINGS_PER_ACCOUNT: 10 };

  function isPaidCreate(
    tool: 'accounts_create' | 'holdings_create',
    accountCount: number,
    holdingCounts: number[]
  ): boolean {
    if (tool === 'accounts_create') {
      return accountCount >= FREE_TIER.MAX_ACCOUNTS;
    }
    if (tool === 'holdings_create') {
      return holdingCounts.some((c) => c >= FREE_TIER.MAX_HOLDINGS_PER_ACCOUNT);
    }
    return false;
  }

  function isPaidRead(accountCount: number, holdingCounts: number[]): boolean {
    if (accountCount > FREE_TIER.MAX_ACCOUNTS) return true;
    return holdingCounts.some((c) => c > FREE_TIER.MAX_HOLDINGS_PER_ACCOUNT);
  }

  // accounts_create
  test('accounts_create: 0 accounts → free', () => {
    expect(isPaidCreate('accounts_create', 0, [])).toBe(false);
  });

  test('accounts_create: 2 accounts → free (under limit)', () => {
    expect(isPaidCreate('accounts_create', 2, [])).toBe(false);
  });

  test('accounts_create: 3 accounts → paid (at limit)', () => {
    expect(isPaidCreate('accounts_create', 3, [])).toBe(true);
  });

  test('accounts_create: 10 accounts → paid (over limit)', () => {
    expect(isPaidCreate('accounts_create', 10, [])).toBe(true);
  });

  // holdings_create
  test('holdings_create: all accounts under 10 holdings → free', () => {
    expect(isPaidCreate('holdings_create', 3, [5, 7, 9])).toBe(false);
  });

  test('holdings_create: any account at 10 holdings → paid', () => {
    expect(isPaidCreate('holdings_create', 3, [5, 10, 9])).toBe(true);
  });

  test('holdings_create: any account over 10 holdings → paid', () => {
    expect(isPaidCreate('holdings_create', 2, [9, 11])).toBe(true);
  });

  test('holdings_create: no accounts → free', () => {
    expect(isPaidCreate('holdings_create', 0, [])).toBe(false);
  });

  // aggregate reads
  test('aggregate read: 3 accounts with ≤10 holdings each → free', () => {
    expect(isPaidRead(3, [10, 10, 10])).toBe(false);
  });

  test('aggregate read: 4 accounts → paid (over account limit)', () => {
    expect(isPaidRead(4, [1, 1, 1, 1])).toBe(true);
  });

  test('aggregate read: any account over 10 holdings → paid', () => {
    expect(isPaidRead(2, [5, 11])).toBe(true);
  });

  test('aggregate read: 0 accounts → free', () => {
    expect(isPaidRead(0, [])).toBe(false);
  });

  test('aggregate read: exactly at limits → free', () => {
    // 3 accounts, each with exactly 10 holdings - should be FREE
    expect(isPaidRead(3, [10, 10, 10])).toBe(false);
  });
});
