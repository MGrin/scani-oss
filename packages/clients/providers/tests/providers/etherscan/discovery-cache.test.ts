import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { ETHERSCAN_CHAINS, EtherscanProvider } from '../../../src/providers/etherscan';
import { TokenBalanceCache } from '../../../src/providers/etherscan/balance-cache';
import {
  DISCOVERY_SWEEP_SECONDS,
  OVERLAP_BLOCKS,
  TokenDiscoveryCache,
} from '../../../src/providers/etherscan/discovery-cache';

const WALLET = '0xabcdef0000000000000000000000000000000000';
const USDC = '0x1111111111111111111111111111111111111111';
const DAI = '0x2222222222222222222222222222222222222222';
const LINK = '0x4444444444444444444444444444444444444444';
const HOUR_AGO = String(Math.floor(Date.now() / 1000) - 3600);

const passthroughLimiter = () =>
  ({ execute: async <T>(fn: () => Promise<T>) => fn() }) as unknown as OutflowRateLimiter;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Row = { contract: string; symbol: string; hash: string; block: number };

/** What each `tokentx` call asked for: `null` is the whole history. */
type Override = (startBlock: number | null) => Response | undefined;

/**
 * An Etherscan that answers `tokentx` from `ledger` the way the real one
 * does — newest first, from `startblock` when given — and `tokenbalance`
 * from `balances`. `override` lets a test replace one answer.
 */
function chain(ledger: Row[], balances: Record<string, string>, override?: Override) {
  const discovery: (number | null)[] = [];
  globalThis.fetch = (async (url: string) => {
    const params = new URL(url).searchParams;
    const action = params.get('action');
    if (action === 'tokentx') {
      const start = params.get('startblock');
      const startBlock = start === null ? null : Number(start);
      discovery.push(startBlock);
      const replaced = override?.(startBlock);
      if (replaced) return replaced;
      const rows = ledger
        .filter((r) => startBlock === null || r.block >= startBlock)
        .sort((a, b) => b.block - a.block);
      if (rows.length === 0) {
        return Response.json({ status: '0', message: 'No transactions found', result: [] });
      }
      return Response.json({
        status: '1',
        message: 'OK',
        result: rows.map((r) => ({
          blockNumber: String(r.block),
          timeStamp: HOUR_AGO,
          hash: r.hash,
          from: '0x9',
          to: WALLET,
          value: '1',
          contractAddress: r.contract,
          tokenName: r.symbol,
          tokenSymbol: r.symbol,
          tokenDecimal: '0',
        })),
      });
    }
    if (action === 'tokenbalance') {
      const contract = params.get('contractaddress') ?? '';
      return Response.json({ status: '1', message: 'OK', result: balances[contract] ?? '0' });
    }
    if (action === 'balance') return Response.json({ status: '1', message: 'OK', result: '0' });
    throw new Error(`Unexpected url: ${url}`);
  }) as unknown as typeof fetch;
  return discovery;
}

class MemoryStore {
  readonly data = new Map<string, string>();
  readonly expiries: number[] = [];
  down = false;
  get = async (key: string) => {
    if (this.down) throw new Error('redis down');
    return this.data.get(key) ?? null;
  };
  mget = async (...keys: string[]) => {
    if (this.down) throw new Error('redis down');
    return keys.map((k) => this.data.get(k) ?? null);
  };
  set = async (key: string, value: string, _ex: string, seconds: number) => {
    if (this.down) throw new Error('redis down');
    this.data.set(key, value);
    if (key.startsWith('etherscan:tokentx:')) this.expiries.push(seconds);
    return 'OK';
  };
}

const ctx = {
  institutionCode: 'ethereum',
  credentialsRef: { userId: 'u', institutionId: 'i' },
  resolveCredentials: async () => ({ walletAddress: WALLET, etherscanApiKey: 'k' }),
};

let clock = 1_800_000_000;
function provider(store: MemoryStore | null) {
  const s = store as never;
  return new EtherscanProvider(
    ETHERSCAN_CHAINS,
    passthroughLimiter(),
    'k',
    new TokenBalanceCache(s),
    new TokenDiscoveryCache(s, () => clock)
  );
}

const balancesOf = (snaps: { externalId: string; balance: string }[]) =>
  Object.fromEntries(snaps.map((s) => [s.externalId, s.balance]));

const ledger: Row[] = [
  { contract: USDC, symbol: 'USDC', hash: '0xa', block: 1000 },
  { contract: DAI, symbol: 'DAI', hash: '0xb', block: 900 },
];
const balances = { [USDC]: '5', [DAI]: '3' };

