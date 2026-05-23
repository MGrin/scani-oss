/**
 * `IbkrProvider` — Interactive Brokers via Flex Query API.
 *
 * Two-step flow per Flex Web Service v3 docs:
 *   1. GET `.../AccountManagement/FlexWebService/SendRequest?t=<token>&q=<queryId>&v=3`
 *      → returns `<ReferenceCode>...</ReferenceCode>`.
 *   2. GET `.../AccountManagement/FlexWebService/GetStatement?t=<token>&q=<refCode>&v=3`
 *      → returns the XML statement (positions + cash balances + trades + cash txs).
 *
 * The legacy `Universal/servlet/FlexStatementService.{SendRequest,GetStatement}`
 * endpoints over POST silently fast-fail with a 1001 ("Statement could not
 * be generated") even on perfectly valid token+query pairs whose templates
 * succeed when run interactively in Account Management. Use the v3 path
 * with GET parameters; SendRequest's response carries the GetStatement URL
 * IBKR wants us to hit (typically `gdcdyn`).
 *
 * Error code map:
 *   - 1010, 1012  → auth-failed
 *   - 1018        → rate-limited
 *   - 1001, 1019  → "still generating" — poll loop with delay
 *
 * Uses regex-based XML parsing (Flex Query XML is well-structured and a
 * full parser is overkill for the limited subset of nodes we extract).
 */

