import { describe, expect, test } from 'bun:test';
import {
  BaseEvmProvider,
  type EvmChainConfig,
  type EvmInternalTxRow,
  type EvmNativeTxRow,
  type EvmPaginationPage,
  type EvmTokenTxRow,
} from '../../../src/core/base/base-evm-provider';
import type { Capability } from '../../../src/core/capabilities';
import { createMockSelfCredContext } from '../../../src/core/testing';
import {
  type JobNotice,
  type NoticeInput,
  type ProviderContext,
  type TransactionEvent,
  type TransactionFetchContext,
  toJobNotice,
  type WithUserCreds,
} from '../../../src/core/types';

const ETHEREUM: EvmChainConfig = {
  chainId: 1,
  institutionCode: 'ethereum',
  nativeSymbol: 'ETH',
  nativeName: 'Ethereum',
  nativeDecimals: 18,
};
const POLYGON: EvmChainConfig = {
  chainId: 137,
  institutionCode: 'polygon',
  nativeSymbol: 'MATIC',
  nativeName: 'Polygon',
  nativeDecimals: 18,
};

interface PaginatedFixtures {
  native: EvmPaginationPage<EvmNativeTxRow>[];
  token: EvmPaginationPage<EvmTokenTxRow>[];
  internal?: EvmPaginationPage<EvmInternalTxRow>[];
  latestBlock?: number;
  walletAddress?: string;
  apiKey?: string;
}

class TestEvmProvider extends BaseEvmProvider {
  readonly providerKey = 'test-evm';
  readonly capabilities: readonly Capability[] = ['transactions'];

  nativeCalls: Array<{ start: number; end: number }> = [];
  tokenCalls: Array<{ start: number; end: number }> = [];
  internalCalls: Array<{ start: number; end: number }> = [];

  constructor(
    chains: readonly EvmChainConfig[],
    private readonly fixtures: PaginatedFixtures
  ) {
    super(chains);
  }

  protected async fetchNativeTxPage(
    _chain: EvmChainConfig,
    _walletAddress: string,
    startBlock: number,
    endBlock: number,
    _apiKey: string
  ): Promise<EvmPaginationPage<EvmNativeTxRow>> {
    this.nativeCalls.push({ start: startBlock, end: endBlock });
    const idx = this.nativeCalls.length - 1;
    return this.fixtures.native[idx] ?? { rows: [], hitPageCap: false };
  }

  protected async fetchTokenTxPage(
    _chain: EvmChainConfig,
    _walletAddress: string,
    startBlock: number,
    endBlock: number,
    _apiKey: string
  ): Promise<EvmPaginationPage<EvmTokenTxRow>> {
    this.tokenCalls.push({ start: startBlock, end: endBlock });
    const idx = this.tokenCalls.length - 1;
    return this.fixtures.token[idx] ?? { rows: [], hitPageCap: false };
  }

  protected async fetchInternalTxPage(
    _chain: EvmChainConfig,
    _walletAddress: string,
    startBlock: number,
    endBlock: number,
    _apiKey: string
  ): Promise<EvmPaginationPage<EvmInternalTxRow>> {
    this.internalCalls.push({ start: startBlock, end: endBlock });
    const idx = this.internalCalls.length - 1;
    return this.fixtures.internal?.[idx] ?? { rows: [], hitPageCap: false };
  }

  protected async fetchLatestBlock(): Promise<number> {
    return this.fixtures.latestBlock ?? 1_000_000;
  }

  protected async resolveRequestParams(): Promise<{ walletAddress: string; apiKey: string }> {
    return {
      walletAddress: this.fixtures.walletAddress ?? WALLET,
      apiKey: this.fixtures.apiKey ?? 'test-api-key',
    };
  }

  // Public test entry points (avoid bracket access on protected methods).
  async runFetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    return this.fetchTransactionsByBlockRange(ctx);
  }

  runGetChainConfig(institutionCode: string): EvmChainConfig {
    return this.getChainConfig(institutionCode);
  }
}

const WALLET = '0xabcdef0000000000000000000000000000000000';

function ctx(institutionCode: string) {
  return {
    ...createMockSelfCredContext({
      credentials: { etherscanApiKey: 'k' },
      institutionId: 'inst',
    }),
    institutionCode,
  } as WithUserCreds<ProviderContext> & { institutionCode: string };
}

