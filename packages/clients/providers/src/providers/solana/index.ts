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
import { PageCapWatch } from '../../core/utils/page-cap';
import { WALLET_HISTORY_ROW_CAP } from '../../core/wallet-limits';
import { associatedTokenAddress } from './associated-token-account';
import { resolveJupiterMint } from './jupiter';

const SOL_INSTITUTION_CODE = 'solana';
const LAMPORTS_PER_SOL = 1_000_000_000;
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

interface TokenBalanceChange {
  /** Owner of the token account — the wallet, for its own ATAs. */
  userAccount?: string;
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
}

interface AccountChange {
  account: string;
  /** Signed lamport delta for `account`, fee included for the payer. */
  nativeBalanceChange?: number;
  tokenBalanceChanges?: TokenBalanceChange[];
}

/** One transaction as the netting reads it: what changed, per account. */
interface NettableTx {
  signature: string;
  timestamp: number;
  accountData: AccountChange[];
}

interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

/** A `transactionDetails: 'full'`, `encoding: 'json'` row — `getTransaction`'s shape. */
interface RpcFullTx {
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: { accountKeys: (string | { pubkey: string })[] };
  };
  meta: {
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: RpcTokenBalance[];
    postTokenBalances?: RpcTokenBalance[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  } | null;
}

interface TransactionsForAddressPage {
  data: RpcFullTx[];
  paginationToken: string | null;
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

    const events: TransactionEvent[] = [];
    const capped = new PageCapWatch();
    let pages = 0;
    let paginationToken: string | undefined;
    while (true) {
      const result = await this.fetchTransactionsPage(address, ctx.since, paginationToken);
      const page = result.data
        .map((raw) => toNettable(raw, address))
        .filter((tx): tx is NettableTx => tx !== null);
      if (result.data.length === 0) break;
      // Pre-resolve every unique mint on this page in parallel, then
      // pass the resolved Map into the synchronous event projection.
      // Without this, projection would have to be async and serialize
      // ~30 Jupiter lookups per tx.
      const mintMap = await collectMintIdentities(page);
      for (const tx of page) {
        events.push(...this.toTransactionEvents(tx, address, mintMap));
      }
      pages += 1;
      if (!result.paginationToken) break;
      // The address is the requester's choice, so its size is too (SC-1271).
      if (events.length >= WALLET_HISTORY_ROW_CAP) {
        capped.note({ walk: { kind: 'addressHistory' }, pages, rows: events.length });
        break;
      }
      const last = page[page.length - 1];
      if (ctx.since && last && new Date(last.timestamp * 1000) < ctx.since) break;
      paginationToken = result.paginationToken;
    }

    capped.retract(ctx, this.providerKey);
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
  // Internals — transactions (Helius getTransactionsForAddress)
  // ============================================================

  private isHeliusUrl(): boolean {
    return this.rpcUrl.includes('helius');
  }

