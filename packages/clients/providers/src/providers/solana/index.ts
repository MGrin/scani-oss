/**
 * `SolanaProvider` — balances + transactions for Solana mainnet via
 * Helius RPC (preferred when `HELIUS_API_KEY` is set) or the public
 * `mainnet-beta.solana.com` endpoint.
 *
 * Capabilities:
 *  - `current-balances`: native SOL via `getBalance`, SPL tokens via
 *    `getTokenAccountsByOwner`. Both fetched in parallel.
 *  - `transactions`: Helius enhanced `/v0/addresses/:addr/transactions`
 *    only. The public Solana RPC has no equivalent parsed-tx endpoint,
 *    so when no Helius URL is configured we warn-once and return [].
 *  - `address-validator`: base58, 32–44 chars.
 *
 * The public Solana RPC throttles aggressively; in production we
 * STRONGLY recommend Helius. The boot-time log emits a warning when
 * the public path is selected so ops sees it once per process.
 */

import type { NewToken } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
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

const SOL_INSTITUTION_CODE = 'solana';
const LAMPORTS_PER_SOL = 1_000_000_000;
const HELIUS_ENHANCED_BASE = 'https://api.helius.xyz/v0';
const HELIUS_PAGE_LIMIT = 100;

interface RpcResponse<T> {
  jsonrpc: string;
  result?: T;
  error?: { code: number; message: string };
  id: number;
}

interface SolanaTokenAccount {
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: { amount: string; decimals: number; uiAmount: number };
        };
      };
    };
  };
  pubkey: string;
}

interface HeliusNativeTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  amount: number;
}

interface HeliusTokenTransfer {
  fromUserAccount?: string;
  toUserAccount?: string;
  fromTokenAccount?: string;
  toTokenAccount?: string;
  tokenAmount: number;
  decimals?: number;
  mint: string;
  tokenStandard?: string;
}

interface HeliusSwapNativeLeg {
  account?: string;
  amount: string | number;
}

interface HeliusSwapTokenLeg {
  userAccount?: string;
  tokenAccount?: string;
  mint: string;
  rawTokenAmount?: { tokenAmount: string; decimals: number };
}

interface HeliusSwapEvent {
  nativeInput?: HeliusSwapNativeLeg;
  nativeOutput?: HeliusSwapNativeLeg;
  tokenInputs?: HeliusSwapTokenLeg[];
  tokenOutputs?: HeliusSwapTokenLeg[];
}

interface HeliusEnhancedTx {
  signature: string;
  timestamp: number;
  description?: string;
  type?: string;
  source?: string;
  fee?: number;
  feePayer?: string;
  nativeTransfers?: HeliusNativeTransfer[];
  tokenTransfers?: HeliusTokenTransfer[];
  events?: { swap?: HeliusSwapEvent };
}

