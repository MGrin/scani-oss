import { ImportExchangeAccountsUseCase, ImportIbkrAccountsUseCase } from '@scani/domain/use-cases';
import type { ExchangeImportJob } from '@scani/queue';
import { emitEntityChangeFromWorker } from '@scani/realtime/publish';
import { type Job, UnrecoverableError } from 'bullmq';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { z } from 'zod';
import { createUserJobProcessor } from '../lib/processor-wrapper';

/**
 * Classify failures that re-running will not fix, so BullMQ skips retries
 * and the user sees the real error immediately on the job page.
 *
 * Auto-retry is fine for transient network/timeout failures, but exchange
 * imports mostly fail on user-actionable conditions: bad credentials,
 * expired tokens, missing permissions, provider rate limits. Retrying
 * those is pure waste — worse for rate limits, where each retry
 * deliberately consumes a slot the user could use for a fresh attempt.
 */
function isUnrecoverableExchangeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    // Explicit IBKR Flex codes — 1010 (bad token), 1012 (expired),
    // 1018 (rate-limited). 1018 gets extra emphasis because retrying
    // actively makes it worse.
    /IBKR Flex Query error \(code 10(10|12|18)\)/.test(msg) ||
    // Generic HTTP auth failures from the exchange services.
    /HTTP 40[13]/.test(msg) ||
    // Signature / nonce / key errors from the exchange services.
    /EAPI:Invalid (signature|nonce|key)/.test(msg) ||
    /rejected request: retCode (10003|10004|10005|10006|33004)/.test(msg) ||
    // Exchange-import targeted a blockchain-type institution. The
    // BlockchainIntegration path requires the wallet-import flow
    // (which supplies userId + walletManager); retrying the exchange
    // job is guaranteed to keep failing identically.
    /No wallet manager available or missing userId in credentials/.test(msg) ||
    /Exchange-import targeted a blockchain-type institution/.test(msg)
  );
}

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

      let result: Awaited<ReturnType<typeof useCase.execute>>;
      try {
        result = await useCase.execute({
          userId: data.userId,
          institutionId: data.institutionId,
        });
      } catch (error) {
        if (isUnrecoverableExchangeError(error)) {
          // BullMQ `UnrecoverableError` short-circuits the retry policy —
          // the job goes to `failed` immediately instead of re-running
          // with exponential backoff.
          const msg = error instanceof Error ? error.message : String(error);
          throw new UnrecoverableError(msg);
        }
        throw error;
      }

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
