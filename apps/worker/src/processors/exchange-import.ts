import type { ExchangeImportJob } from '@scani/core/queues';
import { ImportExchangeAccountsUseCase, ImportIbkrAccountsUseCase } from '@scani/core/use-cases';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { z } from 'zod';
import { emitEntityChangeFromWorker } from '../lib/emit-entity-change';
import { createUserJobProcessor } from '../lib/processor-wrapper';

const payloadSchema: z.ZodType<ExchangeImportJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  institutionId: z.string().min(1),
  provider: z.string().min(1),
});

export function buildExchangeImportProcessor(publisher: Redis): (job: Job) => Promise<unknown> {
  return createUserJobProcessor({
    name: 'exchange-import',
    schema: payloadSchema,
    publisher,
    handler: async (data) => {
      const useCase =
        data.provider.toLowerCase() === 'interactive brokers' ||
        data.provider.toLowerCase() === 'ibkr'
          ? Container.get(ImportIbkrAccountsUseCase)
          : Container.get(ImportExchangeAccountsUseCase);

      const result = await useCase.execute({
        userId: data.userId,
        institutionId: data.institutionId,
      });

      for (const account of result.accounts) {
        await emitEntityChangeFromWorker(publisher, {
          entityType: 'account',
          operationType: 'create',
          entityId: account.id,
          userId: data.userId,
        });
      }
      for (const holding of result.holdings) {
        await emitEntityChangeFromWorker(publisher, {
          entityType: 'holding',
          operationType: 'create',
          entityId: holding.id,
          userId: data.userId,
          data: { accountId: holding.accountId },
        });
      }
      if (result.holdings.length > 0) {
        await emitEntityChangeFromWorker(publisher, {
          entityType: 'holding',
          operationType: 'sync',
          userId: data.userId,
          data: { reason: 'exchange_import', holdingsAffected: result.holdings.length },
        });
      }

      return {
        accountsCreated: result.accountsCreated,
        tokensImported: result.tokensImported,
        errors: result.errors,
      };
    },
  });
}
