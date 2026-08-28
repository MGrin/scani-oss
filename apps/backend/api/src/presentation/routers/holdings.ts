import {
  AccountRepository,
  AccountTypeRepository,
  GroupRepository,
  HoldingApyConfigRepository,
  HoldingRepository,
  TokenRepository,
} from '@scani/domain/repositories';
import {
  HoldingQueryService,
  HoldingService,
  ManualBalanceEditService,
  RealizedLedgerService,
} from '@scani/domain/services';
import {
  BulkAssignHoldingGroupsUseCase,
  DeleteHoldingUseCase,
  HoldingLabelTakenError,
  ManualOutflowAnswerRefused,
  MovementExceedsBalanceError,
  MovementHoldingNotFoundError,
  MovementSameHoldingError,
  RecordHoldingMovementUseCase,
  UpdateHoldingUseCase,
} from '@scani/domain/use-cases';
import { HOLDING_PRICE_UPDATE, REFRESH_ACCOUNT_BALANCE } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { emitBulkEntityChanges, emitEntityChange } from '@scani/realtime';
import {
  Decimal,
  type ManualEditCause,
  parseCostBasisMethod,
  type RealizedLedger,
  RecordHoldingMovementDto,
  toDisposalLotMatchDto,
  UpdateHoldingDto,
  UpsertHoldingApyConfigDto,
} from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { executeBulkOperation } from '../lib/bulk-operation';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const holdingsRouter = router({
  // Get all holdings with full details (for Holdings page)
  getWithDetails: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(HoldingQueryService).getHoldingsByAccountIdWithSummary(
      dbUser,
      undefined,
      false,
      ctx.requestCache
    );
  }),

  /**
   * The lots behind this holding's realized figure (SC-152).
   *
   * Computed on the read, not stored: no table, no migration, no job, and the
   * nightly rollup keeps walking without collecting anything, so this adds no
   * recurring cost. It is only ever called when somebody opens a record and
   * asks why.
   *
   * Deliberately not folded into `getWithDetails`. That query loads the whole
   * holdings list on every visit, and putting a per-holding lot walk in it
   * would make the ordinary case pay for the rare question.
   *
   * Not a tax export and must not become one — see
   * `docs/technical/2026-08-14_why-no-tax-statement.md`.
   */
  realizedLedger: protectedProcedure
    .input(strictInput(z.object({ holdingId: z.string().uuid() })))
    .query(async ({ ctx, input }): Promise<RealizedLedger> => {
      const { dbUser } = await requireAuth(ctx);
      // Ownership guard — without it the endpoint is an IDOR, and this one
      // returns acquisition prices and dates.
      const holding = await Container.get(HoldingRepository).findById(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Holding not found' });
      }
      const baseCurrencyId = dbUser.baseCurrencyId ?? null;
      if (!baseCurrencyId) {
        // Every figure in the ledger is denominated in the base currency, so
        // without one there is no ledger to report — not an empty one.
        return {
          holdingId: input.holdingId,
          baseCurrencyId: null,
          rows: [],
          realizedTotal: '0',
        };
      }
      const rows = await Container.get(RealizedLedgerService).forHolding(
        dbUser.id,
        input.holdingId,
        baseCurrencyId,
        new Date(),
        // The account's own identification rule (SC-462). Read on every walk
        // rather than cached: this ledger is what a reader opens to find out
        // WHY a gain is what it is, so it must be computed under the rule the
        // rest of their figures now use.
        parseCostBasisMethod(dbUser.costBasisMethod)
      );
      const realizedTotal = rows.reduce(
        (sum, row) => (row.gain ? sum.add(row.gain) : sum),
        new Decimal(0)
      );
      return {
        holdingId: input.holdingId,
        baseCurrencyId,
        rows: rows.map(toDisposalLotMatchDto),
        realizedTotal: realizedTotal.toString(),
      };
    }),

  // Holdings hidden from the dashboard — user-hidden or auto-flagged as
  // scam. Powers the Tokens page "Hidden Holdings" section.
  getHidden: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(HoldingQueryService).getHiddenHoldings(dbUser);
  }),

  update: protectedProcedure
    .input(
      strictInput(
        z.object({
          id: z.string().uuid(),
          data: UpdateHoldingDto,
          // Optional client-supplied key. If the same (userId, key)
          // arrives within the 5-min cache window — e.g. a network
          // retry or double-click — the cached response is returned
          // and the underlying mutation runs only once. Frontend
          // opts in by passing `crypto.randomUUID()` per submission;
          // omitting the key is equivalent to the previous behaviour
          // (no de-dup).
          idempotencyKey: z.string().min(1).max(128).optional(),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const editCause = await resolveEditCause(input.id, dbUser.id, input.data);

        // `label` is forwarded only when the client sent the key at all.
        // `null` clears the name and `undefined` leaves it alone, and a
        // balance edit sends neither — spreading it unconditionally would
        // make every balance edit an un-naming (SC-564).
        const updatedHolding = await Container.get(UpdateHoldingUseCase)
          .execute(
            input.id,
            {
              balance: input.data.balance,
              isActive: input.data.isActive,
              ...('label' in input.data ? { label: input.data.label } : {}),
              ...(editCause ? { editCause } : {}),
              ...(input.data.editOccurredAt
                ? { editOccurredAt: new Date(input.data.editOccurredAt) }
                : {}),
              // Where the money went, when the client asked and answered in
              // one dialog (SC-606). Forwarded only when present: absent
              // leaves the synthesized outflow in the transfer-review queue,
              // which is every pre-SC-606 client's behaviour unchanged.
              ...(input.data.editOutflow ? { editOutflow: input.data.editOutflow } : {}),
            },
            dbUser.id
          )
          .catch((error) => {
            // A refusal the reader can act on, not a 500. They are looking at
            // the sheet for the row they just tried to name, and the other row
            // wearing that name is one they can see.
            // The destination went away between the picker and the submit,
            // or a client sent one beside an edit that writes no withdrawal.
            // Both are things the reader can act on, and the edit was rolled
            // back — so this is a refusal, not a 500 over a lost balance.
            if (error instanceof ManualOutflowAnswerRefused) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
            }
            if (error instanceof HoldingLabelTakenError) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: `Another holding for this token in this account is already called "${error.label}". Pot names have to tell the rows apart.`,
              });
            }
            throw error;
          });

        emitEntityChange({
          entityType: 'holding',
          operationType: 'update',
          entityId: updatedHolding.id,
          userId: dbUser.id,
          data: {
            accountId: updatedHolding.accountId,
            tokenId: updatedHolding.tokenId,
          },
        });

        void enqueuePortfolioRollup(dbUser.id);
        return updatedHolding;
      });
    }),

  /**
   * "I withdrew 2000" — the movement, not the balance it leaves (SC-607).
   *
   * Beside `update` rather than replacing it. Editing the amount directly
   * stays, because it is the right verb when reconciling against a statement
   * where the closing figure is the only thing known; this is the right verb
   * when the owner knows what they DID. The first became the correction path,
   * not the only path.
   *
   * `idempotencyKey` matters more here than on `update`: an `update` replayed
   * with the same balance is idempotent by nature, while a movement replayed
   * moves the money twice. The use case is keyed defensively as well — both
   * legs collapse onto their own dedup rows — but the balance ANCHOR would
   * still be advanced twice, so the key is the real guard and the client sends
   * one per submission.
   */
  recordMovement: protectedProcedure
    .input(
      strictInput(
        z.object({
          movement: RecordHoldingMovementDto,
          idempotencyKey: z.string().min(1).max(128).optional(),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const result = await Container.get(RecordHoldingMovementUseCase)
          .execute(input.movement, dbUser.id)
          .catch((error) => {
            // Each of these is something the owner can act on from the sheet
            // they are looking at, so each is a refusal with a sentence rather
            // than a 500 with a stack trace.
            if (error instanceof MovementHoldingNotFoundError) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Holding not found' });
            }
            if (error instanceof MovementExceedsBalanceError) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `This holding holds ${error.balance}, so ${error.amount} cannot leave it.`,
              });
            }
            if (error instanceof MovementSameHoldingError) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'A transfer has to go to a different holding.',
              });
            }
            throw error;
          });

        emitEntityChange({
          entityType: 'holding',
          operationType: 'update',
          entityId: result.holdingId,
          userId: dbUser.id,
          data: {},
        });
        if (result.destinationHoldingId) {
          emitEntityChange({
            entityType: 'holding',
            operationType: 'update',
            entityId: result.destinationHoldingId,
            userId: dbUser.id,
            data: {},
          });
        }

        void enqueuePortfolioRollup(dbUser.id);
        return result;
      });
    }),

  // Delete holding (with cascading to transactions)
  delete: protectedProcedure
    .input(strictInput(z.object({ id: z.string().uuid() })))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await Container.get(DeleteHoldingUseCase).execute(input.id, dbUser.id, {
        baseCurrencyId: dbUser.baseCurrencyId || undefined,
      });

      emitEntityChange({
        entityType: 'holding',
        operationType: 'delete',
        entityId: result.deleted.id,
        userId: dbUser.id,
        metadata: {
          relatedEntities: [
            {
              type: 'account',
              id: result.deleted.accountId,
            },
          ],
        },
      });

      void enqueuePortfolioRollup(dbUser.id);
      return result;
    }),

  bulkDelete: protectedProcedure
    .input(strictInput(z.object({ ids: z.array(z.string()).min(1) })))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const useCase = Container.get(DeleteHoldingUseCase);
      const baseCurrencyId = dbUser.baseCurrencyId || undefined;

      const result = await executeBulkOperation(input.ids, (id) =>
        useCase.execute(id, dbUser.id, { baseCurrencyId })
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (result.deletedIds.length > 0) {
        emitBulkEntityChanges('holding', 'delete', result.deletedIds, dbUser.id);
        void enqueuePortfolioRollup(dbUser.id);
      }

      return result;
    }),

  // Restore a hidden holding (unmark as hidden)
  restore: protectedProcedure
    .input(strictInput(z.object({ id: z.string().uuid() })))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const holdingRepository = Container.get(HoldingRepository);
      const holdingService = Container.get(HoldingService);
      const holding = await holdingRepository.findById(input.id);
      if (!holding) throw new Error('Holding not found');
      if (holding.userId !== dbUser.id) {
        throw new Error('Unauthorized: Holding does not belong to user');
      }
      if (!holding.isHidden) throw new Error('Holding is not hidden');
      const result = await holdingService.unhideHoldingWithEvent(input.id);
      if (!result) throw new Error('Failed to restore holding');

      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: result.id,
        userId: dbUser.id,
        data: {
          accountId: result.accountId,
          tokenId: result.tokenId,
        },
      });

      void enqueuePortfolioRollup(dbUser.id);
      return result;
    }),

  /**
   * Enqueue a holding price refresh. Fetches fresh price from pricing
   * providers (1–3s), then cascades to vault recalculation on the worker.
   * Returns a jobId for the UI to track.
   */
  updatePrice: protectedProcedure
    .input(
      strictInput(
        z.object({
          id: z.string().uuid(),
          requestId: z.string().uuid(),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const jobId = await Container.get(BullMqEnqueueService).add(HOLDING_PRICE_UPDATE, {
        userId: dbUser.id,
        requestId: input.requestId,
        holdingId: input.id,
        // The worker fetches fresh price from providers; these fields are
        // placeholders for a future manual-override payload.
        priceUsd: 0,
        priceSource: 'fetch',
      });
      return { jobId };
    }),

  // Per-holding "Refresh balance" trigger. Looks up the holding, finds
  // the underlying account, and enqueues a balance refresh that hits
  // the same chain / CEX / brokerage provider the hourly cron does.
  // Manual-source holdings have no integration to refresh — the
  // endpoint rejects them with PRECONDITION_FAILED so the frontend can
  // surface a clean "edit the balance manually" message instead of
  // queuing a no-op job. The job's BullMQ id is per-(user, account)
  // so a flurry of clicks collapses to one in-flight refresh.
  refreshBalance: protectedProcedure
    .input(
      strictInput(
        z.object({
          holdingId: z.string().uuid(),
          requestId: z.string().uuid(),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const holdingRepo = Container.get(HoldingRepository);
      const holding = await holdingRepo.findById(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Holding not found' });
      }
      if (!holding.source || holding.source === 'manual') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'This holding is manual — edit the balance directly. Refresh is only for wallet / exchange / broker holdings.',
        });
      }
      const jobId = await Container.get(BullMqEnqueueService).add(REFRESH_ACCOUNT_BALANCE, {
        userId: dbUser.id,
        requestId: input.requestId,
        holdingId: holding.id,
        accountId: holding.accountId,
      });
      return { jobId };
    }),

  bulkAssignGroups: protectedProcedure
    .input(
      strictInput(
        z.object({
          // 500 is well above any realistic UI selection — the bulk-edit
          // grid maxes around the visible viewport — but bounded so a
          // hostile or buggy client can't request a multi-thousand-row
          // database operation in a single round-trip.
          holdingIds: z.array(z.string()).min(1).max(500),
          // The dialog computes an explicit diff between the pre-checked
          // common-groups state and the user's save selection, then sends
          // add/remove sets. Preferable to REPLACE semantics because
          // REPLACE would clobber any per-holding groups that weren't in
          // the pre-checked set.
          addedGroupIds: z.array(z.string()).max(50).default([]),
          removedGroupIds: z.array(z.string()).max(50).default([]),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await Container.get(BulkAssignHoldingGroupsUseCase).execute(
        {
          holdingIds: input.holdingIds,
          addedGroupIds: input.addedGroupIds,
          removedGroupIds: input.removedGroupIds,
        },
        dbUser.id
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (input.holdingIds.length > 0) {
        emitBulkEntityChanges('holding', 'update', input.holdingIds, dbUser.id);
      }

      return result;
    }),

  getCommonGroups: protectedProcedure
    // Allow empty arrays — "common groups across 0 holdings" is well-
    // defined (empty set), and the frontend can transiently pass []
    // while the dialog is mounting or mid-transition. Returning []
    // is cheaper and friendlier than a 400.
    .input(strictInput(z.object({ holdingIds: z.array(z.string()).max(500) })))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      if (input.holdingIds.length === 0) return [];

      // Single batch query that joins through holdings + filters by
      // user_id. Replaces N sequential findGroupsByHoldingId calls
      // (one DB roundtrip per holding) plus the pre-flight
      // findByUserWithFullDetails (5-table join just for ownership
      // validation). For 100 holdings this dropped from ~101 DB
      // roundtrips to 2 (1 batch + 1 ownership backfill for owned
      // holdings with zero groups).
      const groupRepository = Container.get(GroupRepository);
      const groupsMap = await groupRepository.findGroupsByHoldingIds(dbUser.id, input.holdingIds);
      const invalidHoldingIds = input.holdingIds.filter((id) => !groupsMap.has(id));
      if (invalidHoldingIds.length > 0) {
        throw new Error(
          `Unauthorized: Cannot access groups for holdings that don't belong to you: ${invalidHoldingIds.join(
            ', '
          )}`
        );
      }

      // Intersect the per-holding group lists.
      const perHolding = input.holdingIds.map((id) => groupsMap.get(id) ?? []);
      if (perHolding.length === 0) return [];
      return perHolding.reduce((common, holdingGroups) => {
        const holdingGroupIds = new Set(holdingGroups.map((g) => g.id));
        return common.filter((group) => holdingGroupIds.has(group.id));
      });
    }),

  // APY Config endpoints
  getApyConfig: protectedProcedure
    .input(strictInput(z.object({ holdingId: z.string().uuid() })))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const holdingRepository = Container.get(HoldingRepository);
      const apyConfigRepository = Container.get(HoldingApyConfigRepository);
      const holding = await holdingRepository.findByIdVisible(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) throw new Error('Holding not found');
      return await apyConfigRepository.findByHoldingId(input.holdingId);
    }),

  upsertApyConfig: protectedProcedure
    .input(strictInput(UpsertHoldingApyConfigDto))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const holdingRepository = Container.get(HoldingRepository);
      const accountRepository = Container.get(AccountRepository);
      const accountTypeRepository = Container.get(AccountTypeRepository);
      const apyConfigRepository = Container.get(HoldingApyConfigRepository);
      const holding = await holdingRepository.findByIdVisible(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) throw new Error('Holding not found');

      const account = await accountRepository.findById(holding.accountId);
      if (!account) throw new Error('Account not found');
      const accountType = await accountTypeRepository.findById(account.typeId);
      if (!accountType || !['checking', 'savings', 'investment'].includes(accountType.code)) {
        throw new Error(
          'APY configuration is only available for checking, savings, and investment accounts'
        );
      }

      const result = await apyConfigRepository.upsertByHoldingId(input.holdingId, {
        annualRatePct: input.annualRatePct,
        payoutFrequency: input.payoutFrequency,
        payoutDayOfWeek: input.payoutDayOfWeek ?? null,
        payoutDayOfMonth: input.payoutDayOfMonth ?? null,
        payoutMonth: input.payoutMonth ?? null,
      });

      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: input.holdingId,
        userId: dbUser.id,
      });

      return result;
    }),

  deleteApyConfig: protectedProcedure
    .input(strictInput(z.object({ holdingId: z.string().uuid() })))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const holdingRepository = Container.get(HoldingRepository);
      const apyConfigRepository = Container.get(HoldingApyConfigRepository);
      const holding = await holdingRepository.findByIdVisible(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) throw new Error('Holding not found');
      const result = await apyConfigRepository.deleteByHoldingId(input.holdingId);

      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: input.holdingId,
        userId: dbUser.id,
      });

      return result;
    }),
});

