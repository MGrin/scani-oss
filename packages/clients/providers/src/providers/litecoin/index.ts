import type { NewToken } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import { isLitecoinAddress, normalizeLitecoinAddress } from '@scani/shared/validators/litecoin';
import Decimal from 'decimal.js';
import { z } from 'zod';
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
  TransactionFetchContext,
  WithUserCreds,
} from '../../core/types';
import { fetchWithTimeout } from '../../core/utils/fetch';
import { PageCapWatch } from '../../core/utils/page-cap';
import { WALLET_HISTORY_ROW_CAP } from '../../core/wallet-limits';

export { isLitecoinAddress } from '@scani/shared/validators/litecoin';

const INSTITUTION_CODE = 'litecoin';
const BASE_URL = 'https://litecoinspace.org/api';
const LITOSHI_PER_LTC = 100_000_000;
const PAGE_SIZE = 25;
const BLOCK_TIME_SKEW_MS = 2 * 60 * 60 * 1000;

const count = z.number().int().nonnegative().safe();
const statsSchema = z.object({
  funded_txo_sum: count,
  spent_txo_sum: count,
  tx_count: count,
});
const addressSchema = z.object({ chain_stats: statsSchema, mempool_stats: statsSchema });
const outputSchema = z.object({ scriptpubkey_address: z.string().optional(), value: count });
const transactionSchema = z.object({
  txid: z.string().min(1),
  vin: z.array(z.object({ prevout: outputSchema.nullable().optional() })),
  vout: z.array(outputSchema),
  status: z
    .object({ confirmed: z.boolean(), block_time: count.optional() })
    .refine(
      (status) => !status.confirmed || status.block_time !== undefined,
      'Confirmed transaction is missing its block time'
    ),
});
const transactionsSchema = z.array(transactionSchema).max(PAGE_SIZE);
type LitecoinTransaction = z.infer<typeof transactionSchema>;

