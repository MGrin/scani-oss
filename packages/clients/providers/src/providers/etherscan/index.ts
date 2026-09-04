/**
 * `EtherscanProvider` — multi-chain EVM provider using Etherscan V2's
 * unified API endpoint (`https://api.etherscan.io/v2/api?chainid=...`).
 *
 * One provider instance is registered per chain (Ethereum, BSC,
 * Polygon, Arbitrum, Optimism, Base, …) so the registry's
 * institution-code filter dispatches each balance/tx request to the
 * right config. The HTTP client + rate limiter are shared across all
 * chains since Etherscan V2's per-key rate limit is global, not per-chain.
 *
 * Capabilities (per chain):
 *  - `current-balances`: native via `module=account&action=balance`,
 *    ERC-20s discovered via the most recent `tokentx` page then
 *    fetched per-token via `module=account&action=tokenbalance`. Spam
 *    tokens filtered before they reach the federated identity flow.
 *  - `transactions`: extends `BaseEvmProvider` for the `(startblock,
 *    endblock)` pagination of `txlist` + `tokentx` + `txlistinternal`.
 *    Also answers `fetchExitedPositions` — the positions a wallet TRADED and
 *    no longer holds, which the balance path cannot see at all (SC-398).
 *  - `address-validator`: 0x-prefixed 40-hex.
 *
 * Pre-refactor sources:
 *  - `packages/integrations/src/blockchain-services/evm-chain-service.ts`
 *  - `packages/integrations/src/ingesters/EvmTransactionIngester.ts`
 */

import type { NewToken, TokenMetadata } from '@scani/db/schema';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { createOutflowLimiter, withRetry } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import {
  BaseEvmProvider,
  type EvmChainConfig,
  type EvmInternalTxRow,
  type EvmNativeTxRow,
  type EvmPaginationPage,
  type EvmTokenTxRow,
} from '../../core/base/base-evm-provider';
import { isTradedPosition } from '../../core/base/evm-traded-tokens';
import type { ProviderFactory } from '../../core/boot';
import type {
  AddressValidatorProvider,
  BalanceProvider,
  Capability,
  TransactionsProvider,
} from '../../core/capabilities';
import type {
  ExitedPosition,
  HoldingSnapshot,
  PositionProbe,
  ProviderContext,
  TransactionEvent,
  TransactionFetchContext,
  WithUserCreds,
} from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';
import { ETHERSCAN_CHAINS, findChainConfig } from './chains';
import { resolveEnsName } from './ens';
import { isLikelySpamToken } from './spam-filter';

const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T;
}

/**
 * Raw `tokentx` row used both for ERC-20 discovery on the balances
 * path and for transaction-history normalization on the EVM base.
 * Same shape as `EvmTokenTxRow` — re-used here so the discovery code
 * doesn't need a parallel type.
 */
type TokenTxResultRow = EvmTokenTxRow;

/**
 * Structural EVM address check. Pure and offline; the chain-stub
 * provider reuses it so a stubbed boot answers address shape exactly
 * as the live one does.
 */
