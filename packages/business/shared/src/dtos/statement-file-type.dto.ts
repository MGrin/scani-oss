import { z } from 'zod';

/**
 * The statement formats an upload can name. The worker hands the parser a file
 * called `import.<fileType>`, so each value is also an extension the
 * `@scani/file-import` detector reads.
 */
export const StatementFileTypeDto = z.enum([
  'csv',
  'ofx',
  'qif',
  'mt940',
  'camt053',
  'xlsx',
  'xls',
]);
export type StatementFileType = z.infer<typeof StatementFileTypeDto>;

/** A statement format as a reader knows it. Takes any string: a job's stored summary is unvalidated. */
export function statementFormatLabel(format: string): string {
  return format === 'camt053' ? 'CAMT.053' : format.toUpperCase();
}