import type { NewToken } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import {
  createOutflowLimiter,
  credentialBucketKey,
  type OutflowRateLimiter,
} from '@scani/rate-limiter';
import Decimal from 'decimal.js';
import type { ProviderFactory } from '../../core/boot';
import type {
  AccountDiscoveryProvider,
  BalanceProvider,
  Capability,
  CredentialValidator,
  TransactionsProvider,
} from '../../core/capabilities';
import type {
  DecryptedCredentials,
  DiscoveredAccount,
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../../core/types';
import { enforceSign, inferCounterSign, negateFee } from '../../core/utils/enforce-tx-sign';
import { fetchWithTimeout } from '../../core/utils/fetch';
import { ibkrManifest } from './manifest';

export { ibkrManifest } from './manifest';

const IBKR_INSTITUTION_CODE = 'ibkr';
const FLEX_SEND_URL =
  'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest';
// Default fallback if SendRequest's response doesn't include a <Url>; in
// practice IBKR always returns one, pointing at gdcdyn.
const FLEX_GET_URL_DEFAULT =
  'https://gdcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement';
// SendRequest just enqueues the report on IBKR's side; 1001 here is the
// "previous request still in queue" hiccup and clears in tens of seconds.
const MAX_SEND_RETRIES = 6;
const SEND_DELAY_MS = 8_000;
// GetStatement is the actual report-ready poll. On heavy Flex Query
// templates (long date range, all sections) IBKR can keep returning 1001
// for several minutes before the XML is generated. Budget ~5 minutes of
// patience here — BullMQ's default 30s lockDuration is auto-extended at
// lockDuration/2 while the handler is alive, so a multi-minute poll
// won't trigger stalled-job recovery.
const MAX_FETCH_RETRIES = 24;
const FETCH_DELAY_MS = 12_000;
// IBKR Flex Web Service serializes generation per token. A SendRequest
// can hang for tens of seconds if the previous one hasn't cleared
// server-side. 60s gives the call time to ride out the slow path
// without timing out from our side.
const FLEX_REQUEST_TIMEOUT_MS = 60_000;
const logger = createComponentLogger('provider:ibkr');
// IBKR returns these "report not ready yet" error codes during the
// generation window. Both want the same retry-with-delay treatment;
// difference is purely semantic (1019 = generation in progress, 1001 =
// generation hasn't yielded a statement yet).
const TRANSIENT_GENERATION_ERROR_CODES = new Set(['1001', '1019']);

// IBKR `<Trade>` rows cover stocks, ETFs, options, futures, forex, bonds.
// We map only equities for now; derivatives need cost-basis logic we
// don't implement yet (see README "Asset class diversity" note).
const SUPPORTED_TRADE_CATEGORIES = new Set(['STK', 'ETF']);

// IBKR's `listingExchange` field uses venue codes (TSE, NASDAQ, …).
// Yahoo/Finnhub-style symbols use suffixes (.TO, .L, …) and the
// pricing router keys non-US routing on a Finnhub-shaped
// `providerMetadata.exchangeInfo`. This table maps the IBKR venue to
// (Finnhub suffix, exchange display name, native currency) so a
// Toronto-listed XEQT becomes `XEQT.TO` for finnhub.symbol with
// exchangeInfo `{ exchange: 'TSX', currency: 'CAD' }` — that combo
// flips PricingProviderRouter to Google Sheets and the GOOGLEFINANCE
// formula renders `TSE:XEQT`. US venues stay null/null/USD so
// Finnhub free-tier prices them directly.
const IBKR_LISTING_EXCHANGE_TO_FINNHUB: Record<
  string,
  { suffix: string | null; exchange: string | null; currency: string }
> = {
  NASDAQ: { suffix: null, exchange: null, currency: 'USD' },
  NYSE: { suffix: null, exchange: null, currency: 'USD' },
  ARCA: { suffix: null, exchange: null, currency: 'USD' },
  AMEX: { suffix: null, exchange: null, currency: 'USD' },
  BATS: { suffix: null, exchange: null, currency: 'USD' },
  TSE: { suffix: '.TO', exchange: 'TSX', currency: 'CAD' },
  TSX: { suffix: '.TO', exchange: 'TSX', currency: 'CAD' },
  LSE: { suffix: '.L', exchange: 'LSE', currency: 'GBP' },
  LSEETF: { suffix: '.L', exchange: 'LSE', currency: 'GBP' },
  ASX: { suffix: '.AX', exchange: 'ASX', currency: 'AUD' },
};

interface OpenPosition {
  symbol: string;
  description: string;
  position: string;
  currency: string;
  assetCategory: string;
  listingExchange: string;
}
interface CashBalance {
  currency: string;
  endingCash: string;
}

interface TradeRow {
  tradeID: string;
  dateTime: string;
  symbol: string;
  description: string;
  conid: string;
  listingExchange: string;
  assetCategory: string;
  isin: string;
  currency: string;
  buySell: string;
  quantity: string;
  tradePrice: string;
  tradeMoney: string;
  ibCommission: string;
  ibCommissionCurrency: string;
}

interface CashTransactionRow {
  type: string;
  amount: string;
  currency: string;
  dateTime: string;
  description: string;
  accountId: string;
  tradeID: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Best-effort status sink — a flaky reporter (Redis publish failure,
// processor disconnect) must never cancel the IBKR poll mid-flight.
async function reportStatus(
  onStatus: ((message: string) => void | Promise<void>) | undefined,
  message: string
): Promise<void> {
  if (!onStatus) return;
  try {
    await onStatus(message);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), message },
      'onStatus sink threw — ignoring'
    );
  }
}

function extractAttr(attrs: string, name: string): string {
  const regex = new RegExp(`${name}="([^"]*)"`, 'i');
  return attrs.match(regex)?.[1] ?? '';
}

/**
 * Parse IBKR's `YYYYMMDD;HHMMSS` (or `YYYYMMDDHHMMSS`) timestamp format.
 * IBKR reports times in the user's account timezone — for now we treat
 * them as UTC; the import flow can adjust if account TZ becomes a thing
 * we expose.
 */
function parseFlexDateTime(s: string): Date {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})[;\s]?(\d{2})(\d{2})(\d{2})$/);
  if (!m) return new Date(Number.NaN);
  const [, y, mo, d, h, mi, se] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se))
  );
}

