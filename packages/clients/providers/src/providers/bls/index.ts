import { createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import { Service } from 'typedi';
import { fetchWithTimeout } from '../../core/utils/fetch';

/**
 * US Bureau of Labor Statistics, public data API v1 (SC-1255).
 *
 * Not a price provider, so it is not in the registry: a consumer price index
 * is a rate, not something anybody holds, and it never converts a value. It
 * is the inflation line the returns card compares against.
 *
 * v1 needs no key. It allows 25 requests a day per IP and at most ten years
 * per request; one request a night is the whole load.
 */

const BLS_URL = 'https://api.bls.gov/publicAPI/v1/timeseries/data/';

const MAX_YEARS_PER_REQUEST = 10;

export interface MonthlyIndexValue {
  /** First day of the month, `YYYY-MM-01`. */
  month: string;
  value: string;
}

interface BlsResponse {
  status?: string;
  message?: string[];
  Results?: {
    series?: Array<{ data?: Array<{ year?: string; period?: string; value?: string }> }>;
  };
}

/** The monthly points in a BLS answer. `M13` (an annual average) and anything malformed are dropped. */
export function parseBlsMonthly(body: BlsResponse): MonthlyIndexValue[] {
  const data = body.Results?.series?.[0]?.data ?? [];
  const points: MonthlyIndexValue[] = [];
  for (const row of data) {
    const month = /^M(0[1-9]|1[0-2])$/.exec(row.period ?? '')?.[1];
    if (!month || !/^\d{4}$/.test(row.year ?? '')) continue;
    if (!row.value || !Number.isFinite(Number(row.value))) continue;
    points.push({ month: `${row.year}-${month}-01`, value: row.value });
  }
  return points.sort((a, b) => a.month.localeCompare(b.month));
}

@Service()
export class BlsClient {
  private readonly logger = createComponentLogger('provider:bls');
  private readonly limiter: OutflowRateLimiter = createOutflowLimiter({
    maxRequests: 1,
    windowMs: 1000,
    namespace: 'bls',
  });

  /**
   * One series' monthly values from `startYear` through `endYear`, clipped to
   * the ten years a single request may ask for (the most recent ten).
   */
  async fetchMonthly(
    seriesId: string,
    startYear: number,
    endYear: number
  ): Promise<MonthlyIndexValue[]> {
    const from = Math.max(startYear, endYear - MAX_YEARS_PER_REQUEST + 1);
    const response = await this.limiter.execute(async () =>
      fetchWithTimeout(BLS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seriesid: [seriesId],
          startyear: String(from),
          endyear: String(endYear),
        }),
      })
    );
    if (!response.ok) throw new Error(`BLS answered HTTP ${response.status}`);
    const body = (await response.json()) as BlsResponse;
    if (body.status !== 'REQUEST_SUCCEEDED') {
      throw new Error(`BLS refused the request: ${(body.message ?? []).join('; ') || body.status}`);
    }
    const points = parseBlsMonthly(body);
    this.logger.debug({ seriesId, from, endYear, points: points.length }, 'BLS series fetched');
    return points;
  }
}
