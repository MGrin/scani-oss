import { HideClosedHoldingsUseCase } from '@scani/domain/use-cases';
import { HIDE_CLOSED_HOLDINGS_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:hide-closed-holdings');

@Service()
export class HideClosedHoldingsProcessor extends ScheduledJobProcessor {
  readonly descriptor = HIDE_CLOSED_HOLDINGS_SCHEDULE;

  protected async handle(): Promise<void> {
    const start = Date.now();
    try {
      const summary = await Container.get(HideClosedHoldingsUseCase).execute();
      logger.info(
        { ...summary, totalMs: Date.now() - start },
        '✅ Hide-closed-holdings sweep done'
      );
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        '❌ Hide-closed-holdings sweep failed'
      );
      throw error;
    }
  }
}
