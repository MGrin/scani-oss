import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
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
      const users = await db.select({ id: schema.users.id }).from(schema.users);
      let totalLinked = 0;
      let totalAmbiguous = 0;
      for (const u of users) {
        try {
          const s = await useCase.execute({ userId: u.id });
          totalLinked += s.linked;
          totalAmbiguous += s.ambiguous;
        } catch (error) {
          logger.warn(
            { userId: u.id, error: error instanceof Error ? error.message : error },
            'Transfer-linking failed for one user; continuing'
          );
        }
      }
      logger.info(
        {
          users: users.length,
          linked: totalLinked,
          ambiguous: totalAmbiguous,
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