export class LitecoinProvider
  implements BalanceProvider, TransactionsProvider, AddressValidatorProvider
{
  readonly providerKey = INSTITUTION_CODE;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'address-validator',
  ];

  private readonly logger: CustomLogger;

  constructor(private readonly limiter: OutflowRateLimiter) {
    this.logger = createComponentLogger('provider:litecoin');
  }

  canFetchBalances(code: string): boolean {
    return code === INSTITUTION_CODE;
  }

  canFetchTransactions(code: string): boolean {
    return code === INSTITUTION_CODE;
  }

  canValidate(code: string): boolean {
    return code === INSTITUTION_CODE;
  }

  isValidAddress(address: string): boolean {
    return isLitecoinAddress(address);
  }

  async hasActivity(address: string, _code: string, _ctx: ProviderContext): Promise<boolean> {
    const normalized = normalizeLitecoinAddress(address);
    if (!normalized) return false;
    const data = await this.fetchJson(
      `${BASE_URL}/address/${encodeURIComponent(normalized)}`,
      addressSchema
    );
    return data.chain_stats.tx_count + data.mempool_stats.tx_count > 0;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const address = await this.addressFromContext(ctx);
    if (!address) return [];
    const data = await this.fetchJson(
      `${BASE_URL}/address/${encodeURIComponent(address)}`,
      addressSchema
    );
    const balance = new Decimal(data.chain_stats.funded_txo_sum)
      .minus(data.chain_stats.spent_txo_sum)
      .plus(data.mempool_stats.funded_txo_sum)
      .minus(data.mempool_stats.spent_txo_sum)
      .div(LITOSHI_PER_LTC);
    if (balance.isZero()) return [];
    return [
      {
        externalId: 'native',
        tokenIdentity: { symbol: 'LTC', name: 'Litecoin', decimals: 8, providerMetadata: {} },
        balance: balance.toString(),
        capturedAt: new Date(),
      },
    ];
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const address = await this.addressFromContext(ctx);
    if (!address) return [];

    const events: TransactionEvent[] = [];
    const capped = new PageCapWatch();
    let afterTxid: string | null = null;
    let pages = 0;
    let rows = 0;
    const seenTxids = new Set<string>();
    while (true) {
      const cursor: string = afterTxid ? `/${encodeURIComponent(afterTxid)}` : '';
      const txs: LitecoinTransaction[] = await this.fetchJson(
        `${BASE_URL}/address/${encodeURIComponent(address)}/txs/chain${cursor}`,
        transactionsSchema
      );
      if (txs.length === 0) break;
      pages++;
      rows += txs.length;

      const seenBeforePage = seenTxids.size;
      const pageEvents = txs.flatMap((tx) => {
        if (seenTxids.has(tx.txid)) return [];
        seenTxids.add(tx.txid);
        const event = this.toTransactionEvent(tx, address);
        return event ? [event] : [];
      });
      if (seenTxids.size === seenBeforePage) {
        throw new Error('Litecoin Space: transaction history cursor did not advance');
      }
      events.push(...pageEvents);

      if (ctx.since) {
        const pageTimes = txs
          .map((tx) => tx.status?.block_time)
          .filter((time): time is number => typeof time === 'number');
        if (
          pageTimes.length > 0 &&
          Math.min(...pageTimes) * 1000 < ctx.since.getTime() - BLOCK_TIME_SKEW_MS
        ) {
          break;
        }
      }

      if (txs.length < PAGE_SIZE) break;
      const nextTxid = txs[txs.length - 1]?.txid ?? null;
      if (!nextTxid || nextTxid === afterTxid) {
        throw new Error('Litecoin Space: transaction history cursor did not advance');
      }
      if (rows >= WALLET_HISTORY_ROW_CAP) {
        capped.note({ walk: { kind: 'addressHistory' }, pages, rows });
        break;
      }
      afterTxid = nextTxid;
    }

    capped.retract(ctx, this.providerKey);
    return events.filter((event) => {
      if (ctx.since && event.occurredAt < ctx.since) return false;
      if (ctx.until && event.occurredAt > ctx.until) return false;
      return true;
    });
  }

  private async addressFromContext(ctx: WithUserCreds<ProviderContext>): Promise<string | null> {
    const credentials = await ctx.resolveCredentials(ctx.credentialsRef);
    const address = credentials.walletAddress ?? credentials.address;
    const normalized = typeof address === 'string' ? normalizeLitecoinAddress(address) : null;
    if (normalized) return normalized;
    this.logger.warn(
      { providerKey: this.providerKey, hasAddress: typeof address === 'string' },
      'Litecoin wallet request: invalid or missing address'
    );
    return null;
  }

  private async fetchJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.limiter.execute(async () => fetchWithTimeout(url));
    if (!response.ok) throw new Error(`Litecoin Space: HTTP ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Litecoin Space: invalid API response');
    return parsed.data;
  }

  private toTransactionEvent(tx: LitecoinTransaction, wallet: string): TransactionEvent | null {
    if (!tx.status?.confirmed || typeof tx.status.block_time !== 'number') return null;
    let inflow = new Decimal(0);
    let outflow = new Decimal(0);
    for (const output of tx.vout ?? []) {
      if (output.scriptpubkey_address === wallet) inflow = inflow.plus(output.value);
    }
    for (const input of tx.vin ?? []) {
      if (input.prevout?.scriptpubkey_address === wallet) {
        outflow = outflow.plus(input.prevout.value ?? 0);
      }
    }
    const quantity = inflow.minus(outflow).div(LITOSHI_PER_LTC);
    if (quantity.isZero()) return null;
    const tokenIdentity: Partial<NewToken> = { symbol: 'LTC', name: 'Litecoin', decimals: 8 };
    return {
      externalId: tx.txid,
      occurredAt: new Date(tx.status.block_time * 1000),
      kind: quantity.gt(0) ? 'transfer_in' : 'transfer_out',
      primary: { tokenIdentity, quantity: quantity.toString() },
    };
  }
}

export const litecoinFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: INSTITUTION_CODE,
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: INSTITUTION_CODE,
    limiter,
    registeredFrom: 'providers/litecoin',
    description: 'Litecoin Space: 1 req / 1s',
  });
  return new LitecoinProvider(registered);
};
