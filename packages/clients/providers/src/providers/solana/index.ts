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
 * TRANSFER LEGS ARE NOT A SOURCE OF EVENTS (SC-357). Helius reports
 * every account-level movement a transaction makes, and several of
 * them are the same money seen from different sides. A wrap/unwrap
 * round trip moves lamports into the wallet's own WSOL account and
 * then moves WSOL out of it; WSOL resolves to the same token identity
 * as native SOL, so replaying both legs booked the same 0.5 SOL twice.
 * `events.swap` restated it a third time, which is what SC-339
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 *
 * The primitive that cannot double count is `accountData[]`:
 * `nativeBalanceChange` on the wallet's own account plus
 * `tokenBalanceChanges` on the accounts it owns is the transaction's
 * NET effect per token, stated once. This provider projects that and
 * nothing else — one event per token per transaction, keyed
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 *
 * Three consequences worth stating, because each looks like a bug
 * until you know it is the point:
 *
 *  - WSOL folds into native SOL rather than being netted separately.
 *    They are the same asset and the same token identity, so a wrap
 *    that stays wrapped is a movement of nothing and emits no event.
 *  - The transaction FEE is inside `nativeBalanceChange` and stays
 *    there. It is a real disposal of SOL, and `feeQuantity` is written
 *    by the router but read by no cost-basis walk, so a separate fee
 *    leg would silently vanish from the ledger's total.
 *  - A transaction Helius returns without `accountData` emits nothing.
 *    None of the 312 lacked it; if one ever does, saying nothing is
 *    the only honest option left, because every other field on the
 *    payload is a leg and legs are what this stopped trusting.
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
import { resolveJupiterMint } from './jupiter';

const SOL_INSTITUTION_CODE = 'solana';
const LAMPORTS_PER_SOL = 1_000_000_000;
const HELIUS_ENHANCED_BASE = 'https://api.helius.xyz/v0';
const HELIUS_PAGE_LIMIT = 100;
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** `external_id` and net-map key for native SOL, which has no mint. */
const NATIVE_KEY = 'native';

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

interface HeliusTokenBalanceChange {
  /** Owner of `tokenAccount` — the wallet, for its own ATAs. */
  userAccount?: string;
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
}

interface HeliusAccountData {
  account: string;
  /** Signed lamport delta for `account`, fee included for the payer. */
  nativeBalanceChange?: number;
  tokenBalanceChanges?: HeliusTokenBalanceChange[];
}

interface HeliusEnhancedTx {
  signature: string;
  timestamp: number;
  accountData?: HeliusAccountData[];
}

/**
 * Structural Solana address check. Pure and offline; the chain-stub
 * provider reuses it so a stubbed boot answers address shape exactly
 * as the live one does.
 */
