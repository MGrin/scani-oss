import * as schema from '@scani/db/schema';
import type { PgColumn } from 'drizzle-orm/pg-core';

/** Rows per read and per `UPDATE … FROM (VALUES …)` statement of a label write. */
export const LABEL_BATCH_SIZE = 500;

const MAPPED_KEYS = [
  'ledgerKind',
  'kindSubtype',
  'groupId',
  'feeOf',
  'executionPrice',
  'executionPriceTokenId',
  'kindOrigin',
] as const;

/**
 * A ledger row's label columns that `mapLegacyEntry` derives from its legacy
 * facts: the backfill fills each where it is NULL, and `relabelEntries`
 * overwrites them all. `input_id` is not one: the writer states it.
 */
export const MAPPED_ENTRY_LABELS: ReadonlyArray<{
  key: (typeof MAPPED_KEYS)[number];
  column: PgColumn;
}> = MAPPED_KEYS.map((key) => ({ key, column: schema.holdingTransactions[key] }));