/** A context that records every retraction, the way `TransactionRouter` does. */
function recordingCtx(
  institutionCode: string
): TransactionFetchContext & { retractions: string[]; notices: JobNotice[] } {
  const retractions: string[] = [];
  // The structured form beside the sentence, so a test can ask what key the
  // reader renders it under (SC-434).
  const notices: JobNotice[] = [];
  return {
    ...ctx(institutionCode),
    retractions,
    notices,
    retractHistoryClaim: (reason: NoticeInput) => {
      const notice = toJobNotice(reason);
      notices.push(notice);
      retractions.push(notice.text);
    },
  };
}

function nativeRow(over: Partial<EvmNativeTxRow>): EvmNativeTxRow {
  return {
    blockNumber: '100',
    timeStamp: '1704067200', // 2024-01-01T00:00:00Z
    hash: '0xtx',
    from: '0xfrom',
    to: WALLET,
    value: '1000000000000000000', // 1 ETH (18 decimals)
    gasPrice: '0',
    gasUsed: '0',
    isError: '0',
    txreceipt_status: '1',
    ...over,
  };
}

function tokenRow(over: Partial<EvmTokenTxRow>): EvmTokenTxRow {
  return {
    blockNumber: '100',
    timeStamp: '1704067200',
    hash: '0xtx',
    from: '0xfrom',
    to: WALLET,
    value: '1000000', // 1.0 USDC at 6 decimals
    contractAddress: '0xCONTRACT', // mixed-case → base lowercases
    tokenName: 'USD Coin',
    tokenSymbol: 'usdc', // lowercase → base uppercases
    tokenDecimal: '6',
    ...over,
  };
}

function internalRow(over: Partial<EvmInternalTxRow>): EvmInternalTxRow {
  return {
    blockNumber: '100',
    timeStamp: '1704067200',
    hash: '0xtx',
    from: '0xcontract',
    to: WALLET,
    value: '1000000000000000000', // 1 ETH
    type: 'call',
    traceId: '0',
    isError: '0',
    ...over,
  };
}

describe('BaseEvmProvider — chain config lookup', () => {
  test('getChainConfig returns the right config for a known institutionCode', () => {
    const provider = new TestEvmProvider([ETHEREUM, POLYGON], { native: [], token: [] });
    expect(provider.runGetChainConfig('ethereum')).toEqual(ETHEREUM);
    expect(provider.runGetChainConfig('polygon')).toEqual(POLYGON);
  });

  test('getChainConfig throws for an unknown institutionCode', () => {
    const provider = new TestEvmProvider([ETHEREUM], { native: [], token: [] });
    expect(() => provider.runGetChainConfig('mainnet-unsupported')).toThrow(
      /institutionCode 'mainnet-unsupported' not in supported chains/
    );
  });
});

describe('BaseEvmProvider — native tx normalization', () => {
  test('inflow native tx → kind=transfer_in, positive quantity', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [{ rows: [nativeRow({})], hitPageCap: false }],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('transfer_in');
    expect(events[0]?.primary.quantity).toBe('1');
  });

  test('outflow native tx → kind=transfer_out, negative quantity', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        {
          rows: [nativeRow({ from: WALLET, to: '0xother' })],
          hitPageCap: false,
        },
      ],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events[0]?.kind).toBe('transfer_out');
    expect(events[0]?.primary.quantity).toBe('-1');
  });

  test('failed tx (isError=1) is skipped', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [{ rows: [nativeRow({ isError: '1' })], hitPageCap: false }],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(0);
  });

  test('failed tx (txreceipt_status=0) is skipped', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [{ rows: [nativeRow({ txreceipt_status: '0' })], hitPageCap: false }],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(0);
  });

  test('zero-value native tx is skipped (no balance change)', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [{ rows: [nativeRow({ value: '0' })], hitPageCap: false }],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(0);
  });

  test('case-insensitive wallet address match', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      walletAddress: WALLET.toUpperCase(),
      native: [{ rows: [nativeRow({ to: WALLET })], hitPageCap: false }],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events[0]?.kind).toBe('transfer_in');
  });

  test('chain decimals are honored (Polygon also uses 18)', async () => {
    const provider = new TestEvmProvider([POLYGON], {
      native: [
        {
          rows: [nativeRow({ value: '500000000000000000' })], // 0.5 MATIC
          hitPageCap: false,
        },
      ],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('polygon'));
    expect(events[0]?.primary.quantity).toBe('0.5');
    expect(events[0]?.primary.tokenIdentity.symbol).toBe('MATIC');
  });

  test('native identity carries chainId in providerMetadata.etherscan', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [{ rows: [nativeRow({})], hitPageCap: false }],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events[0]?.primary.tokenIdentity.providerMetadata).toEqual({
      etherscan: { chainId: 1 },
    });
  });
});

