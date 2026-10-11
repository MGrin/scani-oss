import { AccountRepository, HoldingRepository } from '@scani/domain/repositories';
import { PricingService } from '@scani/domain/services';
import {
  CreateHoldingsWithDependenciesUseCase,
  DuplicateHoldingTokenError,
  UpdateHoldingPriceUseCase,
} from '@scani/domain/use-cases';
import { MANUAL_HOLDINGS_CREATE } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { emitEntityChange } from '@scani/realtime';
import {
  AMOUNT_MAX_INTEGER_DIGITS,
  amountWithinIntegerDigits,
  CreateAccountDto,
  CreateInstitutionDto,
  HOLDING_LABEL_MAX_LENGTH,
} from '@scani/shared';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { rethrowAccountRefusal } from '../lib/account-refusal';
import { refuseHeldDuplicates } from '../lib/held-duplicates';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { assertTokensVisible } from '../lib/token-visibility';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

// A number, and one no holding is too large for (SC-1527): a 21-digit balance
// went through as `min(1)` and was priced into a $162T net worth. The sign is
// not judged here — a parsed statement can carry a negative card balance, and
// refusing it is not this ticket's call.
const balanceInputSchema = z
  .string()
  .min(1)
  .refine(amountWithinIntegerDigits, {
    message: `Balance must be a number with at most ${AMOUNT_MAX_INTEGER_DIGITS} digits before the decimal point`,
  });

const newHoldingInputSchema = z.object({
  tokenId: z.string().uuid(),
  balance: balanceInputSchema,
  // What the user calls this pot. Present only when the client had to ask —
  // one account, several rows, one token (SC-330).
  label: z.string().trim().max(HOLDING_LABEL_MAX_LENGTH).optional(),
});

const updateHoldingInputSchema = z.object({
  holdingId: z.string().uuid(),
  balance: balanceInputSchema,
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
    .input(strictInput(CreateHoldingsBatchInputSchema))
    .mutation(async ({ input, ctx }): Promise<{ jobId: string }> => {
      const { dbUser } = await requireAuth(ctx);
      if (!dbUser.baseCurrencyId) {
        throw new Error('User must have a base currency set');
      }
      await assertTokensVisible(
        dbUser.id,
        input.newHoldings.map((h) => h.tokenId)
      );
      if (input.accountId) {
        await refuseHeldDuplicates(dbUser.id, input.accountId, input.newHoldings);
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
   * The same create, in the request rather than a job (SC-1617), for an
   * agent: its change is recorded as the rows it wrote, so the write has to
   * have finished when the call returns. Existing account only, and pricing
   * is best-effort, as in the job.
   */
  createHoldingsNow: protectedProcedure
    .input(
      strictInput(
        z.object({
          accountId: z.string().uuid(),
          newHoldings: z.array(newHoldingInputSchema).min(1).max(20),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      if (!dbUser.baseCurrencyId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Set a base currency first' });
      }
      const tokenIds = input.newHoldings.map((h) => h.tokenId);
      await assertTokensVisible(dbUser.id, tokenIds);
      await refuseHeldDuplicates(dbUser.id, input.accountId, input.newHoldings);
      const created = await Container.get(CreateHoldingsWithDependenciesUseCase)
        .execute({ accountId: input.accountId, holdings: input.newHoldings }, dbUser)
        .catch((error: unknown) => {
          if (error instanceof DuplicateHoldingTokenError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
          }
          throw error;
        });
      const base = await Container.get(PricingService).baseToken(dbUser.baseCurrencyId);
      const priced = await Promise.all(
        created.holdings.map(async (h) => {
          if (h.tokenId === base.id) return { holdingId: h.id, priced: true };
          try {
            await Container.get(UpdateHoldingPriceUseCase).execute(h.id, dbUser.id, base);
            return { holdingId: h.id, priced: true };
          } catch {
            return { holdingId: h.id, priced: false };
          }
        })
      );
      for (const h of created.holdings) {
        emitEntityChange({
          entityType: 'holding',
          operationType: 'create',
          entityId: h.id,
          userId: dbUser.id,
        });
      }
      void enqueuePortfolioRollup(dbUser.id);
      return {
        accountId: created.accountId,
        holdings: created.holdings.map((h) => ({
          id: h.id,
          tokenId: h.tokenId,
          balance: h.balance,
          priced: priced.find((p) => p.holdingId === h.id)?.priced ?? false,
        })),
      };
    }),

  /**
   * The account's hand-entered positions for these tokens — the `held` half of
   * the duplicate rule, so the manual-entry form can name a second BTC in
   * place instead of submitting a job that fails on it (SC-1527).
   *
   * Exactly the rows `CreateHoldingsWithDependenciesUseCase` checks against
   * (`findUnsyncedByAccountAndTokens`), hidden ones included, so the form and
   * the worker cannot disagree about what a duplicate is. Scoped by user: an
   * account that is not the caller's reads as holding nothing.
   */
  heldPositions: protectedProcedure
    .input(
      strictInput(
        z.object({
          accountId: z.string().uuid(),
          tokenIds: z.array(z.string().uuid()).max(200),
        })
      )
    )
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const rows = await Container.get(HoldingRepository).findUnsyncedByAccountAndTokens(
        input.accountId,
        input.tokenIds,
        dbUser.id
      );
      return rows.map((row) => ({ tokenId: row.tokenId, label: row.label }));
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
      strictInput(
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
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      if (input.accountId) {
        // The answer is read as "this account is yours" by whatever comes
        // next, so it is checked here rather than trusted downstream (SC-1340).
        const owned = await Container.get(AccountRepository).findByIdAndUser(
          input.accountId,
          dbUser.id
        );
        if (!owned) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' });
        return {
          accountId: owned.id,
          institutionId: owned.institutionId as string | null,
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
      const result = await Container.get(CreateHoldingsWithDependenciesUseCase)
        .execute({ institution: input.institution, account: input.account, holdings: [] }, dbUser)
        .catch(rethrowAccountRefusal);
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
