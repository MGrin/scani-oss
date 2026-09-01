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
 *     `tokentx` (ERC-20 transfers) and `txlistinternal` (native asset
 *     moved by a contract mid-call). Subclass paginates them in turn;
 *     the base merges the resulting events.
 *
 *     The third one was claimed by this comment and fetched by nothing
 *     for as long as the provider existed (SC-337). Native asset
 *     ARRIVING from a contract does not appear in `txlist` — the
 *     wallet was not the recipient of a transaction, a contract sent
 *     it during one — and is not an ERC-20, so it was invisible: the
 *     ETH leg of a token→ETH swap, a bridge payout, a withdrawal from
 *     a staking contract, a router's refund. That bounded what
 *     `linkSwapLegs` below could see, since a swap whose return leg is
 *     native had no return leg as far as this provider was concerned.
 *
 *     An internal row reports its PARENT transaction's hash, so its
 *     `externalId` carries the trace id too — otherwise it collides
 *     with the native leg of the same transaction on
 *     `(holding_id, source, external_id)` and one of the two is lost.
 *
 *   - Every stream is walked from block 0 to the chain head, so the
 *     claim `TransactionRouter` makes about a `since`-less run is one
 *     this provider can normally support. The exception is
 *     `paginateStream`'s did-not-advance bail-out: it stops mid-stream
 *     on a malformed page rather than looping forever, and until SC-395
 *     it stopped SILENTLY — the events already collected were returned
 *     as if the walk had finished, and the coverage row claimed a whole
 *     wallet over a truncated one. It now retracts through
 *     `ctx.retractHistoryClaim`.
 *
 *     This comment used to assert the gate as if it existed. It did
 *     not: no `hasCompleteTxHistory` was computed anywhere in this file,
 *     and 39 of production's 45 complete-coverage rows are `etherscan`
 *     ones written with no truncation check behind them.
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
  TransactionFetchContext,
  WithUserCreds,
} from '../types';
import { inferCounterSign } from '../utils/enforce-tx-sign';

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
 * Etherscan V2 raw row from `txlistinternal`.
 *
 * `hash` is the PARENT transaction's, not this trace's — several internal
 * transfers can share one. `traceId` is what tells them apart. There is no
 * `functionName`/`methodId` and no `txreceipt_status`: a failed internal call
 * reports `isError: '1'` and moved nothing.
 */
