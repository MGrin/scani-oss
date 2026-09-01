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
 * Error code map, implemented in `classifyFlexError` — see the docblock there
 * for why 1025 carries a day-long window rather than a retry hint:
 *   - 1025        → rate-limited, 24h lockout (SC-279)
 *   - 1018        → rate-limited, 60s
 *   - 1010, 1012  → auth-failed, no window
 *   - 1001, 1019  → "still generating" — poll loop with delay, and
 *                   `retryable` once the budget runs out (SC-443)
 *   - anything else → unrecoverable
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
import { credentialRejection, ProviderError } from '../../core/errors';
import type {
  DecryptedCredentials,
  DiscoveredAccount,
  HoldingSnapshot,
  ProviderContext,
  TransactionEvent,
  TransactionFetchContext,
  WithUserCreds,
} from '../../core/types';
import { enforceSign, inferCounterSign, negateFee } from '../../core/utils/enforce-tx-sign';
import { fetchWithTimeout } from '../../core/utils/fetch';
import { ibkrManifest } from './manifest';
import {
  BALANCE_SECTIONS,
  describeIncompleteCashRows,
  describeMissingSections,
  describeStatementWindow,
  describeUnmappedCashTypes,
  type FlexStatementWindow,
  hasFlexSection,
  incompleteCashFieldsKey,
  missingFlexSections,
  TRANSACTION_SECTIONS,
} from './statement-warnings';

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

/**
 * The error-code map at the top of this file, actually implemented (SC-279).
 *
 * It has described 1010/1012 as auth-failed and 1018 as rate-limited since the
 * provider was written, and the code classified none of them — every
 * non-transient code threw a plain `Error`, which orchestrators treat as
 * `retryable`. So an hourly schedule retried a lockout hourly.
 *
 * **1025 is the one that matters and it is not an ordinary rate limit.** IBKR
 * returns "Too many failed attempts" after repeated failure and keeps
 * returning it; each further attempt is another failed attempt against the
 * counter that has to age out. Retrying is not recovery, it is the mechanism
 * that sustains the lockout — so this carries a window the caller must honour
 * by NOT CALLING AT ALL, not by sleeping and trying again.
 *
 * **The window is 24 hours, chosen to be obviously safe rather than
 * optimistically short.** IBKR does not document 1025's cooldown, so there is
 * no correct number to look up; what is known is the asymmetry. Waiting too
 * long costs one more day of staleness on an integration that is already stale
 * and — since this ticket — visibly flagged in its own row. Waiting too little
 * costs the lockout never ageing out at all, which is the failure we are in.
 * A day also exceeds any plausible rolling-counter window and is the unit a
 * human would use ("try again tomorrow").
 */
const IBKR_LOCKOUT_MS = 24 * 60 * 60 * 1000;
// 1018 is the throughput limiter — ~1 request per 15s per token — so it clears
// on its own in seconds. A minute is generous and still same-run recoverable.
const IBKR_RATE_LIMIT_MS = 60_000;

function classifyFlexError(code: string, message: string): ProviderError {
  const full = `IBKR Flex Query error (code ${code}): ${message}`;
  if (code === '1025') {
    return new ProviderError(full, 'rate-limited', 'ibkr', { retryAfterMs: IBKR_LOCKOUT_MS });
  }
  if (code === '1018') {
    return new ProviderError(full, 'rate-limited', 'ibkr', { retryAfterMs: IBKR_RATE_LIMIT_MS });
  }
  if (code === '1010' || code === '1012') {
    // No window: time does not fix a bad token. It needs the user, and
    // `syncBlockedUntil` would only postpone telling them.
    return new ProviderError(full, 'auth-failed', 'ibkr');
  }
  return new ProviderError(full, 'unrecoverable', 'ibkr');
}