function parsePositions(xml: string): OpenPosition[] {
  const out: OpenPosition[] = [];
  for (const match of xml.matchAll(/<OpenPosition\s+([^>]*)\/?>/g)) {
    const attrs = match[1] ?? '';
    const qty = Number.parseFloat(extractAttr(attrs, 'position'));
    if (!Number.isFinite(qty) || qty === 0) continue;
    out.push({
      symbol: extractAttr(attrs, 'symbol'),
      description: extractAttr(attrs, 'description'),
      position: extractAttr(attrs, 'position'),
      currency: extractAttr(attrs, 'currency'),
      assetCategory: extractAttr(attrs, 'assetCategory'),
      listingExchange: extractAttr(attrs, 'listingExchange'),
    });
  }
  return out;
}

function parseCashBalances(xml: string): CashBalance[] {
  const out: CashBalance[] = [];
  for (const match of xml.matchAll(/<CashReportCurrency\s+([^>]*)\/?>/g)) {
    const attrs = match[1] ?? '';
    const currency = extractAttr(attrs, 'currency');
    if (currency === 'BASE_SUMMARY') continue;
    let endingCash = extractAttr(attrs, 'endingCash');
    if (!endingCash) endingCash = extractAttr(attrs, 'endingSettledCash');
    const cash = Number.parseFloat(endingCash);
    if (!Number.isFinite(cash) || cash === 0) continue;
    out.push({ currency, endingCash });
  }
  return out;
}

function parseTrades(xml: string): TradeRow[] {
  const out: TradeRow[] = [];
  for (const match of xml.matchAll(/<Trade\s+([^>]*)\/?>/g)) {
    const attrs = match[1] ?? '';
    out.push({
      tradeID: extractAttr(attrs, 'tradeID'),
      dateTime: extractAttr(attrs, 'dateTime'),
      symbol: extractAttr(attrs, 'symbol'),
      description: extractAttr(attrs, 'description'),
      conid: extractAttr(attrs, 'conid'),
      listingExchange: extractAttr(attrs, 'listingExchange'),
      assetCategory: extractAttr(attrs, 'assetCategory'),
      isin: extractAttr(attrs, 'isin'),
      currency: extractAttr(attrs, 'currency'),
      buySell: extractAttr(attrs, 'buySell'),
      quantity: extractAttr(attrs, 'quantity'),
      tradePrice: extractAttr(attrs, 'tradePrice'),
      tradeMoney: extractAttr(attrs, 'tradeMoney'),
      ibCommission: extractAttr(attrs, 'ibCommission'),
      ibCommissionCurrency: extractAttr(attrs, 'ibCommissionCurrency'),
    });
  }
  return out;
}

function parseCashTransactions(xml: string): CashTransactionRow[] {
  const out: CashTransactionRow[] = [];
  for (const match of xml.matchAll(/<CashTransaction\s+([^>]*)\/?>/g)) {
    const attrs = match[1] ?? '';
    out.push({
      type: extractAttr(attrs, 'type'),
      amount: extractAttr(attrs, 'amount'),
      currency: extractAttr(attrs, 'currency'),
      dateTime: extractAttr(attrs, 'dateTime'),
      description: extractAttr(attrs, 'description'),
      accountId: extractAttr(attrs, 'accountId'),
      tradeID: extractAttr(attrs, 'tradeID'),
    });
  }
  return out;
}

type CashKind = 'reward' | 'interest' | 'fee' | 'deposit' | 'withdraw';

function classifyCashType(type: string, amount: string): CashKind | null {
  switch (type) {
    case 'Dividends':
      return 'reward';
    case 'Broker Interest Received':
      return 'interest';
    case 'Broker Interest Paid':
    case 'Withholding Tax':
    case 'Other Fees':
    case 'Commission Adjustments':
      return 'fee';
    case 'Deposits':
      return 'deposit';
    case 'Withdrawals':
      return 'withdraw';
    case 'Deposits/Withdrawals': {
      // IBKR sometimes collapses both directions under one type and
      // disambiguates by sign on `amount`.
      const a = new Decimal(amount || '0');
      return a.isNegative() ? 'withdraw' : 'deposit';
    }
    default:
      return null;
  }
}

