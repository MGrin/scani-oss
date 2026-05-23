import { describe, expect, test } from 'bun:test';
import {
  BaseEvmProvider,
  type EvmChainConfig,
  type EvmNativeTxRow,
  type EvmPaginationPage,
  type EvmTokenTxRow,
} from '../../../src/core/base/base-evm-provider';
import type { Capability } from '../../../src/core/capabilities';
import { createMockSelfCredContext } from '../../../src/core/testing';
import type { ProviderContext, TransactionEvent, WithUserCreds } from '../../../src/core/types';

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
  latestBlock?: number;
  walletAddress?: string;
  apiKey?: string;
}

class TestEvmProvider extends BaseEvmProvider {
  readonly providerKey = 'test-evm';
  readonly capabilities: readonly Capability[] = ['transactions'];

  nativeCalls: Array<{ start: number; end: number }> = [];
  tokenCalls: Array<{ start: number; end: number }> = [];

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
  async runFetchTransactions(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<TransactionEvent[]> {
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
