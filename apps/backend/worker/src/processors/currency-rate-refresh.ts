import { CurrencyConverter } from '@scani/domain/services';
import { CURRENCY_RATE_REFRESH, type CurrencyRateRefreshJob } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:currency-rate-refresh');

/**
 * Fetch and store one currency pair the read path could not answer (SC-222).
 *
 * The whole job is one `getRateDetail` with the upstream call allowed —
 * which is exactly what `tokens.getBaseCurrencyRates` used to do inline, and
 * exactly why the Money tab took 26 seconds. The work has not got cheaper;
 * it has moved somewhere nobody is watching a skeleton while it happens.
 *
 * `getRateDetail` writes the fetched rate to `token_prices` as a side effect,
 * so this leaves the pair resolvable from storage for every later read, not
 * just warm in this worker's memory. That matters because the api runs in a
 * different process: warming the worker's cache would help nobody.
 */
@Service()
export class CurrencyRateRefreshProcessor extends UserJobProcessor<
  CurrencyRateRefreshJob,
  unknown
> {
  readonly descriptor = CURRENCY_RATE_REFRESH;
  private readonly converter = Container.get(CurrencyConverter);

  protected async handle(data: CurrencyRateRefreshJob, _ctx: ProcessorContext): Promise<unknown> {
    const { fromTokenId, fromSymbol, toTokenId, toSymbol } = data;
    const detail = await this.converter.getRateDetail(
      { id: fromTokenId, symbol: fromSymbol },
      { id: toTokenId, symbol: toSymbol },
      new Date()
    );

    if (!detail) {
      // Not an error worth retrying loudly: a pair with no upstream answer is
      // a currency nobody can price, and the read path already renders that
      // honestly. Retrying it three times only spends limiter budget the next
      // resolvable pair needs.
      logger.info({ fromSymbol, toSymbol }, 'No rate available upstream for this pair');
      return { refreshed: false, pair: `${fromSymbol}->${toSymbol}` };
    }

    logger.info(
      { fromSymbol, toSymbol, rate: detail.rate, asOf: detail.asOf },
      'Refreshed currency rate'
    );
    return { refreshed: true, pair: `${fromSymbol}->${toSymbol}`, asOf: detail.asOf };
  }
}
