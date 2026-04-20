import { randomUUID } from 'node:crypto';
import { BatchOperationImplementations } from '@scani/domain/features';
import { AccountRepository } from '@scani/domain/repositories';
import { JOB_NAMES } from '@scani/queue';
import { emitBulkEntityChanges, emitEntityChange } from '@scani/realtime';
import {
  CreateAccountDto,
  CreateHoldingsWithDependenciesDto,
  type CreateHoldingsWithDependenciesResponseDto,
  CreateInstitutionDto,
} from '@scani/shared';
import Container from 'typedi';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { enqueueJob } from '../../queues/enqueue';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

// Schema for updating multiple holdings in batch
const UpdateHoldingsBatchSchema = z.object({
  holdings: z
    .array(
      z.object({
        id: z.string().uuid(),
        balance: z.string().regex(/^-?\d+(\.\d+)?$/, 'Balance must be a valid decimal string'),
        lastUpdated: z.string().datetime().optional(),
      })
    )
    .min(1, 'At least one holding is required'),
  /**
   * Optional idempotency key. If the client retries with the same key
   * within the cache TTL (5 minutes), the prior response is returned and
   * the mutation is NOT re-run. Prevents duplicate updates on network
   * retries / double-submits.
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
});

// Extended DTO: accept an optional idempotency key alongside the standard
// CreateHoldingsWithDependenciesDto payload.
const CreateHoldingsInputSchema = CreateHoldingsWithDependenciesDto.extend({
  idempotencyKey: z.string().min(1).max(200).optional(),
});

type UpdateHoldingsBatchResult = {
  updated: Array<{
    id: string;
    success: boolean;
    error?: string;
  }>;
  totalUpdated: number;
  totalFailed: number;
};

export const batchOperationsRouter = router({
  createHoldingsWithDependencies: protectedProcedure
    .input(CreateHoldingsInputSchema)
    .mutation(async ({ input, ctx }): Promise<CreateHoldingsWithDependenciesResponseDto> => {
      const { dbUser } = await requireAuth(ctx);
      const { idempotencyKey, ...payload } = input;
      const result = await withIdempotency(dbUser.id, idempotencyKey, () =>
        BatchOperationImplementations.createHoldingsWithDependencies(
          { userId: dbUser.id, dbUser },
          payload
        )
      );

      // Broadcast the new entities so other open tabs / sessions for this
      // user see the imported data without a manual reload. Without these,
      // file-import and manual-entry flows only updated the initiating tab
      // (via React Query invalidation in `onSuccess`), and a second tab
      // would drift out of sync until the user refreshed it.
      if (result.createdInstitution && result.institutionId) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'institution',
          operationType: 'create',
          entityId: result.institutionId,
          userId: dbUser.id,
          data: {},
        });
      }
      if (result.createdAccount && result.accountId) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'account',
          operationType: 'create',
          entityId: result.accountId,
          userId: dbUser.id,
          data: { institutionId: result.institutionId },
        });
      }
      const createdHoldingIds = result.holdings.map((h) => h.id);
      if (createdHoldingIds.length > 0) {
        emitBulkEntityChanges('holding', 'create', createdHoldingIds, dbUser.id, {
          source: 'batch-operations.createHoldingsWithDependencies',
        });
      }

      // Kick off async price fetch for every new non-base-currency holding.
      // PortfolioValuationService only reads cached prices; without this the
      // token_prices row never gets written and the holding shows unpriced
      // until the user hits the manual refresh button.
      const baseCurrencyId = dbUser.baseCurrencyId;
      for (const holding of result.holdings) {
        if (baseCurrencyId && holding.tokenId === baseCurrencyId) continue;
        await enqueueJob(JOB_NAMES.holdingPriceUpdate, {
          userId: dbUser.id,
          requestId: randomUUID(),
          holdingId: holding.id,
          priceUsd: 0,
          priceSource: 'fetch',
        });
      }

      return result;
    }),

  /**
   * Create an account (and optionally an institution) up front, WITHOUT
   * requiring any holdings. Used by the async file/screenshot import
   * flow: if the user picks "new account" in AccountSelectionStep, we
   * need a real accountId before enqueuing the parse job so the job
   * result page can bind the review card to that account.
   *
   * Backed by `createHoldingsWithDependencies` with an empty holdings
   * array — the use case already handles the no-holdings case, so we
   * just bypass the Zod `.min(1)` guard on the public DTO by taking a
   * slimmer input here.
   */
  ensureAccount: protectedProcedure
    .input(
      z
        .object({
          accountId: z.string().uuid().optional(),
          institution: CreateInstitutionDto.optional(),
          account: CreateAccountDto.optional(),
        })
        .refine(
          (v) => Boolean(v.accountId || v.account),
          'Either accountId or account must be provided'
        )
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      // Short-circuit when the client already has a real accountId —
      // avoids an unnecessary no-op transaction.
      if (input.accountId) {
        return {
          accountId: input.accountId,
          institutionId: null as string | null,
          createdAccount: false,
          createdInstitution: false,
        };
      }
      // Idempotent lookup: if the user already has an account with this
      // (institutionId, name) on an existing institution, return it
      // instead of attempting a duplicate insert. The file-import flow
      // calls `ensureAccount` on every file-select; if an earlier attempt
      // succeeded and a later step (R2 upload, parse enqueue) failed, the
      // user retrying would otherwise trip the
      // `uniqueUserInstitutionAccountName` constraint and see an opaque
      // "undefined:undefined" DB error.
      if (input.account?.institutionId && input.account.name) {
        const accountRepository = Container.get(AccountRepository);
        const existing = await accountRepository.findByUserInstitutionName(
          dbUser.id,
          input.account.institutionId,
          input.account.name
        );
        if (existing) {
          return {
            accountId: existing.id,
            institutionId: existing.institutionId,
            createdAccount: false,
            createdInstitution: false,
          };
        }
      }
      const result = await BatchOperationImplementations.createHoldingsWithDependencies(
        { userId: dbUser.id, dbUser },
        {
          institution: input.institution,
          account: input.account,
          holdings: [],
        }
      );
      if (result.createdInstitution && result.institutionId) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'institution',
          operationType: 'create',
          entityId: result.institutionId,
          userId: dbUser.id,
          data: {},
        });
      }
      if (result.createdAccount && result.accountId) {
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'account',
          operationType: 'create',
          entityId: result.accountId,
          userId: dbUser.id,
          data: { institutionId: result.institutionId },
        });
      }
      return {
        accountId: result.accountId,
        institutionId: result.institutionId,
        createdAccount: result.createdAccount,
        createdInstitution: result.createdInstitution,
      };
    }),

  updateHoldingsBatch: protectedProcedure
    .input(UpdateHoldingsBatchSchema)
    .mutation(async ({ input, ctx }): Promise<UpdateHoldingsBatchResult> => {
      const { dbUser } = await requireAuth(ctx);
      const { idempotencyKey, ...payload } = input;
      const result = await withIdempotency(dbUser.id, idempotencyKey, () =>
        BatchOperationImplementations.updateHoldingsBatch({ userId: dbUser.id, dbUser }, payload)
      );

      // Broadcast successful updates so other tabs refresh too.
      const updatedIds = result.updated.filter((u) => u.success).map((u) => u.id);
      if (updatedIds.length > 0) {
        emitBulkEntityChanges('holding', 'update', updatedIds, dbUser.id, {
          source: 'batch-operations.updateHoldingsBatch',
        });
      }

      return result;
    }),
});