function buildEquityIdentity(t: TradeRow): Partial<NewToken> {
  return {
    symbol: t.symbol.toUpperCase(),
    name: t.description || t.symbol,
    marketSegment: mapListingExchangeToSegment(t.listingExchange),
    providerMetadata: {
      ibkr: {
        symbol: t.symbol,
        ...(t.conid ? { conid: t.conid } : {}),
        ...(t.assetCategory ? { assetCategory: t.assetCategory } : {}),
        ...(t.listingExchange ? { listingExchange: t.listingExchange } : {}),
        ...(t.isin ? { isin: t.isin } : {}),
      },
    },
  };
}

function buildCurrencyIdentity(currency: string): Partial<NewToken> {
  return {
    symbol: currency.toUpperCase(),
    name: currency,
    providerMetadata: { ibkr: { currency } },
  };
}

function tradeToEvent(t: TradeRow): TransactionEvent | null {
  if (!t.tradeID || !t.symbol) return null;
  if (t.assetCategory && !SUPPORTED_TRADE_CATEGORIES.has(t.assetCategory)) return null;

  const buySell = t.buySell.toUpperCase();
  const kind: 'buy' | 'sell' | null =
    buySell === 'BUY' ? 'buy' : buySell === 'SELL' ? 'sell' : null;
  if (!kind) return null;

  const primaryQty = enforceSign(t.quantity || '0', kind);
  const counterQty = inferCounterSign(primaryQty, t.tradeMoney || '0');

  const event: TransactionEvent = {
    externalId: t.tradeID,
    occurredAt: parseFlexDateTime(t.dateTime),
    kind,
    primary: {
      tokenIdentity: buildEquityIdentity(t),
      quantity: primaryQty,
      tokenType: 'stock',
    },
    counter: {
      tokenIdentity: buildCurrencyIdentity(t.currency),
      quantity: counterQty,
      tokenType: 'fiat',
    },
    rawPayload: t,
  };

  if (t.tradePrice && t.currency) {
    event.priceNative = {
      value: t.tradePrice,
      quoteIdentity: buildCurrencyIdentity(t.currency),
      tokenType: 'fiat',
    };
  }

  if (t.ibCommission && t.ibCommissionCurrency && !new Decimal(t.ibCommission).abs().isZero()) {
    event.fee = {
      tokenIdentity: buildCurrencyIdentity(t.ibCommissionCurrency),
      quantity: negateFee(t.ibCommission),
      tokenType: 'fiat',
    };
  }

  return event;
}

function cashTxToEvent(c: CashTransactionRow): TransactionEvent | null {
  if (!c.type || !c.currency || !c.amount) return null;
  if (c.currency === 'BASE_SUMMARY') return null;
  const kind = classifyCashType(c.type, c.amount);
  if (!kind) return null;
  return {
    externalId: `${c.type}-${c.dateTime}-${c.currency}-${c.amount}`,
    occurredAt: parseFlexDateTime(c.dateTime),
    kind,
    primary: {
      tokenIdentity: buildCurrencyIdentity(c.currency),
      quantity: enforceSign(c.amount, kind),
      tokenType: 'fiat',
    },
    rawPayload: c,
  };
}

