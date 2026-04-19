import { deleteTempBlob, readTempBlob } from '@scani/core/external-services/storage';
import type { FileImportJob } from '@scani/core/queues';
import { ParseFileUseCase } from '@scani/core/use-cases/ParseFileUseCase';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { z } from 'zod';
import { createUserJobProcessor } from '../lib/processor-wrapper';

const payloadSchema: z.ZodType<FileImportJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  r2Key: z.string().min(1),
  fileType: z.enum(['csv', 'ofx', 'qif']),
  accountId: z.string().min(1),
  enrich: z.boolean().optional(),
});

export function buildFileImportProcessor(publisher: Redis): (job: Job) => Promise<unknown> {
  return createUserJobProcessor({
    name: 'file-import',
    schema: payloadSchema,
    publisher,
    handler: async (data) => {
      const buf = await readTempBlob(data.r2Key);
      try {
        const useCase = Container.get(ParseFileUseCase);
        const result = await useCase.execute({
          content: buf.toString('utf-8'),
          filename: `import.${data.fileType}`,
          accountId: data.accountId,
          userId: data.userId,
        });
        return {
          holdings: result.holdings.map((h) => ({
            symbol: h.symbol,
            name: h.name ?? null,
            balance: h.balance,
            confidence: h.confidence,
            notes: h.notes ?? null,
            tokenId: h.tokenId ?? null,
            holdingId: h.holdingId ?? null,
            existingBalance: h.existingBalance ?? null,
          })),
          format: result.format,
          warnings: result.warnings,
        };
      } finally {
        void deleteTempBlob(data.r2Key).catch(() => undefined);
      }
    },
  });
}
