import { relations } from 'drizzle-orm';
import { date, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';
import { documentExtractions } from './documents';
import { holdingTransactions } from './holdings';
import { tokens } from './tokens';
import { users } from './users';
import { vendors } from './vendors';

// A recurring bill or income definition — the template the recurrence
// engine (`generateOccurrences`) expands into dated `payment_occurrences`
// rows. `account_id` is nullable and unlinked is the NORMAL case: most
// payments start life as a manual ledger entry with no account tie yet.
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    direction: text('direction').notNull(), // 'outflow' | 'inflow'
    kind: text('kind').notNull(), // 'fixed' | 'variable'
    expectedAmount: text('expected_amount'), // Decimal string; null for variable-amount payments with no estimate
    currencyTokenId: uuid('currency_token_id')
      .notNull()
      .references(() => tokens.id, { onDelete: 'restrict' }),
    intervalUnit: text('interval_unit').notNull(), // 'week' | 'month' | 'quarter' | 'year'
    intervalCount: integer('interval_count').notNull(),
    anchorDate: date('anchor_date', { mode: 'string' }).notNull(),
    status: text('status').notNull().default('active'), // 'active' | 'paused' | 'ended'
    endDate: date('end_date', { mode: 'string' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    // 'detected' is kept even though nothing writes it — detection was
    // dropped from this iteration; leaving the value means it can come
    // back without a migration.
    origin: text('origin').notNull().default('manual'), // 'manual' | 'detected' | 'document'
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('idx_payments_user_id').on(table.userId),
    userStatusIdx: index('idx_payments_user_status').on(table.userId, table.status),
  })
);

// A single dated instance a payment's recurrence rule expands into.
// Generated ahead by the recurrence engine, then matched against real
// ledger activity as it happens.
export const paymentOccurrences = pgTable(
  'payment_occurrences',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    paymentId: uuid('payment_id')
      .notNull()
      .references(() => payments.id, { onDelete: 'cascade' }),
    dueDate: date('due_date', { mode: 'string' }).notNull(),
    expectedAmount: text('expected_amount'),
    status: text('status').notNull().default('scheduled'), // 'scheduled' | 'matched' | 'missed' | 'skipped'
    matchedTransactionId: uuid('matched_transaction_id').references(() => holdingTransactions.id, {
      onDelete: 'set null',
    }),
    matchedExtractionId: uuid('matched_extraction_id').references(() => documentExtractions.id, {
      onDelete: 'set null',
    }),
    actualAmount: text('actual_amount'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniquePaymentDueDate: unique('payment_occurrences_payment_due_date_unique').on(
      table.paymentId,
      table.dueDate
    ),
    dueDateIdx: index('idx_payment_occurrences_due_date').on(table.dueDate),
    statusIdx: index('idx_payment_occurrences_status').on(table.status),
  })
);

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  user: one(users, {
    fields: [payments.userId],
    references: [users.id],
  }),
  vendor: one(vendors, {
    fields: [payments.vendorId],
    references: [vendors.id],
  }),
  currency: one(tokens, {
    fields: [payments.currencyTokenId],
    references: [tokens.id],
  }),
  account: one(accounts, {
    fields: [payments.accountId],
    references: [accounts.id],
  }),
  occurrences: many(paymentOccurrences),
}));

export const paymentOccurrencesRelations = relations(paymentOccurrences, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentOccurrences.paymentId],
    references: [payments.id],
  }),
  matchedTransaction: one(holdingTransactions, {
    fields: [paymentOccurrences.matchedTransactionId],
    references: [holdingTransactions.id],
  }),
  matchedExtraction: one(documentExtractions, {
    fields: [paymentOccurrences.matchedExtractionId],
    references: [documentExtractions.id],
  }),
}));

export type PaymentDirection = 'outflow' | 'inflow';
export type PaymentKind = 'fixed' | 'variable';
export type PaymentIntervalUnit = 'week' | 'month' | 'quarter' | 'year';
export type PaymentStatus = 'active' | 'paused' | 'ended';
export type PaymentOrigin = 'manual' | 'detected' | 'document';
export type PaymentOccurrenceStatus = 'scheduled' | 'matched' | 'missed' | 'skipped';

export type Payment = typeof payments.$inferSelect;
export type NewPayment = typeof payments.$inferInsert;
export type PaymentOccurrence = typeof paymentOccurrences.$inferSelect;
export type NewPaymentOccurrence = typeof paymentOccurrences.$inferInsert;
