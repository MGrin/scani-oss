/**
 * `TronProvider` — balances + transactions for the Tron blockchain via
 * the public TronGrid API.
 *
 * Capabilities:
 *  - `current-balances`: native TRX via `/v1/accounts/{addr}`,
 *    TRC20 tokens via `/v1/accounts/{addr}/tokens`. Both fetched in
 *    parallel.
 *  - `transactions`: native + TRC20 in parallel via
 *    `/v1/accounts/{addr}/transactions` and
 *    `/v1/accounts/{addr}/transactions/trc20`. Both endpoints paginate
 *    via `meta.fingerprint`; native parses `raw_data.contract[0]` to
 *    pick out `TransferContract` rows and converts wallet→hex once so
 *    the in/out check is a string match.
 *  - `address-validator`: starts with `T`, 34 chars, base58 alphabet.
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
import { tronBase58ToHex } from './address';

const TRON_INSTITUTION_CODE = 'tron';
const SUN_PER_TRX = 1_000_000;
const TX_PAGE_LIMIT = 200;

interface TronAccountInfo {
  balance?: number;
}

interface TronTRC20Token {
  balance: string;
  tokenId: string;
  tokenAbbr: string;
  tokenName: string;
  tokenDecimal: number;
  tokenType: string;
}

interface TronNativeTxRow {
  txID: string;
  block_timestamp: number;
  raw_data?: {
    contract?: Array<{
      type?: string;
      parameter?: {
        value?: {
          owner_address?: string;
          to_address?: string;
          amount?: number;
        };
      };
    }>;
  };
  ret?: Array<{ contractRet?: string }>;
}

interface TronTrc20Row {
  transaction_id: string;
  block_timestamp: number;
  from?: string;
  to?: string;
  type?: string;
  value?: string;
  token_info?: {
    symbol?: string;
    name?: string;
    address?: string;
    decimals?: number;
  };
}

interface TronPaginatedResponse<T> {
  data?: T[];
  meta?: { fingerprint?: string };
  success?: boolean;
}

export class TronProvider
  implements BalanceProvider, TransactionsProvider, AddressValidatorProvider
{
  readonly providerKey = 'tron';
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'address-validator',
  ];

  private readonly logger: CustomLogger;

  constructor(
    private readonly limiter: OutflowRateLimiter,
    private readonly apiUrl: string,
    private readonly apiKey?: string
  ) {
    this.logger = createComponentLogger('provider:tron');
  }

  canFetchBalances(institutionCode: string): boolean {
    return institutionCode === TRON_INSTITUTION_CODE;
  }

  canFetchTransactions(institutionCode: string): boolean {
    return institutionCode === TRON_INSTITUTION_CODE;
  }

  canValidate(institutionCode: string): boolean {
    return institutionCode === TRON_INSTITUTION_CODE;
  }

  isValidAddress(address: string, _institutionCode?: string): boolean {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
  }

  /**
   * Activity probe — TronGrid `/v1/accounts/{addr}` returns 200 with
   * `data: []` for a never-touched address. A populated `data` array
   * means the account exists on chain (any deposit / contract
   * interaction creates it).
   */
  async hasActivity(
    address: string,
    _institutionCode: string,
    _ctx: ProviderContext
  ): Promise<boolean> {
    if (!this.isValidAddress(address)) return false;
    try {
      const url = `${this.apiUrl}/v1/accounts/${encodeURIComponent(address)}`;
      const response = await this.callJson(url);
      if (!response) return false;
      const data = response as { data?: unknown[]; success?: boolean };
      return Array.isArray(data.data) && data.data.length > 0;
    } catch (err) {
      this.logger.debug(
        { address: `${address.substring(0, 10)}...`, error: err },
        'Tron hasActivity probe failed; treating as no activity'
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

    const [trx, trc20] = await Promise.all([this.fetchNative(address), this.fetchTrc20(address)]);
    const out: HoldingSnapshot[] = [];
    if (trx && new Decimal(trx.balance).gt(0)) out.push(trx);
    for (const t of trc20) {
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
    if (!address || !this.isValidAddress(address)) {
      this.logger.warn(
        { providerKey: this.providerKey, hasAddress: Boolean(address) },
        'Tron transactions fetch: invalid or missing address'
      );
      return [];
    }

    const walletHex = tronBase58ToHex(address).toLowerCase();

    const [native, trc20] = await Promise.all([
      this.fetchNativeTxs(address, walletHex),
      this.fetchTrc20Txs(address),
    ]);

    const events = [...native, ...trc20];
    return events.filter((e) => {
      if (ctx.since && e.occurredAt < ctx.since) return false;
      if (ctx.until && e.occurredAt > ctx.until) return false;
      return true;
    });
  }

  // ============================================================
  // Internals — balances
  // ============================================================

  private async fetchNative(address: string): Promise<HoldingSnapshot | null> {
    const url = `${this.apiUrl}/v1/accounts/${address}`;
    const data = (await this.callJson(url)) as { data?: TronAccountInfo[] } | null;
    const sun = data?.data?.[0]?.balance;
    if (typeof sun !== 'number') return null;
    const trx = new Decimal(sun).div(SUN_PER_TRX).toString();
    return {
      externalId: 'native',
      tokenIdentity: { symbol: 'TRX', name: 'Tron', decimals: 6, providerMetadata: {} },
      balance: trx,
      capturedAt: new Date(),
    };
  }

  private async fetchTrc20(address: string): Promise<HoldingSnapshot[]> {
    const url = `${this.apiUrl}/v1/accounts/${address}/tokens`;
    const data = (await this.callJson(url)) as {
      data?: TronTRC20Token[];
      success?: boolean;
    } | null;
    if (!data?.success || !data.data) return [];

    const out: HoldingSnapshot[] = [];
    for (const t of data.data) {
      if (t.tokenType !== 'trc20') continue;
      const balance = new Decimal(t.balance).div(new Decimal(10).pow(t.tokenDecimal)).toString();
      const identity: Partial<NewToken> = {
        symbol: t.tokenAbbr.toUpperCase(),
        name: t.tokenName,
        decimals: t.tokenDecimal,
        providerMetadata: { tron: { contract: t.tokenId } },
      };
      out.push({
        externalId: t.tokenId,
        tokenIdentity: identity,
        balance,
        capturedAt: new Date(),
      });
    }
    return out;
  }

  // ============================================================
  // Internals — transactions
  // ============================================================

  private async fetchNativeTxs(address: string, walletHex: string): Promise<TransactionEvent[]> {
    const events: TransactionEvent[] = [];
    for await (const row of this.paginate<TronNativeTxRow>(
      `${this.apiUrl}/v1/accounts/${encodeURIComponent(address)}/transactions`,
      { only_confirmed: 'true' }
    )) {
      const event = this.toNativeEvent(row, walletHex);
      if (event) events.push(event);
    }
    return events;
  }

  private async fetchTrc20Txs(address: string): Promise<TransactionEvent[]> {
    const events: TransactionEvent[] = [];
    for await (const row of this.paginate<TronTrc20Row>(
      `${this.apiUrl}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20`,
      { only_confirmed: 'true' }
    )) {
      const event = this.toTrc20Event(row, address);
      if (event) events.push(event);
    }
    return events;
  }

  private async *paginate<T>(
    baseUrl: string,
    extraParams: Record<string, string>
  ): AsyncGenerator<T> {
    let fingerprint: string | undefined;
    while (true) {
      const params = new URLSearchParams({
        limit: String(TX_PAGE_LIMIT),
        ...extraParams,
      });
      if (fingerprint) params.set('fingerprint', fingerprint);
      const url = `${baseUrl}?${params.toString()}`;
      const response = (await this.callJson(url)) as TronPaginatedResponse<T> | null;
      const rows = response?.data ?? [];
      for (const row of rows) yield row;
      const nextFingerprint = response?.meta?.fingerprint;
      if (!nextFingerprint || rows.length === 0) break;
      fingerprint = nextFingerprint;
    }
  }

  private toNativeEvent(row: TronNativeTxRow, walletHex: string): TransactionEvent | null {
    const contract = row.raw_data?.contract?.[0];
    if (!contract || contract.type !== 'TransferContract') return null;
    if (row.ret?.[0]?.contractRet !== 'SUCCESS') return null;

    const value = contract.parameter?.value;
    const owner = value?.owner_address?.toLowerCase();
    const to = value?.to_address?.toLowerCase();
    const amount = value?.amount;
    if (!owner || !to || typeof amount !== 'number') return null;

    let direction: 'in' | 'out';
    if (to === walletHex && owner !== walletHex) {
      direction = 'in';
    } else if (owner === walletHex && to !== walletHex) {
      direction = 'out';
    } else {
      // self-transfer (or unrelated row from spam-like activity) — skip
      return null;
    }

    const qty = new Decimal(amount).div(SUN_PER_TRX);
    if (qty.isZero()) return null;
    const signed = direction === 'in' ? qty : qty.neg();

    const tokenIdentity: Partial<NewToken> = {
      symbol: 'TRX',
      name: 'Tron',
      decimals: 6,
    };
    return {
      externalId: row.txID,
      occurredAt: new Date(row.block_timestamp),
      kind: direction === 'in' ? 'transfer_in' : 'transfer_out',
      primary: { tokenIdentity, quantity: signed.toString() },
    };
  }

  private toTrc20Event(row: TronTrc20Row, walletBase58: string): TransactionEvent | null {
    if (row.type && row.type !== 'Transfer') return null;
    const info = row.token_info;
    if (!info?.address || typeof info.decimals !== 'number' || !row.value) return null;

    let direction: 'in' | 'out';
    if (row.to === walletBase58 && row.from !== walletBase58) {
      direction = 'in';
    } else if (row.from === walletBase58 && row.to !== walletBase58) {
      direction = 'out';
    } else {
      return null;
    }

    const qty = new Decimal(row.value).div(new Decimal(10).pow(info.decimals));
    if (qty.isZero()) return null;
    const signed = direction === 'in' ? qty : qty.neg();

    const tokenIdentity: Partial<NewToken> = {
      symbol: (info.symbol ?? '').toUpperCase(),
      name: info.name,
      decimals: info.decimals,
      providerMetadata: { tron: { contract: info.address } },
    };
    return {
      externalId: `${row.transaction_id}-${info.address}`,
      occurredAt: new Date(row.block_timestamp),
      kind: direction === 'in' ? 'transfer_in' : 'transfer_out',
      primary: { tokenIdentity, quantity: signed.toString() },
    };
  }

  // ============================================================
  // HTTP plumbing
  // ============================================================

  private async callJson(url: string): Promise<unknown | null> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(url, this.apiKey ? { headers } : undefined)
    );
    if (!response.ok) return null;
    return await response.json();
  }
}

export const tronFactory: ProviderFactory = async (deps) => {
  // TronGrid free tier: ~15 req/s. Conservative 10/s.
  const limiter = createOutflowLimiter({
    maxRequests: 10,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'tron',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'tron',
    limiter,
    registeredFrom: 'providers/tron',
    description: 'TronGrid: 10 req / 1s',
  });
  return new TronProvider(
    registered,
    deps.env.TRON_API_URL ?? 'https://api.trongrid.io',
    deps.env.TRON_PRO_API_KEY
  );
};
