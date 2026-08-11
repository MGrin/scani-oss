import { relations } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

// Who the user pays or gets paid by — never an institution. AWS is a
// vendor; Wise (where the money moves through) is an institution.
// `normalizedName` is the collision key aliases merge against (see
// `normalizeVendorName` in @scani/domain/lib); `displayName` is what the
// user actually typed or was shown, kept verbatim for the UI.
export const vendors = pgTable(
  'vendors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    category: text('category'),
    website: text('website'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserNormalized: unique('vendors_user_normalized_unique').on(
      table.userId,
      table.normalizedName
    ),
  })
);

// A raw string a vendor has been seen under — a bank statement
// counterparty string, a document's extracted vendor name, or a
// manually-entered alias from a merge. `source` records where it came
// from (e.g. 'counterparty', 'document', 'manual') for provenance; it is
// not used for matching.
export const vendorAliases = pgTable(
  'vendor_aliases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    vendorId: uuid('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'cascade' }),
    rawName: text('raw_name').notNull(),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueVendorRawName: unique('vendor_aliases_unique').on(table.vendorId, table.rawName),
    rawNameIdx: index('idx_vendor_aliases_raw').on(table.rawName),
  })
);

export const vendorsRelations = relations(vendors, ({ one, many }) => ({
  user: one(users, {
    fields: [vendors.userId],
    references: [users.id],
  }),
  aliases: many(vendorAliases),
}));

export const vendorAliasesRelations = relations(vendorAliases, ({ one }) => ({
  vendor: one(vendors, {
    fields: [vendorAliases.vendorId],
    references: [vendors.id],
  }),
}));

export type Vendor = typeof vendors.$inferSelect;
export type NewVendor = typeof vendors.$inferInsert;
export type VendorAlias = typeof vendorAliases.$inferSelect;
export type NewVendorAlias = typeof vendorAliases.$inferInsert;
