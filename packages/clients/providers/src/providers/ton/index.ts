/**
 * `TonProvider` — balance + transaction fetching for The Open Network
 * via the public Toncenter API.
 *
 * Capabilities:
 *  - `current-balances`: native TON via `/getAddressBalance`. Jetton
 *    (TRC20-equivalent) balances are out of scope here pending a
 *    cleaner Toncenter v3 integration.
 *  - `transactions`: native TON inflows/outflows via `/getTransactions`.
 *    Jettons are explicitly out of scope for this first cut — they
 *    arrive as smart-contract calls with 0-value `in_msg`/`out_msgs`
 *    plus a separate notification message body, and need v3 to
 *    decode cleanly. Smart-contract / 0-value rows are skipped here.
 *  - `address-validator`: user-friendly mainnet (`EQ...`/`UQ...`) and
 *    testnet (`kQ...`/`0Q...`) base64url plus raw (`0:<64 hex>`).
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

const TON_INSTITUTION_CODE = 'ton';
const NANOTONS_PER_TON = 1_000_000_000;
const TX_PAGE_LIMIT = 100;

const TON_NATIVE_IDENTITY: Partial<NewToken> = {
  symbol: 'TON',
  name: 'Toncoin',
  decimals: 9,
  providerMetadata: {},
};

interface ToncenterMessage {
  source?: string;
  destination?: string;
  value: string;
}

interface ToncenterTx {
  utime: number;
  transaction_id: { lt: string; hash: string };
  in_msg?: ToncenterMessage;
  out_msgs?: ToncenterMessage[];
}

interface ToncenterTransactionsResponse {
  ok: boolean;
  result?: ToncenterTx[];
}

export class TonProvider
  implements BalanceProvider, TransactionsProvider, AddressValidatorProvider
{
  readonly providerKey = 'ton';
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
    this.logger = createComponentLogger('provider:ton');
  }

  canFetchBalances(institutionCode: string): boolean {
    return institutionCode === TON_INSTITUTION_CODE;
  }

  canFetchTransactions(institutionCode: string): boolean {
    return institutionCode === TON_INSTITUTION_CODE;
  }

  canValidate(institutionCode: string): boolean {
    return institutionCode === TON_INSTITUTION_CODE;
  }

  isValidAddress(address: string, _institutionCode?: string): boolean {
    if (/^[EUk0]Q[A-Za-z0-9_-]{46}$/.test(address)) return true;
    if (/^-?[0-9]:[a-fA-F0-9]{64}$/.test(address)) return true;
    return false;
  }

  /**
   * Activity probe — Toncenter `/getAddressInformation` returns the
   * account state. A fresh address that's never received TON has
   * `state="uninit"`; activity is anything else.
   */
  async hasActivity(
    address: string,
    _institutionCode: string,
    _ctx: ProviderContext
  ): Promise<boolean> {
    if (!this.isValidAddress(address)) return false;
    try {
      const url = `${this.apiUrl}/getAddressInformation?address=${encodeURIComponent(address)}`;
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, this.requestInit())
      );
      if (!response.ok) return false;
      const data = (await response.json()) as { ok?: boolean; result?: { state?: string } };
      if (!data.ok || !data.result) return false;
      return data.result.state !== undefined && data.result.state !== 'uninit';
    } catch (err) {
      this.logger.debug(
        { address: `${address.substring(0, 10)}...`, error: err },
        'TON hasActivity probe failed; treating as no activity'
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

    const url = `${this.apiUrl}/getAddressBalance?address=${encodeURIComponent(address)}`;
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(url, this.requestInit())
    );
    if (!response.ok) throw new Error(`Toncenter: HTTP ${response.status}`);
    const data = (await response.json()) as { ok: boolean; result: string };
    if (!data.ok) throw new Error('Toncenter returned ok=false');

    const ton = new Decimal(data.result).div(NANOTONS_PER_TON);
    if (ton.isZero()) return [];

    return [
      {
        externalId: 'native',
        tokenIdentity: TON_NATIVE_IDENTITY,
        balance: ton.toString(),
        capturedAt: new Date(),
      },
    ];
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
        'TON transactions fetch: invalid or missing address'
      );
      return [];
    }

    const events: TransactionEvent[] = [];
    let cursor: { lt: string; hash: string } | null = null;
    while (true) {
      const params = new URLSearchParams({
        address,
        limit: String(TX_PAGE_LIMIT),
        to_lt: '0',
      });
      if (cursor) {
        params.set('lt', cursor.lt);
        params.set('hash', cursor.hash);
      }
      const url = `${this.apiUrl}/getTransactions?${params.toString()}`;
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, this.requestInit())
      );
      if (!response.ok) {
        throw new Error(`Toncenter: HTTP ${response.status} for ${address}`);
      }
      const data = (await response.json()) as ToncenterTransactionsResponse;
      if (!data.ok) throw new Error('Toncenter returned ok=false');
      const txs = data.result ?? [];
      for (const tx of txs) {
        for (const event of this.toTransactionEvents(tx, address)) {
          events.push(event);
        }
      }
      if (txs.length < TX_PAGE_LIMIT) break;
      const last = txs[txs.length - 1];
      if (!last) break;
      // Toncenter cursor: pass the last row's lt + hash back. The next
      // page returns rows strictly older than that point.
      cursor = { lt: last.transaction_id.lt, hash: last.transaction_id.hash };
    }

    return events.filter((e) => {
      if (ctx.since && e.occurredAt < ctx.since) return false;
      if (ctx.until && e.occurredAt > ctx.until) return false;
      return true;
    });
  }

  private toTransactionEvents(tx: ToncenterTx, wallet: string): TransactionEvent[] {
    const events: TransactionEvent[] = [];
    const occurredAt = new Date(tx.utime * 1000);
    const { lt, hash } = tx.transaction_id;

    // Position-based legIndex keeps externalId stable regardless of
    // which legs we end up emitting after the 0-value filter:
    //   leg 0 → in_msg
    //   leg 1+i → out_msgs[i]
    const inMsg = tx.in_msg;
    if (inMsg && inMsg.destination === wallet && this.isNonZero(inMsg.value)) {
      const qty = new Decimal(inMsg.value).div(NANOTONS_PER_TON);
      events.push({
        externalId: `${lt}-${hash}-0`,
        occurredAt,
        kind: 'transfer_in',
        primary: { tokenIdentity: TON_NATIVE_IDENTITY, quantity: qty.toString() },
      });
    }

    const outMsgs = tx.out_msgs ?? [];
    for (let i = 0; i < outMsgs.length; i++) {
      const out = outMsgs[i];
      if (!out || !this.isNonZero(out.value)) continue;
      const qty = new Decimal(out.value).div(NANOTONS_PER_TON).neg();
      events.push({
        externalId: `${lt}-${hash}-${i + 1}`,
        occurredAt,
        kind: 'transfer_out',
        primary: { tokenIdentity: TON_NATIVE_IDENTITY, quantity: qty.toString() },
      });
    }

    return events;
  }

  private isNonZero(value: string | undefined): boolean {
    if (value === undefined || value === '' || value === '0') return false;
    return !new Decimal(value).isZero();
  }

  private requestInit(): RequestInit | undefined {
    if (!this.apiKey) return undefined;
    return { headers: { 'X-API-Key': this.apiKey } };
  }
}

export const tonFactory: ProviderFactory = async (deps) => {
  const apiKey = deps.env.TON_API_KEY;
  // Toncenter free tier: 1 req/s anonymous; ~10 req/s with an API key.
  const maxRequests = apiKey ? 10 : 1;
  const limiter = createOutflowLimiter({
    maxRequests,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'ton',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'ton',
    limiter,
    registeredFrom: 'providers/ton',
    description: apiKey ? 'Toncenter: 10 req / 1s (keyed)' : 'Toncenter: 1 req / 1s (anonymous)',
  });
  return new TonProvider(
    registered,
    deps.env.TON_API_URL ?? 'https://toncenter.com/api/v2',
    apiKey
  );
};
