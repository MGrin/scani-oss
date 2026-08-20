import { RescoreScamTokensService } from '@scani/domain/services/tokens/RescoreScamTokensService';
import { RESCORE_SCAM_TOKENS_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:rescore-scam-tokens');

@Service()
export class RescoreScamTokensProcessor extends ScheduledJobProcessor {
  readonly descriptor = RESCORE_SCAM_TOKENS_SCHEDULE;

  protected async handle(): Promise<void> {
    const service = Container.get(RescoreScamTokensService);
    const result = await service.run();

    if (result.examined === 0) {
      logger.debug('No tokens with a stale scam score');
      return;
    }

    logger.info(
      { examined: result.examined, changed: result.changed.length, more: result.more },
      'Scam scores recomputed'
    );

    // A run that filled its page leaves work behind. Saying so is the whole
    // difference between "this finished" and "this got as far as it could" —
    // the next fire continues, and silence here would read as the former.
    if (result.more) {
      logger.info(
        { batch: result.examined },
        'More stale scam scores remain; the next run continues'
      );
    }
  }
}