describe('BaseEvmProvider — token tx normalization', () => {
  test('contract address is lowercased and symbol is uppercased', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [{ rows: [tokenRow({})], hitPageCap: false }],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events[0]?.primary.tokenIdentity.symbol).toBe('USDC');
    expect(events[0]?.primary.tokenIdentity.providerMetadata).toEqual({
      etherscan: { chainId: 1, contractAddress: '0xcontract' },
    });
  });

  test('token decimals applied per row (6 for USDC)', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [{ rows: [tokenRow({ value: '1234567' })], hitPageCap: false }],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events[0]?.primary.quantity).toBe('1.234567');
  });

  test('externalId combines tx hash and contract address (handles multi-token txs)', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xAA', contractAddress: '0xC1' }),
            tokenRow({ hash: '0xAA', contractAddress: '0xC2' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual(['0xAA-0xC1', '0xAA-0xC2']);
  });

  test('outflow token tx → negative quantity', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [tokenRow({ from: WALLET, to: '0xother' })],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events[0]?.primary.quantity).toBe('-1');
    expect(events[0]?.kind).toBe('transfer_out');
  });
});

describe('BaseEvmProvider — pagination', () => {
  test('single sub-cap page → exactly one fetch per stream', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [{ rows: [nativeRow({})], hitPageCap: false }],
      token: [{ rows: [tokenRow({})], hitPageCap: false }],
    });
    await provider.runFetchTransactions(ctx('ethereum'));
    expect(provider.nativeCalls).toHaveLength(1);
    expect(provider.tokenCalls).toHaveLength(1);
    expect(provider.nativeCalls[0]).toEqual({ start: 0, end: 1_000_000 });
  });

  test('full page → next call starts at lastBlock+1', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        {
          rows: [nativeRow({ blockNumber: '500' })],
          hitPageCap: true,
        },
        {
          rows: [nativeRow({ blockNumber: '700' })],
          hitPageCap: false,
        },
      ],
      token: [],
    });
    await provider.runFetchTransactions(ctx('ethereum'));
    expect(provider.nativeCalls).toEqual([
      { start: 0, end: 1_000_000 },
      { start: 501, end: 1_000_000 },
    ]);
  });

  test('infinite-loop guard: lastBlock <= startBlock breaks the loop', async () => {
    // Page 2 starts at block 501 but its last row is also at block 100
    // (provider's API returned a corrupted ordering). The base must not
    // loop forever; it logs and returns what it has.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        { rows: [nativeRow({ blockNumber: '500' })], hitPageCap: true },
        { rows: [nativeRow({ blockNumber: '100' })], hitPageCap: true }, // not advancing
      ],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(provider.nativeCalls.length).toBeLessThanOrEqual(3);
    // Two events ingested (one per page) before the loop bailed.
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  test('empty page (no rows) terminates pagination cleanly', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [{ rows: [], hitPageCap: false }],
      token: [{ rows: [], hitPageCap: false }],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(0);
    expect(provider.nativeCalls).toHaveLength(1);
    expect(provider.tokenCalls).toHaveLength(1);
  });
});

/**
 * A truncated walk says so (SC-395).
 *
 * The did-not-advance bail-out returned the rows it had and nothing else,
 * so a wallet whose stream stopped halfway was indistinguishable from one
 * walked to the chain head — and `TransactionRouter` wrote
 * `has_complete_tx_history = true` over it. This file's own header used to
 * claim the gate existed; it did not.
 */
