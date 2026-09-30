/**
 * Payments tRPC router.
 *
 * Thin wiring over `PaymentService` / `PaymentRepository` /
 * `PaymentOccurrenceRepository` / `ReconcilePaymentsUseCase` — every
 * mutation here takes a client-supplied id (a payment, an occurrence)
 * and every one of them is re-verified against `ctx.userId` before any
 * read or write, either by the service (`PaymentService` — see its own
 * module doc) or, for `list`/`upcoming`, by scoping the initial query to
 * `ctx.userId` so nothing outside that scope is ever loaded.
 *
 * Wire conventions: `expectedAmount` / `actualAmount` are Decimal
 * strings, never parsed into a JS number — a float here would defeat
 * every `Decimal` the domain layer uses once the value lands back on a
 * write. `anchorDate` / `endDate` / `dueDate` are plain `YYYY-MM-DD`
 * strings end to end — `PaymentService`'s own inputs already take dates
 * this way (they map straight onto Postgres `date` columns), so there's
 * no `Date` parsing step in either direction. `createdAt` / `updatedAt`
 * are `timestamptz` columns and DO cross as ISO strings, converted here
 * rather than left as `Date` — same convention as `review.ts`.
 */

import type { Payment, PaymentOccurrence } from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { PaymentOccurrenceRepository, PaymentRepository } from '@scani/domain/repositories';
import {
  PaymentForecastService,
  PaymentHasSettledOccurrencesError,
  PaymentService,
  RecurringSuggestionService,
  SuggestionNotFoundError,
} from '@scani/domain/services';
import {
  AnchorOccurrenceMissingError,
  CreatePaymentFromExtractionUseCase,
  ExtractionNotFoundError,
} from '@scani/domain/use-cases';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { assertTokensVisible } from '../lib/token-visibility';
import { protectedProcedure, router } from '../trpc';

const PAYMENT_DIRECTION = z.enum(['outflow', 'inflow']);
const PAYMENT_KIND = z.enum(['fixed', 'variable']);
const PAYMENT_INTERVAL_UNIT = z.enum(['week', 'month', 'quarter', 'year']);
const OCCURRENCE_SETTLE_STATUS = z.enum(['matched', 'skipped']);
const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date string');

const SuggestionKeySchema = z.object({
  counterpartyKey: z.string().min(1).max(500),
  currencyTokenId: z.string().uuid(),
});

const CreatePaymentInputSchema = z.object({
  groupIds: z.array(z.string().uuid()).max(100).optional(),
  vendorId: z.string().uuid(),
  direction: PAYMENT_DIRECTION,
  kind: PAYMENT_KIND,
  expectedAmount: z.string().nullable().optional(),
  currencyTokenId: z.string().uuid(),
  intervalUnit: PAYMENT_INTERVAL_UNIT,
  intervalCount: z.number().int().positive(),
  anchorDate: DATE_STRING,
  endDate: DATE_STRING.nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  // SC-625's opt-in. Absent means off, which is the whole point of the
  // feature — see the migration for why the default is not a placeholder.
  estimateFromHistory: z.boolean().optional(),
});

// Same shape as `CreatePaymentInputSchema` minus `vendorId`, which
// becomes nullable here: null means "derive the vendor from the
// extraction's own `vendorNameRaw`" rather than "no vendor" (a payment
// always has one).
const CreatePaymentFromExtractionInputSchema = CreatePaymentInputSchema.omit({
  vendorId: true,
}).extend({
  extractionId: z.string().uuid(),
  vendorId: z.string().uuid().nullable().optional(),
  markAnchorPaid: z.boolean().default(false),
});

const UpdatePaymentInputSchema = z.object({
  groupIds: z.array(z.string().uuid()).max(100).optional(),
  paymentId: z.string().uuid(),
  vendorId: z.string().uuid().optional(),
  direction: PAYMENT_DIRECTION.optional(),
  kind: PAYMENT_KIND.optional(),
  expectedAmount: z.string().nullable().optional(),
  currencyTokenId: z.string().uuid().optional(),
  intervalUnit: PAYMENT_INTERVAL_UNIT.optional(),
  intervalCount: z.number().int().positive().optional(),
  anchorDate: DATE_STRING.optional(),
  endDate: DATE_STRING.nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  estimateFromHistory: z.boolean().optional(),
});

// A cap on the bulk write, and it is about the SENTENCE the surface says
// rather than about database load. "Use last month's actual for all of them"
// is a claim the reader can hold in their head over a book of this size; a
// request naming ten thousand ids is not that act, whatever it is.
const ESTIMATE_FROM_HISTORY_MAX_PAYMENTS = 500;

const SetEstimateFromHistoryInputSchema = z.object({
  paymentIds: z.array(z.string().uuid()).min(1).max(ESTIMATE_FROM_HISTORY_MAX_PAYMENTS),
  enabled: z.boolean(),
});

