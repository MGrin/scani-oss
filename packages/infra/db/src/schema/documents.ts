import { relations } from 'drizzle-orm';
import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './users';
import { vendors } from './vendors';

// One row per uploaded FILE. `contentHash` + the `(userId, contentHash)`
// unique is the dedup that stops the same invoice being re-scanned (and
// re-billed to AI spend) twice by the same user — a different user
// uploading the identical file is a legitimate, separate event.
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
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
    uniqueUserContentHash: unique('documents_user_content_hash_unique').on(
      table.userId,
      table.contentHash
    ),
    userIdIdx: index('idx_documents_user_id').on(table.userId),
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

export type DocumentSourceKind = 'upload' | 'email';
export type DocumentReviewState = 'pending' | 'accepted' | 'rejected';

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type DocumentExtraction = typeof documentExtractions.$inferSelect;
export type NewDocumentExtraction = typeof documentExtractions.$inferInsert;