export function isEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export class EtherscanProvider
  extends BaseEvmProvider
  implements BalanceProvider, TransactionsProvider, AddressValidatorProvider
{
  readonly providerKey = 'etherscan';
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'address-validator',
  ];

  constructor(
    chains: readonly EvmChainConfig[],
    private readonly limiter: OutflowRateLimiter,
    private readonly defaultApiKey: string | undefined
  ) {
    super(chains);
  }

  // ============================================================
  // Address + dispatch
  // ============================================================

  isValidAddress(address: string, _institutionCode?: string): boolean {
    return isEvmAddress(address);
  }

  canFetchBalances(institutionCode: string): boolean {
    return findChainConfig(institutionCode) !== null;
  }

  canFetchTransactions(institutionCode: string): boolean {
    return findChainConfig(institutionCode) !== null;
  }

  canValidate(institutionCode: string): boolean {
    return findChainConfig(institutionCode) !== null;
  }

  /**
   * Activity probe — Etherscan's `txlist` endpoint with `offset=1`
   * returns at most one transaction. Status `'1'` means at least one
   * tx exists for this address on the requested chain. We deliberately
   * skip `txlistinternal` and `tokentx` here because the goal is just
   * "does this address appear at all on this chain?" — a single normal
   * tx is sufficient.
   */
  async hasActivity(
    address: string,
    institutionCode: string,
    _ctx: ProviderContext
  ): Promise<boolean> {
    if (!this.isValidAddress(address)) return false;
    const chain = findChainConfig(institutionCode);
    if (!chain) return false;
    const apiKey = this.defaultApiKey ?? '';
    const params = new URLSearchParams({
      chainid: String(chain.chainId),
      module: 'account',
      action: 'txlist',
      address,
      startblock: '0',
      endblock: '99999999',
      page: '1',
      offset: '1',
      sort: 'desc',
    });
    if (apiKey) params.set('apikey', apiKey);
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(`${ETHERSCAN_V2_URL}?${params.toString()}`)
    );
    if (!response.ok) {
      throw new Error(`etherscan: HTTP ${response.status} for chain ${chain.chainId}`);
    }
    const data = (await response.json()) as EtherscanResponse<unknown[]>;
    // Etherscan answers an empty history with `status: '0'` and an empty
    // `result` array, and an error — rate limit, bad key — with `status:
    // '0'` and a `result` STRING carrying the reason. The array is what
    // separates "we asked and there is nothing" from "we could not ask".
    if (!Array.isArray(data.result)) {
      throw new Error(`etherscan: ${data.message ?? 'request failed'} (${String(data.result)})`);
    }
    return data.result.length > 0;
  }

  /**
   * ENS reverse resolution — Ethereum mainnet only. Returns null on
   * non-mainnet institution codes, malformed addresses, or RPC
   * failures. Never throws so the caller can fall back gracefully.
   */
  async resolveAddressName(name: string, _ctx: ProviderContext): Promise<string | null> {
    return resolveEnsName(name);
  }

  // ============================================================
  // BalanceProvider
  // ============================================================

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const chain = this.getChainConfig(ctx.institutionCode);
    const { walletAddress, apiKey } = await this.resolveRequestParams(ctx);
    if (!this.isValidAddress(walletAddress)) return [];

    const [native, erc20] = await Promise.all([
      this.fetchNativeBalance(chain, walletAddress, apiKey),
      this.fetchErc20Balances(chain, walletAddress, apiKey),
    ]);

    const out: HoldingSnapshot[] = [];
    if (native && new Decimal(native.balance).gt(0)) out.push(native);
    for (const t of erc20) {
      if (new Decimal(t.balance).gt(0)) out.push(t);
    }
    return out;
  }

  /**
   * One `tokenbalance` (or `balance`, for the native asset) per key the caller
   * names — the direct question `fetchBalances` cannot ask (SC-852).
   *
   * `fetchTokenBalanceRaw` already separates the three answers and this method
   * exists to stop them being flattened again:
   *
   *   `null`      -> `unreadable`. Retries are exhausted or the endpoint did
   *                  not answer with a balance. It says NOTHING about what the
   *                  wallet holds, and reporting it as `exited` would anchor a
   *                  holding at zero on a number nobody read.
   *   zero        -> `exited`. Measured, and the claim a caller may act on.
   *   anything    -> `held`. The asset is there and discovery missed it —
   *                  the 10k-page blind spot `staleStrategy: 'preserve'`
   *                  exists for, and not an exit.
   *
   * The scale is deliberately not applied. Zero is zero at every decimal
   * count, `held` needs no magnitude to be true, and the caller already has
   * the token's own `decimals` — reading a scale out of the discovery page
   * would mean fetching the page this method exists to avoid.
   *
   * An invalid address answers `unreadable` for everything rather than `[]`:
   * an empty list reads as "nothing to say about these", which is the same
   * silence a working probe over an empty input produces.
   */
  async probePositions(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string },
    externalIds: readonly string[]
  ): Promise<PositionProbe[]> {
    if (externalIds.length === 0) return [];
    const chain = this.getChainConfig(ctx.institutionCode);
    const { walletAddress, apiKey } = await this.resolveRequestParams(ctx);
    const unreadable = externalIds.map(
      (externalId): PositionProbe => ({ externalId, state: 'unreadable' })
    );
    if (!this.isValidAddress(walletAddress)) return unreadable;

    return Promise.all(
      externalIds.map(async (externalId): Promise<PositionProbe> => {
        const raw =
          externalId === 'native'
            ? await this.fetchNativeBalanceRaw(chain, walletAddress, apiKey)
            : await this.fetchTokenBalanceRaw(chain, externalId, walletAddress, apiKey);
        if (!raw) return { externalId, state: 'unreadable' };
        return { externalId, state: raw.isZero() ? 'exited' : 'held' };
      })
    );
  }

  // ============================================================
  // TransactionsProvider — delegates to BaseEvmProvider
  // ============================================================

  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    return this.fetchTransactionsByBlockRange(ctx);
  }

  /**
   * Positions this wallet TRADED and no longer holds (SC-398).
   *
   * Three questions, answered in the order that makes the last one cheap:
   *
   *  1. **What moved?** `tokentx` for the ERC-20 legs and `txlist` for the
   *     native ones, walked to the tail through the same `paginateStream` the
   *     transaction import uses — not the single 10k page
   *     `fetchErc20Balances` discovers with, because a position closed long
   *     enough ago to fall off that page is precisely this ticket's subject.
   *  2. **Did the account holder authorise it?** `txlist.from` is the EOA that
   *     signed, so `signedHashes` is a fact about authorisation rather than a
   *     guess about intent. An address-poisoning contract emits a `Transfer`
   *     out of the victim's own address in a transaction the ATTACKER signed,
   *     so it cannot appear in that set however it names itself. This is the
   *     gate that keeps the 330 unsigned arrivals out — see
   *     `evm-traded-tokens.ts` for the measurement and why no name filter can
   *     do this job.
   *  3. **Is it really gone?** One `tokenbalance` call per surviving
   *     candidate. This is the expensive step and it runs last, on the ~4% of
   *     tokens that clear the signature gate.
   *
   * STEP 3 IS NOT OPTIONAL AND IT IS NOT THE CALLER'S TO SKIP. The caller
   * anchors a holding at zero on this answer, and `holdings.balance` is an
   * anchor rather than a sum — a wrong zero is a wrong number on a screen and
   * a wrong reconstructed history behind it. Inferring "gone" from absence
   * from `fetchBalances` would be wrong twice over: that call reads ONE
   * `tokentx` page and drops anything `isLikelySpamToken` matches, so its
   * population is a subset of this one and the difference is not all exits.
   *
   * The name filter is applied here too, for the same reason: a token this
   * method admits and `fetchBalances` filters out would be offered at zero
   * while the wallet still held some. Agreeing with it is what keeps the two
   * lists comparable. A traded token wearing a spam name is therefore still
   * dropped, exactly as it is today — the frontend's own `spamSignal` flags
   * what does get through, visibly, which is the right place for a heuristic.
   *
   * A failure here THROWS. Falling back to an empty list would be
   * indistinguishable from a wallet that never traded anything, which is the
   * silent omission the ticket is about; the caller reports it and says the
   * review is partial.
   */
  async fetchExitedPositions(ctx: TransactionFetchContext): Promise<ExitedPosition[]> {
    const chain = this.getChainConfig(ctx.institutionCode);
    const { walletAddress, apiKey } = await this.resolveRequestParams(ctx);
    if (!this.isValidAddress(walletAddress)) return [];
    const wallet = walletAddress.toLowerCase();
    const endBlock = await this.fetchLatestBlock(chain, apiKey);

    const nativeRows: EvmNativeTxRow[] = [];
    const truncated: string[] = [];
    if (
      await this.paginateStream(
        'native',
        chain,
        (start) => this.fetchNativeTxPage(chain, walletAddress, start, endBlock, apiKey),
        (row) => {
          nativeRows.push(row);
        }
      )
    ) {
      truncated.push('txlist');
    }

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
      truncated.push('tokentx');
    }

    if (truncated.length > 0) {
      // Not `retractHistoryClaim`: that moves `has_complete_tx_history`, which
      // is a claim about the LEDGER, and nothing has been written here. This
      // walk being short means the offer list is short, and the person picking
      // from it is who needs to know (SC-428's voice, on the review side).
      const streams = truncated.join(', ');
      ctx.noteWarning?.({
        key: 'v3.jobs.notices.reviewPaginationStopped',
        // `txlist` / `tokentx` are Etherscan's own action names, so they are
        // the same token in every language (SC-434).
        params: { streams, chainId: chain.chainId },
        text: `etherscan: pagination stopped early on ${streams} for chain ${chain.chainId} — positions closed before that point are not offered`,
      });
    }

    // A FAILED transaction still carries the signature; it just moved nothing.
    // `normalizeNativeTx` drops those because there is no leg to record, and
    // that is right there and wrong here: what is being asked is who
    // authorised the transaction, not what it transferred.
    const signedHashes = new Set<string>();
    for (const row of nativeRows) {
      if (row.from?.toLowerCase() === wallet) signedHashes.add(row.hash);
    }
    // "The wallet gave up value of ANY asset in this transaction", which is
    // what separates a purchase from a claim. Both streams contribute; see
    // `classifyDrop` for why the token stream's contribution is not itself a
    // signature (SC-764).
    const paidHashes = new Set<string>();
    for (const row of nativeRows) {
      if (row.from?.toLowerCase() === wallet && new Decimal(row.value || '0').gt(0)) {
        paidHashes.add(row.hash);
      }
    }
    const nativeMovements: { inflowHashes: string[]; outflowHashes: string[] } = {
      inflowHashes: [],
      outflowHashes: [],
    };
    for (const row of nativeRows) {
      if (new Decimal(row.value || '0').isZero()) continue;
      if (row.to?.toLowerCase() === wallet) nativeMovements.inflowHashes.push(row.hash);
      if (row.from?.toLowerCase() === wallet) nativeMovements.outflowHashes.push(row.hash);
    }

    interface Candidate {
      contract: string;
      info: { name: string; symbol: string; decimals: number };
      inflowHashes: string[];
      outflowHashes: string[];
    }
    const byContract = new Map<string, Candidate>();
    for (const row of tokenRows) {
      // A zero-value `Transfer` is not a transfer (SC-348) — the same filter
      // `normalizeTokenTx` applies, so the movements this rule sees are the
      // movements the ledger would have recorded.
      if (new Decimal(row.value || '0').isZero()) continue;
      const contract = row.contractAddress.toLowerCase();
      if (!contract) continue;
      let candidate = byContract.get(contract);
      if (!candidate) {
        candidate = {
          contract,
          info: {
            name: row.tokenName,
            symbol: row.tokenSymbol,
            decimals: Number.parseInt(row.tokenDecimal, 10),
          },
          inflowHashes: [],
          outflowHashes: [],
        };
        byContract.set(contract, candidate);
      }
      if (row.to.toLowerCase() === wallet) candidate.inflowHashes.push(row.hash);
      if (row.from.toLowerCase() === wallet) {
        candidate.outflowHashes.push(row.hash);
        if (new Decimal(row.value).gt(0)) paidHashes.add(row.hash);
      }
    }

    const traded: Array<{ externalId: string; identity: Partial<NewToken>; decimals: number }> = [];
    for (const candidate of byContract.values()) {
      if (isLikelySpamToken(candidate.info)) continue;
      if (
        !isTradedPosition({
          inflowHashes: candidate.inflowHashes,
          outflowHashes: candidate.outflowHashes,
          signedHashes,
          paidHashes,
        })
      ) {
        continue;
      }
      traded.push({
        externalId: candidate.contract,
        decimals: candidate.info.decimals,
        identity: {
          symbol: candidate.info.symbol.toUpperCase(),
          name: candidate.info.name,
          decimals: candidate.info.decimals,
          providerMetadata: {
            etherscan: { chainId: Number(chain.chainId), contractAddress: candidate.contract },
          } satisfies TokenMetadata,
        },
      });
    }

    const exited: ExitedPosition[] = [];

    // The native asset gets the same treatment and for the same reason: a
    // wallet that spent all of its ETH has no native snapshot either, so its
    // native legs are dropped exactly as an exited ERC-20's are.
    if (
      isTradedPosition({
        inflowHashes: nativeMovements.inflowHashes,
        outflowHashes: nativeMovements.outflowHashes,
        signedHashes,
        paidHashes,
      })
    ) {
      const nativeBalance = await this.fetchNativeBalanceRaw(chain, walletAddress, apiKey);
      if (nativeBalance?.isZero()) {
        exited.push({ externalId: 'native', tokenIdentity: this.nativeIdentity(chain) });
      }
    }

    for (const token of traded) {
      const raw = await this.fetchTokenBalanceRaw(chain, token.externalId, walletAddress, apiKey);
      // `null` is "could not read", not "zero". Offering a position as closed
      // on a balance nobody read is the wrong number this method exists to
      // avoid, so an unreadable balance drops the candidate.
      if (raw?.isZero()) {
        exited.push({ externalId: token.externalId, tokenIdentity: token.identity });
      }
    }

    return exited;
  }

  // ============================================================
  // BaseEvmProvider implementation
  // ============================================================

  protected async resolveRequestParams(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<{ walletAddress: string; apiKey: string }> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const walletAddress =
      (creds.walletAddress as string | undefined) ?? (creds.address as string | undefined) ?? '';
    // EVM wallet integrations don't require a per-user Etherscan key —
    // we fall back to the platform-credentialed default when the user
    // hasn't supplied their own.
    const apiKey = (creds.etherscanApiKey as string | undefined) ?? this.defaultApiKey ?? '';
    return { walletAddress, apiKey };
  }

  protected async fetchNativeTxPage(
    chain: EvmChainConfig,
    walletAddress: string,
    startBlock: number,
    endBlock: number,
    apiKey: string
  ): Promise<EvmPaginationPage<EvmNativeTxRow>> {
    const url = this.buildUrl(chain.chainId, {
      module: 'account',
      action: 'txlist',
      address: walletAddress,
      startblock: String(startBlock),
      endblock: String(endBlock),
      page: '1',
      offset: '10000',
      sort: 'asc',
      apikey: apiKey,
    });
    const data = await this.callJson<EtherscanResponse<EvmNativeTxRow[]>>(url);
    if (!data || data.status !== '1') {
      return { rows: [], hitPageCap: false };
    }
    const rows = data.result ?? [];
    return { rows, hitPageCap: rows.length >= 10000 };
  }

  protected async fetchTokenTxPage(
    chain: EvmChainConfig,
    walletAddress: string,
    startBlock: number,
    endBlock: number,
    apiKey: string
  ): Promise<EvmPaginationPage<EvmTokenTxRow>> {
    const url = this.buildUrl(chain.chainId, {
      module: 'account',
      action: 'tokentx',
      address: walletAddress,
      startblock: String(startBlock),
      endblock: String(endBlock),
      page: '1',
      offset: '10000',
      sort: 'asc',
      apikey: apiKey,
    });
    const data = await this.callJson<EtherscanResponse<EvmTokenTxRow[]>>(url);
    if (!data || data.status !== '1') {
      return { rows: [], hitPageCap: false };
    }
    const rows = data.result ?? [];
    return { rows, hitPageCap: rows.length >= 10000 };
  }

  protected async fetchInternalTxPage(
    chain: EvmChainConfig,
    walletAddress: string,
    startBlock: number,
    endBlock: number,
    apiKey: string
  ): Promise<EvmPaginationPage<EvmInternalTxRow>> {
    const url = this.buildUrl(chain.chainId, {
      module: 'account',
      action: 'txlistinternal',
      address: walletAddress,
      startblock: String(startBlock),
      endblock: String(endBlock),
      page: '1',
      offset: '10000',
      sort: 'asc',
      apikey: apiKey,
    });
    const data = await this.callJson<EtherscanResponse<EvmInternalTxRow[]>>(url);
    if (!data || data.status !== '1') {
      return { rows: [], hitPageCap: false };
    }
    const rows = data.result ?? [];
    return { rows, hitPageCap: rows.length >= 10000 };
  }

  protected async fetchLatestBlock(chain: EvmChainConfig, apiKey: string): Promise<number> {
    // proxy.eth_blockNumber returns a hex string
    const url = this.buildUrl(chain.chainId, {
      module: 'proxy',
      action: 'eth_blockNumber',
      apikey: apiKey,
    });
    const data = await this.callJson<{ jsonrpc: string; id: number; result: string }>(url);
    if (!data?.result) return 0;
    return Number.parseInt(data.result, 16);
  }

  // ============================================================
  // Internals — balances
  // ============================================================

  /**
   * The native balance in wei, or `null` when it could not be read.
   *
   * Split out of `fetchNativeBalance` because `fetchExitedPositions` needs the
   * THIRD state that method collapses: it returns `null` for "zero" and for
   * "the call failed" alike, which is the right shape for a balance snapshot
   * — neither produces one — and the wrong shape for a caller about to assert
   * that a position is closed (SC-398).
   */
  private async fetchNativeBalanceRaw(
    chain: EvmChainConfig,
    address: string,
    apiKey: string
  ): Promise<Decimal | null> {
    const url = this.buildUrl(chain.chainId, {
      module: 'account',
      action: 'balance',
      address,
      tag: 'latest',
      apikey: apiKey,
    });
    const data = await this.callJson<EtherscanResponse<string>>(url);
    if (!data || data.status !== '1') return null;
    return new Decimal(data.result);
  }

  /**
   * One ERC-20 balance in its smallest unit, or `null` when it could not be
   * read. Same three-state reason as `fetchNativeBalanceRaw`.
   */
  private async fetchTokenBalanceRaw(
    chain: EvmChainConfig,
    contract: string,
    address: string,
    apiKey: string
  ): Promise<Decimal | null> {
    const url = this.buildUrl(chain.chainId, {
      module: 'account',
      action: 'tokenbalance',
      contractaddress: contract,
      address,
      tag: 'latest',
      apikey: apiKey,
    });
    let data: EtherscanResponse<string> | null;
    try {
      data = await withRetry(() => this.callJson<EtherscanResponse<string>>(url), {
        attempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 4000,
      });
    } catch {
      return null;
    }
    if (!data || data.status !== '1') return null;
    return new Decimal(data.result);
  }

  private async fetchNativeBalance(
    chain: EvmChainConfig,
    address: string,
    apiKey: string
  ): Promise<HoldingSnapshot | null> {
    const wei = await this.fetchNativeBalanceRaw(chain, address, apiKey);
    if (!wei) return null;
    const balance = wei.div(new Decimal(10).pow(chain.nativeDecimals));
    if (balance.isZero()) return null;
    return {
      externalId: 'native',
      tokenIdentity: this.nativeIdentity(chain),
      balance: balance.toString(),
      capturedAt: new Date(),
    };
  }

  private async fetchErc20Balances(
    chain: EvmChainConfig,
    address: string,
    apiKey: string
  ): Promise<HoldingSnapshot[]> {
    // Discovery: pull the most recent page of tokentx and dedup
    // contracts. Etherscan caps at 10,000 rows; descending sort puts
    // the freshest activity first. Retry transient rate-limit /
    // upstream-error responses so a single 429 doesn't blank the
    // whole discovery (which then makes every ERC-20 silently absent
    // from the snapshots).
    const discoverUrl = this.buildUrl(chain.chainId, {
      module: 'account',
      action: 'tokentx',
      address,
      page: '1',
      offset: '10000',
      sort: 'desc',
      apikey: apiKey,
    });
    const discoverData = await withRetry(
      () => this.callJson<EtherscanResponse<TokenTxResultRow[]>>(discoverUrl),
      { attempts: 3, baseDelayMs: 500, maxDelayMs: 4000 }
    );
    if (!discoverData || discoverData.status !== '1') return [];

    const uniqueTokens = new Map<string, { name: string; symbol: string; decimals: number }>();
    for (const tx of discoverData.result ?? []) {
      const contract = tx.contractAddress.toLowerCase();
      if (uniqueTokens.has(contract)) continue;
      const info = {
        name: tx.tokenName,
        symbol: tx.tokenSymbol,
        decimals: Number.parseInt(tx.tokenDecimal, 10),
      };
      if (isLikelySpamToken(info)) continue;
      uniqueTokens.set(contract, info);
    }

    // Per-token current balance. Etherscan's tokenbalance is one call
    // per (contract, address). Each call is wrapped in `withRetry` so
    // a transient `Max calls per sec rate limit reached` (HTTP 200
    // body, not a 429) bounces back instead of silently null'ing the
    // snapshot — which used to drop the legitimate USDC for users
    // with many ERC-20s in their tokentx history.
    const tasks = [...uniqueTokens.entries()].map(async ([contract, info]) => {
      // `null` covers both "unreachable even after retries" and "the endpoint
      // answered but not with a balance". Either way there is no snapshot to
      // make: the user's other holdings still resolve, and the next refresh /
      // cron re-checks this one.
      const raw = await this.fetchTokenBalanceRaw(chain, contract, address, apiKey);
      if (!raw || raw.isZero()) return null;
      const balance = raw.div(new Decimal(10).pow(info.decimals));
      const tokenIdentity: Partial<NewToken> = {
        symbol: info.symbol.toUpperCase(),
        name: info.name,
        decimals: info.decimals,
        providerMetadata: {
          etherscan: { chainId: Number(chain.chainId), contractAddress: contract },
        } satisfies TokenMetadata,
      };
      const snapshot: HoldingSnapshot = {
        externalId: contract,
        tokenIdentity,
        balance: balance.toString(),
        capturedAt: new Date(),
      };
      return snapshot;
    });
    const results = await Promise.all(tasks);
    return results.filter((r): r is HoldingSnapshot => r !== null);
  }

  // ============================================================
  // HTTP plumbing
  // ============================================================

  private buildUrl(chainId: number, params: Record<string, string>): string {
    const search = new URLSearchParams({ chainid: String(chainId), ...params });
    return `${ETHERSCAN_V2_URL}?${search.toString()}`;
  }

  private async callJson<T>(url: string): Promise<T | null> {
    const response = await this.limiter.execute(async () => fetchWithTimeout(url));
    if (!response.ok) {
      // Map 429 and 5xx HTTP-level failures to a thrown error so
      // upstream callers wrapped in `withRetry` can recover. Other
      // non-2xx responses still resolve to null (the legacy contract).
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`Etherscan HTTP ${response.status} (rate limit / upstream error)`);
      }
      return null;
    }
    const parsed = (await response.json()) as
      | T
      | { status?: string; message?: string; result?: unknown };
    // Etherscan v2 returns HTTP 200 with `{status:"0", message:"NOTOK",
    // result:"Max calls per sec rate limit reached"}` when the rate
    // limit is breached. The previous shape `Promise<T | null>` lost
    // that distinction — every "NOTOK" looked indistinguishable from a
    // legitimate empty result. The discovery + balance loops then
    // silently dropped the contract; a wallet with 100+ ERC-20s would
    // get the legitimate USDC dropped because the rate limiter and
    // Etherscan disagreed about what's allowed.
    //
    // Now: if the response is a rate-limit / NOTOK shape, throw so the
    // `withRetry` wrappers retry with backoff. Other status='0' shapes
    // (e.g. "No transactions found") continue to flow through untouched
    // — the caller already handles status checks downstream.
    if (
      parsed &&
      typeof parsed === 'object' &&
      'message' in parsed &&
      typeof parsed.message === 'string' &&
      parsed.message === 'NOTOK'
    ) {
      const result = (parsed as { result?: unknown }).result;
      const text = typeof result === 'string' ? result : '';
      if (
        /rate limit|max calls per sec|too many|invalid api key|missing\/invalid api key/i.test(text)
      ) {
        throw new Error(`Etherscan rate limit / auth: ${text}`);
      }
    }
    return parsed as T;
  }
}

export const etherscanFactory: ProviderFactory = async (deps) => {
  // Etherscan V2 free tier: 5 calls/sec across all chains globally.
  const limiter = createOutflowLimiter({
    maxRequests: 5,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'etherscan',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'etherscan',
    limiter,
    registeredFrom: 'providers/etherscan',
    description: 'Etherscan V2: 5 req / 1s',
  });
  // No warn lived here before SC-536: an unkeyed Etherscan simply omits
  // the `apikey` param and calls go out unauthenticated, so an operator
  // reading every log line still could not learn this had happened.
  deps.reportCredentialStatus({
    provider: 'etherscan',
    envVar: 'ETHERSCAN_API_KEY',
    keyed: Boolean(deps.env.ETHERSCAN_API_KEY),
    degradedBehaviour: 'calls go out unauthenticated, sharing the anonymous free-tier budget',
  });
  return new EtherscanProvider(ETHERSCAN_CHAINS, registered, deps.env.ETHERSCAN_API_KEY);
};

export { ETHERSCAN_CHAINS, findChainConfig } from './chains';
export { isLikelySpamToken } from './spam-filter';