  /**
   * One page of the wallet's history, newest first (SC-1578).
   *
   * `tokenAccounts: 'balanceChanged'` is what reaches an incoming SPL
   * transfer: it lands on the wallet's token account, and the wallet
   * itself is not among that transaction's keys. Without
   * `maxSupportedTransactionVersion` only legacy transactions come back.
   */
  private async fetchTransactionsPage(
    address: string,
    since: Date | undefined,
    paginationToken: string | undefined
  ): Promise<TransactionsForAddressPage> {
    const filters: Record<string, unknown> = { tokenAccounts: 'balanceChanged' };
    if (since) filters.blockTime = { gte: Math.floor(since.getTime() / 1000) };
    const options: Record<string, unknown> = {
      transactionDetails: 'full',
      encoding: 'json',
      maxSupportedTransactionVersion: 1,
      sortOrder: 'desc',
      limit: HELIUS_PAGE_LIMIT,
      filters,
    };
    if (paginationToken) options.paginationToken = paginationToken;
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransactionsForAddress',
          params: [address, options],
        }),
      })
    );
    if (!response.ok) {
      throw new Error(`Helius getTransactionsForAddress: HTTP ${response.status}`);
    }
    const body = (await response.json()) as RpcResponse<TransactionsForAddressPage>;
    if (body.error) {
      throw new Error(`Helius getTransactionsForAddress: ${body.error.message}`);
    }
    return { data: body.result?.data ?? [], paginationToken: body.result?.paginationToken ?? null };
  }

  private warnPublicRpcTransactionsOnce(): void {
    if (this.warnedPublicRpcTransactions) return;
    this.warnedPublicRpcTransactions = true;
    this.logger.warn(
      'SolanaProvider.fetchTransactions: Helius API key not configured; public Solana RPC has no parsed-tx endpoint, returning []'
    );
  }

  /**
   * One event per token per transaction, netted from its account changes.
   *
   * The wallet's `nativeBalanceChange` and the `tokenBalanceChanges` of
   * the token accounts it owns are, together, the whole of what the
   * transaction did to it. Nothing here reads a transfer leg, so no
   * amount can be counted twice — see the file header for the 3.4x
   * that motivated it (SC-357).
   */
  private toTransactionEvents(
    tx: NettableTx,
    wallet: string,
    mintMap: Map<string, Partial<NewToken>>
  ): TransactionEvent[] {
    const occurredAt = new Date(tx.timestamp * 1000);
    const net = new Map<string, Decimal>();
    const add = (key: string, qty: Decimal) =>
      net.set(key, (net.get(key) ?? new Decimal(0)).plus(qty));

    for (const account of tx.accountData) {
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
/**
 * A raw transaction as the per-account changes the netting reads.
 *
 * `meta` carries balances before and after, so a change is their
 * difference: lamports per account key, and token units per token
 * account, its owner taken from whichever side lists it (a token
 * account opened or closed in the transaction appears on one side
 * only). A v0 transaction keeps some keys in `loadedAddresses`, after
 * the static ones, which is the order `accountIndex` counts in.
 */
function toNettable(raw: RpcFullTx, wallet: string): NettableTx | null {
  const signature = raw.transaction.signatures[0];
  if (!signature || raw.blockTime === null || !raw.meta) return null;
  const { meta } = raw;
  const keys = [
    ...raw.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey)),
    ...(meta.loadedAddresses?.writable ?? []),
    ...(meta.loadedAddresses?.readonly ?? []),
  ];

  const changes = keys.map((account, i): AccountChange => {
    const pre = meta.preBalances[i] ?? 0;
    const post = meta.postBalances[i] ?? 0;
    return { account, nativeBalanceChange: post - pre, tokenBalanceChanges: [] };
  });

  const byIndex = new Map<number, { pre?: RpcTokenBalance; post?: RpcTokenBalance }>();
  for (const b of meta.preTokenBalances ?? []) {
    byIndex.set(b.accountIndex, { ...byIndex.get(b.accountIndex), pre: b });
  }
  for (const b of meta.postTokenBalances ?? []) {
    byIndex.set(b.accountIndex, { ...byIndex.get(b.accountIndex), post: b });
  }
  for (const [index, { pre, post }] of byIndex) {
    const side = post ?? pre;
    const change = changes[index];
    if (!side || !change) continue;
    const delta =
      BigInt(post?.uiTokenAmount.amount ?? '0') - BigInt(pre?.uiTokenAmount.amount ?? '0');
    if (delta === 0n) continue;
    change.tokenBalanceChanges?.push({
      userAccount: post?.owner ?? pre?.owner ?? ownerlessHolder(change.account, side.mint, wallet),
      mint: side.mint,
      rawTokenAmount: { tokenAmount: delta.toString(), decimals: side.uiTokenAmount.decimals },
    });
  }

  return { signature, timestamp: raw.blockTime, accountData: changes };
}

/** A balance recorded before the RPC's `owner` field existed names no owner.
    It is the wallet's when the account is the wallet's ATA for that mint;
    otherwise nobody can be named, so it is not the wallet's (SC-1578). */
function ownerlessHolder(account: string, mint: string, wallet: string): string | undefined {
  return account === associatedTokenAddress(wallet, mint) ? wallet : undefined;
}

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
// touching the same mint are free. Scans the account changes because
// they are what the projection reads — WSOL is skipped, since it is emitted
// under the native SOL identity and never looked up as a mint.
async function collectMintIdentities(txs: NettableTx[]): Promise<Map<string, Partial<NewToken>>> {
  const mints = new Map<string, number>();
  for (const tx of txs) {
    for (const account of tx.accountData) {
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
  deps.reportCredentialStatus({
    provider: 'solana',
    envVar: 'HELIUS_API_KEY',
    keyed: Boolean(heliusKey),
    degradedBehaviour: 'falls back to the public Solana RPC, which throttles aggressively',
  });

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