describe('BaseEvmProvider — a truncated walk retracts the completeness claim', () => {
  test('the did-not-advance bail-out retracts, naming the stream', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        { rows: [nativeRow({ blockNumber: '500' })], hitPageCap: true },
        { rows: [nativeRow({ blockNumber: '100' })], hitPageCap: true }, // not advancing
      ],
      token: [],
    });
    const c = recordingCtx('ethereum');

    await provider.runFetchTransactions(c);

    expect(c.retractions).toHaveLength(1);
    expect(c.retractions[0]).toContain('native');
  });

  /**
   * And it names the key that sentence is translated under (SC-434).
   *
   * Every param is an identifier or a number — the provider key, the API's own
   * stream names, the chain id — which is what makes this sentence keyable at
   * all. `PageCapWatch` produces the same kind of warning and is still a plain
   * string precisely because its list carries English noun phrases.
   */
  test('the retraction carries the key and the params the reader interpolates', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        { rows: [nativeRow({ blockNumber: '500' })], hitPageCap: true },
        { rows: [nativeRow({ blockNumber: '100' })], hitPageCap: true },
      ],
      token: [],
    });
    const c = recordingCtx('ethereum');

    await provider.runFetchTransactions(c);

    expect(c.notices[0]?.key).toBe('v3.jobs.notices.walletPaginationStopped');
    expect(c.notices[0]?.params).toEqual({
      provider: 'test-evm',
      streams: 'native',
      chainId: 1,
    });
    // The English is still there, and is what an older build renders.
    expect(c.notices[0]?.text).toContain('pagination stopped early on native');
  });

  // The negative control. Every other test in this file walks to a tail, so
  // a retraction that fired unconditionally would still leave them green —
  // it would only show up as every EVM wallet in production losing its
  // coverage claim.
  test('a walk that reaches every tail retracts nothing', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        { rows: [nativeRow({ blockNumber: '500' })], hitPageCap: true },
        { rows: [nativeRow({ blockNumber: '900' })], hitPageCap: false },
      ],
      token: [{ rows: [tokenRow({})], hitPageCap: false }],
    });
    const c = recordingCtx('ethereum');

    await provider.runFetchTransactions(c);

    expect(c.retractions).toEqual([]);
  });

  test('a stream that truncates outside the since window still retracts', async () => {
    // The rows the bail-out lost may be older than the window the caller
    // asked about — but what was retracted is a fact about the WALK, and a
    // `since` that happens to exclude them does not make the wallet whole.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        { rows: [nativeRow({ blockNumber: '500' })], hitPageCap: true },
        { rows: [nativeRow({ blockNumber: '100' })], hitPageCap: true },
      ],
      token: [],
    });
    const c = { ...recordingCtx('ethereum'), since: new Date('2030-01-01T00:00:00Z') };

    const events = await provider.runFetchTransactions(c);

    expect(events).toHaveLength(0);
    expect(c.retractions).toHaveLength(1);
  });

  test('a truncated walk against a context with no sink does not throw', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        { rows: [nativeRow({ blockNumber: '500' })], hitPageCap: true },
        { rows: [nativeRow({ blockNumber: '100' })], hitPageCap: true },
      ],
      token: [],
    });

    const events = await provider.runFetchTransactions(ctx('ethereum'));

    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});

describe('BaseEvmProvider — since/until filtering', () => {
  test('events outside the since/until window are filtered out (in-memory)', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        {
          rows: [
            nativeRow({ hash: '0xa', timeStamp: '1700000000', blockNumber: '90' }),
            nativeRow({ hash: '0xb', timeStamp: '1710000000', blockNumber: '110' }),
            nativeRow({ hash: '0xc', timeStamp: '1720000000', blockNumber: '120' }),
          ],
          hitPageCap: false,
        },
      ],
      token: [],
    });
    const c: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    } = {
      ...ctx('ethereum'),
      since: new Date(1705000000 * 1000),
      until: new Date(1715000000 * 1000),
    };
    const events = await provider.runFetchTransactions(c);
    expect(events.map((e) => e.externalId)).toEqual(['0xb']);
  });
});