export function isSolanaAddress(address: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
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
    return isSolanaAddress(address);
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
    if (!response.ok) {
      throw new Error(`solana rpc: HTTP ${response.status} for getSignaturesForAddress`);
    }
    const data = (await response.json()) as RpcResponse<unknown[]>;
    if (!Array.isArray(data.result)) {
      throw new Error(`solana rpc: no result for getSignaturesForAddress`);
    }
    return data.result.length > 0;
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
   *
   * `since` also stops the walk. Helius returns an address's transactions
   * newest-first — which is the whole reason `before` pages BACKWARDS — so
   * once a page ends older than the cutoff, every later page is older
   * still and every event on it would be filtered out below. Without this
   * the nightly sync re-walked a wallet's entire history to keep a 30-day
   * window: 4 Helius calls per wallet per night for mgrin's larger wallet,
   * against 1 (SC-360). The filter below stays — it is what makes the
   * boundary page correct, since a page straddling the cutoff carries
   * events on both sides of it.
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
      // Pre-resolve every unique mint on this page in parallel, then
      // pass the resolved Map into the synchronous event projection.
      // Without this, projection would have to be async and serialize
      // ~30 Jupiter lookups per tx.
      const mintMap = await collectMintIdentities(page);
      for (const tx of page) {
        events.push(...this.toTransactionEvents(tx, address, mintMap));
      }
      const last = page[page.length - 1];
      if (!last?.signature || page.length < HELIUS_PAGE_LIMIT) break;
      if (ctx.since && new Date(last.timestamp * 1000) < ctx.since) break;
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

    // Resolve every mint to its real symbol via Jupiter in parallel.
    // The cache means subsequent syncs are free; the first sync of a
    // wallet pays one HTTP round-trip per unique mint. Jupiter's lite
    // endpoint is unauthenticated and tolerant of bursts.
    const resolved = await Promise.all(
      accounts.map(async (acct) => {
        const info = acct.account.data.parsed.info;
        const jup = await resolveJupiterMint(info.mint);
        return { info, jup };
      })
    );

    const out: HoldingSnapshot[] = [];
    for (const { info, jup } of resolved) {
      const amount = info.tokenAmount.amount;
      const decimals = jup?.decimals ?? info.tokenAmount.decimals;
      const balance = new Decimal(amount).div(new Decimal(10).pow(decimals)).toString();
      out.push({
        externalId: info.mint,
        tokenIdentity: splIdentity(info.mint, decimals, jup),
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

  /**
   * One event per token per transaction, netted from `accountData`.
   *
   * The wallet's `nativeBalanceChange` and the `tokenBalanceChanges` of
   * the token accounts it owns are, together, the whole of what the
   * transaction did to it. Nothing here reads a transfer leg, so no
   * amount can be counted twice — see the file header for the 3.4x
   * that motivated it (SC-357).
   */
  private toTransactionEvents(
    tx: HeliusEnhancedTx,
    wallet: string,
    mintMap: Map<string, Partial<NewToken>>
  ): TransactionEvent[] {
    const occurredAt = new Date(tx.timestamp * 1000);
    const net = new Map<string, Decimal>();
    const add = (key: string, qty: Decimal) =>
      net.set(key, (net.get(key) ?? new Decimal(0)).plus(qty));

    for (const account of tx.accountData ?? []) {
      if (account.account === wallet && account.nativeBalanceChange) {
        add(NATIVE_KEY, new Decimal(account.nativeBalanceChange).div(LAMPORTS_PER_SOL));
      }
      for (const change of account.tokenBalanceChanges ?? []) {
        if (change.userAccount !== wallet) continue;
        const { tokenAmount, decimals } = change.rawTokenAmount;
        add(mintKey(change.mint), new Decimal(tokenAmount).div(new Decimal(10).pow(decimals)));
      }
    }

    const events: TransactionEvent[] = [];
    // Sorted so a re-import produces the same events in the same order
    // whatever order Helius listed the accounts in.
    for (const key of [...net.keys()].sort()) {
      const qty = net.get(key) as Decimal;
      if (qty.isZero()) continue;
      events.push({
        externalId: `${tx.signature}-net-${key}`,
        occurredAt,
        kind: qty.isNegative() ? 'transfer_out' : 'transfer_in',
        primary: {
          tokenIdentity: key === NATIVE_KEY ? solIdentity() : lookupMintIdentity(mintMap, key),
          quantity: qty.toString(),
        },
      });
    }
    return events;
  }
}

// WSOL is native SOL in a token account. It resolves to the same token
// identity, so netting it under a separate key would leave a wrap and
// its unwrap as two full-sized movements of the same lamports.
function mintKey(mint: string): string {
  return mint === WSOL_MINT ? NATIVE_KEY : mint;
}

function solIdentity(): Partial<NewToken> {
  return {
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
    providerMetadata: {},
  };
}

// Build a Partial<NewToken> for an SPL mint. Jupiter's metadata is
// preferred when present; the mint-prefix fallback only fires when
// Jupiter has no record of the mint (brand-new launches, scam tokens
// outside the verified set, or a Jupiter outage during the sync).
function splIdentity(
  mint: string,
  decimals: number,
  jup: { symbol: string; name: string; decimals: number; isVerified: boolean } | null
): Partial<NewToken> {
  if (jup) {
    return {
      symbol: jup.symbol,
      name: jup.name,
      decimals: jup.decimals,
      providerMetadata: {
        solana: { mint },
      },
    };
  }
  return {
    symbol: mint.slice(0, 8).toUpperCase(),
    name: `SPL ${mint.slice(0, 6)}`,
    decimals,
    providerMetadata: {
      solana: { mint },
    },
  };
}

// Pre-resolve all unique mints on a page of Helius txs so the
// synchronous projection function can look them up without awaiting.
// Concurrent Jupiter lookups; per-mint cache means subsequent pages
// touching the same mint are free. Scans `accountData` because that is
// what the projection reads — WSOL is skipped, since it is emitted
// under the native SOL identity and never looked up as a mint.
async function collectMintIdentities(
  txs: HeliusEnhancedTx[]
): Promise<Map<string, Partial<NewToken>>> {
  const mints = new Map<string, number>();
  for (const tx of txs) {
    for (const account of tx.accountData ?? []) {
      for (const change of account.tokenBalanceChanges ?? []) {
        if (!change.mint || change.mint === WSOL_MINT) continue;
        mints.set(change.mint, change.rawTokenAmount.decimals);
      }
    }
  }
  const entries = await Promise.all(
    Array.from(mints).map(async ([mint, decimals]) => {
      const jup = await resolveJupiterMint(mint);
      return [mint, splIdentity(mint, jup?.decimals ?? decimals, jup)] as const;
    })
  );
  return new Map(entries);
}

function lookupMintIdentity(
  mintMap: Map<string, Partial<NewToken>>,
  mint: string
): Partial<NewToken> {
  const cached = mintMap.get(mint);
  if (cached) return cached;
  // Fallback when the mint wasn't pre-resolved (defensive — should not
  // happen because collectMintIdentities scans every tx).
  return splIdentity(mint, 0, null);
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
