import type { User } from '@scani/db';
import { AccountRepository } from '@scani/domain/repositories';
import { CreateHoldingsWithDependenciesUseCase } from '@scani/domain/use-cases';
import { MANUAL_HOLDINGS_CREATE } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import { CreateAccountDto, CreateInstitutionDto } from '@scani/shared';
import Container from 'typedi';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const newHoldingInputSchema = z.object({
  tokenId: z.string().uuid(),
  balance: z.string().min(1),
});

const updateHoldingInputSchema = z.object({
  holdingId: z.string().uuid(),
  balance: z.string().min(1),
});

const CreateHoldingsBatchInputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    institution: CreateInstitutionDto.optional(),
    accountId: z.string().uuid().optional(),
    account: CreateAccountDto.optional(),
    // Caps protect the worker job payload against a runaway client —
    // the typical screenshot or import surfaces ≤30 holdings; 200 is
    // generous headroom while keeping the payload size bounded.
    newHoldings: z.array(newHoldingInputSchema).max(200).default([]),
    updateHoldings: z.array(updateHoldingInputSchema).max(200).default([]),
    parentJobIdToStampOnSuccess: z.string().min(1).max(200).optional(),
  })
  .refine((d) => d.newHoldings.length + d.updateHoldings.length > 0, {
    message: 'At least one holding (new or updated) is required',
    path: ['newHoldings'],
  })
  .refine((d) => Boolean(d.accountId || d.account), {
    message: 'Either accountId or account details must be provided',
    path: ['accountId'],
  });

export const batchOperationsRouter = router({
  /**
   * Enqueue a manual-holdings-create job. The worker handles the entire
   * pipeline (institution + account + new holdings + balance updates +
   * per-holding price fetch + portfolio valuation + optional parent-job
   * stamp). The frontend navigates to /jobs/{jobId} to watch progress.
   *
   * Request dedup: BullMQ uses `manualHoldingsCreate_{userId}_{requestId}`
   * as the deterministic jobId, so a double-submit returns the same jobId
   * without re-running the work.
   */
  createHoldingsBatch: protectedProcedure
    .input(CreateHoldingsBatchInputSchema)
    .mutation(async ({ input, ctx }): Promise<{ jobId: string }> => {
      const { dbUser } = await requireAuth(ctx);
      if (!dbUser.baseCurrencyId) {
        throw new Error('User must have a base currency set');
      }
      const jobId = await Container.get(BullMqEnqueueService).add(MANUAL_HOLDINGS_CREATE, {
        userId: dbUser.id,
        requestId: input.requestId,
        baseCurrencyId: dbUser.baseCurrencyId,
        institution: input.institution,
        accountId: input.accountId,
        account: input.account,
        newHoldings: input.newHoldings,
        updateHoldings: input.updateHoldings,
        parentJobIdToStampOnSuccess: input.parentJobIdToStampOnSuccess,
      });
      return { jobId };
    }),

  /**
   * Create an account (and optionally an institution) up front, WITHOUT
   * requiring any holdings. Used by the async file/screenshot import
   * flow: if the user picks "new account" in AccountSelectionStep, we
   * need a real accountId before enqueuing the parse job so the job
   * result page can bind the review card to that account.
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
      // `uniqueUserInstitutionAccountName` constraint.
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
      const result = await Container.get(CreateHoldingsWithDependenciesUseCase).execute(
        {
          institution: input.institution,
          account: input.account,
          holdings: [],
        },
        dbUser as User
      );
      if (result.createdInstitution && result.institutionId) {
        emitEntityChange({
          entityType: 'institution',
          operationType: 'create',
          entityId: result.institutionId,
          userId: dbUser.id,
          data: {},
        });
      }
      if (result.createdAccount && result.accountId) {
        emitEntityChange({
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
});
