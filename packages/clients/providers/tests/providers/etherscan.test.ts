import { describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import {
  ETHERSCAN_CHAINS,
  EtherscanProvider,
  findChainConfig,
} from '../../src/providers/etherscan';

function passthroughLimiter(): OutflowRateLimiter {
  return {
    execute: async <T>(fn: () => Promise<T>) => fn(),
  } as unknown as OutflowRateLimiter;
}

const VALID_EVM = '0xabcdef0000000000000000000000000000000000';

describe('EtherscanProvider', () => {
  test('chain dispatch via institution code', () => {
    const p = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), 'k');
    expect(p.canFetchBalances('ethereum')).toBe(true);
    expect(p.canFetchBalances('polygon')).toBe(true);
    expect(p.canFetchBalances('bitcoin')).toBe(false);
    expect(p.canFetchTransactions('arbitrum')).toBe(true);
    expect(p.canValidate('ethereum')).toBe(true);
  });

  test('isValidAddress matches 0x-prefixed 40-hex', () => {
    const p = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), 'k');
    expect(p.isValidAddress(VALID_EVM)).toBe(true);
    expect(p.isValidAddress('0xZZ')).toBe(false);
  });

  test('findChainConfig returns the correct chain config or null', () => {
    expect(findChainConfig('ethereum')?.chainId).toBe(1);
    expect(findChainConfig('polygon')?.chainId).toBe(137);
    expect(findChainConfig('not-a-chain')).toBeNull();
  });

  test('fetchBalances filters spam tokens and emits real ones', async () => {
    const p = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), 'k');
    const ctx = {
      institutionCode: 'ethereum',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'u', institutionId: 'i' },
      resolveCredentials: async () => ({ walletAddress: VALID_EVM }),
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (url.includes('action=balance') && !url.includes('tokenbalance')) {
        return new Response(
          JSON.stringify({
            status: '1',
            message: 'OK',
            result: '1000000000000000000', // 1 ETH
          }),
          { status: 200 }
        );
      }
      if (url.includes('action=tokentx')) {
        return new Response(
          JSON.stringify({
            status: '1',
            message: 'OK',
            result: [
              {
                blockNumber: '100',
                timeStamp: '1700000000',
                hash: '0xtx',
                from: '0xfrom',
                to: VALID_EVM,
                value: '1000000',
                contractAddress: '0xCONTRACT1',
                tokenName: 'USD Coin',
                tokenSymbol: 'USDC',
                tokenDecimal: '6',
              },
            ],
          }),
          { status: 200 }
        );
      }
      if (url.includes('action=tokenbalance')) {
        return new Response(
          JSON.stringify({ status: '1', message: 'OK', result: '5000000' }), // 5 USDC
          { status: 200 }
        );
      }
      throw new Error(`Unexpected url: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const out = await p.fetchBalances(ctx as never);
      const eth = out.find((h) => h.tokenIdentity.symbol === 'ETH');
      const usdc = out.find((h) => h.tokenIdentity.symbol === 'USDC');
      expect(eth?.balance).toBe('1');
      expect(usdc?.balance).toBe('5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchBalances returns [] for invalid wallet address', async () => {
    const p = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), 'k');
    const out = await p.fetchBalances({
      institutionCode: 'ethereum',
      baseCurrency: { id: 'usd', symbol: 'USD' } as never,
      credentialsRef: { userId: 'u', institutionId: 'i' },
      resolveCredentials: async () => ({ walletAddress: 'bad' }),
    } as never);
    expect(out).toEqual([]);
  });
});

describe('EtherscanProvider history pages (SC-1443)', () => {
  const ctx = {
    institutionCode: 'ethereum',
    baseCurrency: { id: 'usd', symbol: 'USD' } as never,
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => ({ walletAddress: VALID_EVM }),
  };

  async function withFetch<T>(answer: (url: string) => unknown, run: () => Promise<T>): Promise<T> {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) =>
      new Response(JSON.stringify(answer(url)), { status: 200 })) as unknown as typeof fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const latestBlock = { jsonrpc: '2.0', id: 1, result: '0x100' };
  const empty = { status: '0', message: 'No transactions found', result: [] };

  test('an empty history is not an error', async () => {
    const p = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), 'k');
    const out = await withFetch(
      (url) => (url.includes('eth_blockNumber') ? latestBlock : empty),
      () => p.fetchTransactions(ctx as never)
    );
    expect(out).toEqual([]);
  });

  // Rate-limit and auth refusals already threw in callJson; these are the
  // refusals that did not, and were read as the end of the history.
  test('a refused page throws instead of ending the history', async () => {
    const p = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), 'k');
    await expect(
      withFetch(
        (url) =>
          url.includes('eth_blockNumber')
            ? latestBlock
            : url.includes('action=txlist&')
              ? {
                  status: '0',
                  message: 'NOTOK',
                  result: 'Free API access is not supported for this chain',
                }
              : empty,
        () => p.fetchTransactions(ctx as never)
      )
    ).rejects.toThrow(/native history page refused .*not supported for this chain/);
  });

  test('an unreadable latest block throws instead of walking no blocks', async () => {
    const p = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), 'k');
    await expect(
      withFetch(
        (url) =>
          url.includes('eth_blockNumber')
            ? { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Query Timeout occured' } }
            : empty,
        () => p.fetchTransactions(ctx as never)
      )
    ).rejects.toThrow(/latest block unreadable/);
  });
});