export interface EvmInternalTxRow {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  type: string;
  traceId?: string;
  isError: string;
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

/**
 * One normalized event plus the two facts swap detection needs and a
 * `TransactionEvent` deliberately does not carry: which transaction it came
 * from, and which asset it moved. `externalId` encodes both for token legs
 * (`<hash>-<contract>`, sometimes with a leg number after it) and neither
 * unambiguously for native ones, and re-deriving them by string-splitting an
 * id other code owns is how a parser ends up load-bearing.
 */
interface EvmLeg {
  event: TransactionEvent;
  hash: string;
  /** Contract address, or the sentinel for the chain's native asset. */
  tokenKey: string;
}

/** No ERC-20 contract can collide with this — addresses are 40 hex chars. */
const NATIVE_TOKEN_KEY = 'native';

/**
 * The `externalId` a token leg gets when its transaction moves that token
 * exactly once, which is true of 522 of the 535 `(hash, contract, holding)`
 * sites on production — the other 13 are SC-341. Built from
 * `contractAddress` verbatim rather than lowercased because it is the key
 * rows already in the ledger were written under.
 */
function tokenLegGroupKey(row: EvmTokenTxRow): string {
  return `${row.hash}-${row.contractAddress}`;
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
   * Same shape again but for `txlistinternal` — native asset moved by a
   * contract during a call, which neither of the other two streams reports.
   */
  protected abstract fetchInternalTxPage(
    chain: EvmChainConfig,
    walletAddress: string,
    startBlock: number,
    endBlock: number,
    apiKey: string
  ): Promise<EvmPaginationPage<EvmInternalTxRow>>;

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
    ctx: TransactionFetchContext
  ): Promise<TransactionEvent[]> {
    const chain = this.getChainConfig(ctx.institutionCode);
    const { walletAddress, apiKey } = await this.resolveRequestParams(ctx);

    // since/until → block range. Etherscan V2 doesn't accept
    // timestamps directly; subclasses can either hint via a
    // block-by-timestamp call (most chains support it) or just
    // start at 0 and filter in-memory by occurredAt — the latter
    // is the safe default since "all of history" is the typical
    // first-import case.
    const endBlock = await this.fetchLatestBlock(chain, apiKey);

    const legs: EvmLeg[] = [];
    // Only consulted when a row arrives without a `traceId`. Ordinal WITHIN a
    // hash rather than within the run, because it lands in an `externalId`
    // that has to mean the same thing on the next import.
    const internalOrdinals = new Map<string, number>();

    // One entry per stream that stopped before its tail. Named rather than
    // counted: "token" and "internal" fail for different reasons and the
    // warning is the only place a reader learns which.
    const truncatedStreams: string[] = [];

    if (
      await this.paginateStream(
        'native',
        chain,
        (start) => this.fetchNativeTxPage(chain, walletAddress, start, endBlock, apiKey),
        (row) => {
          const leg = this.normalizeNativeTx(row, chain, walletAddress);
          if (leg) legs.push(leg);
        }
      )
    ) {
      truncatedStreams.push('native');
    }

    // Buffered rather than normalized in place because a token leg's
    // `externalId` depends on how many OTHER legs of the same token the same
    // transaction carries, which is only known once the stream ends.
    const tokenRows: EvmTokenTxRow[] = [];
    if (
      await this.paginateStream(
        'token',
        chain,
        (start) => this.fetchTokenTxPage(chain, walletAddress, start, endBlock, apiKey),
        (row) => {
          tokenRows.push(row);
        }
      )
    ) {
      truncatedStreams.push('token');
    }
    const legCounts = new Map<string, number>();
    for (const row of tokenRows) {
      const key = tokenLegGroupKey(row);
      legCounts.set(key, (legCounts.get(key) ?? 0) + 1);
    }
    const legIndices = new Map<string, number>();
    for (const row of tokenRows) {
      const key = tokenLegGroupKey(row);
      const legIndex = legIndices.get(key) ?? 0;
      legIndices.set(key, legIndex + 1);
      const leg = this.normalizeTokenTx(
        row,
        chain,
        walletAddress,
        legIndex,
        legCounts.get(key) ?? 1
      );
      if (leg) legs.push(leg);
    }

    if (
      await this.paginateStream(
        'internal',
        chain,
        (start) => this.fetchInternalTxPage(chain, walletAddress, start, endBlock, apiKey),
        (row) => {
          const ordinal = internalOrdinals.get(row.hash) ?? 0;
          internalOrdinals.set(row.hash, ordinal + 1);
          const leg = this.normalizeInternalTx(row, chain, walletAddress, ordinal);
          if (leg) legs.push(leg);
        }
      )
    ) {
      truncatedStreams.push('internal');
    }

    // Before the window filter and before swap linking, because what was
    // retracted is a fact about the WALK: a `since` that happens to exclude
    // every truncated row does not make the wallet's history whole.
    if (truncatedStreams.length > 0) {
      ctx.retractHistoryClaim?.(
        `${this.providerKey}: pagination stopped early on ${truncatedStreams.join(', ')} for chain ${chain.chainId} — this wallet's history is missing whatever came after`
      );
    }

    // since/until filter — we always paginate the full chain because
    // Etherscan's by-block API can't translate dates without an extra
    // call, and the result is always small enough to sift in memory.
    const filtered = legs.filter((l) => {
      if (ctx.since && l.event.occurredAt < ctx.since) return false;
      if (ctx.until && l.event.occurredAt > ctx.until) return false;
      return true;
    });

    // After the window filter, not before, so a swap group can never span
    // the edge of the window it was classified in. Both legs of a swap
    // share a timestamp, so in practice the filter keeps or drops the
    // pair together — this only fixes where the invariant is stated.
    this.linkSwapLegs(filtered, chain);

    return filtered.map((l) => l.event);
  }

  /**
   * Walk one stream from block 0 to `endBlock`, narrowing the window each
   * time a page comes back full. Shared by all three streams so the
   * did-not-advance guard cannot be present in two of them and missing from
   * the third.
   *
   * Returns whether the walk stopped SHORT of the tail.
   */
  protected async paginateStream<T extends { blockNumber: string }>(
    streamLabel: string,
    chain: EvmChainConfig,
    fetchPage: (startBlock: number) => Promise<EvmPaginationPage<T>>,
    onRow: (row: T) => void
  ): Promise<boolean> {
    let startBlock = 0;
    while (true) {
      const page = await fetchPage(startBlock);
      for (const row of page.rows) onRow(row);
      const lastRow = page.rows[page.rows.length - 1];
      // A page that did not hit the cap IS the tail; an empty one is a tail
      // too. Either way the stream ended where the chain did.
      if (!page.hitPageCap || !lastRow) return false;
      const nextStart = Number(lastRow.blockNumber) + 1;
      if (nextStart <= startBlock) {
        // Defensive: a malformed page response could put us in an
        // infinite loop. Bail out instead of looping forever — and say so
        // in the return value, because the rows already handed to `onRow`
        // are indistinguishable from a complete walk's (SC-395).
        this.logger.warn(
          {
            providerKey: this.providerKey,
            chainId: chain.chainId,
            stream: streamLabel,
            lastBlock: lastRow.blockNumber,
          },
          'Pagination did not advance; stopping'
        );
        return true;
      }
      startBlock = nextStart;
    }
  }

