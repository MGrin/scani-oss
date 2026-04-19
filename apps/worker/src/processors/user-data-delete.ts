import { SettingsImplementations } from '@scani/core/features/implementations';
import type { UserDataDeleteJob } from '@scani/core/queues';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { emitEntityChangeFromWorker } from '../lib/emit-entity-change';
import { createUserJobProcessor } from '../lib/processor-wrapper';

const payloadSchema: z.ZodType<UserDataDeleteJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
});

export function buildUserDataDeleteProcessor(publisher: Redis): (job: Job) => Promise<unknown> {
  return createUserJobProcessor({
    name: 'user-data-delete',
    schema: payloadSchema,
    publisher,
    handler: async (data) => {
      const result = await SettingsImplementations.deleteAllData({ userId: data.userId }, {});
      await emitEntityChangeFromWorker(publisher, {
        entityType: 'user',
        operationType: 'delete',
        entityId: data.userId,
        userId: data.userId,
      });
      return result;
    },
  });
}
