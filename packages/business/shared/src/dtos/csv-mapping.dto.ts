import { z } from 'zod';

const column = z.string().max(256);
export const CsvMappingDto = z
  .object({
    date: column.min(1),
    description: column,
    amount: column,
    credit: column.optional(),
    debit: column.optional(),
    currency: column.optional(),
    balance: column.optional(),
    fee: column.optional(),
  })
  .strict()
  .refine(
    (value) => !!(value.amount || value.credit || value.debit),
    'Choose an amount column or credit/debit columns'
  );
export type CsvMapping = z.infer<typeof CsvMappingDto>;

/**
 * Appended to a CSV parse's warnings when the column mapping came from the AI
 * detector. A note about how the file was read rather than a problem with it,
 * so the job page shows it as a fact and keeps it out of the warning count
 * (SC-1527).
 */
export const AI_COLUMN_MAPPING_WARNING = 'Column mapping detected by AI';
