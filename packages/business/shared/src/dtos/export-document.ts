import { z } from 'zod';

/**
 * A rendered export, as a wire contract.
 *
 * SC-89 built the export entirely in the browser: a surface resolves its
 * columns into scalars and a writer turns those into CSV or XLSX. SC-94 adds
 * PDF, and PDF cannot be built there — see `docs/features/2026-08-14_exports.md`
 * §7 for the measurement, but the short version is that the only library that
 * can lay out a statement costs **+464 kB gzip in every page load**, which is a
 * 74% increase on the whole app bundle for a feature used occasionally.
 *
 * So the *description* of the document travels to the server and the server
 * renders it. This file is that description, and the reason it lives in
 * `@scani/shared` rather than being redeclared on each side is the whole point:
 *
 * > The server must never decide what a holdings list contains.
 *
 * If it did, twelve surfaces' column definitions would exist twice and the PDF
 * would drift from the CSV — which is exactly the class of bug SC-89 built one
 * shared `V3DataView` export to avoid. The server is a *renderer*: it is handed
 * headers, rows and provenance, and its only job is to make them beautiful.
 * `@scani/ui` infers its own `ExportValue` / `ExportSheet` types from these
 * schemas, so there is one definition and it is this one.
 *
 * Everything numeric crosses as a **string**. A decimal string is exact and a
 * JSON number is a double; the whole export path is careful about this
 * (`cell.ts`), and the wire is the easiest place to lose it by accident.
 */

export const ExportValueDto = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('blank') }),
  z.object({ kind: z.literal('text'), value: z.string() }),
  z.object({
    kind: z.literal('number'),
    value: z.string(),
    decimals: z.number().int().min(0).max(30).optional(),
    style: z.enum(['plain', 'money', 'percent']).optional(),
    currency: z.string().optional(),
  }),
  z.object({ kind: z.literal('date'), value: z.string(), withTime: z.boolean() }),
]);

export type ExportValueDtoType = z.infer<typeof ExportValueDto>;

/**
 * A contiguous run of rows under one heading — the grouping the reader applied
 * on screen, carried as *structure* rather than as a repeated column value.
 *
 * Only the PDF uses it. A spreadsheet gets the same grouping as a column, which
 * is what a spreadsheet can pivot on; a statement gets headings, which is what
 * a person reads. `rowCount`s are in row order and cover the sheet, so the two
 * cannot describe different documents.
 */
export const ExportGroupDto = z.object({
  label: z.string(),
  rowCount: z.number().int().nonnegative(),
});

export const ExportSheetDto = z.object({
  name: z.string(),
  headers: z.array(z.string()),
  rows: z.array(z.array(ExportValueDto)),
  numericColumns: z.array(z.boolean()),
  /**
   * Which columns the statement totals. Declared by the surface, never inferred
   * from the cells: a price column and a column of daily net-worth snapshots
   * are both single-currency money and neither one adds up.
   */
  totalColumns: z.array(z.boolean()).optional(),
  groups: z.array(ExportGroupDto).optional(),
  /**
   * The column that carries the group label, where one was added for the
   * spreadsheets. The PDF drops it: it prints the same fact as a heading, and a
   * heading over a column repeating it underneath is the grouped list rendered
   * twice.
   */
  groupColumn: z.number().int().nonnegative().optional(),
});

export type ExportSheetDtoType = z.infer<typeof ExportSheetDto>;

export const ExportProvenanceLineDto = z.object({ label: z.string(), value: z.string() });

export const ExportProvenanceDto = z.object({
  subject: z.string(),
  scope: z.string(),
  /** ISO 8601. A `Date` does not survive JSON, and the renderer only prints it. */
  generatedAt: z.string(),
  details: z.array(ExportProvenanceLineDto),
  rowCount: z.number().int().nonnegative().optional(),
  amountsWithheld: z.boolean().optional(),
});

export type ExportProvenanceDtoType = z.infer<typeof ExportProvenanceDto>;

/**
 * A PDF is a document someone reads, not a dataset someone queries, and past a
 * few hundred rows it stops being either. The cap is a refusal rather than a
 * truncation: a statement that silently ends at row 2,000 is worse than one
 * that was never produced, and CSV or XLSX is right there for the long list.
 */
export const PDF_MAX_ROWS = 2_000;

export const RenderPdfInput = z.object({
  /** Only the first sheet is rendered — a PDF is one statement. */
  sheet: ExportSheetDto.refine((sheet) => sheet.rows.length <= PDF_MAX_ROWS, {
    message: `A PDF is limited to ${PDF_MAX_ROWS} rows — export CSV or Excel for a longer list`,
  })
    .refine((sheet) => sheet.rows.every((row) => row.length === sheet.headers.length), {
      message: 'Every row must have exactly as many cells as there are headers',
    })
    // Groups are row *runs*, so a set that does not cover the sheet exactly
    // would silently leave rows under the wrong heading — the one failure of
    // this feature a reader could not see.
    .refine(
      (sheet) =>
        sheet.groups === undefined ||
        sheet.groups.reduce((sum, group) => sum + group.rowCount, 0) === sheet.rows.length,
      { message: 'Groups must account for every row exactly once' }
    ),
  provenance: ExportProvenanceDto,
});

export type RenderPdfInputType = z.infer<typeof RenderPdfInput>;