export class SolanaProvider
  implements BalanceProvider, TransactionsProvider, AddressValidatorProvider
{
  readonly providerKey = 'solana';
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'address-validator',
  ];

  private readonly logger: CustomLogger;
  private warnedPublicRpcTransactions = false;

  constructor(
    private readonly limiter: OutflowRateLimiter,
    private readonly rpcUrl: string
  ) {
    this.logger = createComponentLogger('provider:solana');
  }

  canFetchBalances(institutionCode: string): boolean {
    return institutionCode === SOL_INSTITUTION_CODE;
  }

  canFetchTransactions(institutionCode: string): boolean {
    return institutionCode === SOL_INSTITUTION_CODE;
  }

  canValidate(institutionCode: string): boolean {
    return institutionCode === SOL_INSTITUTION_CODE;
  }

  isValidAddress(address: string, _institutionCode?: string): boolean {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  }

  /**
   * Activity probe — Solana RPC's `getSignaturesForAddress` with
   * limit=1 tells us whether the address has any transaction history.
   * Cheap, public-RPC-friendly, doesn't decode anything.
   */
  async hasActivity(
    address: string,
    _institutionCode: string,
    _ctx: ProviderContext
  ): Promise<boolean> {
    if (!this.isValidAddress(address)) return false;
    try {
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(this.rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignaturesForAddress',
            params: [address, { limit: 1 }],
          }),
        })
      );
      if (!response.ok) return false;
      const data = (await response.json()) as RpcResponse<unknown[]>;
      return Array.isArray(data.result) && data.result.length > 0;
    } catch (err) {
      this.logger.debug(
        { address: `${address.substring(0, 10)}...`, error: err },
        'Solana hasActivity probe failed; treating as no activity'
      );
      return false;
    }
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const address =
      (creds.walletAddress as string | undefined) ?? (creds.address as string | undefined);
    if (!address || !this.isValidAddress(address)) return [];

    const [native, spl] = await Promise.all([
      this.fetchNativeBalance(address),
      this.fetchSplBalances(address),
    ]);

    const out: HoldingSnapshot[] = [];
    if (native && new Decimal(native.balance).gt(0)) out.push(native);
    for (const t of spl) {
      if (new Decimal(t.balance).gt(0)) out.push(t);
    }
    return out;
  }

  /**
   * Transactions for a Solana wallet. Helius enhanced API only — public
   * RPC has no equivalent parsed-transaction endpoint, so when the
   * configured `rpcUrl` is the public Solana RPC we warn-once and
   * return []. Pagination uses Helius's `before=<signature>` cursor on
   * the last item of each page; we stop when a page comes back short.
   */
  async fetchTransactions(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const address =
      (creds.walletAddress as string | undefined) ?? (creds.address as string | undefined);
    if (!address || !this.isValidAddress(address)) return [];

    if (!this.isHeliusUrl()) {
      this.warnPublicRpcTransactionsOnce();
      return [];
    }
    const apiKey = this.extractHeliusApiKey();
    if (!apiKey) {
      this.warnPublicRpcTransactionsOnce();
      return [];
    }

    const events: TransactionEvent[] = [];
    let before: string | undefined;
    while (true) {
      const url = this.buildEnhancedTxUrl(address, apiKey, before);
      const response = await this.limiter.execute(async () => fetchWithTimeout(url));
      if (!response.ok) {
        throw new Error(`Helius enhanced /transactions: HTTP ${response.status}`);
      }
      const page = (await response.json()) as HeliusEnhancedTx[];
      if (!Array.isArray(page) || page.length === 0) break;
      for (const tx of page) {
        events.push(...this.toTransactionEvents(tx, address));
      }
      const last = page[page.length - 1];
      if (!last?.signature || page.length < HELIUS_PAGE_LIMIT) break;
      before = last.signature;
    }

    return events.filter((e) => {
      if (ctx.since && e.occurredAt < ctx.since) return false;
      if (ctx.until && e.occurredAt > ctx.until) return false;
      return true;
    });
  }

  // ============================================================
  // Internals
  // ============================================================

  private async fetchNativeBalance(address: string): Promise<HoldingSnapshot | null> {
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getBalance',
          params: [address],
        }),
      })
    );
    if (!response.ok) {
      throw new Error(`Solana RPC: HTTP ${response.status}`);
    }
    const data = (await response.json()) as RpcResponse<{ value: number }>;
    if (data.error) throw new Error(`Solana RPC: ${data.error.message}`);
    const value = data.result?.value;
    if (typeof value !== 'number') return null;
    const sol = new Decimal(value).div(LAMPORTS_PER_SOL).toString();

    return {
      externalId: 'native',
      tokenIdentity: { symbol: 'SOL', name: 'Solana', decimals: 9, providerMetadata: {} },
      balance: sol,
      capturedAt: new Date(),
    };
  }

  private async fetchSplBalances(address: string): Promise<HoldingSnapshot[]> {
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTokenAccountsByOwner',
          params: [
            address,
            { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
            { encoding: 'jsonParsed' },
          ],
        }),
      })
    );
    if (!response.ok) return [];
    const data = (await response.json()) as RpcResponse<{ value: SolanaTokenAccount[] }>;
    if (data.error) {
      this.logger.warn(
        { code: data.error.code, message: data.error.message },
        'getTokenAccountsByOwner failed'
      );
      return [];
    }
    const accounts = data.result?.value ?? [];

    const out: HoldingSnapshot[] = [];
    for (const acct of accounts) {
      const info = acct.account.data.parsed.info;
      const amount = info.tokenAmount.amount;
      const decimals = info.tokenAmount.decimals;
      const balance = new Decimal(amount).div(new Decimal(10).pow(decimals)).toString();
      const tokenIdentity: Partial<NewToken> = {
        symbol: info.mint.slice(0, 8).toUpperCase(),
        name: `SPL ${info.mint.slice(0, 6)}`,
        decimals,
        providerMetadata: {
          // Reuse etherscan namespace would be wrong (different chain
          // semantics). SPL tokens get their own future namespace —
          // for now record the mint under a generic provider key.
          // The federated identity flow's CoinGecko/DeFiLlama
          // probes can match on symbol when the token's well-known.
          solana: { mint: info.mint },
        },
      };
      out.push({
        externalId: info.mint,
        tokenIdentity,
        balance,
        capturedAt: new Date(),
      });
    }
    return out;
  }

  // ============================================================
  // Internals — transactions (Helius enhanced API)
  // ============================================================

  private isHeliusUrl(): boolean {
    return this.rpcUrl.includes('helius');
  }

  private extractHeliusApiKey(): string | null {
    try {
      return new URL(this.rpcUrl).searchParams.get('api-key');
    } catch {
      return null;
    }
  }

  private buildEnhancedTxUrl(address: string, apiKey: string, before?: string): string {
    const params = new URLSearchParams({
      'api-key': apiKey,
      limit: String(HELIUS_PAGE_LIMIT),
    });
    if (before) params.set('before', before);
    return `${HELIUS_ENHANCED_BASE}/addresses/${address}/transactions?${params.toString()}`;
  }

  private warnPublicRpcTransactionsOnce(): void {
    if (this.warnedPublicRpcTransactions) return;
    this.warnedPublicRpcTransactions = true;
    this.logger.warn(
      'SolanaProvider.fetchTransactions: Helius API key not configured; public Solana RPC has no parsed-tx endpoint, returning []'
    );
  }

  private toTransactionEvents(tx: HeliusEnhancedTx, wallet: string): TransactionEvent[] {
    const events: TransactionEvent[] = [];
    const occurredAt = new Date(tx.timestamp * 1000);

    const nativeTransfers = tx.nativeTransfers ?? [];
    for (let i = 0; i < nativeTransfers.length; i++) {
      const t = nativeTransfers[i];
      if (!t) continue;
      const sol = new Decimal(t.amount).div(LAMPORTS_PER_SOL);
      if (t.fromUserAccount === wallet) {
        events.push({
          externalId: `${tx.signature}-native-${i}`,
          occurredAt,
          kind: 'transfer_out',
          primary: { tokenIdentity: solIdentity(), quantity: sol.negated().toString() },
        });
      } else if (t.toUserAccount === wallet) {
        events.push({
          externalId: `${tx.signature}-native-${i}`,
          occurredAt,
          kind: 'transfer_in',
          primary: { tokenIdentity: solIdentity(), quantity: sol.toString() },
        });
      }
    }

    const tokenTransfers = tx.tokenTransfers ?? [];
    for (let i = 0; i < tokenTransfers.length; i++) {
      const t = tokenTransfers[i];
      if (!t) continue;
      const qty = new Decimal(t.tokenAmount);
      const tokenId = mintIdentity(t.mint, t.decimals);
      if (t.fromUserAccount === wallet) {
        events.push({
          externalId: `${tx.signature}-token-${i}`,
          occurredAt,
          kind: 'transfer_out',
          primary: { tokenIdentity: tokenId, quantity: qty.negated().toString() },
        });
      } else if (t.toUserAccount === wallet) {
        events.push({
          externalId: `${tx.signature}-token-${i}`,
          occurredAt,
          kind: 'transfer_in',
          primary: { tokenIdentity: tokenId, quantity: qty.toString() },
        });
      }
    }

    const swap = tx.events?.swap;
    if (swap) {
      const outLeg = pickSwapLeg(swap, wallet, 'out');
      if (outLeg) {
        events.push({
          externalId: `${tx.signature}-swap-0`,
          occurredAt,
          kind: 'swap_out',
          primary: {
            tokenIdentity: outLeg.tokenIdentity,
            quantity: outLeg.quantity.negated().toString(),
          },
        });
      }
      const inLeg = pickSwapLeg(swap, wallet, 'in');
      if (inLeg) {
        events.push({
          externalId: `${tx.signature}-swap-1`,
          occurredAt,
          kind: 'swap_in',
          primary: {
            tokenIdentity: inLeg.tokenIdentity,
            quantity: inLeg.quantity.toString(),
          },
        });
      }
    }

    return events;
  }
}

