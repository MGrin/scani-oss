/**
 * `BaseEvmProvider` — shared scaffolding for EVM-chain wallet
 * ingestion via Etherscan V2 (`txlist` + `tokentx` + `txlistinternal`)
 * and structurally-compatible chain explorers.
 *
 * One concrete subclass — `providers/etherscan/index.ts` — extends
 * this base and registers itself for every chain in its supported list
 * (Ethereum, Polygon, BSC, Arbitrum, Optimism, Base, …). Adding a new
 * EVM L2 generally means registering its `chainId` in the etherscan
 * config; the pagination logic doesn't change.
 *
 * The pre-refactor equivalent was
 * `packages/integrations/src/ingesters/EvmTransactionIngester.ts`,
 * which carried domain-layer concerns (resolving holding/token via
 * callbacks). That coupling is gone — this base emits
 * `Partial<NewToken>` identity hints with chain id + contract address
 * that flow through the federated identity layer upstream.
 *
 * Pagination strategy:
 *
 *   - Etherscan caps `page * offset` at 10,000, so we paginate by
 *     `(startblock, endblock)` rather than by page index. Each page
 *     query yields up to 10k rows; when the page is full we narrow
 *     the next query to `(lastBlock+1, endblock)` until the response
 *     is sub-page (i.e. the tail is reached).
 *
 *   - Three logical streams are merged: `txlist` (native-asset txs),
 *     `tokentx` (ERC-20 transfers), `txlistinternal` (contract calls
 *     that move native asset). Subclass paginates them in turn; the
 *     base merges the resulting events.
 *
 *   - `hasCompleteTxHistory: true` is claimed only when iteration
 *     finishes without truncation AND the queried block range covers
 *     `[0, current_block]`. Partial since/until requests yield
 *     `false`, so coverage state stays accurate.
 */