describe('BaseEvmProvider — swap detection (SC-332)', () => {
  // A DEX swap is one transaction with two legs: value leaves the wallet and a
  // different token arrives back at it in the SAME hash. Both legs are already
  // fetched — the outgoing one from `txlist`, the returning one from `tokentx`
  // — and the pair is what the ingester used to throw away.
  function swapFixtures() {
    return {
      native: [
        {
          rows: [nativeRow({ hash: '0xswap', from: WALLET, to: '0xrouter' })],
          hitPageCap: false,
        },
      ],
      token: [
        {
          rows: [
            tokenRow({
              hash: '0xswap',
              from: '0xrouter',
              to: WALLET,
              value: '2000000000', // 2000 USDC at 6 decimals
            }),
          ],
          hitPageCap: false,
        },
      ],
    };
  }

  test('an outflow and a different token returning in the same tx become linked swap legs', async () => {
    const provider = new TestEvmProvider([ETHEREUM], swapFixtures());
    const events = await provider.runFetchTransactions(ctx('ethereum'));

    const out = events.find((e) => e.primary.quantity.startsWith('-'));
    const inn = events.find((e) => !e.primary.quantity.startsWith('-'));
    expect(out?.kind).toBe('swap_out');
    expect(inn?.kind).toBe('swap_in');
    expect(out?.swapGroupKey).toBe('1:0xswap');
    expect(inn?.swapGroupKey).toBe('1:0xswap');
  });

  test('each swap leg carries the other as its counter, opposite-signed', async () => {
    const provider = new TestEvmProvider([ETHEREUM], swapFixtures());
    const events = await provider.runFetchTransactions(ctx('ethereum'));

    const out = events.find((e) => e.kind === 'swap_out');
    const inn = events.find((e) => e.kind === 'swap_in');
    expect(out?.counter?.quantity).toBe('2000');
    expect(out?.counter?.tokenIdentity.symbol).toBe('USDC');
    expect(inn?.counter?.quantity).toBe('-1');
    expect(inn?.counter?.tokenIdentity.symbol).toBe('ETH');
  });

  test('the pair supplies an exact execution price, so neither leg needs a price source', async () => {
    const provider = new TestEvmProvider([ETHEREUM], swapFixtures());
    const events = await provider.runFetchTransactions(ctx('ethereum'));

    const out = events.find((e) => e.kind === 'swap_out');
    const inn = events.find((e) => e.kind === 'swap_in');
    // 2000 USDC for 1 ETH, and its reciprocal on the other leg.
    expect(out?.priceNative?.value).toBe('2000');
    expect(out?.priceNative?.quoteIdentity.symbol).toBe('USDC');
    expect(inn?.priceNative?.value).toBe('0.0005');
    expect(inn?.priceNative?.quoteIdentity.symbol).toBe('ETH');
  });

  test('a bridge is left alone — its other leg is on another chain, not in this receipt', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        {
          rows: [nativeRow({ hash: '0xbridge', from: WALLET, to: '0xspokepool' })],
          hitPageCap: false,
        },
      ],
      token: [],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('transfer_out');
    expect(events[0]?.swapGroupKey).toBeUndefined();
  });

  test('the same token leaving and returning in one tx is not a swap', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xself', from: WALLET, to: '0xself-custody' }),
            tokenRow({ hash: '0xself', from: '0xself-custody', to: WALLET }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.kind)).toEqual(['transfer_out', 'transfer_in']);
    expect(events.every((e) => e.swapGroupKey === undefined)).toBe(true);
  });

  test('a tx with two outflows and one inflow is too ambiguous to call a swap', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        {
          rows: [nativeRow({ hash: '0xmulti', from: WALLET, to: '0xrouter' })],
          hitPageCap: false,
        },
      ],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xmulti', from: WALLET, to: '0xfee', contractAddress: '0xfeetok' }),
            tokenRow({ hash: '0xmulti', from: '0xrouter', to: WALLET }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.every((e) => e.swapGroupKey === undefined)).toBe(true);
    expect(events.every((e) => e.kind === 'transfer_in' || e.kind === 'transfer_out')).toBe(true);
  });

  test('the group key carries the chain, so two chains cannot share one swap', async () => {
    const provider = new TestEvmProvider([ETHEREUM, POLYGON], swapFixtures());
    const events = await provider.runFetchTransactions(ctx('polygon'));
    expect(events.find((e) => e.kind === 'swap_out')?.swapGroupKey).toBe('137:0xswap');
  });
});

