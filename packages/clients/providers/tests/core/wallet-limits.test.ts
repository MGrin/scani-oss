/**
 * SC-1271. Every fixture here is a wallet that never ends: an uncapped walk
 * over it would run until the process ran out of memory, which is what one
 * import of the Ethereum zero address did to the worker. Each test asserts the
 * walk stops, and that it says so rather than claiming a complete history.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import {
  BaseEvmProvider,
  type EvmChainConfig,
  type EvmInternalTxRow,
  type EvmNativeTxRow,
  type EvmPaginationPage,
  type EvmTokenTxRow,
} from '../../src/core/base/base-evm-provider';
import type { Capability } from '../../src/core/capabilities';
import type { TransactionFetchContext } from '../../src/core/types';
import {
  isBurnAddress,
  WALLET_HISTORY_ROW_CAP,
  WALLET_TOKEN_DISCOVERY_CAP,
} from '../../src/core/wallet-limits';
import { BitcoinProvider } from '../../src/providers/bitcoin';
import { ETHERSCAN_CHAINS, EtherscanProvider } from '../../src/providers/etherscan';

const passthroughLimiter = () =>
  ({ execute: async <T>(fn: () => Promise<T>) => fn() }) as unknown as OutflowRateLimiter;

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function recordingCtx(institutionCode: string, walletAddress: string) {
  const retractions: string[] = [];
  const ctx = {
    institutionCode,
    baseCurrency: { id: 'usd', symbol: 'USD' } as never,
    credentialsRef: { userId: 'u', institutionId: 'i' },
    resolveCredentials: async () => ({ walletAddress, etherscanApiKey: 'k' }),
    retractHistoryClaim: (reason: string | { text: string }) => {
      retractions.push(typeof reason === 'string' ? reason : reason.text);
    },
  } as unknown as TransactionFetchContext;
  return { ctx, retractions };
}

describe('isBurnAddress (SC-1271)', () => {
  test('the zero address and the dead sink, in any case, and nothing else', () => {
    expect(isBurnAddress('0x0000000000000000000000000000000000000000')).toBe(true);
    expect(isBurnAddress(' 0x000000000000000000000000000000000000dEaD ')).toBe(true);
    expect(isBurnAddress('0xabcdef0000000000000000000000000000000000')).toBe(false);
  });
});

const ETHEREUM: EvmChainConfig = {
  chainId: 1,
  institutionCode: 'ethereum',
  nativeSymbol: 'ETH',
  nativeName: 'Ethereum',
  nativeDecimals: 18,
};
const WALLET = '0xabcdef0000000000000000000000000000000000';
const PAGE = 10_000;

/** Every stream answers a full page, forever. */
class EndlessEvmProvider extends BaseEvmProvider {
  readonly providerKey = 'endless-evm';
  readonly capabilities: readonly Capability[] = ['transactions'];
  pages = 0;

  constructor() {
    super([ETHEREUM]);
  }

  private page<T>(startBlock: number, row: (block: number, i: number) => T): EvmPaginationPage<T> {
    this.pages += 1;
    return {
      rows: Array.from({ length: PAGE }, (_, i) => row(startBlock + Math.floor(i / 2), i)),
      hitPageCap: true,
    };
  }

  protected async fetchNativeTxPage(_c: EvmChainConfig, _w: string, start: number) {
    return this.page<EvmNativeTxRow>(
      start,
      (block, i) =>
        ({
          blockNumber: String(block),
          timeStamp: '1700000000',
          hash: `0xn${block}_${i}`,
          from: '0x1111111111111111111111111111111111111111',
          to: WALLET,
          value: '1',
          isError: '0',
          gasUsed: '0',
          gasPrice: '0',
        }) as unknown as EvmNativeTxRow
    );
  }

  protected async fetchTokenTxPage(_c: EvmChainConfig, _w: string, start: number) {
    return this.page<EvmTokenTxRow>(
      start,
      (block, i) =>
        ({
          blockNumber: String(block),
          timeStamp: '1700000000',
          hash: `0xt${block}_${i}`,
          from: '0x1111111111111111111111111111111111111111',
          to: WALLET,
          value: '1',
          contractAddress: '0x2222222222222222222222222222222222222222',
          tokenName: 'Token',
          tokenSymbol: 'TKN',
          tokenDecimal: '18',
        }) as unknown as EvmTokenTxRow
    );
  }