  /**
   * Recognise a swap from the legs we already fetched (SC-332).
   *
   * A DEX swap moves value out of the wallet and returns a DIFFERENT token
   * to it **in the same transaction** — the outgoing leg arrives via
   * `txlist`, the returning one via `tokentx`, and until this existed both
   * were emitted as unrelated transfers. Every EVM swap in production was
   * therefore two loose rows, and the transfer-review queue was asked "did
   * this leave your control?" about half of an exchange.
   *
   * The test is the receipt's own shape, deliberately not a router
   * allowlist or the `functionName` string. Two reasons:
   *
   *  - **A bridge cannot pass it.** A bridge's other leg is on another
   *    chain, so a bridge transaction has no return leg in its own
   *    receipt. That is structural: no allowlist has to be kept current
   *    for `SocketGateway`, Across or Polygon PoS to stay unclassified,
   *    and bridging must not realize a disposal.
   *  - **`functionName` names the swap but cannot price it.**
   *    `CostBasisService.txValueInBase` refuses the held-token fallback
   *    for swap kinds — deliberately, so the BTC leg of a BTC→ETH swap is
   *    not valued at BTC spot — and pops the lots at *zero* realized when
   *    no `priceNative` is present. Marking a lone outflow `swap_out` on
   *    the strength of its method name would quietly convert a correct
   *    market-value disposal into a zero-proceeds one. The other leg is
   *    what carries the price, which is why the pair is required.
   *
   * Exactly two tokens moved, one out and one in. A group of any other shape
   * (a fee leg to a third party, a same-token self-transfer, three tokens) is
   * left exactly as it was: under-claiming here costs a linkage,
   * over-claiming rewrites a disposal.
   *
   * The test is on each token's NET movement across the group, not on the leg
   * count, and `txlistinternal` is why (SC-337). Uniswap's UniversalRouter
   * refunds the unspent remainder of an exact-out ETH swap, which is a second
   * native leg on the same hash — invisible until that stream was fetched,
   * and enough to push a two-leg swap to three and un-link it. Two native
   * legs that net to one outflow are one outflow. The refund itself stays the
   * plain arrival it is; the swap legs are the ones that carry each token's
   * net direction, and their own quantities set the rate, so a row's
   * quantity × price still equals its counter exactly.
   */
  private linkSwapLegs(legs: readonly EvmLeg[], chain: EvmChainConfig): void {
    const byHash = new Map<string, EvmLeg[]>();
    for (const leg of legs) {
      const group = byHash.get(leg.hash);
      if (group) group.push(leg);
      else byHash.set(leg.hash, [leg]);
    }

    for (const [hash, group] of byHash) {
      if (group.length < 2) continue;

      const netByToken = new Map<string, Decimal>();
      for (const leg of group) {
        const running = netByToken.get(leg.tokenKey) ?? new Decimal(0);
        netByToken.set(leg.tokenKey, running.plus(leg.event.primary.quantity));
      }
      const moved = [...netByToken.entries()].filter(([, net]) => !net.isZero());
      if (moved.length !== 2) continue;
      const outToken = moved.find(([, net]) => net.isNegative())?.[0];
      const inToken = moved.find(([, net]) => net.isPositive())?.[0];
      if (!outToken || !inToken) continue;

      const outgoing = this.dominantLeg(group, outToken, true);
      const incoming = this.dominantLeg(group, inToken, false);
      if (!outgoing || !incoming) continue;

      const outAbs = new Decimal(outgoing.event.primary.quantity).abs();
      const inAbs = new Decimal(incoming.event.primary.quantity).abs();
      // A rate needs both sides. Without one there is no price to record,
      // and a swap kind without a price realizes at zero — see above.
      if (outAbs.isZero() || inAbs.isZero()) continue;

      const swapGroupKey = `${chain.chainId}:${hash}`;
      outgoing.event.kind = 'swap_out';
      outgoing.event.swapGroupKey = swapGroupKey;
      outgoing.event.counter = {
        tokenIdentity: incoming.event.primary.tokenIdentity,
        quantity: inferCounterSign(outgoing.event.primary.quantity, inAbs.toString()),
      };
      outgoing.event.priceNative = {
        value: inAbs.div(outAbs).toString(),
        quoteIdentity: incoming.event.primary.tokenIdentity,
      };

      incoming.event.kind = 'swap_in';
      incoming.event.swapGroupKey = swapGroupKey;
      incoming.event.counter = {
        tokenIdentity: outgoing.event.primary.tokenIdentity,
        quantity: inferCounterSign(incoming.event.primary.quantity, outAbs.toString()),
      };
      incoming.event.priceNative = {
        value: outAbs.div(inAbs).toString(),
        quoteIdentity: outgoing.event.primary.tokenIdentity,
      };
    }
  }

