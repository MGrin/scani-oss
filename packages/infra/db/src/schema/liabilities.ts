import { date, integer, numeric, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';

export type LiabilityKind = 'loan' | 'credit_card' | 'other';

// SC-1640. Loan or card terms for a liability account. Monetary columns are
// text, as `holdings.balance` is. Every term is optional: an account with no
// terms still counts in net worth through its holding.
export const liabilityTerms = pgTable('liability_terms', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountId: uuid('account_id')
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  kind: text('kind').$type<LiabilityKind>().notNull(),
  annualRatePct: numeric('annual_rate_pct', { precision: 7, scale: 4 }),
  termMonths: integer('term_months'),
  startDate: date('start_date'),
  originalPrincipal: text('original_principal'),
  contractedPayment: text('contracted_payment'),
  creditLimit: text('credit_limit'),
  minimumPayment: text('minimum_payment'),
  annualFee: text('annual_fee'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type LiabilityTerms = typeof liabilityTerms.$inferSelect;
export type NewLiabilityTerms = typeof liabilityTerms.$inferInsert;
