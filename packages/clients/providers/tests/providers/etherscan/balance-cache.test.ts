import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ETHERSCAN_CHAINS, EtherscanProvider } from '../../../src/providers/etherscan';
import {
  BALANCE_CACHE_TTL_SECONDS,
  type BalanceCacheStore,
  balanceMovesWithoutTransfers,
  TokenBalanceCache,
} from '../../../src/providers/etherscan/balance-cache';

const WALLET = '0xabcdef0000000000000000000000000000000000';
const USDC = '0x1111111111111111111111111111111111111111';
const DAI = '0x2222222222222222222222222222222222222222';
const STETH = '0x3333333333333333333333333333333333333333';
const HOUR_AGO = String(Math.floor(Date.now() / 1000) - 3600);

const passthroughLimiter = () =>
  ({ execute: async <T>(fn: () => Promise<T>) => fn() }) as unknown as OutflowRateLimiter;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Row = {
  contract: string;
  symbol: string;
  name?: string;
  hash: string;
  block?: string;
  at?: string;
};

/** A chain that answers `tokentx` with `rows` and `tokenbalance` from `balances`. */
function chain(rows: Row[], balances: Record<string, string>) {
  const balanceCalls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    const params = new URL(url).searchParams;
    const action = params.get('action');
    if (action === 'tokentx') {
      return Response.json({
        status: '1',
        message: 'OK',
        result: rows.map((r) => ({
          blockNumber: r.block ?? '100',
          timeStamp: r.at ?? HOUR_AGO,
          hash: r.hash,
          from: '0x9',
          to: WALLET,
          value: '1',
          contractAddress: r.contract,
          tokenName: r.name ?? r.symbol,
          tokenSymbol: r.symbol,
          tokenDecimal: '0',
        })),
      });
    }
    if (action === 'tokenbalance') {
      const contract = params.get('contractaddress') ?? '';
      balanceCalls.push(contract);
      return Response.json({ status: '1', message: 'OK', result: balances[contract] ?? '0' });
    }
    if (action === 'balance') return Response.json({ status: '1', message: 'OK', result: '0' });
    throw new Error(`Unexpected url: ${url}`);
  }) as unknown as typeof fetch;
  return balanceCalls;
}

class MemoryStore implements BalanceCacheStore {
  readonly data = new Map<string, string>();
  readonly ttls: unknown[] = [];
  mget = (async (...keys: string[]) =>
    keys.map((k) => this.data.get(k) ?? null)) as unknown as BalanceCacheStore['mget'];
  set = (async (key: string, value: string, ...rest: unknown[]) => {
    this.data.set(key, value);
    this.ttls.push(rest);
    return 'OK';
  }) as unknown as BalanceCacheStore['set'];
}

const ctx = {
  institutionCode: 'ethereum',
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ walletAddress: WALLET, etherscanApiKey: 'k' }),
};

function provider(store: BalanceCacheStore | null) {
  return new EtherscanProvider(
    ETHERSCAN_CHAINS,
    passthroughLimiter(),
    'k',
    new TokenBalanceCache(store)
  );
}

const balancesOf = (snaps: { externalId: string; balance: string }[]) =>
  Object.fromEntries(snaps.map((s) => [s.externalId, s.balance]));