/**
 * The poll ran out of OUR budget while IBKR was still saying "generating"
 * (SC-443).
 *
 * `retryable`, not `unrecoverable`. Exhaustion means the report was accepted
 * and had not been built yet: a slow generation, not a broken credential, and
 * nothing the user can correct. Classifying it terminal told them "this failed
 * for a reason another attempt will not fix" — an instruction to go repair
 * something that is not broken.
 *
 * No `retryAfterMs`. That contract means "do not contact the provider at all",
 * which is right for the 1025 lockout and wrong here — the next attempt is the
 * queue's to schedule, and every caller already bounds it: `RETRY_EXTERNAL`
 * gives exchange-import 3 attempts, transaction-import allows 4, and the
 * hourly `exchange-balances` cron simply runs again. Retrying forever is not
 * one of the outcomes on offer.
 */
function flexPollExhausted(message: string): ProviderError {
  return new ProviderError(message, 'retryable', 'ibkr');
}

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
  /** The row's own as-of date, verbatim. Optional in IBKR's schema, so the
   *  statement's `toDate` is the fallback and our clock the last resort. */
  reportDate: string;
}
interface CashBalance {
  currency: string;
  endingCash: string;
  reportDate: string;
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
  /** IBKR's own row identifier. Present on DETAIL rows, empty on SUMMARY. */
  transactionID: string;
  /** `'DETAIL'` | `'SUMMARY'` | `''` when the template does not ask for it. */
  levelOfDetail: string;
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

/**
 * Read one attribute out of an element's attribute text.
 *
 * The name is anchored to a whitespace boundary, and that is the whole
 * substance of this function (SC-855). Unanchored, `type` matched inside
 * `securityIDType="ISIN"` — which IBKR emits eleven attributes ahead of the
 * element's own `type` — so every `<CashTransaction>` in a real statement
 * read `type = "ISIN"`, `classifyCashType` refused it, and the row was
 ***REMOVED***
 ***REMOVED***
 * all, and it is kept because IBKR's own casing is the thing we do not
 * control; the anchor is what makes it safe.
 *
 * The hazard is not specific to `type` — `conid` sits inside
 * `underlyingConid` and `currency` inside `ibCommissionCurrency`. Those two
 * happen to be safe today only because IBKR emits the shorter name first,
 * which is a property of the statement rather than of this parser, and a
 * Flex query's columns are the user's to choose.
 */
function extractAttr(attrs: string, name: string): string {
  const regex = new RegExp(`(?:^|\\s)${name}="([^"]*)"`, 'i');
  return attrs.match(regex)?.[1] ?? '';
}

/**
 * Parse IBKR's `YYYYMMDD;HHMMSS` (or `YYYYMMDDHHMMSS`) timestamp format.
 * IBKR reports times in the user's account timezone — for now we treat
 * them as UTC; the import flow can adjust if account TZ becomes a thing
 * we expose.
 *
 * **The time is OPTIONAL, and demanding it crashed the import (SC-880).**
 * Most `<CashTransaction>` rows in a real statement carry a date-only
 * `dateTime="YYYYMMDD"` — settlement-dated rows, where IBKR knows the day and
 * not the second. Rejecting those returned `new Date(NaN)`, which drizzle
 * threw `RangeError: Invalid Date` on while building the insert; `bulkUpsert`
 * is one statement for the whole batch, so NOTHING was written — not the cash
 * rows, and not the trades beside them. The path was unreachable until SC-855
 * stopped every cash row reading `type="ISIN"`, which is why a parser this old
 * first crashed the night after a fix landed.
 *
 * A date with no time resolves to the instant that day ENDS, which is what
 * `parseFlexDate` already does with `reportDate` and `toDate` and for the
 * same reason: the value describes a whole day, and midnight would place it
 * before every timestamped event on it rather than after.
 */
function parseFlexDateTime(s: string): Date {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:[;\s]?(\d{2})(\d{2})(\d{2}))?$/);
  if (!m) return new Date(Number.NaN);
  const [, y, mo, d, h, mi, se] = m as unknown as [
    string,
    string,
    string,
    string | undefined,
    string | undefined,
    string | undefined,
    string | undefined,
  ];
  const timed = h !== undefined && mi !== undefined && se !== undefined;
  return new Date(
    Date.UTC(
      Number(y),
      Number(mo) - 1,
      Number(d),
      timed ? Number(h) : 23,
      timed ? Number(mi) : 59,
      timed ? Number(se) : 59
    )
  );
}

