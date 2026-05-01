import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { TronProvider } from '../../src/providers/tron';
import { tronBase58ToHex } from '../../src/providers/tron/address';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const VALID_TRX = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
// Known base58 / hex pair: USDT TRC20 contract on Tron mainnet.
const USDT_BASE58 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const USDT_HEX = '41a614f803b6fd780986a42c78ec9c7f77e6ded13c';

const ctx = {
  institutionCode: 'tron',
  baseCurrency: { id: 'usd', symbol: 'USD' } as never,
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ walletAddress: VALID_TRX }),
};

describe('TronProvider', () => {
  test('canFetchBalances / canFetchTransactions / canValidate gate on tron', () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api');
    expect(p.canFetchBalances('tron')).toBe(true);
    expect(p.canFetchTransactions('tron')).toBe(true);
    expect(p.canValidate('tron')).toBe(true);
    expect(p.canFetchBalances('ethereum')).toBe(false);
    expect(p.canFetchTransactions('ethereum')).toBe(false);
  });

  test('exposes transactions capability', () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api');
    expect(p.capabilities).toContain('transactions');
    expect(p.capabilities).toContain('current-balances');
    expect(p.capabilities).toContain('address-validator');
  });

  test('isValidAddress accepts T+33-base58, rejects others', () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api');
    expect(p.isValidAddress(VALID_TRX)).toBe(true);
    expect(p.isValidAddress('NotATronAddress')).toBe(false);
  });

  test('fetchBalances merges native TRX + TRC20 tokens', async () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith(`/v1/accounts/${VALID_TRX}`)) {
        return new Response(
          JSON.stringify({ data: [{ balance: 5_000_000 }] }), // 5 TRX
          { status: 200 }
        );
      }
      if (url.endsWith(`/v1/accounts/${VALID_TRX}/tokens`)) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                tokenId: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
                tokenAbbr: 'usdt',
                tokenName: 'Tether',
                tokenDecimal: 6,
                tokenType: 'trc20',
                balance: '1000000',
              },
              {
                tokenId: 'NOT_TRC20',
                tokenAbbr: 'fake',
                tokenName: 'Fake',
                tokenDecimal: 6,
                tokenType: 'trc10',
                balance: '50000',
              },
            ],
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    }) as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      const trx = out.find((h) => h.tokenIdentity.symbol === 'TRX');
      const usdt = out.find((h) => h.tokenIdentity.symbol === 'USDT');
      expect(trx?.balance).toBe('5');
      expect(usdt?.balance).toBe('1');
      // trc10 entry filtered out
      expect(out.find((h) => h.tokenIdentity.symbol === 'FAKE')).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('tronBase58ToHex', () => {
  test('USDT TRC20 contract base58 → known 21-byte hex', () => {
    expect(tronBase58ToHex(USDT_BASE58)).toBe(USDT_HEX);
  });

  test('produces 42-char lowercase hex with leading 41 (mainnet version byte)', () => {
    const hex = tronBase58ToHex(VALID_TRX);
    expect(hex).toMatch(/^41[0-9a-f]{40}$/);
  });

  test('different addresses decode to different hex', () => {
    expect(tronBase58ToHex(USDT_BASE58)).not.toBe(tronBase58ToHex(VALID_TRX));
  });

  test('rejects malformed input length', () => {
    expect(() => tronBase58ToHex('1')).toThrow();
  });

  test('rejects non-base58 characters', () => {
    // 'O' / '0' / 'I' / 'l' are not in the base58 alphabet.
    expect(() => tronBase58ToHex('O'.repeat(34))).toThrow();
  });
});

