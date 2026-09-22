import { date, numeric, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * One monthly value per consumer price index series (SC-1255): the returns
 * card's inflation line. `month` is the first day of the month the value
 * describes. Not a token price — an index is a rate and converts nothing.
 */
export const inflationIndexMonthly = pgTable(
  'inflation_index_monthly',
  {
    seriesId: text('series_id').notNull(),
    month: date('month').notNull(),
    value: numeric('value').notNull(),
    source: text('source').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.seriesId, table.month] })]
);

export type InflationIndexMonthly = typeof inflationIndexMonthly.$inferSelect;
