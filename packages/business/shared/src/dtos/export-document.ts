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
  z.object({
    kind: z.literal('date'),
    value: z.string(),
    withTime: z.boolean(),
    /** How the PDF prints it, in the reader's locale (SC-1199). The CSV and the
     *  workbook ignore it and keep `value`, which a machine can parse. */
    display: z.string().optional(),
  }),
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

/**
 * Every word the statement sets that is not the reader's data (SC-1199).
 *
 * The headers, group labels, subject, scope and provenance details already
 * arrive translated — the client builds them. What did not were the renderer's
 * own few words, `TOTAL` and `Page 2 of 3` and the metadata labels, which were
 * English literals in `statement.ts`, and the generated time, which the server
 * formatted in `en-GB`. They travel here instead, so **the renderer stays a
 * printer**: nothing under `apps/backend/api` knows what a language is, and a
 * language the app adds later needs no server change.
 *
 * Two fields are TEMPLATES rather than strings, because the renderer supplies
 * the value and the translation supplies the word order: `pageOf` carries
 * `{{page}}` and `{{pages}}`, `unsupportedNote` carries `{{mark}}`. The
 * renderer substitutes; it never concatenates.
 *
 * `generatedAt` and `rowCount` are ALREADY FORMATTED — a date and a figure in
 * the reader's locale are the client's to produce, for the reason above.
 *
 * **Optional, and the renderer falls back to today's English when it is
 * absent.** The api deploys to Fly and the app to Pages, not atomically, and an
 * installed PWA can run a build for days. A required field would turn every
 * export from such a client into a validation error and no document; a fallback
 * gives it exactly the statement it got before. `pdf-export.ts` always sends it,
 * and its test says so.
 */
export const StatementTextDto = z.object({
  total: z.string(),
  pageOf: z.string(),
  account: z.string(),
  generated: z.string(),
  generatedAt: z.string(),
  rows: z.string(),
  rowCount: z.string().optional(),
  amounts: z.string(),
  amountsWithheld: z.string(),
  characters: z.string(),
  unsupportedNote: z.string(),
  noRows: z.string(),
});

export type StatementTextDtoType = z.infer<typeof StatementTextDto>;

const notADigit = (value: string) => !/\p{Nd}/u.test(value);

/**
 * The two characters a statement's figures are written with, in the reader's
 * locale — `1 234,56` in French, `1.234,56` in Spanish (SC-1199).
 *
 * Separators and not a locale tag, so the renderer still knows no language: it
 * rounds through `Decimal` exactly as before and only spells the result. That
 * ASSUMES grouping every three digits, which two characters cannot express;
 * `offered-language-formats.test.ts` fails the build on an offered locale that
 * groups otherwise, rather than letting it print wrong figures.
 *
 * Digits are refused: a separator that is a digit makes a figure unreadable,
 * and one that equals the other makes it ambiguous. Optional for the stale
 * client `StatementTextDto` describes, which gets `1,234.56` as before.
 */
export const FigureSeparatorsDto = z
  .object({
    group: z.string().min(1).max(2).refine(notADigit),
    decimal: z.string().length(1).refine(notADigit),
  })
  .refine((separators) => separators.group !== separators.decimal, {
    message: 'The group and decimal separators must differ',
  });

export type FigureSeparatorsDtoType = z.infer<typeof FigureSeparatorsDto>;

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
  text: StatementTextDto.optional(),
  figures: FigureSeparatorsDto.optional(),
  /**
   * Which side of the page the statement starts from (SC-1198) — `rtl` mirrors
   * the columns, the masthead, the metadata block and the footer.
   *
   * A direction and not a language, for the reason `figures` is separators: the
   * renderer still knows no language. Optional for the stale client
   * `StatementTextDto` describes, which gets the left-to-right page it always got.
   */
  direction: z.enum(['ltr', 'rtl']).optional(),
});

export type RenderPdfInputType = z.infer<typeof RenderPdfInput>;