/**
 * What this balance edit meant, or a refusal (SC-510).
 *
 * `null` when the edit does not move a balance — an `isActive` toggle has no
 * cause and must not write a ledger row. Otherwise `ManualBalanceEditService`
 * decides from what the user said, the token type, and this holding's
 * remembered answer, and a holding it cannot answer for raises `BAD_REQUEST`.
 *
 * ## The refusal is the feature, and it is the thing to resist "fixing"
 *
 * Defaulting here would be easy and would look harmless: almost every edit
 * really is a flow. But this is a blindness state — we do not know what the
 * delta meant — and a blindness state that quietly resolves to the likely
 * answer is at its most persuasive exactly when it is wrong. Treat a monthly
 * savings top-up as a flow and it is right; treat the interest credit that
 * looks identical as a flow and that account returns 0% forever, printed as a
 * plausible number nobody questions.
 *
 * So it is loud instead. The SPA never sees this error, because it shows the
 * three-way control for the same set of holdings this predicate names; a
 * client that does not is told to ask rather than answered for.
 */
async function resolveEditCause(
  holdingId: string,
  userId: string,
  data: { balance?: string; editCause?: ManualEditCause }
): Promise<ManualEditCause | null> {
  if (data.balance === undefined) return null;

  const holding = await Container.get(HoldingRepository).findById(holdingId);
  if (!holding || holding.userId !== userId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Holding not found' });
  }

  const token = await Container.get(TokenRepository).findWithType(holding.tokenId);
  const cause = Container.get(ManualBalanceEditService).resolveCause({
    tokenTypeCode: token?.typeCode ?? null,
    requested: data.editCause,
    remembered: holding.manualEditCause,
  });

  if (!cause) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        "This holding's balance carries its own performance — a change to it could be money added or withdrawn, a correction to the previous figure, or growth. Send `editCause` so it is not guessed at.",
    });
  }
  return cause;
}