/**
 * Parse a Flex date-only attribute (`toDate`, `reportDate`) into the instant
 * that day ENDS, UTC.
 *
 * Two spellings, because the date format is a per-query setting the user
 * picks in Account Management and we do not set it for them: the default is
 * `yyyyMMdd`, and `yyyy-MM-dd` is the other common choice (it is what IBKR's
 * own published samples use). A parser that knew one of them would report a
 * correct date for some users' statements and `Invalid Date` for the rest —
 * which is the same silence we are fixing, one layer down.
 *
 * End of day rather than midnight because that is what the number means. An
 * activity statement's positions are the CLOSING positions for `reportDate`,
 * so 23:59:59Z is the latest instant they are known to describe; midnight
 * would place a whole day's trading after the observation instead of before
 * it. IBKR reports in the account's timezone and we treat it as UTC — the
 * same simplification `parseFlexDateTime` above already makes, and it cannot
 * move the date by more than the hours in a day.
 */
function parseFlexDate(s: string): Date {
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return new Date(Number.NaN);
  const [, y, mo, d] = m as unknown as [string, string, string, string];
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), 23, 59, 59));
}

/**
 * The attribute text of the `<FlexStatement>` element, or `''` when the
 * statement has none. Both readers below want a different attribute off the
 * same element, and an empty string is the right miss for both: `extractAttr`
 * returns `''` for an attribute that is not there, which `parseFlexDate`
 * already turns into `Invalid Date`.
 */
function flexStatementAttrs(xml: string): string {
  return xml.match(/<FlexStatement\s+([^>]*?)\/?>/)?.[1] ?? '';
}

/**
 * The date the STATEMENT claims to describe, from `<FlexStatement>`'s own
 * attributes — the account-wide fallback for rows that carry no `reportDate`
 * of their own.
 *
 * `toDate` is the answer and `whenGenerated` is not: the second says when
 * IBKR built the report, which for an intraday fetch is today even when the
 * data in it is not. Reading the generation stamp as an as-of date would
 * reproduce exactly the lie this function exists to stop telling.
 */
