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
 *    endblock)` pagination of `txlist` + `tokentx`.
 *  - `address-validator`: 0x-prefixed 40-hex.
 *
 * Pre-refactor sources:
 *  - `packages/integrations/src/blockchain-services/evm-chain-service.ts`
 *  - `packages/integrations/src/ingesters/EvmTransactionIngester.ts`
 */

import type { NewToken, TokenMetadata } from '@scani/db/schema';
import type { OutflowRateLimiter } from '@scani/rate-limiter';
import { createOutflowLimiter } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import {
  BaseEvmProvider,
  type EvmChainConfig,
  type EvmNativeTxRow,
  type EvmPaginationPage,
  type EvmTokenTxRow,
} from '../../core/base/base-evm-provider';
import type { ProviderFactory } from '../../core/boot';
import type {
  AddressValidatorProvider,
  BalanceProvider,
  Capability,
  TransactionsProvider,
} from '../../core/capabilities';
import type {
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
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
    return /^0x[a-fA-F0-9]{40}$/.test(address);
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
    try {
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
      if (!response.ok) return false;
      const data = (await response.json()) as EtherscanResponse<unknown[]>;
      return data.status === '1' && Array.isArray(data.result) && data.result.length > 0;
    } catch {
      return false;
    }
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

  private async fetchNativeBalance(
    chain: EvmChainConfig,
    address: string,
    apiKey: string
  ): Promise<HoldingSnapshot | null> {
    const url = this.buildUrl(chain.chainId, {
      module: 'account',
      action: 'balance',
      address,
      tag: 'latest',
      apikey: apiKey,
    });
    const data = await this.callJson<EtherscanResponse<string>>(url);
    if (!data || data.status !== '1') return null;
    const wei = new Decimal(data.result);
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
    // the freshest activity first.
    const discoverUrl = this.buildUrl(chain.chainId, {
      module: 'account',
      action: 'tokentx',
      address,
      page: '1',
      offset: '10000',
      sort: 'desc',
      apikey: apiKey,
    });
    const discoverData = await this.callJson<EtherscanResponse<TokenTxResultRow[]>>(discoverUrl);
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

    // Per-token current balance. Etherscan's tokenbalance is one
    // call per (contract, address); parallel issuance is fine
    // because the rate-limiter is the gate.
    const tasks = [...uniqueTokens.entries()].map(async ([contract, info]) => {
      const balanceUrl = this.buildUrl(chain.chainId, {
        module: 'account',
        action: 'tokenbalance',
        contractaddress: contract,
        address,
        tag: 'latest',
        apikey: apiKey,
      });
      const balanceData = await this.callJson<EtherscanResponse<string>>(balanceUrl);
      if (!balanceData || balanceData.status !== '1') return null;
      const raw = new Decimal(balanceData.result);
      if (raw.isZero()) return null;
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
    if (!response.ok) return null;
    return (await response.json()) as T;
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
  return new EtherscanProvider(ETHERSCAN_CHAINS, registered, deps.env.ETHERSCAN_API_KEY);
};

export { ETHERSCAN_CHAINS, findChainConfig } from './chains';
export { isLikelySpamToken } from './spam-filter';