  protected async fetchInternalTxPage(_c: EvmChainConfig, _w: string, start: number) {
    return this.page<EvmInternalTxRow>(
      start,
      (block, i) =>
        ({
          blockNumber: String(block),
          timeStamp: '1700000000',
          hash: `0xi${block}_${i}`,
          from: '0x1111111111111111111111111111111111111111',
          to: WALLET,
          value: '1',
          isError: '0',
        }) as unknown as EvmInternalTxRow
    );
  }

  protected async fetchLatestBlock(): Promise<number> {
    return 100_000_000;
  }

  protected async resolveRequestParams() {
    return { walletAddress: WALLET, apiKey: 'k' };
  }

  run(ctx: TransactionFetchContext) {
    return this.fetchTransactionsByBlockRange(ctx);
  }
}

describe('an EVM wallet with no end (SC-1271)', () => {
  test('each stream stops at the row cap and the history claim is retracted', async () => {
    const p = new EndlessEvmProvider();
    const { ctx, retractions } = recordingCtx('ethereum', WALLET);
    await p.run(ctx);
    // Three streams, each stopping at the first page that reaches the cap.
    expect(p.pages).toBe(3 * Math.ceil(WALLET_HISTORY_ROW_CAP / PAGE));
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('native, token, internal');
  });
});

describe('ERC-20 discovery over a wallet that touched thousands of tokens (SC-1271)', () => {
  test(`looks up at most ${WALLET_TOKEN_DISCOVERY_CAP} tokens, newest first`, async () => {
    const tokenBalanceCalls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      if (url.includes('action=tokenbalance')) {
        tokenBalanceCalls.push(new URL(url).searchParams.get('contractaddress') ?? '');
        return Response.json({ status: '1', message: 'OK', result: '1' });
      }
      if (url.includes('action=tokentx')) {
        return Response.json({
          status: '1',
          message: 'OK',
          result: Array.from({ length: 10_000 }, (_, i) => ({
            blockNumber: String(10_000 - i),
            timeStamp: '1700000000',
            hash: `0x${i}`,
            from: '0x1',
            to: WALLET,
            value: '1',
            contractAddress: `0x${String(i % 1_000).padStart(40, '0')}`,
            tokenName: `Token ${i % 1_000}`,
            tokenSymbol: `T${i % 1_000}`,
            tokenDecimal: '0',
          })),
        });
      }
      if (url.includes('action=balance')) {
        return Response.json({ status: '1', message: 'OK', result: '0' });
      }
      throw new Error(`Unexpected url: ${url}`);
    }) as unknown as typeof fetch;

    const p = new EtherscanProvider(ETHERSCAN_CHAINS, passthroughLimiter(), 'k');
    const { ctx } = recordingCtx('ethereum', WALLET);
    await p.fetchBalances(ctx as never);

    expect(tokenBalanceCalls).toHaveLength(WALLET_TOKEN_DISCOVERY_CAP);
    // The first rows of a newest-first page are the ones kept.
    expect(tokenBalanceCalls[0]).toBe(`0x${'0'.repeat(40)}`);
  });
});

describe('a Bitcoin address with no end (SC-1271)', () => {
  test('the walk stops at the row cap and the history claim is retracted', async () => {
    const address = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
    let pages = 0;
    globalThis.fetch = (async () => {
      pages += 1;
      return Response.json({
        txs: Array.from({ length: 50 }, (_, i) => ({
          hash: `h${pages}_${i}`,
          time: 1_700_000_000 - pages,
          out: [{ addr: address, value: 1000 }],
          inputs: [],
        })),
      });
    }) as unknown as typeof fetch;

    const p = new BitcoinProvider(passthroughLimiter());
    const { ctx, retractions } = recordingCtx('bitcoin', address);
    const events = await p.fetchTransactions(ctx as never);

    expect(pages).toBe(WALLET_HISTORY_ROW_CAP / 50);
    expect(events).toHaveLength(WALLET_HISTORY_ROW_CAP);
    expect(retractions).toHaveLength(1);
    expect(retractions[0]).toContain('the address history');
  });
});
