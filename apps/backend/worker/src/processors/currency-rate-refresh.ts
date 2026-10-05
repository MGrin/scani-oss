import { TokenRepository } from '@scani/domain/repositories';
import { PricingService } from '@scani/domain/services';
import { CURRENCY_RATE_REFRESH, type CurrencyRateRefreshJob } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { type ProcessorContext, UserJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:currency-rate-refresh');

@Service()
export class CurrencyRateRefreshProcessor extends UserJobProcessor<
  CurrencyRateRefreshJob,
  unknown
> {
  readonly descriptor = CURRENCY_RATE_REFRESH;
  private readonly pricing = Container.get(PricingService);
  private readonly tokens = Container.get(TokenRepository);

  protected async handle(data: CurrencyRateRefreshJob, _ctx: ProcessorContext): Promise<unknown> {
    const { fromTokenId, fromSymbol, toTokenId, toSymbol } = data;
    const usd = await this.pricing.baseToken();
    const ids = [...new Set([fromTokenId, toTokenId])].filter((id) => id !== usd.id);
    const tokens = await this.tokens.findByIds(ids);
    const asOf = new Date();
    // Both legs are persisted: the API reads through USD in another process.
    const prices = await this.pricing.getTokenPrices(tokens, usd, asOf);

    if (!ids.every((id) => prices.has(id))) {
      // Not an error worth retrying loudly: a pair with no upstream answer is
      // a currency nobody can price, and the read path already renders that
      // honestly. Retrying it three times only spends limiter budget the next
      // resolvable pair needs.
      logger.info({ fromSymbol, toSymbol }, 'No rate available upstream for this pair');
      return { refreshed: false, pair: `${fromSymbol}->${toSymbol}` };
    }

    logger.info({ fromSymbol, toSymbol, asOf }, 'Refreshed currency rate');
    return { refreshed: true, pair: `${fromSymbol}->${toSymbol}`, asOf };
  }
}
