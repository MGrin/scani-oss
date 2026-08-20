import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';
import { RETRY_EXTERNAL } from '../retry-policies';

/**
 * Go and get a currency pair we could not answer from storage (SC-222).
 *
 * This job exists because the fetch it performs must not happen on a request.
 * `CurrencyConverter`'s upstream call goes through an outflow limiter of two
 * requests per sixty seconds whose acquire *sleeps*, so on a read path the
 * third uncovered currency waits half a minute — measured at 26 s for three
 * currencies against production. Here the same wait costs nobody anything.
 *
 * The user's figure does not block on this. It renders without the pair and
 * says so; the refresh lands, and the next read has it.
 *
 * **The mechanism did not get faster; it got moved.** Verified against
 * production after deploy: three uncovered currencies returned `null` in
 * 314 ms, and the rates appeared three minutes later with `asOf` stamps of
 * 07:58:36, 07:59:36 and 07:58:36 — one of the three a full minute behind the
 * other two, because the limiter serialised it exactly as it always did. A
 * minute of waiting is still a minute. The change is that nobody is watching
 * it.
 *
 * **The pair is identified by token id** (SC-223). The symbols ride along
 * because the upstream call is symbol-addressed
 * (`exchangerate-api.com/v4/latest/GBP`) and because a queue dashboard showing
 * `GBP->USD` is readable where one showing two uuids is not — but they never
 * select a row. Eight tickers have more than one `tokens` row in production,
 * and refreshing the memecoin `SOS` rather than the Somali shilling stores the
 * rate against a row no valuation reads.
 *
 * The id fields are required, so a job enqueued by an api process older than
 * this fails payload validation, exhausts `RETRY_EXTERNAL` and lands in the
 * DLQ. Bounded and self-healing: a refresh is enqueued and consumed within
 * seconds, and any pair lost this way is re-enqueued by the next read that
 * misses it.
 */
export interface CurrencyRateRefreshJob extends UserJobBase {
  fromTokenId: string;
  fromSymbol: string;
  toTokenId: string;
  toSymbol: string;
}

export const currencyRateRefreshSchema: z.ZodType<CurrencyRateRefreshJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  fromTokenId: z.string().uuid(),
  fromSymbol: z.string().min(1).max(32),
  toTokenId: z.string().uuid(),
  toSymbol: z.string().min(1).max(32),
});

const JOB_ID_SEP = '_';

export const CURRENCY_RATE_REFRESH: UserJobDescriptor<CurrencyRateRefreshJob> = {
  name: JOB_NAMES.currencyRateRefresh,
  schema: currencyRateRefreshSchema,
  defaultOpts: {
    ...RETRY_EXTERNAL,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  // Keyed on the PAIR and a time bucket, with no `userId`: a rate is not
  // per-user, and the pathological case this fix has to survive is every user
  // on the platform opening Money in the same minute after a deploy empties
  // the in-memory cache. Without pair-level dedup that is one queued upstream
  // call per user per currency, all of them behind a 2-per-60s limiter.
  computeJobId: (d) =>
    [JOB_NAMES.currencyRateRefresh, d.fromTokenId, d.toTokenId, d.requestId].join(JOB_ID_SEP),
  summarizePayload: (d) => ({ pair: `${d.fromSymbol}->${d.toSymbol}` }),
};

/**
 * How long one queued refresh stands in for every other request for the same
 * pair. Matches `CurrencyConverter`'s in-memory TTL: a shorter window would
 * queue work whose result the converter is still serving from memory, and a
 * longer one would leave a genuinely missing pair unfetched after the cache
 * that was hiding it expired.
 */
export const CURRENCY_RATE_REFRESH_COALESCE_MS = 10 * 60 * 1000;
