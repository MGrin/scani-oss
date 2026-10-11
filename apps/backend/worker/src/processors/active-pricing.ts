import { PriceActiveUsersCryptoUseCase } from '@scani/domain/use-cases';
import { ACTIVE_PRICING_SCHEDULE } from '@scani/jobs';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

@Service()
export class ActivePricingProcessor extends ScheduledJobProcessor {
  readonly descriptor = ACTIVE_PRICING_SCHEDULE;

  protected async handle(): Promise<void> {
    await Container.get(PriceActiveUsersCryptoUseCase).execute();
  }
}
