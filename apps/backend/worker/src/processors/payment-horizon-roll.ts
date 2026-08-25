import { RollPaymentHorizonsUseCase } from '@scani/domain/use-cases';
import { PAYMENT_HORIZON_ROLL_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:payment-horizon-roll');

@Service()
export class PaymentHorizonRollProcessor extends ScheduledJobProcessor {
  readonly descriptor = PAYMENT_HORIZON_ROLL_SCHEDULE;

  protected async handle(): Promise<void> {
    const start = Date.now();
    try {
      const summary = await Container.get(RollPaymentHorizonsUseCase).execute();
      logger.info({ ...summary, totalMs: Date.now() - start }, '✅ Payment horizon roll done');
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        '❌ Payment horizon roll failed'
      );
      throw error;
    }
  }
}