  /**
   * The leg that carries a token's net direction across one transaction —
   * the largest movement the right way. Anything else in that token (a
   * refund against an outflow) keeps the kind it was normalized with.
   */
  private dominantLeg(
    group: readonly EvmLeg[],
    tokenKey: string,
    outgoing: boolean
  ): EvmLeg | undefined {
    let best: EvmLeg | undefined;
    let bestAbs = new Decimal(0);
    for (const leg of group) {
      if (leg.tokenKey !== tokenKey) continue;
      const quantity = new Decimal(leg.event.primary.quantity);
      if (outgoing ? !quantity.isNegative() : !quantity.isPositive()) continue;
      const abs = quantity.abs();
      if (abs.gt(bestAbs)) {
        best = leg;
        bestAbs = abs;
      }
    }
    return best;
  }

  // ============================================================
  // Normalization
  // ============================================================

  private normalizeNativeTx(
    row: EvmNativeTxRow,
    chain: EvmChainConfig,
    walletAddress: string
  ): EvmLeg | null {
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
      hash: row.hash,
      tokenKey: NATIVE_TOKEN_KEY,
      event: {
        externalId: row.hash,
        occurredAt: new Date(Number(row.timeStamp) * 1000),
        kind: isInflow ? 'transfer_in' : 'transfer_out',
        primary: {
          tokenIdentity: this.nativeIdentity(chain),
          quantity,
        },
        rawPayload: row,
      },
    };
  }

  /**
   * `txlistinternal` row → native-asset leg.
   *
   * The `externalId` is `<parentHash>-internal-<traceId>` rather than the bare
   * hash the other native leg uses, because the hash belongs to the parent
   * transaction: a wallet that spends ETH and is refunded some of it in the
   * same call has two native legs under one hash, and
   * `(holding_id, source, external_id)` would keep only one of them.
   */
  private normalizeInternalTx(
    row: EvmInternalTxRow,
    chain: EvmChainConfig,
    walletAddress: string,
    ordinal: number
  ): EvmLeg | null {
    if (row.isError === '1') return null;
    const valueWei = new Decimal(row.value);
    const value = valueWei.div(new Decimal(10).pow(chain.nativeDecimals));
    if (value.isZero()) return null;

    const isInflow = row.to.toLowerCase() === walletAddress.toLowerCase();
    const trace = row.traceId ?? String(ordinal);

    return {
      hash: row.hash,
      tokenKey: NATIVE_TOKEN_KEY,
      event: {
        externalId: `${row.hash}-internal-${trace}`,
        occurredAt: new Date(Number(row.timeStamp) * 1000),
        kind: isInflow ? 'transfer_in' : 'transfer_out',
        primary: {
          tokenIdentity: this.nativeIdentity(chain),
          quantity: isInflow ? value.toString() : value.neg().toString(),
        },
        rawPayload: row,
      },
    };
  }

  /**
   * `tokentx` row → ERC-20 leg, or `null` where nothing moved.
   *
   * A ZERO-VALUE `Transfer` IS NOT A TRANSFER, and dropping it here is the
   * only defence that can work against address poisoning (SC-348). The attack
   * emits a `Transfer` log of 0 on the REAL USDC or USDT contract with `from`
   * spoofed to the victim's own address, so their explorer history — and ours
   * — shows an outgoing USDC transfer sitting next to a lookalike address they
   * will later copy. `spam-filter.ts` matches token name and symbol and can
   * NEVER see this: the name and symbol are genuinely USDC's, because the
   * contract genuinely is USDC. The distinguishing property is the shape of
   * the event, not the identity of the token.
   *
   * This is the filter `normalizeNativeTx` and `normalizeInternalTx` have
   * always applied. The token stream was the outlier, not the policy — and a
   * quantity of zero cannot move a balance, cost basis or realized PnL, so
   * nothing downstream loses an input it was using.
   *
   * Measured on production 2026-08-17 by re-reading `tokentx` for every wallet
   * on four chains: a small number of legs carry value 0, all of them on a
   * handful of REAL contracts, and nearly all of those reached the ledger. All
   * but one are poisoning. The
   * one that is not is a user-initiated `unstake(uint256)` whose SOMM payout
   * really was zero — verified against `eth_getTransactionReceipt`, whose
   * `Transfer` log data reads `0x00…00`. It moved nothing either.
   *
   * NUMBERING IS DERIVED FROM THE UPSTREAM STREAM AND NOT FROM WHAT WE KEEP —
   * `legIndex` and `legCount` are counted over every row `tokentx` returned,
   * including the ones this method rejects. That is what makes the filter safe
   * to add after the fact: removing a leg can never renumber a surviving one,
   * so no stored `external_id` moves onto a different movement. It matters
   * because a `transfer_review` answer travels with `external_id`, and SC-341
   * measured real realized PnL that a key change would have silently
   * re-attached.
   *
   * One transaction can move the same token more than once through the same
   * wallet — a pool pays WETH in and a fee goes back out, a router splits a
   * payment across two recipients — and `tokentx` reports each `Transfer`
   * log separately. `<hash>-<contract>` cannot tell them apart, so
   * `bulkUpsert`'s dedupe on `(holding_id, source, external_id)` kept one and
   * dropped the rest silently: a dozen or so legs across as many transactions
   * on production, `warnings` empty and `hasCompleteTxHistory: true` (SC-341).
   *
   * `logIndex` would be the natural discriminator and Etherscan V2's
   * `tokentx` response does not carry one — the 22 fields it returns are
   * stored verbatim in `raw_payload` and none of them is a log index. So the
   * leg's position in the stream is used, exactly as `normalizeInternalTx`
   * does for a trace that arrives without a `traceId`.
   *
   * That borrows the assumption `tokentx` returns a transaction's legs in log
   * order every time, which it does — pagination narrows by block and a block
   * is never split, so the legs of one transaction always arrive together and
   * ascending. It is worth naming because it is the one way this scheme could
   * bite: were two legs of a group ever to swap places between imports, they
   * would swap `external_id`s, and an answer given about one would land on
   * the other.
   *
   * THE LAST LEG KEEPS THE BARE `<hash>-<contract>` KEY, and that asymmetry
   * is load-bearing: it is why this change needs no migration. Every token
   * row already in the ledger was written by a dedupe map whose last
   * occurrence wins, so each one describes the LAST leg of its group —
   * checked against `eth_getTransactionReceipt` for all 13 production
   * collision sites, 13 of 13. Numbering only the earlier legs makes the fix
   * a pure INSERT: no `external_id` is rewritten, no row's content is
   * replaced by a different leg's, and no `transfer_review` answer ends up
   * attached to an event it was not given about. Ten of those 13 rows carry
   * an unattributed `left_control`, and one of them books a 161.38 USDC
   * disposal that a forward-numbered key would have silently moved onto a
   * 1.63 USDC leg.
   */
  private normalizeTokenTx(
    row: EvmTokenTxRow,
    chain: EvmChainConfig,
    walletAddress: string,
    legIndex: number,
    legCount: number
  ): EvmLeg | null {
    const wallet = walletAddress.toLowerCase();
    const isInflow = row.to.toLowerCase() === wallet;
    const decimals = Number(row.tokenDecimal);
    const valueRaw = new Decimal(row.value);
    const valueAdj = valueRaw.div(new Decimal(10).pow(decimals));
    if (valueAdj.isZero()) return null;
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

    const groupKey = tokenLegGroupKey(row);
    return {
      hash: row.hash,
      tokenKey: row.contractAddress.toLowerCase(),
      event: {
        externalId: legIndex === legCount - 1 ? groupKey : `${groupKey}-${legIndex}`,
        occurredAt: new Date(Number(row.timeStamp) * 1000),
        kind: isInflow ? 'transfer_in' : 'transfer_out',
        primary: { tokenIdentity: identity, quantity },
        rawPayload: row,
      },
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
