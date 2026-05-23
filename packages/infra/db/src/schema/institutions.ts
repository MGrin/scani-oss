import { relations } from 'drizzle-orm';
import { boolean, index, pgTable, real, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { accounts } from './accounts';

// Dynamic enum table for institution types — 'bank', 'broker', 'cex',
// 'blockchain', etc. Lives in the DB so admins can extend the catalog
// without a migration.
export const institutionTypes = pgTable('institution_types', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: text('code').notNull().unique(), // 'bank', 'broker', etc. - for programmatic use
  name: text('name').notNull(), // 'Bank', 'Broker', etc. - for display
  description: text('description'), // Optional description
  displayOrder: real('display_order').notNull().default(0), // For UI ordering
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Public catalog of financial institutions (banks, brokers, exchanges,
// blockchain networks). Available to all users.
export const institutions = pgTable(
  'institutions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => institutionTypes.id, { onDelete: 'restrict' }),
    description: text('description'),
    website: text('website'),
    logoUrl: text('logo_url'),
    hasIntegration: boolean('has_integration').notNull().default(false), // Indicates if institution has API integration support
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    uniqueInstitutionWebsite: unique().on(table.website),
    nameIdx: index('idx_institutions_name').on(table.name),
  })
);

// Maps institutions to blockchain chain IDs. Blockchain-typed
// institutions in `institutions` (Ethereum, Bitcoin, …) get one row
// here so the wallet-discovery flow can resolve `institutionId →
// chainId/chainType` without baking the catalog into application code.
export const institutionBlockchainMappings = pgTable(
  'institution_blockchain_mappings',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    institutionId: uuid('institution_id')
      .notNull()
      .references(() => institutions.id, { onDelete: 'cascade' })
      .unique(), // Each institution can only map to one chain
    chainId: text('chain_id').notNull(), // Blockchain chain ID (e.g., '1' for Ethereum, 'bitcoin', 'solana')
    chainType: text('chain_type').notNull(), // 'evm', 'bitcoin', 'solana', 'tron', 'ton'
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    institutionIdIdx: index('idx_institution_blockchain_mappings_institution_id').on(
      table.institutionId
    ),
    chainIdIdx: index('idx_institution_blockchain_mappings_chain_id').on(table.chainId),
  })
);

export const institutionTypesRelations = relations(institutionTypes, ({ many }) => ({
  institutions: many(institutions),
}));

export const institutionsRelations = relations(institutions, ({ one, many }) => ({
  type: one(institutionTypes, {
    fields: [institutions.typeId],
    references: [institutionTypes.id],
  }),
  accounts: many(accounts),
  blockchainMapping: one(institutionBlockchainMappings, {
    fields: [institutions.id],
    references: [institutionBlockchainMappings.institutionId],
  }),
}));

export const institutionBlockchainMappingsRelations = relations(
  institutionBlockchainMappings,
  ({ one }) => ({
    institution: one(institutions, {
      fields: [institutionBlockchainMappings.institutionId],
      references: [institutions.id],
    }),
  })
);

export type InstitutionType = typeof institutionTypes.$inferSelect;
export type Institution = typeof institutions.$inferSelect;
export type NewInstitution = typeof institutions.$inferInsert;
export type InstitutionBlockchainMapping = typeof institutionBlockchainMappings.$inferSelect;
export type NewInstitutionBlockchainMapping = typeof institutionBlockchainMappings.$inferInsert;

// Mirrors the seed in `0001_seed_type_enums.sql`. Drizzle types `code`
// as a plain `string`; this literal union gives compile-time guarantees
// to callers (provider manifests, frontend filters) that don't want to
// hit the DB just to enumerate categories. Adding a new institution
// type means appending here AND updating the seed migration.
export const INSTITUTION_TYPE_CODES = [
  'bank',
  'broker',
  'crypto_exchange',
  'crypto_wallet',
  'investment_fund',
  'private_equity',
  'real_estate',
  'other',
] as const;
export type InstitutionTypeCode = (typeof INSTITUTION_TYPE_CODES)[number];
