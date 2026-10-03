/**
 * `TronProvider` — balances + transactions for the Tron blockchain via
 * the public TronGrid API.
 *
 * Capabilities:
 *  - `current-balances`: one `/v1/accounts/{addr}` read carries both the
 *    TRX balance and the TRC-20 balances (`data[0].trc20`, raw amounts
 *    keyed by contract); symbols and decimals come from `/v1/trc20/info`.
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
import { ProviderError } from '../../core/errors';
import type {
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  TransactionFetchContext,
  WithUserCreds,
} from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';
import { type PageCapWalk, PageCapWatch } from '../../core/utils/page-cap';
import { WalkFailureWatch } from '../../core/utils/walk-failures';
import { WALLET_HISTORY_ROW_CAP } from '../../core/wallet-limits';
import { tronBase58ToHex } from './address';

const TRON_INSTITUTION_CODE = 'tron';
const SUN_PER_TRX = 1_000_000;
const TX_PAGE_LIMIT = 200;
// `/v1/trc20/info` answers 400 "A valid limit by parameter is required" above 20.
const TRC20_INFO_BATCH = 20;

interface TronAccountInfo {
  balance?: number;
  trc20?: Array<Record<string, string>>;
}

interface TronTrc20Info {
  contract_address: string;
  symbol?: string;
  name?: string;
  decimals?: string | number;
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

/**
 * Structural Tron address check. Pure and offline; the chain-stub
 * provider reuses it so a stubbed boot answers address shape exactly
 * as the live one does.
 */