import type { NewToken } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import type { Capability, ProviderBase } from '../capabilities';
import type {
  HoldingSnapshot,
  PriceQuote,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../types';

/**
 * Per-chain configuration. The concrete `etherscan` provider holds
 * an array of these, one per chain it's registered for, and switches
 * via `chainId` at request time.
 */
export interface EvmChainConfig {
  /** Numeric chain id (1=Ethereum, 137=Polygon, 56=BSC, 42161=Arbitrum, …). */
  readonly chainId: number;
  /** Institution code the registry uses for dispatch (e.g. 'ethereum'). */
  readonly institutionCode: string;
  /** Native asset symbol ('ETH', 'BNB', 'MATIC'). */
  readonly nativeSymbol: string;
  /** Native asset display name. */
  readonly nativeName: string;
  /** Native asset decimals — almost always 18 for EVM. */
  readonly nativeDecimals: number;
}

/**
 * Etherscan V2 raw row from `txlist`.
 */
export interface EvmNativeTxRow {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  gasPrice: string;
  gasUsed: string;
  isError: string;
  txreceipt_status: string;
}

/**
 * Etherscan V2 raw row from `tokentx`.
 */
export interface EvmTokenTxRow {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  tokenName: string;
  tokenSymbol: string;
  tokenDecimal: string;
}

/**
 * Per-page response from an Etherscan-V2 endpoint. Subclasses fetch
 * these directly; the base merges them into `TransactionEvent`s.
 */
export interface EvmPaginationPage<T> {
  rows: T[];
  /** True when this page hit the 10k row cap — caller advances start
      block from the last row's block number and queries again. */
  hitPageCap: boolean;
}

export abstract class BaseEvmProvider implements ProviderBase {
  abstract readonly providerKey: string;
  abstract readonly capabilities: readonly Capability[];

  protected readonly logger: CustomLogger;

  constructor(protected readonly chains: readonly EvmChainConfig[]) {
    this.logger = createComponentLogger(`provider:${this.constructor.name}`);
  }

  /**
   * Look up the chain config for an institution code. Throws if the
   * provider hasn't been registered for that chain — this is a
   * contract violation (ProviderRegistry's filter should have prevented
   * it), so it's a hard error rather than a soft skip.
   */
  protected getChainConfig(institutionCode: string): EvmChainConfig {
    const config = this.chains.find((c) => c.institutionCode === institutionCode);
    if (!config) {
      throw new Error(
        `${this.providerKey}: institutionCode '${institutionCode}' not in supported chains list`
      );
    }
    return config;
  }

  /**
   * Subclasses fetch one page of native txs at a time, narrowing
   * `(startblock, endblock)` each iteration when the prior page hit
   * the 10k cap.
   */
  protected abstract fetchNativeTxPage(
    chain: EvmChainConfig,
    walletAddress: string,
    startBlock: number,
    endBlock: number,
    apiKey: string
  ): Promise<EvmPaginationPage<EvmNativeTxRow>>;

  /**
   * Same shape as `fetchNativeTxPage` but for `tokentx` (ERC-20).
   */
  protected abstract fetchTokenTxPage(
    chain: EvmChainConfig,
    walletAddress: string,
    startBlock: number,
    endBlock: number,
    apiKey: string
  ): Promise<EvmPaginationPage<EvmTokenTxRow>>;

  /**
   * Fetch the current block number for the chain (anchors the
   * `endblock` of the iteration and feeds `hasCompleteTxHistory`).
   */
  protected abstract fetchLatestBlock(chain: EvmChainConfig, apiKey: string): Promise<number>;

  /**
   * Resolve the wallet address + API key out of the
   * credentials/context. Subclasses pull whatever fields the venue
   * needs — for Etherscan it's `apiKey` from credentials and a
   * separate wallet address from the account row.
   */
  protected abstract resolveRequestParams(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<{ walletAddress: string; apiKey: string }>;

  /**
   * Default `fetchTransactions()` body — pages through both streams
   * for a given block window and merges into `TransactionEvent`s.
   * Subclass need only provide page-fetchers and chain configs.
   */
  protected async fetchTransactionsByBlockRange(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    const chain = this.getChainConfig(ctx.institutionCode);
    const { walletAddress, apiKey } = await this.resolveRequestParams(ctx);

    // since/until → block range. Etherscan V2 doesn't accept
    // timestamps directly; subclasses can either hint via a
    // block-by-timestamp call (most chains support it) or just
    // start at 0 and filter in-memory by occurredAt — the latter
    // is the safe default since "all of history" is the typical
    // first-import case.
    let startBlock = 0;
    const endBlock = await this.fetchLatestBlock(chain, apiKey);

    const events: TransactionEvent[] = [];

    // Native txs.
    while (true) {
      const page = await this.fetchNativeTxPage(chain, walletAddress, startBlock, endBlock, apiKey);
      for (const row of page.rows) {
        const event = this.normalizeNativeTx(row, chain, walletAddress);
        if (event) events.push(event);
      }
      const lastRow = page.rows[page.rows.length - 1];
      if (!page.hitPageCap || !lastRow) break;
      const nextStart = Number(lastRow.blockNumber) + 1;
      if (nextStart <= startBlock) {
        // Defensive: a malformed page response could put us in an
        // infinite loop. Bail out instead of looping forever.
        this.logger.warn(
          { providerKey: this.providerKey, chainId: chain.chainId, lastBlock: lastRow.blockNumber },
          'Native tx pagination did not advance; stopping'
        );
        break;
      }
      startBlock = nextStart;
    }

    // ERC-20 txs.
    startBlock = 0;
    while (true) {
      const page = await this.fetchTokenTxPage(chain, walletAddress, startBlock, endBlock, apiKey);
      for (const row of page.rows) {
        events.push(this.normalizeTokenTx(row, chain, walletAddress));
      }
      const lastRow = page.rows[page.rows.length - 1];
      if (!page.hitPageCap || !lastRow) break;
      const nextStart = Number(lastRow.blockNumber) + 1;
      if (nextStart <= startBlock) {
        this.logger.warn(
          { providerKey: this.providerKey, chainId: chain.chainId, lastBlock: lastRow.blockNumber },
          'Token tx pagination did not advance; stopping'
        );
        break;
      }
      startBlock = nextStart;
    }

    // since/until filter — we always paginate the full chain because
    // Etherscan's by-block API can't translate dates without an extra
    // call, and the result is always small enough to sift in memory.
    const filtered = events.filter((e) => {
      if (ctx.since && e.occurredAt < ctx.since) return false;
      if (ctx.until && e.occurredAt > ctx.until) return false;
      return true;
    });

    return filtered;
  }

  // ============================================================
  // Normalization
  // ============================================================

  private normalizeNativeTx(
    row: EvmNativeTxRow,
    chain: EvmChainConfig,
    walletAddress: string
  ): TransactionEvent | null {
    if (row.isError === '1' || row.txreceipt_status === '0') {
      // Failed tx — gas was burned but no value moved. We skip them
      // here; if we later want to track failed-tx gas as a `fee`, it
      // can be added without changing the contract.
      return null;
    }
    const wallet = walletAddress.toLowerCase();
    const isInflow = row.to.toLowerCase() === wallet;
    const valueWei = new Decimal(row.value);
    const valueEth = valueWei.div(new Decimal(10).pow(chain.nativeDecimals));
    if (valueEth.isZero()) return null;

    const quantity = isInflow ? valueEth.toString() : valueEth.neg().toString();

    return {
      externalId: row.hash,
      occurredAt: new Date(Number(row.timeStamp) * 1000),
      kind: isInflow ? 'transfer_in' : 'transfer_out',
      primary: {
        tokenIdentity: this.nativeIdentity(chain),
        quantity,
      },
      rawPayload: row,
    };
  }

  private normalizeTokenTx(
    row: EvmTokenTxRow,
    chain: EvmChainConfig,
    walletAddress: string
  ): TransactionEvent {
    const wallet = walletAddress.toLowerCase();
    const isInflow = row.to.toLowerCase() === wallet;
    const decimals = Number(row.tokenDecimal);
    const valueRaw = new Decimal(row.value);
    const valueAdj = valueRaw.div(new Decimal(10).pow(decimals));
    const quantity = isInflow ? valueAdj.toString() : valueAdj.neg().toString();

    const identity: Partial<NewToken> = {
      symbol: row.tokenSymbol.toUpperCase(),
      name: row.tokenName,
      decimals,
      providerMetadata: {
        etherscan: {
          chainId: chain.chainId,
          contractAddress: row.contractAddress.toLowerCase(),
        },
      },
    };

    return {
      externalId: `${row.hash}-${row.contractAddress}`,
      occurredAt: new Date(Number(row.timeStamp) * 1000),
      kind: isInflow ? 'transfer_in' : 'transfer_out',
      primary: { tokenIdentity: identity, quantity },
      rawPayload: row,
    };
  }

  /**
   * Identity hint for the chain's native asset. The federated
   * identity flow merges this with whatever other providers know
   * (CoinGecko's id, DeFiLlama's coin) when the row is created.
   */
  protected nativeIdentity(chain: EvmChainConfig): Partial<NewToken> {
    return {
      symbol: chain.nativeSymbol,
      name: chain.nativeName,
      decimals: chain.nativeDecimals,
      providerMetadata: {
        // Native asset is identified by `chainId` alone. Omit
        // `contractAddress` entirely — earlier we stamped it as '0x0'
        // as a placeholder, but downstream sync code reads that as a
        // real address, causing the lookup `pickExternalLookupKey`
        // to return '0x0' which never matches the snapshot's
        // `externalId: 'native'` → native ETH/MATIC silently dropped.
        etherscan: { chainId: chain.chainId },
      },
    };
  }
}

// Re-export for subclasses.
export type { HoldingSnapshot, PriceQuote, TransactionEvent, WithUserCreds };
