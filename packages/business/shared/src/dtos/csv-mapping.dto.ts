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