describe('the Etherscan balance cache (SC-1513)', () => {
  const rows: Row[] = [
    { contract: USDC, symbol: 'USDC', hash: '0xa' },
    { contract: DAI, symbol: 'DAI', hash: '0xb' },
  ];

  test('CONTROL: with no store, every token is read from the chain every time', async () => {
    const p = provider(null);
    const calls = chain(rows, { [USDC]: '5' });
    await p.fetchBalances(ctx as never);
    await p.fetchBalances(ctx as never);
    expect(calls).toHaveLength(4);
  });

  test('an unchanged transfer history is answered from the cache, with the same balances', async () => {
    const p = provider(new MemoryStore());
    const calls = chain(rows, { [USDC]: '5' });
    const first = await p.fetchBalances(ctx as never);
    expect(calls).toHaveLength(2);
    const second = await p.fetchBalances(ctx as never);
    expect(calls).toHaveLength(2);
    expect(balancesOf(second)).toEqual(balancesOf(first));
    expect(balancesOf(second)).toEqual({ [USDC]: '5' });
  });

  test('a new transfer of one token re-reads exactly that token', async () => {
    const p = provider(new MemoryStore());
    chain(rows, { [USDC]: '5' });
    await p.fetchBalances(ctx as never);
    const calls = chain([{ contract: DAI, symbol: 'DAI', hash: '0xnew', block: '200' }, ...rows], {
      [USDC]: '5',
      [DAI]: '3',
    });
    const snaps = await p.fetchBalances(ctx as never);
    expect(calls).toEqual([DAI]);
    expect(balancesOf(snaps)).toEqual({ [USDC]: '5', [DAI]: '3' });
  });

  test('entries expire after a day, so no cached balance is older than that', async () => {
    const store = new MemoryStore();
    chain(rows, {});
    await provider(store).fetchBalances(ctx as never);
    expect(store.ttls).toEqual([
      ['EX', BALANCE_CACHE_TTL_SECONDS],
      ['EX', BALANCE_CACHE_TTL_SECONDS],
    ]);
    expect(BALANCE_CACHE_TTL_SECONDS).toBe(86_400);
  });

  test('a token that rebases is read from the chain every time', async () => {
    const p = provider(new MemoryStore());
    const steth: Row[] = [{ contract: STETH, symbol: 'stETH', hash: '0xs' }];
    chain(steth, { [STETH]: '100' });
    await p.fetchBalances(ctx as never);
    const calls = chain(steth, { [STETH]: '101' });
    const snaps = await p.fetchBalances(ctx as never);
    expect(calls).toEqual([STETH]);
    expect(balancesOf(snaps)).toEqual({ [STETH]: '101' });
  });

  test('a balance read right after a transfer is not cached', async () => {
    const p = provider(new MemoryStore());
    const fresh: Row[] = [
      { contract: USDC, symbol: 'USDC', hash: '0xa', at: String(Math.floor(Date.now() / 1000)) },
    ];
    chain(fresh, { [USDC]: '5' });
    await p.fetchBalances(ctx as never);
    const calls = chain(fresh, { [USDC]: '6' });
    const snaps = await p.fetchBalances(ctx as never);
    expect(calls).toEqual([USDC]);
    expect(balancesOf(snaps)).toEqual({ [USDC]: '6' });
  });

  test('a store that fails is a miss for every token, never an assumed balance', async () => {
    const store = new MemoryStore();
    const p = provider(store);
    chain(rows, { [USDC]: '5' });
    await p.fetchBalances(ctx as never);
    store.mget = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as BalanceCacheStore['mget'];
    const calls = chain(rows, { [USDC]: '7' });
    const snaps = await p.fetchBalances(ctx as never);
    expect(calls).toHaveLength(2);
    expect(balancesOf(snaps)).toEqual({ [USDC]: '7' });
  });

  test('a store that never answers is a miss inside the deadline, not a hang', async () => {
    const store = new MemoryStore();
    store.mget = (() => new Promise(() => {})) as unknown as BalanceCacheStore['mget'];
    store.set = (() => new Promise(() => {})) as unknown as BalanceCacheStore['set'];
    const calls = chain(rows, { [USDC]: '5' });
    const started = Date.now();
    const snaps = await provider(store).fetchBalances(ctx as never);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(calls).toHaveLength(2);
    expect(balancesOf(snaps)).toEqual({ [USDC]: '5' });
  });

  test('an entry that does not parse is a miss', async () => {
    const store = new MemoryStore();
    const p = provider(store);
    chain(rows, { [USDC]: '5' });
    await p.fetchBalances(ctx as never);
    for (const key of store.data.keys()) store.data.set(key, '{"fingerprint":1}');
    const calls = chain(rows, { [USDC]: '5' });
    await p.fetchBalances(ctx as never);
    expect(calls).toHaveLength(2);
  });
});

describe('balanceMovesWithoutTransfers', () => {
  test('names stETH, AMPL, OUSD and Aave receipt tokens, and not an ordinary token', () => {
    expect(balanceMovesWithoutTransfers('stETH', 'Liquid staked Ether 2.0')).toBe(true);
    expect(balanceMovesWithoutTransfers(' AMPL ', 'Ampleforth')).toBe(true);
    expect(balanceMovesWithoutTransfers('OUSD', 'Origin Dollar')).toBe(true);
    expect(balanceMovesWithoutTransfers('aEthUSDC', 'Aave Ethereum USDC')).toBe(true);
    expect(balanceMovesWithoutTransfers('USDC', 'USD Coin')).toBe(false);
    expect(balanceMovesWithoutTransfers('wstETH', 'Wrapped liquid staked Ether 2.0')).toBe(false);
  });
});