export class IbkrProvider
  implements BalanceProvider, TransactionsProvider, CredentialValidator, AccountDiscoveryProvider
{
  readonly providerKey = 'ibkr';
  readonly manifest = ibkrManifest;
  readonly capabilities: readonly Capability[] = [
    'current-balances',
    'transactions',
    'credential-validator',
    'account-discoverer',
  ];

  constructor(private readonly limiter: OutflowRateLimiter) {}

  canFetchBalances(c: string): boolean {
    return c === IBKR_INSTITUTION_CODE;
  }
  canFetchTransactions(c: string): boolean {
    return c === IBKR_INSTITUTION_CODE;
  }
  canDiscoverAccounts(c: string): boolean {
    return c === IBKR_INSTITUTION_CODE;
  }

  /**
   * IBKR Flex Query reports always belong to one configured account
   * (the user binds a Flex Query token + query id to a single IBKR
   * account). We surface that as a single synthetic 'PORTFOLIO'
   * account so the import flow can iterate uniformly with multi-
   * account venues.
   */
  async fetchAccounts(
    _ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<DiscoveredAccount[]> {
    return [
      {
        externalId: 'ibkr-flex-portfolio',
        label: 'IBKR Portfolio',
        metadata: {
          provider: 'ibkr',
          accountType: 'PORTFOLIO',
          description: 'Interactive Brokers Portfolio via Flex Query',
        },
      },
    ];
  }

  async fetchBalances(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string }
  ): Promise<HoldingSnapshot[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const token = creds.flexQueryToken as string | undefined;
    const queryId = creds.flexQueryId as string | undefined;
    if (!token || !queryId) return [];

    const xml = await this.runFlexQuery(token, queryId, ctx.onStatus);
    const positions = parsePositions(xml);
    const cashBalances = parseCashBalances(xml);

    const out: HoldingSnapshot[] = [];

    // Equity / ETF positions. `marketSegment` derived from the
    // listing exchange so the federated identity flow can dedupe
    // AAPL US vs AAPL.L correctly.
    for (const p of positions) {
      const marketSegment = mapListingExchangeToSegment(p.listingExchange);
      const lx = (p.listingExchange || '').toUpperCase();
      const finnhubMap = IBKR_LISTING_EXCHANGE_TO_FINNHUB[lx];
      const finnhubSymbol = finnhubMap?.suffix
        ? `${p.symbol.toUpperCase()}${finnhubMap.suffix}`
        : p.symbol.toUpperCase();
      const exchangeInfo = finnhubMap?.exchange
        ? { exchange: finnhubMap.exchange, currency: finnhubMap.currency }
        : undefined;
      const tokenIdentity: Partial<NewToken> = {
        symbol: p.symbol.toUpperCase(),
        name: p.description || p.symbol,
        marketSegment,
        providerMetadata: {
          ibkr: {
            symbol: p.symbol,
            assetCategory: p.assetCategory,
            listingExchange: p.listingExchange,
          },
          // Pre-seed finnhub.symbol with the Yahoo-style suffix so the
          // pricing router's `metadata.finnhub?.symbol` branch fires
          // straight from the IBKR snapshot (no nightly identity
          // backfill required), and so non-US listings carry the
          // `exchangeInfo` that flips routing to Google Sheets.
          finnhub: { symbol: finnhubSymbol },
          ...(exchangeInfo ? { exchangeInfo } : {}),
        },
      };
      out.push({
        // externalId must match what HoldingSnapshotProjection's
        // extractExternalTokenId() produces from providerMetadata —
        // ibkr.symbol here. Otherwise the import service can't
        // back-match the projected holding to its source snapshot
        // and silently drops every position with "provider returned
        // inconsistent shape".
        externalId: p.symbol,
        tokenIdentity,
        balance: p.position,
        capturedAt: new Date(),
        tokenType: 'stock',
      });
    }

    // Cash balances per currency. Tagged `fiat` so the import resolver
    // matches the existing fiat USD/EUR/GBP rows instead of creating
    // duplicate stock-typed currency tokens that have no price source.
    for (const c of cashBalances) {
      const tokenIdentity: Partial<NewToken> = {
        symbol: c.currency.toUpperCase(),
        name: c.currency,
        providerMetadata: { ibkr: { currency: c.currency } },
      };
      out.push({
        // Same constraint as above — ibkr.currency drives
        // extractExternalTokenId, so the snapshot key must be the bare
        // currency code (no "cash-" prefix).
        externalId: c.currency,
        tokenIdentity,
        balance: new Decimal(c.endingCash).toString(),
        capturedAt: new Date(),
        tokenType: 'fiat',
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
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const token = creds.flexQueryToken as string | undefined;
    const queryId = creds.flexQueryId as string | undefined;
    if (!token || !queryId) return [];

    const xml = await this.runFlexQuery(token, queryId, ctx.onStatus);
    const trades = parseTrades(xml);
    const cashTxs = parseCashTransactions(xml);

    const events: TransactionEvent[] = [];
    for (const t of trades) {
      const e = tradeToEvent(t);
      if (e) events.push(e);
    }
    for (const c of cashTxs) {
      const e = cashTxToEvent(c);
      if (e) events.push(e);
    }
    return events;
  }

  async validateCredentials(
    creds: DecryptedCredentials,
    institutionCode: string
  ): Promise<{ valid: boolean; message?: string }> {
    if (institutionCode !== IBKR_INSTITUTION_CODE) {
      return { valid: false, message: `Wrong institution: ${institutionCode}` };
    }
    const token = creds.flexQueryToken as string | undefined;
    const queryId = creds.flexQueryId as string | undefined;
    if (!token || !queryId) {
      return { valid: false, message: 'flexQueryToken + flexQueryId required' };
    }
    try {
      // SendRequest alone is enough — if IBKR accepts the token+query
      // and returns a reference code, credentials are valid. We don't
      // need to wait for the full statement.
      await this.requestReport(token, queryId);
      return { valid: true };
    } catch (err) {
      return { valid: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  private async runFlexQuery(
    token: string,
    queryId: string,
    onStatus?: (message: string) => void | Promise<void>
  ): Promise<string> {
    const sent = await this.requestReport(token, queryId, onStatus);
    await delay(FETCH_DELAY_MS);
    return this.fetchReport(token, sent.referenceCode, sent.getStatementUrl, onStatus);
  }

  private async requestReport(
    token: string,
    queryId: string,
    onStatus?: (message: string) => void | Promise<void>
  ): Promise<{ referenceCode: string; getStatementUrl: string }> {
    const subKey = credentialBucketKey(token);
    const params = new URLSearchParams({ t: token, q: queryId, v: '3' });
    const url = `${FLEX_SEND_URL}?${params.toString()}`;
    const tokenSuffix = token.length > 4 ? `…${token.slice(-4)}` : '****';
    logger.info(
      { tokenSuffix, queryId, url: FLEX_SEND_URL, version: '3' },
      'IBKR SendRequest: starting'
    );
    // IBKR's Flex Web Service serializes requests per (token, queryId).
    // After a 1001 response, the server-side generation slot stays
    // occupied for tens of seconds; a retry within 3s often hangs until
    // our 60s timeout. So: long fetch timeout, longer inter-retry delay,
    // and explicit catch on network/timeout errors so we don't blow out
    // the inline retry budget on a single hang.
    let lastErrorMsg = 'unknown';
    for (let attempt = 0; attempt < MAX_SEND_RETRIES; attempt++) {
      if (attempt === 0) {
        await reportStatus(onStatus, 'Connecting to IBKR Flex Web Service…');
      }
      let response: Response;
      try {
        response = await this.limiter.execute(
          async () => fetchWithTimeout(url, { method: 'GET' }, FLEX_REQUEST_TIMEOUT_MS, 0),
          subKey
        );
      } catch (err) {
        lastErrorMsg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_SEND_RETRIES - 1) {
          logger.warn(
            { tokenSuffix, queryId, error: lastErrorMsg, attempt, retryDelayMs: SEND_DELAY_MS },
            'IBKR SendRequest: network/timeout, retrying'
          );
          await reportStatus(
            onStatus,
            `IBKR Flex Web Service unreachable — retrying (${attempt + 2}/${MAX_SEND_RETRIES})…`
          );
          await delay(SEND_DELAY_MS);
          continue;
        }
        logger.error(
          { tokenSuffix, queryId, error: lastErrorMsg, attempt },
          'IBKR SendRequest: network/timeout, giving up'
        );
        throw err;
      }
      if (!response.ok) {
        logger.error(
          { tokenSuffix, queryId, status: response.status, attempt },
          'IBKR SendRequest: non-2xx HTTP'
        );
        throw new Error(`IBKR SendRequest HTTP ${response.status}`);
      }
      const xml = await response.text();
      const errorMatch = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/);
      if (errorMatch) {
        const code = errorMatch[1] ?? '';
        const errorMsg = xml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/)?.[1] ?? 'Unknown';
        if (TRANSIENT_GENERATION_ERROR_CODES.has(code) && attempt < MAX_SEND_RETRIES - 1) {
          logger.warn(
            { tokenSuffix, queryId, code, errorMsg, attempt, retryDelayMs: SEND_DELAY_MS },
            'IBKR SendRequest: transient error, retrying'
          );
          await reportStatus(
            onStatus,
            `IBKR queue busy — retrying SendRequest (${attempt + 2}/${MAX_SEND_RETRIES})…`
          );
          await delay(SEND_DELAY_MS);
          continue;
        }
        // Last-ditch: dump the full XML so we can see if IBKR included
        // additional context (extra tags, account-specific notes, etc.)
        // that the regex-based parser ignored.
        logger.error(
          {
            tokenSuffix,
            queryId,
            code,
            errorMsg,
            attempt,
            xmlLength: xml.length,
            xmlBody: xml.slice(0, 4096),
          },
          'IBKR SendRequest: failed permanently'
        );
        throw new Error(`IBKR Flex Query error (code ${code}): ${errorMsg}`);
      }
      const refMatch = xml.match(/<ReferenceCode>([^<]+)<\/ReferenceCode>/);
      if (!refMatch?.[1]) {
        logger.error(
          { tokenSuffix, queryId, xmlLength: xml.length, xmlBody: xml.slice(0, 4096) },
          'IBKR SendRequest: response missing ReferenceCode'
        );
        throw new Error('IBKR SendRequest response missing ReferenceCode');
      }
      // IBKR routes us to a specific data center for GetStatement
      // (typically gdcdyn). Honor it — calling the wrong DC works for
      // SendRequest but can stale-cache GetStatement.
      const urlMatch = xml.match(/<Url>([^<]+)<\/Url>/);
      const getStatementUrl = urlMatch?.[1]?.trim() || FLEX_GET_URL_DEFAULT;
      logger.info(
        { tokenSuffix, queryId, referenceCode: refMatch[1], getStatementUrl, attempt },
        'IBKR SendRequest: succeeded'
      );
      return { referenceCode: refMatch[1], getStatementUrl };
    }
    throw new Error(
      `IBKR SendRequest still transient after ${MAX_SEND_RETRIES} retries (last: ${lastErrorMsg})`
    );
  }

  private async fetchReport(
    token: string,
    referenceCode: string,
    getStatementUrl: string,
    onStatus?: (message: string) => void | Promise<void>
  ): Promise<string> {
    const subKey = credentialBucketKey(token);
    const params = new URLSearchParams({ t: token, q: referenceCode, v: '3' });
    const url = `${getStatementUrl}?${params.toString()}`;
    const tokenSuffix = token.length > 4 ? `…${token.slice(-4)}` : '****';
    logger.info(
      { tokenSuffix, referenceCode, url: getStatementUrl },
      'IBKR GetStatement: starting'
    );
    let lastErrorMsg = 'unknown';
    for (let attempt = 0; attempt < MAX_FETCH_RETRIES; attempt++) {
      if (attempt === 0) {
        await reportStatus(onStatus, 'IBKR is generating your Flex statement…');
      }
      let response: Response;
      try {
        response = await this.limiter.execute(
          async () => fetchWithTimeout(url, { method: 'GET' }, FLEX_REQUEST_TIMEOUT_MS, 0),
          subKey
        );
      } catch (err) {
        lastErrorMsg = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_FETCH_RETRIES - 1) {
          logger.warn(
            {
              tokenSuffix,
              referenceCode,
              error: lastErrorMsg,
              attempt,
              retryDelayMs: FETCH_DELAY_MS,
            },
            'IBKR GetStatement: network/timeout, retrying'
          );
          await reportStatus(
            onStatus,
            `IBKR Flex Web Service unreachable — retrying GetStatement (${attempt + 2}/${MAX_FETCH_RETRIES})…`
          );
          await delay(FETCH_DELAY_MS);
          continue;
        }
        logger.error(
          { tokenSuffix, referenceCode, error: lastErrorMsg, attempt },
          'IBKR GetStatement: network/timeout, giving up'
        );
        throw err;
      }
      if (!response.ok) {
        logger.error(
          { tokenSuffix, referenceCode, status: response.status, attempt },
          'IBKR GetStatement: non-2xx HTTP'
        );
        throw new Error(`IBKR GetStatement HTTP ${response.status}`);
      }
      const xml = await response.text();
      const errorMatch = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/);
      if (errorMatch) {
        const code = errorMatch[1] ?? '';
        const errorMsg = xml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/)?.[1] ?? 'Unknown';
        if (TRANSIENT_GENERATION_ERROR_CODES.has(code) && attempt < MAX_FETCH_RETRIES - 1) {
          logger.warn(
            { tokenSuffix, referenceCode, code, errorMsg, attempt, retryDelayMs: FETCH_DELAY_MS },
            'IBKR GetStatement: transient error, retrying'
          );
          await reportStatus(
            onStatus,
            `Waiting for IBKR — generating report (attempt ${attempt + 2}/${MAX_FETCH_RETRIES})…`
          );
          await delay(FETCH_DELAY_MS);
          continue;
        }
        logger.error(
          {
            tokenSuffix,
            referenceCode,
            code,
            errorMsg,
            attempt,
            xmlLength: xml.length,
            xmlBody: xml.slice(0, 4096),
          },
          'IBKR GetStatement: failed permanently'
        );
        throw new Error(`IBKR Flex Query error (code ${code}): ${errorMsg}`);
      }
      logger.info(
        { tokenSuffix, referenceCode, attempt, xmlLength: xml.length },
        'IBKR GetStatement: succeeded'
      );
      return xml;
    }
    throw new Error(
      `IBKR report still generating after ${MAX_FETCH_RETRIES} retries (last: ${lastErrorMsg})`
    );
  }
}