function serializePayment(payment: Payment) {
  return {
    ...payment,
    // Null whenever the payment is not paused, so unlike the other two
    // timestamps this one crosses as `string | null` — the client reads
    // it to state what resuming will do to the elapsed due dates.
    pausedAt: payment.pausedAt ? payment.pausedAt.toISOString() : null,
    createdAt: payment.createdAt.toISOString(),
    updatedAt: payment.updatedAt.toISOString(),
  };
}

function serializeOccurrence(occurrence: PaymentOccurrence) {
  return {
    ...occurrence,
    createdAt: occurrence.createdAt.toISOString(),
    updatedAt: occurrence.updatedAt.toISOString(),
  };
}

function startOfUtcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// `days` out from "now" as a `YYYY-MM-DD` string, for comparing against
// `dueDate` (a plain date-string column) without ever constructing a
// `Date` from it.
function horizonDateString(days: number): string {
  const today = startOfUtcToday();
  return new Date(today.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * `at` crosses as an ISO string, per this file's wire convention for
 * `timestamptz` (SC-661).
 *
 * Not a formatting preference. There is no superjson transformer on this
 * router, so a `Date` left in the payload arrives at the client as a string
 * while `RouterOutputs` still types it `Date` — a type that disagrees with the
 * value at runtime, on a field a surface formats. The domain function keeps
 * returning `Date` because that is what it means; the conversion belongs at the
 * wire, once.
 */

export const paymentsRouter = router({
  groupAssignments: protectedProcedure.query(({ ctx }) =>
    Container.get(PaymentService).groupAssignments(ctx.userId)
  ),
  assignGroups: protectedProcedure
    .input(
      strictInput(
        z.object({
          paymentId: z.string().uuid(),
          occurrenceId: z.string().uuid().optional(),
          groupIds: z.array(z.string().uuid()).max(100),
        })
      )
    )
    .mutation(({ ctx, input }) => Container.get(PaymentService).assignGroups(ctx.userId, input)),
  editOccurrence: protectedProcedure
    .input(
      strictInput(
        z.object({
          occurrenceId: z.string().uuid(),
          expectedAmount: z.string().nullable(),
          groupIds: z.array(z.string().uuid()).max(100).optional(),
        })
      )
    )
    .mutation(({ ctx, input }) =>
      Container.get(PaymentService).editOccurrence(ctx.userId, input.occurrenceId, {
        expectedAmount: input.expectedAmount,
        groupIds: input.groupIds,
      })
    ),
  scheduled: protectedProcedure.query(({ ctx }) =>
    Container.get(PaymentForecastService).forecast(ctx.userId)
  ),

  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await Container.get(PaymentRepository).findByUser(ctx.userId);
    return rows.map(serializePayment);
  }),

  get: protectedProcedure
    .input(strictInput(z.object({ paymentId: z.string().uuid() })))
    .query(async ({ ctx, input }) => {
      const payment = await Container.get(PaymentRepository).findByIdAndUser(
        input.paymentId,
        ctx.userId
      );
      if (!payment) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Payment not found' });
      }
      // Safe without a second ownership check: `payment.id` only reaches
      // here after `findByIdAndUser` already proved it belongs to
      // `ctx.userId` — `findByPaymentId` itself is not ownership-scoped
      // (see PaymentOccurrenceRepository's own doc comment).
      const occurrences = await Container.get(PaymentOccurrenceRepository).findByPaymentId(
        payment.id
      );
      return {
        payment: serializePayment(payment),
        occurrences: occurrences.map(serializeOccurrence),
      };
    }),

  create: protectedProcedure
    .input(strictInput(CreatePaymentInputSchema))
    .mutation(async ({ ctx, input }) => {
      await assertTokensVisible(ctx.userId, [input.currencyTokenId]);
      const payment = await Container.get(PaymentService).create(ctx.userId, input);
      return serializePayment(payment);
    }),

  /**
   * Approve a parsed invoice INTO a recurring payment — the write side of
   * the review feed's "this is a subscription" decision. Replaces a bare
   * `documents.acceptExtraction` when the user fills the payment form:
   * vendor find-or-create, payment + occurrence materialisation, optional
   * settlement of the anchor occurrence (a PAID invoice), and flipping the
   * extraction to 'accepted' all commit together or not at all — see
   * `CreatePaymentFromExtractionUseCase`'s own doc for why a partial
   * apply here would let a second approval create a duplicate payment.
   *
   * `extractionId` is a client-supplied id and is never trusted: the use
   * case loads it through `DocumentExtractionRepository.findByIdAndUser`,
   * whose join through `documents` IS the ownership check, and both
   * "doesn't exist" and "belongs to someone else" surface as the same
   * NOT_FOUND here.
   */
  createFromExtraction: protectedProcedure
    .input(strictInput(CreatePaymentFromExtractionInputSchema))
    .mutation(async ({ ctx, input }) => {
      await assertTokensVisible(ctx.userId, [input.currencyTokenId]);
      try {
        const payment = await withTransaction(
          (tx) => Container.get(CreatePaymentFromExtractionUseCase).execute(ctx.userId, input, tx),
          { name: 'payments.createFromExtraction', timeout: 15000 }
        );
        return serializePayment(payment);
      } catch (error) {
        if (error instanceof ExtractionNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Extraction not found' });
        }
        if (error instanceof AnchorOccurrenceMissingError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw error;
      }
    }),

  update: protectedProcedure
    .input(strictInput(UpdatePaymentInputSchema))
    .mutation(async ({ ctx, input }) => {
      const { paymentId, ...patch } = input;
      await assertTokensVisible(ctx.userId, [patch.currencyTokenId]);
      const updated = await Container.get(PaymentService).update(ctx.userId, paymentId, patch);
      return serializePayment(updated);
    }),

  /**
   * Turn SC-625's history estimate on or off across a named set of payments —
   * the "use it for all of them" act, and the per-payment one too, since one
   * id is a set of one.
   *
   * ## Why the client names the ids rather than saying "all"
   *
   * The set the reader is agreeing to is the one the forecast just showed
   * them: the payments it could not project. Letting the server re-derive
   * that set would put the rule in two places, and the two would answer
   * differently the moment a settlement landed between the render and the tap
   * — the reader would be agreeing to a sentence about N payments and
   * changing N+1. Named ids make the request the same act the screen
   * described.
   *
   * ## Why this does not go through `PaymentService.update`
   *
   * That path invalidates and re-materialises a schedule when the fields
   * governing due dates change, and it compares amounts to decide whether
   * future occurrences need rewriting. This flag changes neither: the
   * estimate is derived at read time and no due date moves. Routing a
   * single-column write through it would run schedule work for a change that
   * cannot affect a schedule — and doing so once per payment, which is the
   * shape "for all of them" would take.
   *
   * Ownership lives in the repository's `WHERE`, so an id belonging to
   * somebody else matches nothing and the count comes back smaller. The count
   * is returned rather than a success flag for exactly that reason: it is the
   * only thing that distinguishes "changed them all" from "changed some".
   */
  setEstimateFromHistory: protectedProcedure
    .input(strictInput(SetEstimateFromHistoryInputSchema))
    .mutation(async ({ ctx, input }) => {
      const updated = await Container.get(PaymentRepository).setEstimateFromHistory(
        ctx.userId,
        input.paymentIds,
        input.enabled
      );
      return { updated: updated.length, requested: input.paymentIds.length };
    }),

  pause: protectedProcedure
    .input(strictInput(z.object({ paymentId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const updated = await Container.get(PaymentService).pause(ctx.userId, input.paymentId);
      return serializePayment(updated);
    }),

  /**
   * Undo a pause. See `PaymentService.resume` for what that means for the
   * schedule — the short version is that the anchor never moves, the due
   * dates the pause covered are recorded as `skipped`, and nothing lands
   * overdue. Resuming an active payment is a no-op; an `ended` one is
   * refused, since reviving it is a different operation.
   */
  resume: protectedProcedure
    .input(strictInput(z.object({ paymentId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const updated = await Container.get(PaymentService).resume(ctx.userId, input.paymentId);
      return serializePayment(updated);
    }),

  end: protectedProcedure
    .input(strictInput(z.object({ paymentId: z.string().uuid(), endDate: DATE_STRING.optional() })))
    .mutation(async ({ ctx, input }) => {
      const updated = await Container.get(PaymentService).end(
        ctx.userId,
        input.paymentId,
        input.endDate
      );
      return serializePayment(updated);
    }),

  /**
   * Remove a payment that should never have existed — NOT the same act as
   * `end`, which retires one that really ran. `end` keeps the record and its
   * history; `delete` takes both, and every figure that counted the payment
   * stops counting it.
   *
   * Refused with a count when settled occurrences exist, because those are
   * money that moved (see `PaymentHasSettledOccurrencesError`). The message
   * names `end` rather than only saying no — a refusal with no next step is
   * a dead end on the one screen the reader came to act on.
   *
   * Transactional so the recount it refuses on and the delete it performs
   * meet the same rows.
   */
  delete: protectedProcedure
    .input(strictInput(z.object({ paymentId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTransaction(
          (tx) => Container.get(PaymentService).delete(ctx.userId, input.paymentId, tx),
          { name: 'payments.delete' }
        );
      } catch (error) {
        if (error instanceof PaymentHasSettledOccurrencesError) {
          const count = error.settledCount;
          throw new TRPCError({
            code: 'CONFLICT',
            message: `This payment has ${count} settled ${count === 1 ? 'date' : 'dates'} against it. End it instead — deleting would erase money that really moved.`,
          });
        }
        throw error;
      }
    }),

  /**
   * Monthly payments the user makes but never recorded (SC-674). Derived on
   * every read from the caller's own outflows; nothing is stored until they
   * accept one.
   */
  suggestions: protectedProcedure.query(({ ctx }) =>
    Container.get(RecurringSuggestionService).list(ctx.userId)
  ),

  /** A dismissed suggestion stays dismissed: keyed on payee and currency, not on the series. */
  dismissSuggestion: protectedProcedure
    .input(strictInput(SuggestionKeySchema))
    .mutation(async ({ ctx, input }) => {
      await Container.get(RecurringSuggestionService).dismiss(
        ctx.userId,
        input.counterpartyKey,
        input.currencyTokenId
      );
    }),

  /**
   * Records a suggestion as a recurring payment. The input NAMES a
   * suggestion; the amount, anchor and payee are re-derived on the server,
   * so a client cannot write a payment the detector did not find.
   */
  acceptSuggestion: protectedProcedure
    .input(strictInput(SuggestionKeySchema))
    .mutation(async ({ ctx, input }) => {
      try {
        const payment = await withTransaction(
          (tx) =>
            Container.get(RecurringSuggestionService).accept(
              ctx.userId,
              input.counterpartyKey,
              input.currencyTokenId,
              new Date(),
              tx
            ),
          { name: 'payments.acceptSuggestion' }
        );
        return serializePayment(payment);
      } catch (error) {
        if (error instanceof SuggestionNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: error.message });
        }
        throw error;
      }
    }),

  /**
   * Every scheduled occurrence of an active payment due within `days`
   * from today, overdue included (no lower bound on `dueDate` — an
   * occurrence stays `scheduled` until the user settles or skips it, so
   * "overdue" is just "scheduled with a due date in the past").
   *
   * Composed from `PaymentRepository.findByUser` +
   * `PaymentOccurrenceRepository.findByPaymentId` rather than a joined
   * repository query — both are already ownership-scoped to
   * `ctx.userId`/the payments returned by it, so no id from the client
   * ever enters this path.
   */
  upcoming: protectedProcedure
    .input(
      strictInput(
        z.object({
          days: z.number().int().min(0).max(365).default(30),
          status: z.enum(['scheduled', 'matched', 'skipped', 'missed', 'all']).default('scheduled'),
        })
      )
    )
    .query(async ({ ctx, input }) => {
      const paymentRepository = Container.get(PaymentRepository);
      const occurrenceRepository = Container.get(PaymentOccurrenceRepository);

      const activePayments = (await paymentRepository.findByUser(ctx.userId)).filter(
        (payment) => input.status !== 'scheduled' || payment.status === 'active'
      );
      if (activePayments.length === 0) return [];

      const horizon = horizonDateString(input.days);
      const occurrenceLists = await occurrenceRepository.findByPaymentIds(
        activePayments.map((payment) => payment.id)
      );
      const paymentsById = new Map(activePayments.map((payment) => [payment.id, payment]));

      return occurrenceLists
        .flat()
        .filter(
          (occurrence) =>
            (input.status === 'all' || occurrence.status === input.status) &&
            occurrence.dueDate <= horizon
        )
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .map((occurrence) => {
          // Guaranteed present: every occurrence in occurrenceLists was
          // fetched BY one of activePayments' own ids.
          const payment = paymentsById.get(occurrence.paymentId);
          if (!payment) {
            throw new Error(`Occurrence ${occurrence.id} has no owning payment in this batch`);
          }
          // A settled row shows the payee, currency and direction it settled
          // under, not whatever the bill says now (SC-1401).
          const bill = serializePayment(payment);
          return {
            ...serializeOccurrence(occurrence),
            payment: {
              ...bill,
              vendorId: occurrence.settledVendorId ?? bill.vendorId,
              currencyTokenId: occurrence.settledCurrencyTokenId ?? bill.currencyTokenId,
              direction: occurrence.settledDirection ?? bill.direction,
            },
          };
        });
    }),

  settleOccurrence: protectedProcedure
    .input(
      strictInput(
        z.object({
          occurrenceId: z.string().uuid(),
          status: OCCURRENCE_SETTLE_STATUS,
          actualAmount: z.string().nullable().optional(),
          matchedTransactionId: z.string().uuid().nullable().optional(),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const { occurrenceId, ...settleInput } = input;
      const updated = await Container.get(PaymentService).settleOccurrence(
        ctx.userId,
        occurrenceId,
        settleInput
      );
      return serializeOccurrence(updated);
    }),
});
