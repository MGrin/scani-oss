/**
 * Whether the hourly pricing run should ask for a token this hour (SC-1603,
 * SC-1598 items 4 + 5).
 *
 * Measured over 7 days (docs/technical/2026-10-06_sc1598-liveness-audit.md):
 * 92-100% of stock rows fetched outside US hours repeated the previous price,
 * and 91% of hourly FX rows repeated a rate published once a working day.
 * Crypto changes every hour and keeps the hourly cadence.
 *
 * **Every token is due in the 23:00Z hour, every day.** That reading is what
 * `findPricedDayKeys` counts as a priced day; without it the nightly backfill
 * asks for the day again every night.
 */

export interface PricingCadenceToken {
  typeCode: string | null;
  /** `tokens.market_segment`: `US`, `TO`, … */
  marketSegment: string | null;
  /** The listing exchange from provider metadata, when the segment is absent. */
  exchange: string | null;
}

const DAILY_READING_HOUR_UTC = 23;
/** Past this, a missed 23:00Z run is made up at the next run, whatever the hour. */
const MAX_DEFERRED_AGE_MS = 24 * 60 * 60 * 1000;
/** Hourly runs fire at :00, so these are the local hours whose run sees the session: 10:00 to the 16:00 close. */
const FIRST_SESSION_HOUR = 10;
const LAST_SESSION_HOUR = 16;

const NEW_YORK = 'America/New_York';
const TORONTO = 'America/Toronto';

const ZONE_BY_SEGMENT: Record<string, string> = { US: NEW_YORK, TO: TORONTO };
const ZONE_BY_EXCHANGE: Record<string, string> = {
  NYSE: NEW_YORK,
  NASDAQ: NEW_YORK,
  AMEX: NEW_YORK,
  ARCA: NEW_YORK,
  'NYSE ARCA': NEW_YORK,
  BATS: NEW_YORK,
  TSX: TORONTO,
  TSXV: TORONTO,
};

function exchangeZone(token: PricingCadenceToken): string | null {
  const segment = token.marketSegment?.toUpperCase();
  if (segment && ZONE_BY_SEGMENT[segment]) return ZONE_BY_SEGMENT[segment];
  const exchange = token.exchange?.toUpperCase();
  return exchange ? (ZONE_BY_EXCHANGE[exchange] ?? null) : null;
}

/** Holidays are not modelled: a closed weekday costs a few extra fetches, never a stale price. */
function inSession(zone: string, at: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    weekday: 'short',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(at);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return hour >= FIRST_SESSION_HOUR && hour <= LAST_SESSION_HOUR;
}

export function isPriceFetchDue(
  token: PricingCadenceToken,
  newestPriceAt: Date | null,
  runAt: Date
): boolean {
  if (token.typeCode !== 'fiat' && token.typeCode !== 'stock') return true;
  if (!newestPriceAt || runAt.getTime() - newestPriceAt.getTime() > MAX_DEFERRED_AGE_MS) {
    return true;
  }
  if (runAt.getUTCHours() === DAILY_READING_HOUR_UTC) return true;
  if (token.typeCode === 'fiat') return false;

  const zone = exchangeZone(token);
  return zone === null || inSession(zone, runAt);
}

/** The listing exchange a provider recorded for a stock, if any. */
export function listingExchange(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as {
    exchangeInfo?: { exchange?: unknown };
    finnhub?: { exchange?: unknown };
  };
  const exchange = m.exchangeInfo?.exchange ?? m.finnhub?.exchange;
  return typeof exchange === 'string' && exchange !== '' ? exchange : null;
}
