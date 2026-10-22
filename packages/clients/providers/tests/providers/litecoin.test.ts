import { describe, expect, test } from 'bun:test';
import type { Token } from '@scani/db/schema';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import type { TransactionFetchContext } from '../../src/core/types';
import { WALLET_HISTORY_ROW_CAP } from '../../src/core/wallet-limits';
import { isLitecoinAddress, LitecoinProvider } from '../../src/providers/litecoin';

const WALLET = 'LKDyUEtTR1HXamkiEphisSiBJu6o3ZPE34';
const P2SH = 'M7uBSTV2qNDHDe2tHfNMqhFkZucgRMpJQk';
const P2SH_ALIAS = '31h38a54tFMrR8kzBnP2241MFD2EUHtGha';
const SEGWIT = 'ltc1qqqqsyqcyq5rqwzqfpg9scrgwpugpzysn3s44dy';
const TAPROOT = 'ltc1pqqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0sts9tf8';
const TIME = 1_700_000_000;
const EMPTY_STATS = { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 };

function provider(): LitecoinProvider {
  return new LitecoinProvider({
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as OutflowRateLimiter);
}

function context(address = WALLET): TransactionFetchContext {
  return {
    institutionCode: 'litecoin',
    baseCurrency: { id: 'usd', symbol: 'USD' } as Token,
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => ({ walletAddress: address }),
  };
}

function incoming(txid: string, address = WALLET, time = TIME) {
  return {
    txid,
    vin: [],
    vout: [{ scriptpubkey_address: address, value: 25_000_000 }],
    status: { confirmed: true, block_time: time },
  };
}

async function withFetch(respond: (url: URL) => Response, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    return respond(url);
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('LitecoinProvider', () => {
  test('validates checksums and supported address encodings', () => {
    for (const address of [WALLET, P2SH, P2SH_ALIAS, SEGWIT, TAPROOT, SEGWIT.toUpperCase()]) {
      expect(isLitecoinAddress(address)).toBe(true);
    }
    for (const address of [
      `${WALLET.slice(0, -1)}5`,
      `ltc1${'q'.repeat(39)}`,
      `${SEGWIT.slice(0, -1)}q`,
      `LTC1${SEGWIT.slice(4)}`,
      'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
      'not-a-litecoin-address',
    ]) {
      expect(isLitecoinAddress(address)).toBe(false);
    }
  });

  test('claims only Litecoin and probes both confirmed and mempool activity', async () => {
    const instance = provider();
    expect(instance.canFetchBalances('litecoin')).toBe(true);
    expect(instance.canFetchTransactions('litecoin')).toBe(true);
    expect(instance.canValidate('litecoin')).toBe(true);
    expect(instance.canFetchBalances('bitcoin')).toBe(false);
    expect(instance.canFetchTransactions('bitcoin')).toBe(false);
    expect(instance.canValidate('bitcoin')).toBe(false);
    for (const [chainCount, mempoolCount, active] of [
      [1, 0, true],
      [0, 1, true],
      [0, 0, false],
    ] as const) {
      await withFetch(
        () =>
          json({
            chain_stats: { ...EMPTY_STATS, tx_count: chainCount },
            mempool_stats: { ...EMPTY_STATS, tx_count: mempoolCount },
          }),
        async () => {
          expect(await instance.hasActivity(WALLET, 'litecoin', context())).toBe(active);
        }
      );
    }
  });

  test('invalid addresses do not call the API', async () => {
    await withFetch(
      () => {
        throw new Error('Unexpected request');
      },
      async () => {
        const instance = provider();
        expect(await instance.hasActivity('invalid', 'litecoin', context())).toBe(false);
        expect(await instance.fetchBalances(context('invalid'))).toEqual([]);
        expect(await instance.fetchTransactions(context('invalid'))).toEqual([]);
      }
    );
  });

  test('balances include unconfirmed net outputs and convert litoshi to LTC', async () => {
    await withFetch(
      () =>
        json({
          chain_stats: { funded_txo_sum: 200_000_000, spent_txo_sum: 120_000_000, tx_count: 2 },
          mempool_stats: { funded_txo_sum: 30_000_000, spent_txo_sum: 10_000_000, tx_count: 1 },
        }),
      async () => {
        expect(await provider().fetchBalances(context())).toMatchObject([
          {
            externalId: 'native',
            balance: '1',
            tokenIdentity: { symbol: 'LTC', name: 'Litecoin', decimals: 8 },
          },
        ]);
      }
    );
  });

  test('history sums all wallet outputs, subtracts inputs and excludes unconfirmed rows', async () => {
    await withFetch(
      () =>
        json([
          {
            ...incoming('in'),
            vout: [
              { scriptpubkey_address: WALLET, value: 10_000_000 },
              { scriptpubkey_address: WALLET, value: 15_000_000 },
            ],
          },
          {
            ...incoming('out'),
            vin: [{ prevout: { scriptpubkey_address: WALLET, value: 60_000_000 } }],
            vout: [{ scriptpubkey_address: WALLET, value: 10_000_000 }, { value: 49_000_000 }],
          },
          { ...incoming('pending'), status: { confirmed: false } },
        ]),
      async () => {
        expect(await provider().fetchTransactions(context())).toMatchObject([
          { externalId: 'in', kind: 'transfer_in', primary: { quantity: '0.25' } },
          { externalId: 'out', kind: 'transfer_out', primary: { quantity: '-0.5' } },
        ]);
      }
    );
  });

  test('fetches the older page using the API path cursor', async () => {
    const firstPage = Array.from({ length: 25 }, (_, i) =>
      incoming(`new-${i}`, WALLET, TIME + 100)
    );
    const paths: string[] = [];
    const base = `/api/address/${WALLET}/txs/chain`;
    await withFetch(
      (url) => {
        paths.push(url.pathname);
        expect(url.search).toBe('');
        if (url.pathname === base) return json(firstPage);
        if (url.pathname === `${base}/new-24`) return json([incoming('older', WALLET, TIME)]);
        throw new Error(`Unexpected history URL ${url}`);
      },
      async () => {
        const events = await provider().fetchTransactions(context());
        expect(events).toHaveLength(26);
        expect(events.at(-1)?.externalId).toBe('older');
        expect(paths).toEqual([base, `${base}/new-24`]);
      }
    );
  });

  test('uppercase SegWit and legacy P2SH aliases match canonical API script addresses', async () => {
    for (const [supplied, canonical] of [
      [SEGWIT.toUpperCase(), SEGWIT],
      [P2SH_ALIAS, P2SH],
    ]) {
      await withFetch(
        (url) => {
          expect(url.pathname).toBe(`/api/address/${canonical}/txs/chain`);
          return json([
            incoming('canonical-in', canonical),
            {
              ...incoming('canonical-out', canonical),
              vin: [{ prevout: { scriptpubkey_address: canonical, value: 50_000_000 } }],
            },
          ]);
        },
        async () => {
          expect(await provider().fetchTransactions(context(supplied))).toMatchObject([
            { externalId: 'canonical-in', primary: { quantity: '0.25' } },
            { externalId: 'canonical-out', primary: { quantity: '-0.25' } },
          ]);
        }
      );
    }
  });

  test('includes exact since/until boundaries and walks past a small timestamp inversion', async () => {
    const firstPage = Array.from({ length: 25 }, (_, i) =>
      incoming(`page-${i}`, WALLET, TIME - 3600)
    );
    let calls = 0;
    await withFetch(
      () =>
        json(
          ++calls === 1
            ? firstPage
            : [
                incoming('before', WALLET, TIME - 1),
                incoming('since', WALLET, TIME),
                incoming('until', WALLET, TIME + 100),
                incoming('after', WALLET, TIME + 101),
              ]
        ),
      async () => {
        const events = await provider().fetchTransactions({
          ...context(),
          since: new Date(TIME * 1000),
          until: new Date((TIME + 100) * 1000),
        });
        expect(events.map((event) => event.externalId)).toEqual(['since', 'until']);
        expect(calls).toBe(2);
      }
    );
  });

  test('stops since paging beyond the timestamp skew margin', async () => {
    let calls = 0;
    await withFetch(
      () => {
        calls++;
        return json(
          Array.from({ length: 25 }, (_, i) => incoming(`old-${i}`, WALLET, TIME - 7201))
        );
      },
      async () => {
        expect(
          await provider().fetchTransactions({ ...context(), since: new Date(TIME * 1000) })
        ).toEqual([]);
        expect(calls).toBe(1);
      }
    );
  });

  test('caps raw scanned rows even when every transaction has zero net value and retracts history', async () => {
    let calls = 0;
    const notices: unknown[] = [];
    await withFetch(
      () => {
        const page = calls++;
        if (calls > WALLET_HISTORY_ROW_CAP / 25) throw new Error('Raw scan cap was exceeded');
        return json(
          Array.from({ length: 25 }, (_, i) => ({
            ...incoming(`zero-${page}-${i}`),
            vin: [{ prevout: { scriptpubkey_address: WALLET, value: 25_000_000 } }],
          }))
        );
      },
      async () => {
        const events = await provider().fetchTransactions({
          ...context(),
          retractHistoryClaim: (notice) => {
            notices.push(notice);
          },
        });
        expect(events).toEqual([]);
        expect(calls).toBe(WALLET_HISTORY_ROW_CAP / 25);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
          key: 'v3.jobs.notices.pageCapRetracted',
          params: { provider: 'litecoin' },
        });
      }
    );
  });

  test('rejects a repeated cursor instead of returning duplicate or incomplete history', async () => {
    let calls = 0;
    await withFetch(
      () => {
        if (++calls > 2) throw new Error('Cursor guard failed');
        return json(Array.from({ length: 25 }, (_, i) => incoming(`same-${i}`)));
      },
      async () => {
        await expect(provider().fetchTransactions(context())).rejects.toThrow(
          'cursor did not advance'
        );
        expect(calls).toBe(2);
      }
    );
  });

  test('rejects malformed successful stats rather than reporting zero balances or no activity', async () => {
    for (const body of [
      {},
      { chain_stats: EMPTY_STATS },
      {
        chain_stats: { ...EMPTY_STATS, funded_txo_sum: '100' },
        mempool_stats: EMPTY_STATS,
      },
    ]) {
      await withFetch(
        () => json(body),
        async () => {
          await expect(provider().fetchBalances(context())).rejects.toThrow('invalid API response');
          await expect(provider().hasActivity(WALLET, 'litecoin', context())).rejects.toThrow(
            'invalid API response'
          );
        }
      );
    }
  });

  test('rejects malformed transaction values and missing confirmed timestamps', async () => {
    for (const body of [
      [{ ...incoming('bad'), vout: [{ value: -1 }] }],
      [{ ...incoming('bad'), status: { confirmed: true } }],
      {},
    ]) {
      await withFetch(
        () => json(body),
        async () => {
          await expect(provider().fetchTransactions(context())).rejects.toThrow(
            'invalid API response'
          );
        }
      );
    }
  });

  test('propagates upstream HTTP errors from probes, balances and history', async () => {
    await withFetch(
      () => json('unavailable', 503),
      async () => {
        const instance = provider();
        await expect(instance.hasActivity(WALLET, 'litecoin', context())).rejects.toThrow(
          'HTTP 503'
        );
        await expect(instance.fetchBalances(context())).rejects.toThrow('HTTP 503');
        await expect(instance.fetchTransactions(context())).rejects.toThrow('HTTP 503');
      }
    );
  });
});