/**
 * Map IBKR's `listingExchange` field to our `marketSegment` column
 * value. Only the most common segments are mapped; unmapped exchanges
 * leave the segment null and rely on symbol-only matching.
 */
function mapListingExchangeToSegment(listingExchange: string): string | null {
  const lx = listingExchange.toUpperCase();
  if (!lx) return null;
  const map: Record<string, string> = {
    NASDAQ: 'US',
    NYSE: 'US',
    ARCA: 'US',
    AMEX: 'US',
    BATS: 'US',
    LSE: 'L',
    LSEETF: 'L',
    TSE: 'TO',
    TSX: 'TO',
    ASX: 'AX',
  };
  return map[lx] ?? null;
}

export const ibkrFactory: ProviderFactory = async (deps) => {
  // IBKR Flex Query: 1018 fires at ~1 req/15s per token. Conservative
  // 1 req / 5s gives users headroom to validate + sync without
  // tripping the limit.
  const limiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 5_000,
    redis: deps.redis ?? undefined,
    namespace: 'ibkr-flex',
  });
  const registered = deps.rateLimiterRegistry.register({
    namespace: 'ibkr-flex',
    limiter,
    registeredFrom: 'providers/ibkr',
    description: 'IBKR Flex Query: 1 req / 5s per token',
  });
  return new IbkrProvider(registered);
};