function solIdentity(): Partial<NewToken> {
  return {
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    providerMetadata: {},
  };
}

function mintIdentity(mint: string, decimals?: number): Partial<NewToken> {
  return {
    symbol: mint.slice(0, 8).toUpperCase(),
    name: `SPL ${mint.slice(0, 6)}`,
    decimals: decimals ?? 0,
    providerMetadata: {
      solana: { mint },
    },
  };
}

function pickSwapLeg(
  swap: HeliusSwapEvent,
  wallet: string,
  direction: 'in' | 'out'
): { tokenIdentity: Partial<NewToken>; quantity: Decimal } | null {
  const nativeLeg = direction === 'out' ? swap.nativeInput : swap.nativeOutput;
  if (nativeLeg && nativeLeg.account === wallet) {
    const lamports = new Decimal(nativeLeg.amount);
    return {
      tokenIdentity: solIdentity(),
      quantity: lamports.div(LAMPORTS_PER_SOL),
    };
  }
  const tokenLegs = direction === 'out' ? swap.tokenInputs : swap.tokenOutputs;
  for (const leg of tokenLegs ?? []) {
    if (leg.userAccount !== wallet) continue;
    const raw = leg.rawTokenAmount;
    if (!raw) continue;
    const qty = new Decimal(raw.tokenAmount).div(new Decimal(10).pow(raw.decimals));
    return {
      tokenIdentity: mintIdentity(leg.mint, raw.decimals),
      quantity: qty,
    };
  }
  return null;
}

export const solanaFactory: ProviderFactory = async (deps) => {
  const heliusKey = deps.env.HELIUS_API_KEY;
  const rpcUrl = heliusKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
    : 'https://api.mainnet-beta.solana.com';
  if (!heliusKey) {
    // eslint-disable-next-line no-console
    console.warn(
      'SolanaProvider: HELIUS_API_KEY not set; using public RPC which throttles aggressively'
    );
  }

  // Helius free tier: ~100 req/s; public RPC: <50 req/min sustained.
  // Conservative 30 req/s default; ops can tune.
  const limiter = createOutflowLimiter({
    maxRequests: 30,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'solana',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'solana',
    limiter,
    registeredFrom: 'providers/solana',
    description: 'Solana RPC: 30 req / 1s',
  });
  return new SolanaProvider(registered, rpcUrl);
};