export function isTronAddress(address: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address);
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
    return isTronAddress(address);
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
    return (await this.fetchAccount(address)) !== null;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const address =
      (creds.walletAddress as string | undefined) ?? (creds.address as string | undefined);
    if (!address || !this.isValidAddress(address)) return [];

    const account = await this.fetchAccount(address);
    if (!account) return [];
    const out: HoldingSnapshot[] = [];
    if (typeof account.balance === 'number' && account.balance > 0) {
      out.push({
        externalId: 'native',
        tokenIdentity: { symbol: 'TRX', name: 'Tron', decimals: 6, providerMetadata: {} },
        balance: new Decimal(account.balance).div(SUN_PER_TRX).toString(),
        capturedAt: new Date(),
      });
    }
    out.push(...(await this.trc20Holdings(account.trc20 ?? [])));
    return out;
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
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

    const capped = new PageCapWatch();
    const failures = new WalkFailureWatch(this.providerKey, this.logger);
    const [native, trc20] = await Promise.all([
      this.fetchNativeTxs(address, walletHex, capped, failures),
      this.fetchTrc20Txs(address, capped, failures),
    ]);

    const events = [...native, ...trc20];
    capped.retract(ctx, this.providerKey);
    failures.retract(ctx);
    return events.filter((e) => {
      if (ctx.since && e.occurredAt < ctx.since) return false;
      if (ctx.until && e.occurredAt > ctx.until) return false;
      return true;
    });
  }

  // ============================================================
  // Internals — balances
  // ============================================================

  /** `null` for an address the chain has never seen: TronGrid answers 200 with `data: []`. */
  private async fetchAccount(address: string): Promise<TronAccountInfo | null> {
    const body = (await this.callJson(
      `${this.apiUrl}/v1/accounts/${encodeURIComponent(address)}`
    )) as { data?: TronAccountInfo[] };
    if (!Array.isArray(body.data)) {
      throw new ProviderError(
        'trongrid: /v1/accounts returned no data array',
        'retryable',
        this.providerKey
      );
    }
    return body.data[0] ?? null;
  }

  private async trc20Holdings(entries: Array<Record<string, string>>): Promise<HoldingSnapshot[]> {
    const raw = new Map<string, Decimal>();
    for (const entry of entries) {
      for (const [contract, amount] of Object.entries(entry)) {
        const value = new Decimal(amount);
        if (value.gt(0)) raw.set(contract, value);
      }
    }

    const contracts = [...raw.keys()];
    const out: HoldingSnapshot[] = [];
    for (let i = 0; i < contracts.length; i += TRC20_INFO_BATCH) {
      const batch = contracts.slice(i, i + TRC20_INFO_BATCH);
      const body = (await this.callJson(
        `${this.apiUrl}/v1/trc20/info?contract_list=${batch.join(',')}`
      )) as { data?: TronTrc20Info[] };
      if (!Array.isArray(body.data)) {
        throw new ProviderError(
          'trongrid: /v1/trc20/info returned no data array',
          'retryable',
          this.providerKey
        );
      }
      for (const info of body.data) {
        const amount = raw.get(info.contract_address);
        const decimals = Number(info.decimals);
        if (!amount || !Number.isInteger(decimals)) continue;
        raw.delete(info.contract_address);
        const identity: Partial<NewToken> = {
          symbol: (info.symbol ?? '').toUpperCase(),
          name: info.name,
          decimals,
          providerMetadata: { tron: { contract: info.contract_address } },
        };
        out.push({
          externalId: info.contract_address,
          tokenIdentity: identity,
          balance: amount.div(new Decimal(10).pow(decimals)).toString(),
          capturedAt: new Date(),
        });
      }
    }
    if (raw.size > 0) {
      this.logger.warn(
        { providerKey: this.providerKey, contracts: [...raw.keys()].slice(0, 10), count: raw.size },
        'TRC-20 balances with no token metadata from TronGrid were left out'
      );
    }
    return out;
  }

  // ============================================================
  // Internals — transactions
  // ============================================================

  private async fetchNativeTxs(
    address: string,
    walletHex: string,
    capped: PageCapWatch,
    failures: WalkFailureWatch
  ): Promise<TransactionEvent[]> {
    const events: TransactionEvent[] = [];
    for await (const row of this.paginate<TronNativeTxRow>(
      `${this.apiUrl}/v1/accounts/${encodeURIComponent(address)}/transactions`,
      { only_confirmed: 'true' },
      { kind: 'trxTransfers' },
      capped,
      failures
    )) {
      const event = this.toNativeEvent(row, walletHex);
      if (event) events.push(event);
    }
    return events;
  }

  private async fetchTrc20Txs(
    address: string,
    capped: PageCapWatch,
    failures: WalkFailureWatch
  ): Promise<TransactionEvent[]> {
    const events: TransactionEvent[] = [];
    for await (const row of this.paginate<TronTrc20Row>(
      `${this.apiUrl}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20`,
      { only_confirmed: 'true' },
      { kind: 'trc20Transfers' },
      capped,
      failures
    )) {
      const event = this.toTrc20Event(row, address);
      if (event) events.push(event);
    }
    return events;
  }

  private async *paginate<T>(
    baseUrl: string,
    extraParams: Record<string, string>,
    walk: PageCapWalk,
    capped: PageCapWatch,
    failures: WalkFailureWatch
  ): AsyncGenerator<T> {
    let fingerprint: string | undefined;
    let rowsSeen = 0;
    let pages = 0;
    while (true) {
      const params = new URLSearchParams({
        limit: String(TX_PAGE_LIMIT),
        ...extraParams,
      });
      if (fingerprint) params.set('fingerprint', fingerprint);
      const url = `${baseUrl}?${params.toString()}`;
      const walkName =
        walk.kind === 'trxTransfers' ? 'the TRX transfer walk' : 'the TRC-20 transfer walk';
      // A refused page is not the end of the feed: treating it as "no more
      // rows" let a 500 on the first page claim a complete, empty history
      // (SC-1481).
      let response: TronPaginatedResponse<T>;
      try {
        response = (await this.callJson(url)) as TronPaginatedResponse<T>;
      } catch (err) {
        failures.note(walkName, err);
        break;
      }
      if (response.success === false) {
        failures.note(walkName);
        break;
      }
      const rows = response.data ?? [];
      for (const row of rows) yield row;
      rowsSeen += rows.length;
      pages += 1;
      const nextFingerprint = response.meta?.fingerprint;
      if (!nextFingerprint || rows.length === 0) break;
      // The address is the requester's choice, so its size is too (SC-1271).
      if (rowsSeen >= WALLET_HISTORY_ROW_CAP) {
        capped.note({ walk, pages, rows: rowsSeen });
        break;
      }
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

  private async callJson(url: string): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(url, this.apiKey ? { headers } : undefined)
    );
    if (!response.ok) {
      throw ProviderError.fromHttp(this.providerKey, response, await response.text());
    }
    return await response.json();
  }
}

export const tronFactory: ProviderFactory = async (deps) => {
  const apiKey = deps.env.TRON_PRO_API_KEY;
  // Keyless TronGrid refuses the second request in a second
  // (`exceeded the allowed_rps(1)`) and then suspends the caller for a while.
  // 10/s was budgeted for every caller; it holds only for a keyed one.
  const maxRequests = apiKey ? 10 : 1;
  const limiter = createOutflowLimiter({
    maxRequests,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'tron',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'tron',
    limiter,
    registeredFrom: 'providers/tron',
    description: `TronGrid ${apiKey ? 'with' : 'without'} an API key: ${maxRequests} req / 1s`,
  });
  return new TronProvider(registered, deps.env.TRON_API_URL ?? 'https://api.trongrid.io', apiKey);
};
