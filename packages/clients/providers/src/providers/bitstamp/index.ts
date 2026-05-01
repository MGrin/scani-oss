import crypto from 'node:crypto';
import type { NewToken } from '@scani/db/schema';
import { createOutflowLimiter } from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import {
  type ApiKeyCreds,
  BaseHmacCexProvider,
  type SignedRequest,
} from '../../core/base/base-hmac-cex-provider';
import type { ProviderFactory } from '../../core/boot';
import type {
  BalanceProvider,
  Capability,
  CredentialValidator,
  TransactionsProvider,
} from '../../core/capabilities';
import { ProviderError } from '../../core/errors';
import type {
  DecryptedCredentials,
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { enforceSign, inferCounterSign, negateFee } from '../../core/utils/enforce-tx-sign';
import { bitstampManifest } from './manifest';
import { resolvePair, resolveSingleAsset } from './pair-resolver';

export { bitstampManifest } from './manifest';

const BITSTAMP_INSTITUTION_CODE = 'bitstamp';
const BITSTAMP_HOST = 'www.bitstamp.net';

const USER_TX_PAGE_SIZE = 1000;
const CRYPTO_TX_PAGE_SIZE = 1000;
const MAX_PAGES = 200;

interface BitstampUserTransactionRow {
  id: number | string;
  datetime: string;
  type: string;
  fee?: string;
  order_id?: number | string;
  [key: string]: unknown;
}

interface BitstampCryptoTransactionRow {
  currency: string;
  datetime?: string;
  amount: string;
  txid?: string;
  destinationAddress?: string;
}

interface BitstampCryptoTransactionsResponse {
  deposits?: BitstampCryptoTransactionRow[];
  withdrawals?: BitstampCryptoTransactionRow[];
}

function tokenIdentity(currency: string): Partial<NewToken> {
  const symbol = currency.toUpperCase();
  return {
    symbol,
    name: symbol,
    providerMetadata: { bitstamp: { currency } },
  };
}

// Bitstamp datetimes are ISO-ish with a space separator and microseconds,
// always UTC. `Date.parse` accepts the comma-free variant once we swap
// the space for a `T` and append `Z`.
function parseBitstampDatetime(value: string): Date {
  const trimmed = value.trim().replace(' ', 'T');
  const ms = Date.parse(trimmed.endsWith('Z') ? trimmed : `${trimmed}Z`);
  return new Date(Number.isFinite(ms) ? ms : 0);
}

export function userTransactionToEvent(row: BitstampUserTransactionRow): TransactionEvent | null {
  const occurredAt = parseBitstampDatetime(row.datetime);
  const externalId = `user-tx:${row.id}`;
  const rawType = String(row.type);

  if (rawType === '0' || rawType === '1') {
    const asset = resolveSingleAsset(row);
    if (!asset) return null;
    const rawAmount = row[asset];
    if (typeof rawAmount !== 'string' && typeof rawAmount !== 'number') return null;
    const kind = rawType === '0' ? 'deposit' : 'withdraw';
    return {
      externalId,
      occurredAt,
      kind,
      primary: {
        tokenIdentity: tokenIdentity(asset),
        quantity: enforceSign(String(rawAmount), kind),
      },
      rawPayload: row,
    };
  }

  if (rawType === '2') {
    const pair = resolvePair(row);
    if (!pair) return null;
    const baseRaw = row[pair.base];
    const quoteRaw = row[pair.quote];
    const priceRaw = row[pair.priceKey];
    if (typeof baseRaw !== 'string' && typeof baseRaw !== 'number') return null;
    if (typeof quoteRaw !== 'string' && typeof quoteRaw !== 'number') return null;

    const baseDec = new Decimal(String(baseRaw));
    const kind = baseDec.isNegative() ? 'sell' : 'buy';
    const primaryQty = enforceSign(String(baseRaw), kind);
    const counterQty = inferCounterSign(primaryQty, String(quoteRaw));

    const event: TransactionEvent = {
      externalId,
      occurredAt,
      kind,
      primary: {
        tokenIdentity: tokenIdentity(pair.base),
        quantity: primaryQty,
      },
      counter: {
        tokenIdentity: tokenIdentity(pair.quote),
        quantity: counterQty,
      },
      rawPayload: row,
    };

    if (typeof priceRaw === 'string' || typeof priceRaw === 'number') {
      const priceDec = new Decimal(String(priceRaw));
      if (priceDec.gt(0)) {
        event.priceNative = {
          value: priceDec.toString(),
          quoteIdentity: tokenIdentity(pair.quote),
        };
      }
    }

    if (row.fee !== undefined && row.fee !== null) {
      const feeDec = new Decimal(String(row.fee));
      if (feeDec.gt(0)) {
        event.fee = {
          tokenIdentity: tokenIdentity(pair.quote),
          quantity: negateFee(String(row.fee)),
        };
      }
    }
    return event;
  }

  if (rawType === '14') {
    const asset = resolveSingleAsset(row);
    if (!asset) return null;
    const rawAmount = row[asset];
    if (typeof rawAmount !== 'string' && typeof rawAmount !== 'number') return null;
    const amountDec = new Decimal(String(rawAmount));
    if (amountDec.isZero()) return null;
    const kind = amountDec.isNegative() ? 'transfer_out' : 'transfer_in';
    return {
      externalId,
      occurredAt,
      kind,
      primary: {
        tokenIdentity: tokenIdentity(asset),
        quantity: amountDec.toString(),
      },
      rawPayload: row,
    };
  }

  return null;
}

export class BitstampProvider
  extends BaseHmacCexProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator
{
  readonly providerKey = 'bitstamp';
  readonly manifest = bitstampManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
  ];
  protected readonly baseUrl = `https://${BITSTAMP_HOST}`;

  // Bitstamp's pre-sign string is unusually long: includes host, content
  // type, nonce (UUID), timestamp (ms), version, body in a fixed order.
  protected signRequest(req: SignedRequest, creds: ApiKeyCreds): Record<string, string> {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const contentType = req.method === 'POST' ? 'application/x-www-form-urlencoded' : '';
    const version = 'v2';
    const queryString = req.query ?? '';
    const preSign = `BITSTAMP ${creds.apiKey}${req.method}${BITSTAMP_HOST}${req.url}${queryString}${contentType}${nonce}${timestamp}${version}${req.body ?? ''}`;
    const signature = crypto.createHmac('sha256', creds.apiSecret).update(preSign).digest('hex');
    const headers: Record<string, string> = {
      'X-Auth': `BITSTAMP ${creds.apiKey}`,
      'X-Auth-Signature': signature,
      'X-Auth-Nonce': nonce,
      'X-Auth-Timestamp': timestamp,
      'X-Auth-Version': version,
    };
    if (contentType) headers['Content-Type'] = contentType;
    return headers;
  }

  canFetchBalances(c: string): boolean {
    return c === BITSTAMP_INSTITUTION_CODE;
  }

  canFetchTransactions(c: string): boolean {
    return c === BITSTAMP_INSTITUTION_CODE;
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const data = await this.signedJson<Record<string, string>>(
      { method: 'POST', url: '/api/v2/balance/' },
      creds
    );

    const balanceRegex = /^([a-z0-9]+)_balance$/;
    const out: HoldingSnapshot[] = [];
    for (const [key, value] of Object.entries(data)) {
      const match = key.match(balanceRegex);
      if (!match?.[1] || typeof value !== 'string') continue;
      const amount = new Decimal(value || '0');
      if (amount.lte(0)) continue;
      const currency = match[1].toUpperCase();
      const identity: Partial<NewToken> = {
        symbol: currency,
        name: currency,
        providerMetadata: { bitstamp: { currency: match[1] } },
      };
      out.push({
        externalId: currency,
        tokenIdentity: identity,
        balance: amount.toString(),
        capturedAt: new Date(),
      });
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
    const creds = await this.resolveApiCreds(ctx);
    if (!creds) return [];

    const events: TransactionEvent[] = [];
    const seen = new Set<string>();
    const push = (event: TransactionEvent | null): void => {
      if (!event) return;
      if (seen.has(event.externalId)) return;
      seen.add(event.externalId);
      events.push(event);
    };

    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(USER_TX_PAGE_SIZE),
        sort: 'asc',
      });
      const body = params.toString();
      const rows = await this.signedJson<BitstampUserTransactionRow[]>(
        { method: 'POST', url: '/api/v2/user_transactions/', body },
        creds
      );
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) push(userTransactionToEvent(row));
      if (rows.length < USER_TX_PAGE_SIZE) break;
      offset += rows.length;
    }

    const cryptoTxByMatch = await this.collectCryptoTxIds(creds);
    if (cryptoTxByMatch.size > 0) {
      for (const event of events) {
        if (event.kind !== 'deposit' && event.kind !== 'withdraw') continue;
        const symbol = event.primary.tokenIdentity.symbol;
        if (!symbol) continue;
        const matchKey = `${symbol}|${event.occurredAt.getTime()}`;
        const txid = cryptoTxByMatch.get(matchKey);
        if (txid) {
          event.rawPayload = { ...(event.rawPayload as object), txid };
        }
      }
    }

    return events;
  }

  /**
   * Walk `/crypto-transactions/` and build a `${SYMBOL}|${ms}` → txid
   * lookup. Used to enrich user_transactions deposit/withdraw events
   * with the on-chain hash, which user_transactions itself does not
   * surface.
   */
  private async collectCryptoTxIds(creds: ApiKeyCreds): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({
        offset: String(offset),
        limit: String(CRYPTO_TX_PAGE_SIZE),
      });
      const body = params.toString();
      const data = await this.signedJson<BitstampCryptoTransactionsResponse>(
        { method: 'POST', url: '/api/v2/crypto-transactions/', body },
        creds
      ).catch(() => ({}) as BitstampCryptoTransactionsResponse);
      const all = [...(data.deposits ?? []), ...(data.withdrawals ?? [])];
      if (all.length === 0) break;
      for (const tx of all) {
        if (!tx.txid || !tx.currency || !tx.datetime) continue;
        const ms = parseBitstampDatetime(tx.datetime).getTime();
        out.set(`${tx.currency.toUpperCase()}|${ms}`, tx.txid);
      }
      if (all.length < CRYPTO_TX_PAGE_SIZE) break;
      offset += all.length;
    }
    return out;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== BITSTAMP_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const apiKey = creds.apiKey as string | undefined;
    const apiSecret = creds.apiSecret as string | undefined;
    if (!apiKey || !apiSecret) return { valid: false, message: 'apiKey + apiSecret required' };
    try {
      await this.signedFetch({ method: 'POST', url: '/api/v2/balance/' }, { apiKey, apiSecret });
      return { valid: true };
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'auth-failed') {
        return { valid: false, message: err.message };
      }
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const bitstampFactory: ProviderFactory = async (deps) => {
  const limiter = createOutflowLimiter({
    maxRequests: 5,
    windowMs: 1000,
    redis: deps.redis ?? undefined,
    namespace: 'bitstamp-private',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'bitstamp-private',
    limiter,
    registeredFrom: 'providers/bitstamp',
    description: 'Bitstamp v2: 5 req / 1s per API key',
  });
  return new BitstampProvider(registered);
};
