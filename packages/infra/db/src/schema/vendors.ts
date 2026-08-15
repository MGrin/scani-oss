import { relations, sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

// Trailing legal forms, stripped from `normalized_name` to produce
// `match_key`. Kept as one string applied four times rather than four literals,
// because the whole point of the column is that there is exactly one definition
// of it — see migration 0027, and the parity test in `VendorRepository.test.ts`
// that holds this to what `vendorMatchKey` computes in TypeScript.
const LEGAL_FORM_SUFFIX_SQL =
  '\\s(?:s a r l|s r l|s a s|s p a|sp z o o|z o o|d o o|incorporated|corporation|company|limited|gmbh|mbh|kgaa|nyrt|sarl|ltda|slu|sdn|bhd|kft|zrt|sro|doo|oyj|aps|pty|pte|plc|llc|llp|inc|corp|ltd|spa|sas|srl|nv|bv|ab|oy|ag|ug|kg|eg|ev|sa|sl|co|as)$';

const stripLegalForm = (expression: string) =>
  `regexp_replace(${expression}, '${LEGAL_FORM_SUFFIX_SQL}', '')`;

// Four passes: "Muster GmbH & Co. KG" needs three, and the cap is what keeps
// this and `vendorMatchKey`'s own loop in step on a pathological name.
const MATCH_KEY_EXPRESSION = stripLegalForm(
  stripLegalForm(stripLegalForm(stripLegalForm('normalized_name')))
);

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
    // `normalizedName` with the trailing legal form dropped — the key
    // near-duplicate detection compares on. GENERATED, so no writer has to
    // know it exists and none can disagree about what it should hold; the
    // TypeScript twin (`vendorMatchKey`) exists only to compute the same key
    // for the string being SEARCHED for, never for a row being stored.
    matchKey: text('match_key').notNull().generatedAlwaysAs(sql.raw(MATCH_KEY_EXPRESSION)),
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
    userMatchKeyIdx: index('idx_vendors_user_match_key').on(table.userId, table.matchKey),
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
