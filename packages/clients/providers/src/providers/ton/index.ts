/**
 * `TonProvider` — balance + transaction fetching for The Open Network
 * via the public Toncenter indexed API v3
 * (docs.ton.org/ecosystem/api/toncenter/v3/overview, SC-1580).
 *
 * Capabilities:
 *  - `current-balances`: native TON via `/accountStates`. Jetton
 *    (TRC20-equivalent) balances are out of scope.
 *  - `transactions`: native TON inflows/outflows via `/transactions`.
 *    Jettons are out of scope: they arrive as smart-contract calls with
 *    0-value messages, and those rows are skipped here.
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
import { PageCapWatch } from '../../core/utils/page-cap';
import { WALLET_HISTORY_ROW_CAP } from '../../core/wallet-limits';

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
  source?: string | null;
  destination?: string | null;
  value?: string | null;
}

interface ToncenterTx {
  hash: string;
  lt: string;
  now: number;
  in_msg?: ToncenterMessage | null;
  out_msgs?: ToncenterMessage[];
}

interface ToncenterTransactionsResponse {
  transactions?: ToncenterTx[];
}

interface ToncenterAccountStatesResponse {
  accounts?: Array<{ balance?: string; status?: string }>;
}

/**
 * Structural TON address check. Pure and offline; the chain-stub
 * provider reuses it so a stubbed boot answers address shape exactly
 * as the live one does.
 */
export function isTonAddress(address: string): boolean {
  if (/^[EUk0]Q[A-Za-z0-9_-]{46}$/.test(address)) return true;
  if (/^-?[0-9]:[a-fA-F0-9]{64}$/.test(address)) return true;
  return false;
}

/**
 * The account an address names, as `<workchain>:<hex>` lowercase. v3 reports
 * every address raw, while a user saves the bounceable (`EQ…`) or
 * non-bounceable (`UQ…`) form of the same account, so addresses are compared
 * on this and never as strings.
 */
function accountOf(address: string): string {
  const raw = /^(-?[0-9]):([a-fA-F0-9]{64})$/.exec(address);
  if (raw) return `${raw[1]}:${raw[2]?.toLowerCase()}`;
  const bytes = Buffer.from(address, 'base64url');
  const workchain = bytes.readInt8(1);
  return `${workchain}:${bytes.subarray(2, 34).toString('hex')}`;
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
    return isTonAddress(address);
  }

  /**
   * Activity probe — `/accountStates` returns the account's status. An
   * address that never received TON is `nonexist`, one funded but never
   * deployed is `uninit`; activity is anything else.
   */
  async hasActivity(
    address: string,
    _institutionCode: string,
    _ctx: ProviderContext
  ): Promise<boolean> {
    if (!this.isValidAddress(address)) return false;
    const { status } = await this.accountState(address);
    if (status === undefined) throw new Error('toncenter: accountStates returned no status');
    return status !== 'nonexist' && status !== 'uninit';
  }

  private async accountState(address: string): Promise<{ balance?: string; status?: string }> {
    const params = new URLSearchParams({ address, include_boc: 'false' });
    const url = `${this.apiUrl}/accountStates?${params.toString()}`;
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(url, this.requestInit())
    );
    if (!response.ok) throw new Error(`toncenter: HTTP ${response.status} for accountStates`);
    const data = (await response.json()) as ToncenterAccountStatesResponse;
    if (!data.accounts) throw new Error('toncenter: accountStates returned no list');
    // v3 lists no row at all for an address the chain has never seen.
    return data.accounts[0] ?? { balance: '0', status: 'nonexist' };
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const address =
      (creds.walletAddress as string | undefined) ?? (creds.address as string | undefined);
    if (!address || !this.isValidAddress(address)) return [];

    const state = await this.accountState(address);
    if (state.balance === undefined)
      throw new Error('toncenter: accountStates returned no balance');

    const ton = new Decimal(state.balance).div(NANOTONS_PER_TON);
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
    const capped = new PageCapWatch();
    let pages = 0;
    const wallet = accountOf(address);
    let endLt: bigint | null = null;
    while (true) {
      const params = new URLSearchParams({
        account: address,
        limit: String(TX_PAGE_LIMIT),
        sort: 'desc',
      });
      if (endLt !== null) params.set('end_lt', endLt.toString());
      const url = `${this.apiUrl}/transactions?${params.toString()}`;
      const response = await this.limiter.execute(async () =>
        fetchWithTimeout(url, this.requestInit())
      );
      if (!response.ok) {
        throw new Error(`Toncenter: HTTP ${response.status} for ${address}`);
      }
      const data = (await response.json()) as ToncenterTransactionsResponse;
      if (!data.transactions) throw new Error('toncenter: transactions returned no list');
      const txs = data.transactions;
      for (const tx of txs) {
        for (const event of this.toTransactionEvents(tx, wallet)) {
          events.push(event);
        }
      }
      pages += 1;
      if (txs.length < TX_PAGE_LIMIT) break;
      // The address is the requester's choice, so its size is too (SC-1271).
      if (events.length >= WALLET_HISTORY_ROW_CAP) {
        capped.note({ walk: { kind: 'addressHistory' }, pages, rows: events.length });
        break;
      }
      const last = txs[txs.length - 1];
      if (!last) break;
      // An account's transactions have distinct lt, so the next page is
      // everything strictly older than the last row.
      endLt = BigInt(last.lt) - 1n;
    }

    capped.retract(ctx, this.providerKey);
    return events.filter((e) => {
      if (ctx.since && e.occurredAt < ctx.since) return false;
      if (ctx.until && e.occurredAt > ctx.until) return false;
      return true;
    });
  }

  private toTransactionEvents(tx: ToncenterTx, wallet: string): TransactionEvent[] {
    const events: TransactionEvent[] = [];
    const occurredAt = new Date(tx.now * 1000);
    const { lt, hash } = tx;

    // Position-based legIndex keeps externalId stable regardless of
    // which legs we end up emitting after the 0-value filter:
    //   leg 0 → in_msg
    //   leg 1+i → out_msgs[i]
    const inMsg = tx.in_msg;
    if (
      inMsg?.destination &&
      accountOf(inMsg.destination) === wallet &&
      inMsg.value &&
      this.isNonZero(inMsg.value)
    ) {
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
      if (!out?.value || !this.isNonZero(out.value)) continue;
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

  private isNonZero(value: string): boolean {
    if (value === '' || value === '0') return false;
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
    deps.env.TON_API_URL ?? 'https://toncenter.com/api/v3',
    apiKey
  );
};