describe('BaseEvmProvider — internal transactions (SC-337)', () => {
  test('an internal transfer to the wallet becomes a transfer_in', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [],
      internal: [{ rows: [internalRow({})], hitPageCap: false }],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('transfer_in');
    expect(events[0]?.primary.quantity).toBe('1');
    expect(events[0]?.primary.tokenIdentity.symbol).toBe('ETH');
  });

  test('an internal row keeps its own externalId, so it cannot shadow the parent tx', async () => {
    // `txlistinternal` reports the PARENT transaction's hash, which is also
    // the native leg's `externalId`. A wallet that sends value and gets some
    // of it back inside the same call therefore has two native legs on one
    // hash, and `(holding_id, source, external_id)` would collapse them to
    // one row — losing whichever the upsert saw first.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        {
          rows: [nativeRow({ hash: '0xrefund', from: WALLET, to: '0xrouter' })],
          hitPageCap: false,
        },
      ],
      token: [],
      internal: [
        {
          rows: [internalRow({ hash: '0xrefund', value: '10000000000000000', traceId: '0_1' })],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId).sort()).toEqual(['0xrefund', '0xrefund-internal-0_1']);
  });

  test('two internal transfers in one tx get distinct externalIds from their trace ids', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [],
      internal: [
        {
          rows: [
            internalRow({ hash: '0xsplit', traceId: '0' }),
            internalRow({ hash: '0xsplit', traceId: '1_0' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(new Set(events.map((e) => e.externalId)).size).toBe(2);
  });

  test('a failed internal call moved no value and is skipped', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [],
      internal: [{ rows: [internalRow({ isError: '1' })], hitPageCap: false }],
    });
    expect(await provider.runFetchTransactions(ctx('ethereum'))).toHaveLength(0);
  });

  test('a zero-value internal call is skipped', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [],
      internal: [{ rows: [internalRow({ value: '0' })], hitPageCap: false }],
    });
    expect(await provider.runFetchTransactions(ctx('ethereum'))).toHaveLength(0);
  });

  test('internal pagination narrows by block like the other two streams', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [],
      internal: [
        { rows: [internalRow({ blockNumber: '500', hash: '0xa' })], hitPageCap: true },
        { rows: [internalRow({ blockNumber: '900', hash: '0xb' })], hitPageCap: false },
      ],
    });
    await provider.runFetchTransactions(ctx('ethereum'));
    expect(provider.internalCalls).toEqual([
      { start: 0, end: 1_000_000 },
      { start: 501, end: 1_000_000 },
    ]);
  });

  test('a token→native swap links, because the returning ETH is an internal transfer', async () => {
    // The reason this stream exists. `txlist` never carries the ETH leg of a
    // token→ETH swap — the wallet did not receive ETH from an address, a
    // contract sent it mid-call — so before this the outflow was a lone,
    // unanswerable `transfer_out`.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [tokenRow({ hash: '0xsell', from: WALLET, to: '0xrouter', value: '2000000000' })],
          hitPageCap: false,
        },
      ],
      internal: [{ rows: [internalRow({ hash: '0xsell', from: '0xrouter' })], hitPageCap: false }],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    const out = events.find((e) => e.kind === 'swap_out');
    const inn = events.find((e) => e.kind === 'swap_in');
    expect(out?.primary.tokenIdentity.symbol).toBe('USDC');
    expect(inn?.primary.tokenIdentity.symbol).toBe('ETH');
    expect(out?.swapGroupKey).toBe('1:0xsell');
    expect(inn?.swapGroupKey).toBe('1:0xsell');
    expect(out?.priceNative?.value).toBe('0.0005');
    expect(inn?.priceNative?.value).toBe('2000');
  });

  test('a router refunding unspent ETH still leaves one swap, not three loose rows', async () => {
    // Uniswap's UniversalRouter returns the unspent remainder of an exact-out
    // ETH swap. That refund is a third leg on the same hash, and the strict
    // two-leg test would decline the whole group — so a swap that linked
    // before this stream existed would stop linking once it did. The legs are
    // netted per token first: two native legs that net to one outflow are one
    // outflow.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        { rows: [nativeRow({ hash: '0xexec', from: WALLET, to: '0xrouter' })], hitPageCap: false },
      ],
      token: [
        {
          rows: [tokenRow({ hash: '0xexec', from: '0xrouter', to: WALLET, value: '2000000000' })],
          hitPageCap: false,
        },
      ],
      internal: [
        {
          rows: [internalRow({ hash: '0xexec', value: '10000000000000000', traceId: '0_1' })],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.filter((e) => e.kind === 'swap_out')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'swap_in')).toHaveLength(1);
    // The refund is a real arrival and stays its own row — unlinked, because
    // it is not what was exchanged.
    const refund = events.find((e) => e.externalId === '0xexec-internal-0_1');
    expect(refund?.kind).toBe('transfer_in');
    expect(refund?.swapGroupKey).toBeUndefined();
  });

  test('a bridge arrival paying out native asset is a transfer_in, never a swap', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [],
      internal: [
        { rows: [internalRow({ hash: '0xfill', from: '0xspokepool' })], hitPageCap: false },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('transfer_in');
    expect(events[0]?.swapGroupKey).toBeUndefined();
  });

  test('two internal arrivals and no outflow move one token, so nothing is a swap', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [],
      internal: [
        {
          rows: [
            internalRow({ hash: '0xclaim', traceId: '0' }),
            internalRow({ hash: '0xclaim', traceId: '1' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.every((e) => e.kind === 'transfer_in')).toBe(true);
    expect(events.every((e) => e.swapGroupKey === undefined)).toBe(true);
  });

  test('an internal refund that exactly cancels the outflow moves nothing and is not a swap', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [
        { rows: [nativeRow({ hash: '0xnoop', from: WALLET, to: '0xrouter' })], hitPageCap: false },
      ],
      token: [
        {
          rows: [tokenRow({ hash: '0xnoop', from: '0xrouter', to: WALLET, value: '2000000000' })],
          hitPageCap: false,
        },
      ],
      internal: [{ rows: [internalRow({ hash: '0xnoop', traceId: '0_1' })], hitPageCap: false }],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.every((e) => e.swapGroupKey === undefined)).toBe(true);
  });
});

