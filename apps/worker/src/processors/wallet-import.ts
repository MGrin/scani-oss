import { WalletImplementations } from '@scani/domain/features';
import type { WalletImportJob } from '@scani/queue';
import { emitEntityChangeFromWorker } from '@scani/realtime/publish';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { createUserJobProcessor } from '../lib/processor-wrapper';

const payloadSchema: z.ZodType<WalletImportJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  chain: z.string().min(1),
  address: z.string().min(1),
  label: z.string().optional(),
  detectedInstitutionIds: z.array(z.string()).optional(),
});

export function buildWalletImportProcessor(publisher: Redis): (job: Job) => Promise<unknown> {
  return createUserJobProcessor({
    name: 'wallet-import',
    schema: payloadSchema,
    publisher,
    handler: async (data) => {
      const result = await WalletImplementations.importAddress(
        { userId: data.userId },
        {
          address: data.address,
          displayName: data.label,
          detectedInstitutionIds: data.detectedInstitutionIds,
        }
      );

      for (const account of result.accounts) {
        await emitEntityChangeFromWorker(publisher, {
          entityType: 'account',
          operationType: 'create',
          entityId: account.id,
          userId: data.userId,
          data: { institutionId: account.institutionId, name: account.name },
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
          data: {
            reason: 'wallet_import',
            holdingsAffected: result.holdings.length,
          },
        });
      }

      return {
        accountsCreated: result.accounts.length,
        holdingsCreated: result.holdings.length,
        chainsDetected: result.chainsDetected,
        // IDs are needed by the /jobs/:jobId detail page's wallet-import body
        // to render a review table without introducing a bespoke "what did
        // this job create" endpoint. Kept alongside the existing count
        // fields so `JobProgressModal` consumers still work.
        accountIds: result.accounts.map((a) => a.id),
        holdingIds: result.holdings.map((h) => h.id),
        errors: result.errors,
      };
    },
  });
}