describe('incremental token discovery (SC-1535)', () => {
  test('CONTROL: with no store, every run reads the whole history', async () => {
    const p = provider(null);
    const discovery = chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    await p.fetchBalances(ctx as never);
    expect(discovery).toEqual([null, null]);
  });

  test('the second run reads only from just before the newest block seen, with the same balances', async () => {
    const p = provider(new MemoryStore());
    const discovery = chain(ledger, balances);
    const first = await p.fetchBalances(ctx as never);
    const second = await p.fetchBalances(ctx as never);
    expect(discovery).toEqual([null, 1000 - OVERLAP_BLOCKS]);
    expect(balancesOf(second)).toEqual(balancesOf(first));
    expect(balancesOf(second)).toEqual({ [USDC]: '5', [DAI]: '3' });
  });

  test('a token first transferred after the first run is found, and the earlier ones are kept', async () => {
    const p = provider(new MemoryStore());
    chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    const discovery = chain(
      [...ledger, { contract: LINK, symbol: 'LINK', hash: '0xc', block: 1500 }],
      { ...balances, [LINK]: '7' }
    );
    const second = await p.fetchBalances(ctx as never);
    expect(discovery).toEqual([1000 - OVERLAP_BLOCKS]);
    expect(balancesOf(second)).toEqual({ [USDC]: '5', [DAI]: '3', [LINK]: '7' });
  });

  test('a token whose balance moved since is re-read rather than served from the balance cache', async () => {
    const p = provider(new MemoryStore());
    chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    chain([...ledger, { contract: DAI, symbol: 'DAI', hash: '0xd', block: 1600 }], {
      ...balances,
      [DAI]: '0',
    });
    const second = await p.fetchBalances(ctx as never);
    expect(balancesOf(second)).toEqual({ [USDC]: '5' });
  });

  test('Redis down: every run reads the whole history', async () => {
    const store = new MemoryStore();
    store.down = true;
    const p = provider(store);
    const discovery = chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    const second = await p.fetchBalances(ctx as never);
    expect(discovery).toEqual([null, null]);
    expect(balancesOf(second)).toEqual({ [USDC]: '5', [DAI]: '3' });
  });

  test('a day after the last full read, the whole history is read again', async () => {
    const store = new MemoryStore();
    const p = provider(store);
    const discovery = chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    clock += DISCOVERY_SWEEP_SECONDS - 60;
    await p.fetchBalances(ctx as never);
    clock += 120;
    await p.fetchBalances(ctx as never);
    expect(discovery).toEqual([null, 1000 - OVERLAP_BLOCKS, null]);
  });

  test('an incremental read never extends the day: its entry expires with the full read it came from', async () => {
    const store = new MemoryStore();
    const p = provider(store);
    chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    clock += 3600;
    await p.fetchBalances(ctx as never);
    expect(store.expiries).toEqual([DISCOVERY_SWEEP_SECONDS, DISCOVERY_SWEEP_SECONDS - 3600]);
  });

  test('an incremental read Etherscan refuses falls back to the whole history in the same run', async () => {
    const p = provider(new MemoryStore());
    chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    const discovery = chain(ledger, balances, (start) =>
      start === null
        ? undefined
        : Response.json({ status: '0', message: 'NOTOK', result: 'Error!' })
    );
    const second = await p.fetchBalances(ctx as never);
    expect(discovery).toEqual([1000 - OVERLAP_BLOCKS, null]);
    expect(balancesOf(second)).toEqual({ [USDC]: '5', [DAI]: '3' });
  });

  test('no transfers in range keeps the remembered set', async () => {
    const p = provider(new MemoryStore());
    chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    const discovery = chain(ledger, balances, (start) =>
      start === null
        ? undefined
        : Response.json({ status: '0', message: 'No transactions found', result: [] })
    );
    const second = await p.fetchBalances(ctx as never);
    expect(discovery).toEqual([1000 - OVERLAP_BLOCKS]);
    expect(balancesOf(second)).toEqual({ [USDC]: '5', [DAI]: '3' });
  });

  test('a full incremental page may have cut transfers off, so the whole history is read', async () => {
    const p = provider(new MemoryStore());
    chain(ledger, balances);
    await p.fetchBalances(ctx as never);
    const full = Array.from({ length: 10_000 }, (_, i) => ({
      blockNumber: String(2000 - (i % 50)),
      timeStamp: HOUR_AGO,
      hash: `0xf${i}`,
      from: '0x9',
      to: WALLET,
      value: '1',
      contractAddress: USDC,
      tokenName: 'USDC',
      tokenSymbol: 'USDC',
      tokenDecimal: '0',
    }));
    const discovery = chain(ledger, balances, (start) =>
      start === null ? undefined : Response.json({ status: '1', message: 'OK', result: full })
    );
    const second = await p.fetchBalances(ctx as never);
    expect(discovery).toEqual([1000 - OVERLAP_BLOCKS, null]);
    expect(balancesOf(second)).toEqual({ [USDC]: '5', [DAI]: '3' });
  });
});
