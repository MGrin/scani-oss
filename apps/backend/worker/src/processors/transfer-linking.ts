import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { TransferReviewService } from '@scani/domain/services';
import { LinkTransferPairsUseCase } from '@scani/domain/use-cases';
import { TRANSFER_LINKING_SCHEDULE } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { ScheduledJobProcessor } from '@scani/queue';
import { Container, Service } from 'typedi';

const logger = createComponentLogger('processor:transfer-linking');

@Service()
export class TransferLinkingProcessor extends ScheduledJobProcessor {
  readonly descriptor = TRANSFER_LINKING_SCHEDULE;

  protected async handle(): Promise<void> {
    const start = Date.now();
    logger.info('🕐 Starting transfer-link sweep');
    try {
      const useCase = Container.get(LinkTransferPairsUseCase);
      const reviews = Container.get(TransferReviewService);
      const users = await db.select({ id: schema.users.id }).from(schema.users);
      let totalLinked = 0;
      let totalAmbiguous = 0;
      let totalRuleAnswered = 0;
      // Counted separately because it is a different claim about the money:
      // a bridge is one asset arriving on another chain, and until SC-336 the
      // pass could not see one at all. A run whose `bridged` count moves is
      // the run that stopped booking a disposal that never happened.
      let totalBridged = 0;
      // Bounded fan-out: linking is per-user independent, so batch it
      // instead of serializing every user behind the previous one.
      const USER_CONCURRENCY = 25;
      for (let i = 0; i < users.length; i += USER_CONCURRENCY) {
        const batch = users.slice(i, i + USER_CONCURRENCY);
        await Promise.all(
          batch.map(async (u) => {
            try {
              const s = await useCase.execute({ userId: u.id });
              totalLinked += s.linked;
              totalAmbiguous += s.ambiguous;
              totalBridged += s.bridged;
              // After the matcher, so a rule only ever answers a row the
              // matcher declined. The net under every writer that does not
              // apply destination rules itself — and the pass that answers
              // rows left unmarked when the queue's reads stopped writing
              // (SC-1071).
              totalRuleAnswered += await reviews.applyDisposalMarks(u.id);
            } catch (error) {
              logger.warn(
                { userId: u.id, error: error instanceof Error ? error.message : error },
                'Transfer-linking failed for one user; continuing'
              );
            }
          })
        );
      }
      logger.info(
        {
          users: users.length,
          linked: totalLinked,
          bridged: totalBridged,
          ambiguous: totalAmbiguous,
          ruleAnswered: totalRuleAnswered,
          totalMs: Date.now() - start,
        },
        '✅ Transfer-link sweep complete'
      );
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          totalMs: Date.now() - start,
        },
        '❌ Transfer-link sweep failed'
      );
      throw error;
    }
  }
}