describe('TronProvider.fetchTransactions — native', () => {
  test('parses TransferContract rows, signs in/out, skips failed + non-transfer', async () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api');
    const walletHex = tronBase58ToHex(VALID_TRX).toLowerCase();
    const counterparty = `41${'aa'.repeat(20)}`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/transactions') && !u.pathname.endsWith('trc20/transactions')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                txID: 'tx-in-1',
                block_timestamp: 1_700_000_000_000,
                ret: [{ contractRet: 'SUCCESS' }],
                raw_data: {
                  contract: [
                    {
                      type: 'TransferContract',
                      parameter: {
                        value: {
                          owner_address: counterparty,
                          to_address: walletHex,
                          amount: 10_000_000, // 10 TRX in
                        },
                      },
                    },
                  ],
                },
              },
              {
                txID: 'tx-out-1',
                block_timestamp: 1_700_000_001_000,
                ret: [{ contractRet: 'SUCCESS' }],
                raw_data: {
                  contract: [
                    {
                      type: 'TransferContract',
                      parameter: {
                        value: {
                          owner_address: walletHex,
                          to_address: counterparty,
                          amount: 2_500_000, // 2.5 TRX out
                        },
                      },
                    },
                  ],
                },
              },
              {
                txID: 'tx-failed',
                block_timestamp: 1_700_000_002_000,
                ret: [{ contractRet: 'REVERT' }],
                raw_data: {
                  contract: [
                    {
                      type: 'TransferContract',
                      parameter: {
                        value: {
                          owner_address: walletHex,
                          to_address: counterparty,
                          amount: 999_999_999,
                        },
                      },
                    },
                  ],
                },
              },
              {
                txID: 'tx-other-contract',
                block_timestamp: 1_700_000_003_000,
                ret: [{ contractRet: 'SUCCESS' }],
                raw_data: {
                  contract: [
                    {
                      type: 'TriggerSmartContract',
                      parameter: { value: { owner_address: walletHex } },
                    },
                  ],
                },
              },
            ],
            meta: {},
          }),
          { status: 200 }
        );
      }
      // empty TRC20 page so the parallel loop finishes
      return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    }) as typeof fetch;

    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toHaveLength(2);
      const txIn = events.find((e) => e.externalId === 'tx-in-1');
      const txOut = events.find((e) => e.externalId === 'tx-out-1');
      expect(txIn?.kind).toBe('transfer_in');
      expect(txIn?.primary.quantity).toBe('10');
      expect(txIn?.primary.tokenIdentity.symbol).toBe('TRX');
      expect(txOut?.kind).toBe('transfer_out');
      expect(txOut?.primary.quantity).toBe('-2.5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('paginates via meta.fingerprint', async () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api');
    const walletHex = tronBase58ToHex(VALID_TRX).toLowerCase();
    const counterparty = `41${'bb'.repeat(20)}`;

    const pages: Array<{ data: unknown[]; meta: { fingerprint?: string } }> = [
      {
        data: [
          {
            txID: 'p1-tx',
            block_timestamp: 1_700_000_000_000,
            ret: [{ contractRet: 'SUCCESS' }],
            raw_data: {
              contract: [
                {
                  type: 'TransferContract',
                  parameter: {
                    value: {
                      owner_address: counterparty,
                      to_address: walletHex,
                      amount: 1_000_000,
                    },
                  },
                },
              ],
            },
          },
        ],
        meta: { fingerprint: 'fp-1' },
      },
      {
        data: [
          {
            txID: 'p2-tx',
            block_timestamp: 1_700_000_001_000,
            ret: [{ contractRet: 'SUCCESS' }],
            raw_data: {
              contract: [
                {
                  type: 'TransferContract',
                  parameter: {
                    value: {
                      owner_address: counterparty,
                      to_address: walletHex,
                      amount: 2_000_000,
                    },
                  },
                },
              ],
            },
          },
        ],
        meta: {}, // no fingerprint → loop ends
      },
    ];

    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/transactions') && !u.pathname.endsWith('trc20/transactions')) {
        const fp = u.searchParams.get('fingerprint');
        if (calls === 0) {
          expect(fp).toBeNull();
          calls++;
          return new Response(JSON.stringify(pages[0]), { status: 200 });
        }
        expect(fp).toBe('fp-1');
        calls++;
        return new Response(JSON.stringify(pages[1]), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    }) as typeof fetch;

    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events.map((e) => e.externalId).sort()).toEqual(['p1-tx', 'p2-tx']);
      expect(events.find((e) => e.externalId === 'p1-tx')?.primary.quantity).toBe('1');
      expect(events.find((e) => e.externalId === 'p2-tx')?.primary.quantity).toBe('2');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('respects since/until window', async () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api');
    const walletHex = tronBase58ToHex(VALID_TRX).toLowerCase();
    const counterparty = `41${'cc'.repeat(20)}`;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/transactions') && !u.pathname.endsWith('trc20/transactions')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                txID: 'old',
                block_timestamp: 1_000,
                ret: [{ contractRet: 'SUCCESS' }],
                raw_data: {
                  contract: [
                    {
                      type: 'TransferContract',
                      parameter: {
                        value: {
                          owner_address: counterparty,
                          to_address: walletHex,
                          amount: 1_000_000,
                        },
                      },
                    },
                  ],
                },
              },
              {
                txID: 'new',
                block_timestamp: 5_000,
                ret: [{ contractRet: 'SUCCESS' }],
                raw_data: {
                  contract: [
                    {
                      type: 'TransferContract',
                      parameter: {
                        value: {
                          owner_address: counterparty,
                          to_address: walletHex,
                          amount: 2_000_000,
                        },
                      },
                    },
                  ],
                },
              },
            ],
            meta: {},
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    }) as typeof fetch;

    try {
      const events = await p.fetchTransactions({
        ...ctx,
        since: new Date(2_000),
        until: new Date(10_000),
      } as never);
      expect(events.map((e) => e.externalId)).toEqual(['new']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('TronProvider.fetchTransactions — TRC20', () => {
  test('parses transfers, signs in/out, builds composite externalId', async () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/transactions/trc20')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                transaction_id: 'usdt-in',
                block_timestamp: 1_700_000_000_000,
                from: 'TOtherWallet1111111111111111111111',
                to: VALID_TRX,
                type: 'Transfer',
                value: '1500000', // 1.5 USDT in
                token_info: {
                  symbol: 'USDT',
                  name: 'Tether USD',
                  address: USDT_BASE58,
                  decimals: 6,
                },
              },
              {
                transaction_id: 'usdt-out',
                block_timestamp: 1_700_000_001_000,
                from: VALID_TRX,
                to: 'TOtherWallet2222222222222222222222',
                type: 'Transfer',
                value: '750000', // 0.75 USDT out
                token_info: {
                  symbol: 'USDT',
                  name: 'Tether USD',
                  address: USDT_BASE58,
                  decimals: 6,
                },
              },
              {
                transaction_id: 'usdt-self',
                block_timestamp: 1_700_000_002_000,
                from: VALID_TRX,
                to: VALID_TRX,
                type: 'Transfer',
                value: '999',
                token_info: {
                  symbol: 'USDT',
                  name: 'Tether USD',
                  address: USDT_BASE58,
                  decimals: 6,
                },
              },
              {
                transaction_id: 'approve',
                block_timestamp: 1_700_000_003_000,
                from: VALID_TRX,
                to: 'TOtherWallet3333333333333333333333',
                type: 'Approval',
                value: '1',
                token_info: {
                  symbol: 'USDT',
                  name: 'Tether USD',
                  address: USDT_BASE58,
                  decimals: 6,
                },
              },
            ],
            meta: {},
          }),
          { status: 200 }
        );
      }
      // native side returns nothing
      return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    }) as typeof fetch;

    try {
      const events = await p.fetchTransactions(ctx as never);
      expect(events).toHaveLength(2);
      const inEvent = events.find((e) => e.externalId === `usdt-in-${USDT_BASE58}`);
      const outEvent = events.find((e) => e.externalId === `usdt-out-${USDT_BASE58}`);
      expect(inEvent?.kind).toBe('transfer_in');
      expect(inEvent?.primary.quantity).toBe('1.5');
      expect(inEvent?.primary.tokenIdentity.symbol).toBe('USDT');
      expect(inEvent?.primary.tokenIdentity.providerMetadata).toEqual({
        tron: { contract: USDT_BASE58 },
      });
      expect(outEvent?.kind).toBe('transfer_out');
      expect(outEvent?.primary.quantity).toBe('-0.75');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('TronProvider — API key header', () => {
  test('attaches TRON-PRO-API-KEY when configured', async () => {
    const p = new TronProvider(passthroughLimiter(), 'http://api', 'secret-key');

    let seenHeaders: HeadersInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenHeaders = init?.headers;
      return new Response(JSON.stringify({ data: [], meta: {} }), { status: 200 });
    }) as typeof fetch;

    try {
      await p.fetchTransactions(ctx as never);
      const headers = new Headers(seenHeaders);
      expect(headers.get('TRON-PRO-API-KEY')).toBe('secret-key');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// Live test against TronGrid — gated on SCANI_LIVE=1 to keep CI offline-clean.
const LIVE = process.env.SCANI_LIVE === '1';
const liveDescribe = LIVE ? describe : describe.skip;
liveDescribe('TronProvider — live (SCANI_LIVE=1)', () => {
  test('fetches transactions from TronGrid Shasta testnet', async () => {
    const p = new TronProvider(passthroughLimiter(), 'https://api.shasta.trongrid.io');
    // A long-lived testnet faucet address with mixed activity. If this
    // ever runs dry, swap for any other Shasta address with > 0 txs.
    const liveAddress = 'TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy';
    const events = await p.fetchTransactions({
      institutionCode: 'tron',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'u', institutionId: 'i' },
      resolveCredentials: async () => ({ walletAddress: liveAddress }),
    } as never);
    expect(Array.isArray(events)).toBe(true);
    for (const e of events) {
      expect(['transfer_in', 'transfer_out']).toContain(e.kind);
      expect(typeof e.externalId).toBe('string');
      expect(e.occurredAt instanceof Date).toBe(true);
    }
  }, 30_000);
});