function parseStatementAsOf(xml: string): Date | null {
  const at = parseFlexDate(extractAttr(flexStatementAttrs(xml), 'toDate'));
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * The window `<FlexStatement>` says it covers, read from the same element
 * `parseStatementAsOf` above reads and for the mirror-image reason: that one
 * asks how recent the data is, this one asks how far back it goes (SC-882).
 *
 * `fromDate` is absent from a statement often enough to matter — the element
 * carries whatever attributes the saved query produced — so the two halves
 * are returned separately rather than collapsed into a default. A missing
 * `fromDate` means the range is UNKNOWN, which is not the same fact as a
 * range that reaches the account's start.
 */
function parseStatementWindow(xml: string): FlexStatementWindow {
  const attrs = flexStatementAttrs(xml);
  const from = parseFlexDate(extractAttr(attrs, 'fromDate'));
  return {
    from: Number.isNaN(from.getTime()) ? null : from,
    period: extractAttr(attrs, 'period'),
  };
}

/**
 * Said on every IBKR sync, unconditionally, because the lag is a property of
 * the interface rather than of a particular run (SC-384).
 *
 * The Flex Web Service is a REPORTING interface: IBKR generates an activity
 * statement after the close and serves that same statement all day. Same-day
 * positions exist — IBKR's Client Portal Web API has them — but that API
 * authenticates by OAuth 1.0a signature or a gateway session, and a Flex
 * token cannot produce either (measured 2026-08-19: every Client Portal
 * endpoint answers 401 to a Flex token, and ignores the `t=` parameter
 * entirely). So the credential a user pastes into Scani reaches the lagging
 * source and no other, and the honest move is to say so next to the number
 * rather than let a reader who just traded conclude their broker data is
 * wrong.
 */
const IBKR_AS_OF_NOTE =
  'Interactive Brokers generates this statement after the close and serves it all day, ' +
  'so positions are as of the date shown — trades made since then appear tomorrow.';

function parsePositions(xml: string): OpenPosition[] {
  const out: OpenPosition[] = [];
  for (const match of xml.matchAll(/<OpenPosition\s+([^>]*)\/?>/g)) {
    const attrs = match[1] ?? '';
    const qty = Number.parseFloat(extractAttr(attrs, 'position'));
    // Skip flat and short positions. Holdings model long balances only
    // (holdings.balance >= 0); a short is a liability with no representable
    // holding row, so drop it rather than trip the DB check constraint.
    if (!Number.isFinite(qty) || qty <= 0) continue;
    out.push({
      symbol: extractAttr(attrs, 'symbol'),
      description: extractAttr(attrs, 'description'),
      position: extractAttr(attrs, 'position'),
      currency: extractAttr(attrs, 'currency'),
      assetCategory: extractAttr(attrs, 'assetCategory'),
      listingExchange: extractAttr(attrs, 'listingExchange'),
      reportDate: extractAttr(attrs, 'reportDate'),
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
    // Skip zero and negative (margin-debt) cash for the same reason as
    // short positions above — a negative cash balance is a liability, not
    // a holding, and holdings.balance is constrained to >= 0.
    if (!Number.isFinite(cash) || cash <= 0) continue;
    out.push({ currency, endingCash, reportDate: extractAttr(attrs, 'reportDate') });
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
      transactionID: extractAttr(attrs, 'transactionID'),
      levelOfDetail: extractAttr(attrs, 'levelOfDetail'),
    });
  }
  return out;
}

/**
 * One movement of money, once — because a Flex statement reports each one
 * TWICE when the template asks for both levels of detail (SC-877).
 *
 * Measured on a real statement carrying both levels: the amounts summed per
 * currency are IDENTICAL between them. `SUMMARY` is a roll-up of the `DETAIL`
 * rows beneath it, so importing both counts every deposit, dividend and fee
 * twice.
 *
 * The dedup key hid this rather than preventing it: `(holding, source,
 * externalId)` collapsed only those pairs whose type, date, currency and
 * amount matched exactly, and let through every pair where one `SUMMARY` row
 * rolled up several `DETAIL` rows — which is most of them.
 *
 * `DETAIL` wins where both exist, and it is the level that carries
 * `transactionID`. Where there is no `DETAIL` row at all — a template that
 * asks only for the summary — the summary IS the statement and is kept: the
 * rule is prefer, not require.
 */
function preferDetailCashRows(rows: CashTransactionRow[]): CashTransactionRow[] {
  const level = (c: CashTransactionRow): string => c.levelOfDetail.toUpperCase();
  if (!rows.some((c) => level(c) === 'DETAIL')) return rows;
  return rows.filter((c) => level(c) !== 'SUMMARY');
}

type CashKind = 'reward' | 'interest' | 'fee' | 'deposit' | 'withdraw';

function classifyCashType(type: string, amount: string): CashKind | null {
  switch (type) {
    case 'Dividends':
    // What a dividend is called when the share was on loan over the record
    // date. Same money, same direction, same counterparty — and the only type
    // still warned about once SC-855 let real ones through (SC-877).
    case 'Payment In Lieu Of Dividends':
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

/**
 * Why a cash row produced no event — separated from producing one because the
 * three reasons are not alike (SC-435).
 *
 * `summary` is IBKR's own BASE_SUMMARY total line and is meant to be dropped,
 * and it is the ONLY one of the three that may be silent.
 *
 * `unmapped-type`: `classifyCashType` matches IBKR's `type` attribute EXACTLY,
 * so a string the map has never seen — a category we did not know existed, or
 * one IBKR renamed — takes real money out of the ledger. That is the same
 * defect as a section the query never sent, arriving through a different door,
 * and it is the other half of what could have made every IBKR transaction in
 * production a `<Trade>`.
 *
 * `incomplete`: a row that arrived carrying money with `type`, `currency` or
 * `amount` blank. It reads as the same thing from the user's side — a deposit
 * that never appeared — and until SC-873 it was the one drop nothing counted,
 * which is why SC-855's 177 rows a run is a floor on the loss rather than the
 * figure. Both non-`summary` reasons are now warned on, separately.
 */
type CashDropReason = 'summary' | 'incomplete' | 'unmapped-type';

function cashTxDropReason(c: CashTransactionRow): CashDropReason | null {
  if (c.currency === 'BASE_SUMMARY') return 'summary';
  if (!c.type || !c.currency || !c.amount) return 'incomplete';
  if (!classifyCashType(c.type, c.amount)) return 'unmapped-type';
  return null;
}

function cashTxToEvent(c: CashTransactionRow): TransactionEvent | null {
  if (cashTxDropReason(c)) return null;
  const kind = classifyCashType(c.type, c.amount);
  if (!kind) return null;
  return {
    // IBKR's own row id where it sends one, because the composite below is
    // not an identifier: it collides wherever a statement repeats a movement,
    // and it MOVES if IBKR restates an amount — which writes a second row rather
    // than correcting the first (SC-877). Only `SUMMARY` rows arrive without
    // it, and those are dropped whenever a `DETAIL` row exists.
    externalId: c.transactionID || `${c.type}-${c.dateTime}-${c.currency}-${c.amount}`,
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

  /**
   * `sleep` is injected only so the poll budget can be exercised. Exhausting
   * GetStatement legitimately takes 24×12s, and a test that proves what
   * exhaustion classifies AS cannot be the test that sits through it.
   */
  constructor(
    private readonly limiter: OutflowRateLimiter,
    private readonly sleep: (ms: number) => Promise<void> = delay
  ) {}

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

    // Three sources for "when is this true", narrowest first: the row's own
    // `reportDate`, the statement's `toDate`, and — only if IBKR sent neither
    // and only so a sync never fails over a missing attribute — the clock.
    // The last one is the pre-SC-384 behaviour and it is a lie; it is here
    // because a wrong date on a working balance beats no balance, not because
    // it is acceptable.
    const statementAsOf = parseStatementAsOf(xml);
    const fetchedAt = new Date();
    const asOf = (reportDate: string): Date => {
      const row = parseFlexDate(reportDate);
      if (!Number.isNaN(row.getTime())) return row;
      return statementAsOf ?? fetchedAt;
    };

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
        capturedAt: asOf(p.reportDate),
        asOfNote: IBKR_AS_OF_NOTE,
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
        capturedAt: asOf(c.reportDate),
        asOfNote: IBKR_AS_OF_NOTE,
        tokenType: 'fiat',
      });
    }

    return out;
  }

  async fetchTransactions(ctx: TransactionFetchContext): Promise<TransactionEvent[]> {
    const creds = await ctx.resolveCredentials(ctx.credentialsRef);
    const token = creds.flexQueryToken as string | undefined;
    const queryId = creds.flexQueryId as string | undefined;
    if (!token || !queryId) return [];

    const xml = await this.runFlexQuery(token, queryId, ctx.onStatus);

    // Before parsing, not after. A section the query never sent and a section
    // that is simply empty produce the same zero rows, and only the statement
    // itself can tell them apart (SC-435).
    const missing = describeMissingSections(missingFlexSections(xml, TRANSACTION_SECTIONS));
    if (missing) ctx.noteWarning?.(missing);

    // A run that asked for the whole ledger got this statement's window and
    // nothing older, and IBKR can declare no `transactionHistoryHorizonMs`
    // because the window is the user's saved-query setting rather than ours
    // (SC-882). `describeStatementWindow` carries the argument.
    //
    // SCOPED TO A `since`-LESS RUN, and that is the load-bearing half.
    // `TransactionImportCoordinator` passes `completenessIsClaimed: !since ||
    // historyRetractions.length > 0`, so retracting on an incremental run
    // WRITES `has_complete_tx_history` through where the nightly leaves the
    // stored value alone — moving a cost-basis flag as a side effect of a
    // claim that run never made (SC-877). The router's own `describeHorizon`
    // is guarded the same way and for the same stated reason: a window is the
    // caller's choice rather than a shortfall.
    if (!ctx.since) ctx.retractHistoryClaim?.(describeStatementWindow(parseStatementWindow(xml)));

    const trades = parseTrades(xml);
    const cashTxs = preferDetailCashRows(parseCashTransactions(xml));

    const events: TransactionEvent[] = [];
    for (const t of trades) {
      const e = tradeToEvent(t);
      if (e) events.push(e);
    }

    // A row we received and could not place is money that moved with nothing
    // to say so — the same outcome as a section we never received, so it gets
    // the same voice rather than a log line (SC-435).
    //
    // Both non-`summary` reasons are counted, and they are counted SEPARATELY
    // because they are different questions for the reader (SC-873).
    // `unmapped-type` is a category our map has never seen — ours to fix.
    // `incomplete` is a row that arrived with `type`, `currency` or `amount`
    // blank — which is IBKR's data or the user's Flex Query columns, and
    // neither is answered by a count of the other. Folding them together
    // would send every reader down one action for two causes.
    const unmappedTypes = new Map<string, number>();
    const incompleteFields = new Map<string, number>();
    for (const c of cashTxs) {
      const e = cashTxToEvent(c);
      if (e) {
        events.push(e);
        continue;
      }
      const reason = cashTxDropReason(c);
      if (reason === 'unmapped-type') {
        unmappedTypes.set(c.type, (unmappedTypes.get(c.type) ?? 0) + 1);
      } else if (reason === 'incomplete') {
        const fields = incompleteCashFieldsKey(c);
        incompleteFields.set(fields, (incompleteFields.get(fields) ?? 0) + 1);
      }
    }
    const unmapped = describeUnmappedCashTypes(unmappedTypes);
    if (unmapped) ctx.noteWarning?.(unmapped);
    const incomplete = describeIncompleteCashRows(incompleteFields);
    if (incomplete) ctx.noteWarning?.(incomplete);

    return events;
  }

  /**
   * **Not on the connect path**, and that is deliberate: `ibkrManifest` sets
   * `skipServerValidation`, so `integrations.validateKeys` stores the
   * credential and enqueues the import without calling this. One SendRequest
   * per minute is the whole budget, and spending it here spends the worker's.
   * What a user sees after connecting IBKR is the import job's own outcome.
   *
   * It still has to be right for the day that flag flips, and for anything
   * that reaches a validator through the registry. Only IBKR's documented
   * bad-token codes (1010, 1012) are an answer about the credential; a
   * lockout, a throughput limit, a report IBKR has not finished generating
   * and a network failure all leave the token's validity unknown, and
   * `credentialRejection` re-throws them rather than blaming it (SC-445).
   */
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
      return credentialRejection(err);
    }
  }

  // ============================================================
  // Internals
  // ============================================================

  /**
   * Logged on every statement, both callers, whether or not anything is
   * missing — because the question SC-435 asks is answered by one line from
   * one scheduled sync, and a line that only appears when something is wrong
   * cannot distinguish "nothing wrong" from "never ran".
   *
   * It names the four sections and the statement's size. No account
   * identifier, no token: which report sections a user selected is a
   * configuration fact, and the log already carries the run's identity.
   */
  private logSectionInventory(xml: string, queryId: string): void {
    const sections = [...BALANCE_SECTIONS, ...TRANSACTION_SECTIONS];
    logger.info(
      {
        queryId,
        bytes: xml.length,
        sections: Object.fromEntries(
          sections.map((section) => [section.element, hasFlexSection(xml, section.element)])
        ),
      },
      'IBKR statement: sections present'
    );
  }

  private async runFlexQuery(
    token: string,
    queryId: string,
    onStatus?: (message: string) => void | Promise<void>
  ): Promise<string> {
    const sent = await this.requestReport(token, queryId, onStatus);
    await this.sleep(FETCH_DELAY_MS);
    const xml = await this.fetchReport(token, sent.referenceCode, sent.getStatementUrl, onStatus);
    this.logSectionInventory(xml, queryId);
    return xml;
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
    const exhausted = () =>
      flexPollExhausted(
        `IBKR SendRequest still transient after ${MAX_SEND_RETRIES} retries (last: ${lastErrorMsg})`
      );
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
          await this.sleep(SEND_DELAY_MS);
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
        throw ProviderError.fromHttp(IBKR_INSTITUTION_CODE, response);
      }
      const xml = await response.text();
      const errorMatch = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/);
      if (errorMatch) {
        const code = errorMatch[1] ?? '';
        const errorMsg = xml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/)?.[1] ?? 'Unknown';
        if (TRANSIENT_GENERATION_ERROR_CODES.has(code)) {
          lastErrorMsg = `code ${code}: ${errorMsg}`;
          if (attempt < MAX_SEND_RETRIES - 1) {
            logger.warn(
              { tokenSuffix, queryId, code, errorMsg, attempt, retryDelayMs: SEND_DELAY_MS },
              'IBKR SendRequest: transient error, retrying'
            );
            await reportStatus(
              onStatus,
              `IBKR queue busy — retrying SendRequest (${attempt + 2}/${MAX_SEND_RETRIES})…`
            );
            await this.sleep(SEND_DELAY_MS);
            continue;
          }
          logger.warn(
            { tokenSuffix, queryId, code, errorMsg, attempts: MAX_SEND_RETRIES },
            'IBKR SendRequest: still queued after the full budget'
          );
          throw exhausted();
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
        throw classifyFlexError(code, errorMsg);
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
    // Unreachable: the last attempt returns or throws. Present because the
    // compiler cannot prove a bounded loop runs, and identical to the throw
    // above so the two can never drift apart.
    throw exhausted();
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
    const exhausted = () =>
      flexPollExhausted(
        `IBKR report still generating after ${MAX_FETCH_RETRIES} retries (last: ${lastErrorMsg})`
      );
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
          await this.sleep(FETCH_DELAY_MS);
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
        throw ProviderError.fromHttp(IBKR_INSTITUTION_CODE, response);
      }
      const xml = await response.text();
      const errorMatch = xml.match(/<ErrorCode>(\d+)<\/ErrorCode>/);
      if (errorMatch) {
        const code = errorMatch[1] ?? '';
        const errorMsg = xml.match(/<ErrorMessage>([^<]*)<\/ErrorMessage>/)?.[1] ?? 'Unknown';
        if (TRANSIENT_GENERATION_ERROR_CODES.has(code)) {
          lastErrorMsg = `code ${code}: ${errorMsg}`;
          if (attempt < MAX_FETCH_RETRIES - 1) {
            logger.warn(
              { tokenSuffix, referenceCode, code, errorMsg, attempt, retryDelayMs: FETCH_DELAY_MS },
              'IBKR GetStatement: transient error, retrying'
            );
            await reportStatus(
              onStatus,
              `Waiting for IBKR — generating report (attempt ${attempt + 2}/${MAX_FETCH_RETRIES})…`
            );
            await this.sleep(FETCH_DELAY_MS);
            continue;
          }
          logger.warn(
            { tokenSuffix, referenceCode, code, errorMsg, attempts: MAX_FETCH_RETRIES },
            'IBKR GetStatement: still generating after the full budget'
          );
          throw exhausted();
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
        throw classifyFlexError(code, errorMsg);
      }
      logger.info(
        { tokenSuffix, referenceCode, attempt, xmlLength: xml.length },
        'IBKR GetStatement: succeeded'
      );
      return xml;
    }
    // Unreachable, for the same reason as in `requestReport`.
    throw exhausted();
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