describe('BaseEvmProvider — repeated token legs in one transaction (SC-341)', () => {
  test('two legs of the same token in one tx get distinct externalIds', async () => {
    // Before SC-341 both legs keyed on `<hash>-<contract>`, so
    // `bulkUpsert`'s dedupe map — last occurrence wins — handed Postgres
    // one row and the earlier leg was never written. Measured on
    // production: a dozen or so legs across as many transactions, no warning,
    // and the import still reported `hasCompleteTxHistory: true`.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xswap', contractAddress: '0xweth', from: '0xpool', to: WALLET }),
            tokenRow({ hash: '0xswap', contractAddress: '0xweth', from: WALLET, to: '0xfee' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.externalId)).size).toBe(2);
  });

  test('the LAST leg keeps the bare `<hash>-<contract>` key, so no stored row changes identity', async () => {
    // This is the whole reason there is no migration. Every etherscan token
    // row in the ledger was written by the last-wins dedupe, so each one
    // already describes the LAST leg of its `(hash, contract)` group —
    // verified against `eth_getTransactionReceipt` for every production
    // collision site, all of them. Numbering the earlier legs and leaving the
    // last one bare therefore makes the fix pure INSERT: no `external_id`
    // is rewritten, and no `transfer_review` answer moves to a leg it was
    // not given about.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xswap', contractAddress: '0xweth', from: '0xpool', to: WALLET }),
            tokenRow({ hash: '0xswap', contractAddress: '0xweth', from: WALLET, to: '0xfee' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual(['0xswap-0xweth-0', '0xswap-0xweth']);
    expect(events[1]?.primary.quantity).toBe('-1');
  });

  test('three legs number the first two and leave the last bare', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xthree', contractAddress: '0xc', value: '1000000' }),
            tokenRow({ hash: '0xthree', contractAddress: '0xc', value: '2000000' }),
            tokenRow({ hash: '0xthree', contractAddress: '0xc', value: '3000000' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual([
      '0xthree-0xc-0',
      '0xthree-0xc-1',
      '0xthree-0xc',
    ]);
    expect(events.map((e) => e.primary.quantity)).toEqual(['1', '2', '3']);
  });

  test('a lone leg is untouched — the overwhelming majority of rows keep the key they have', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [{ rows: [tokenRow({ hash: '0xsolo', contractAddress: '0xc' })], hitPageCap: false }],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual(['0xsolo-0xc']);
  });

  test('legs are numbered per contract, not per transaction', async () => {
    // Two tokens moving once each in one tx never collided and must not
    // start being numbered — that would rewrite keys the ledger already has.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xmulti', contractAddress: '0xc1' }),
            tokenRow({ hash: '0xmulti', contractAddress: '0xc2' }),
            tokenRow({ hash: '0xmulti', contractAddress: '0xc1', value: '5000000' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual([
      '0xmulti-0xc1-0',
      '0xmulti-0xc2',
      '0xmulti-0xc1',
    ]);
  });

  test('numbering is per transaction, so the same token in two txs stays bare in both', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xa', contractAddress: '0xc' }),
            tokenRow({ hash: '0xb', contractAddress: '0xc' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual(['0xa-0xc', '0xb-0xc']);
  });

  test('a group split across two pages is still numbered as one group', async () => {
    // Pagination narrows by block and a block is never split mid-way, so a
    // transaction cannot straddle two pages today. Asserted anyway because
    // the numbering must be a property of the whole stream, not of a page.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [tokenRow({ blockNumber: '500', hash: '0xspan', contractAddress: '0xc' })],
          hitPageCap: true,
        },
        {
          rows: [
            tokenRow({
              blockNumber: '900',
              hash: '0xspan',
              contractAddress: '0xc',
              value: '7000000',
            }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual(['0xspan-0xc-0', '0xspan-0xc']);
  });

  test('a zero-value spam leg does not displace the real one', async () => {
    // Address poisoning emits a real `Transfer` of 0 on a real contract, and
    // SC-348 drops it — but the leg it shares a transaction with is a real
    // 161.382085 USDC movement and has to survive intact.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xpoison', contractAddress: '0xusdc', value: '161382085' }),
            tokenRow({ hash: '0xpoison', contractAddress: '0xusdc', value: '0' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(1);
    expect(events[0]?.primary.quantity).toBe('161.382085');
  });
});

describe('BaseEvmProvider — a zero-value token transfer is not a transfer (SC-348)', () => {
  test('a zero-value token leg is dropped', async () => {
    // A hundred or so rows on production are this: a `Transfer` log of 0 on the REAL
    // USDC/USDT contract, `from` spoofed to the victim's own address so the
    // lookalike beside it gets copied out of their history later. The name
    // and symbol are genuinely USDC's, so no name-based filter can see it —
    // the shape can: nothing moved.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [tokenRow({ hash: '0xspam', contractAddress: '0xusdc', value: '0' })],
          hitPageCap: false,
        },
      ],
    });
    expect(await provider.runFetchTransactions(ctx('ethereum'))).toEqual([]);
  });

  test('a transaction whose every token leg is zero contributes nothing', async () => {
    // Nearly every affected production group is shaped like this.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xspam', contractAddress: '0xusdc', value: '0' }),
            tokenRow({ hash: '0xspam', contractAddress: '0xusdc', value: '0' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    expect(await provider.runFetchTransactions(ctx('ethereum'))).toEqual([]);
  });

  test('a dropped LAST leg leaves the earlier one numbered, not promoted to the bare key', async () => {
    // THE INVARIANT THIS FILTER RESTS ON. Leg numbering is derived from the
    // upstream stream and not from what we keep, so removing a leg can never
    // renumber a surviving one. Were the bare `<hash>-<contract>` key to slide
    // onto a different leg, a stored row's `external_id` would silently start
    // describing another movement — and `transfer_review` answers travel with
    // `external_id` (SC-341 measured 159.75 USDC of realized PnL moved by
    // exactly that mistake).
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xmix', contractAddress: '0xc', value: '5000000' }),
            tokenRow({ hash: '0xmix', contractAddress: '0xc', value: '0' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual(['0xmix-0xc-0']);
  });

  test('a dropped FIRST leg leaves the last one bare, exactly as it is stored today', async () => {
    // The one mixed group on production (USDT, tx 0x6aa91c58…) is this shape.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0x6aa91c', contractAddress: '0xusdt', value: '0' }),
            tokenRow({ hash: '0x6aa91c', contractAddress: '0xusdt', value: '5000000' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events.map((e) => e.externalId)).toEqual(['0x6aa91c-0xusdt']);
  });

  test('a zero leg cannot make a swap out of a transaction that moved one token', async () => {
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [],
      token: [
        {
          rows: [
            tokenRow({ hash: '0xsw', contractAddress: '0xa', value: '5000000', to: '0xother' }),
            tokenRow({ hash: '0xsw', contractAddress: '0xb', value: '0' }),
          ],
          hitPageCap: false,
        },
      ],
    });
    const events = await provider.runFetchTransactions(ctx('ethereum'));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('transfer_out');
    expect(events[0]?.swapGroupKey).toBeUndefined();
  });

  test('the filter is the one the native and internal streams already apply', async () => {
    // `normalizeNativeTx` and `normalizeInternalTx` have always returned null
    // on a zero value. The token stream was the outlier, not the policy.
    const provider = new TestEvmProvider([ETHEREUM], {
      native: [{ rows: [nativeRow({ value: '0' })], hitPageCap: false }],
      token: [{ rows: [tokenRow({ value: '0' })], hitPageCap: false }],
      internal: [{ rows: [internalRow({ value: '0' })], hitPageCap: false }],
    });
    expect(await provider.runFetchTransactions(ctx('ethereum'))).toEqual([]);
  });
});
