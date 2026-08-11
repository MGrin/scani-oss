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
import { PaymentOccurrenceRepository, PaymentRepository } from '@scani/domain/repositories';
import { PaymentService } from '@scani/domain/services';
import { ReconcilePaymentsUseCase } from '@scani/domain/use-cases';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';

const PAYMENT_DIRECTION = z.enum(['outflow', 'inflow']);
const PAYMENT_KIND = z.enum(['fixed', 'variable']);
const PAYMENT_INTERVAL_UNIT = z.enum(['week', 'month', 'quarter', 'year']);
const OCCURRENCE_SETTLE_STATUS = z.enum(['matched', 'skipped']);
const DATE_STRING = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date string');

const CreatePaymentInputSchema = z.object({
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
});

const UpdatePaymentInputSchema = z.object({
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
});

function serializePayment(payment: Payment) {
  return {
    ...payment,
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

export const paymentsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await Container.get(PaymentRepository).findByUser(ctx.userId);
    return rows.map(serializePayment);
  }),

  get: protectedProcedure
    .input(z.object({ paymentId: z.string().uuid() }))
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

  create: protectedProcedure.input(CreatePaymentInputSchema).mutation(async ({ ctx, input }) => {
    const payment = await Container.get(PaymentService).create(ctx.userId, input);
    return serializePayment(payment);
  }),

  update: protectedProcedure.input(UpdatePaymentInputSchema).mutation(async ({ ctx, input }) => {
    const { paymentId, ...patch } = input;
    const updated = await Container.get(PaymentService).update(ctx.userId, paymentId, patch);
    return serializePayment(updated);
  }),

  pause: protectedProcedure
    .input(z.object({ paymentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const updated = await Container.get(PaymentService).pause(ctx.userId, input.paymentId);
      return serializePayment(updated);
    }),

  end: protectedProcedure
    .input(z.object({ paymentId: z.string().uuid(), endDate: DATE_STRING.optional() }))
    .mutation(async ({ ctx, input }) => {
      const updated = await Container.get(PaymentService).end(
        ctx.userId,
        input.paymentId,
        input.endDate
      );
      return serializePayment(updated);
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
    .input(z.object({ days: z.number().int().min(0).max(365).default(30) }))
    .query(async ({ ctx, input }) => {
      const paymentRepository = Container.get(PaymentRepository);
      const occurrenceRepository = Container.get(PaymentOccurrenceRepository);

      const activePayments = (await paymentRepository.findByUser(ctx.userId)).filter(
        (payment) => payment.status === 'active'
      );
      if (activePayments.length === 0) return [];

      const horizon = horizonDateString(input.days);
      const occurrenceLists = await Promise.all(
        activePayments.map((payment) => occurrenceRepository.findByPaymentId(payment.id))
      );
      const paymentsById = new Map(activePayments.map((payment) => [payment.id, payment]));

      return occurrenceLists
        .flat()
        .filter((occurrence) => occurrence.status === 'scheduled' && occurrence.dueDate <= horizon)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .map((occurrence) => {
          // Guaranteed present: every occurrence in occurrenceLists was
          // fetched BY one of activePayments' own ids.
          const payment = paymentsById.get(occurrence.paymentId);
          if (!payment) {
            throw new Error(`Occurrence ${occurrence.id} has no owning payment in this batch`);
          }
          return {
            ...serializeOccurrence(occurrence),
            payment: serializePayment(payment),
          };
        });
    }),

  settleOccurrence: protectedProcedure
    .input(
      z.object({
        occurrenceId: z.string().uuid(),
        status: OCCURRENCE_SETTLE_STATUS,
        actualAmount: z.string().nullable().optional(),
        matchedTransactionId: z.string().uuid().nullable().optional(),
      })
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

  /**
   * Runs the opt-in bank-matching sweep (`ReconcilePaymentsUseCase`) for
   * the caller only — the use case itself loads payments via
   * `PaymentRepository.findByUser(userId)` and settles matches through
   * `PaymentService.settleOccurrence`, so every write it makes is
   * already ownership-checked at the point the use case was wired.
   */
  reconcile: protectedProcedure.mutation(async ({ ctx }) => {
    return Container.get(ReconcilePaymentsUseCase).execute(ctx.userId);
  }),
});
