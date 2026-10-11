import * as schema from '@scani/db/schema';
import { type SQL, sql } from 'drizzle-orm';

const ledger = schema.holdingTransactions;

/** `source_metadata ->> key` when that value is a string, else NULL. */
function ledgerMetadataText(key: 'income' | 'feeOf'): SQL<string | null> {
  const value = sql`${ledger.sourceMetadata} -> ${sql.raw(`'${key}'`)}`;
  return sql<string | null>`CASE WHEN jsonb_typeof(${value}) = 'string' THEN ${value} #>> '{}' END`;
}

/** The `LedgerMetadataFacts` every loader of a ledger row's facts selects. */
export const LEDGER_METADATA_FACTS = {
  metadataIncome: ledgerMetadataText('income'),
  metadataFeeOf: ledgerMetadataText('feeOf'),
};
