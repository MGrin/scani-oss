import { relations, sql } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
// Type-only, so this does not create a runtime cycle with payments.ts
// (which imports `documentExtractions` from here for its FK relation).
import type { PaymentIntervalUnit } from './payments';
import { users } from './users';
import { vendors } from './vendors';

// One row per uploaded FILE — every file, not just invoices. `purpose`
// says which upload flow put it here, and it is the only thing that
// differs between an invoice PDF, a portfolio screenshot and a bank
// statement: all three are bytes the user handed us and expects to find
// again.
//
// The `(userId, contentHash)` unique is PARTIAL, `WHERE purpose =
// 'invoice'` (see 0025). For invoices it is the dedup that stops the
// same file being re-scanned — and re-billed to AI spend — twice by the
// same user. Applying it to every purpose would make a re-uploaded CSV
// (the retry after a failed import) fail an INSERT and take the import
// job down with it, and would collide an invoice against a screenshot
// that happens to share bytes. Screenshots and imports therefore reuse
// an existing row by lookup instead (`UploadedFileService`), which never
// raises.
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull().default('invoice'), // DocumentPurpose
    r2Key: text('r2_key').notNull(),
    contentHash: text('content_hash').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size').notNull(),
    originalFilename: text('original_filename').notNull(),
    sourceKind: text('source_kind').notNull(), // 'upload' | 'email' | ...
    classification: text('classification'), // e.g. 'invoice', 'receipt', 'unknown'
    classificationConfidence: text('classification_confidence'), // Decimal string
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueUserContentHash: uniqueIndex('documents_user_content_hash_unique')
      .on(table.userId, table.contentHash)
      .where(sql`purpose = 'invoice'`),
    // Keyset pagination for `documents.list`: newest first, `id` breaking
    // ties so a cursor can never skip or repeat a row.
    userCreatedAtIdx: index('idx_documents_user_created_at').on(
      table.userId,
      table.createdAt.desc(),
      table.id.desc()
    ),
    userPurposeCreatedAtIdx: index('idx_documents_user_purpose_created_at').on(
      table.userId,
      table.purpose,
      table.createdAt.desc(),
      table.id.desc()
    ),
  })
);

// One row per invoice FOUND IN a document — a single PDF can hold
// several, hence `ordinal` rather than a 1:1 with `documents`.
// `vendorId` is nullable and ON DELETE SET NULL: extraction history must
// survive a vendor merge/delete even though the vendor link is gone.
export const documentExtractions = pgTable(
  'document_extractions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),
    vendorNameRaw: text('vendor_name_raw').notNull(),
    vendorId: uuid('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    invoiceNumber: text('invoice_number'),
    issueDate: date('issue_date', { mode: 'string' }),
    dueDate: date('due_date', { mode: 'string' }),
    totalAmount: text('total_amount'), // Decimal string
    currencyCode: text('currency_code'),
    lineItems: jsonb('line_items').notNull().default('[]'),
    confidence: text('confidence'), // Decimal string
    // Both NULL when the model couldn't tell — see 0024's comment on why
    // there's no CHECK and no default.
    paymentStatus: text('payment_status'), // 'paid' | 'unpaid' | null
    billingPeriod: text('billing_period'), // PaymentIntervalUnit | null
    promptVersion: text('prompt_version'),
    extractorKind: text('extractor_kind'),
    reviewState: text('review_state').notNull().default('pending'), // 'pending' | 'accepted' | 'rejected'
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueDocumentOrdinal: unique('document_extractions_document_ordinal_unique').on(
      table.documentId,
      table.ordinal
    ),
    documentIdIdx: index('idx_document_extractions_document_id').on(table.documentId),
    reviewStateIdx: index('idx_document_extractions_review_state').on(table.reviewState),
  })
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  user: one(users, {
    fields: [documents.userId],
    references: [users.id],
  }),
  extractions: many(documentExtractions),
}));

export const documentExtractionsRelations = relations(documentExtractions, ({ one }) => ({
  document: one(documents, {
    fields: [documentExtractions.documentId],
    references: [documents.id],
  }),
  vendor: one(vendors, {
    fields: [documentExtractions.vendorId],
    references: [vendors.id],
  }),
}));

/** Which upload flow produced the file. `'invoice'` is the DB default, so
    every row that predates 0025 classifies correctly without a backfill. */
export type DocumentPurpose = 'invoice' | 'screenshot' | 'file-import';
export const DOCUMENT_PURPOSES = [
  'invoice',
  'screenshot',
  'file-import',
] as const satisfies readonly DocumentPurpose[];

export type DocumentSourceKind = 'upload' | 'email';
export type DocumentReviewState = 'pending' | 'accepted' | 'rejected';
export type ExtractionPaymentStatus = 'paid' | 'unpaid';
/** Same vocabulary as `PaymentIntervalUnit` by design — an accepted
    extraction's billing period is copied straight onto the recurring
    payment it creates, so the two must never drift apart. */
export type ExtractionBillingPeriod = PaymentIntervalUnit;

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentExtraction = typeof documentExtractions.$inferSelect;
export type NewDocumentExtraction = typeof documentExtractions.$inferInsert;
