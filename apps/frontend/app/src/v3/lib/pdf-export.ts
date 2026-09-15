import {
  type ExportSheetDtoType,
  type FigureSeparatorsDtoType,
  formatNumber,
  getFormatLocale,
  PDF_MAX_ROWS,
  type StatementTextDtoType,
} from '@scani/shared';
import { uiT } from '@scani/ui/i18n';
import { UserFacingError } from '@scani/ui/lib/user-facing-error';
import { registerPdfRenderer } from '@scani/ui/v3/lib/export/format';
import { useEffect } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Teach the export path how to make a PDF (SC-94).
 *
 * `@scani/ui` owns the export and has no network client — deliberately, since
 * `apps/frontend/cloud` mounts the same list surface against a different API.
 * PDF is the one format it cannot produce alone, so the app hands it a renderer
 * once at boot and every surface picks it up. Cloud registers nothing and
 * simply does not offer PDF, which is better than offering it and failing.
 *
 * The document that goes over the wire is the **same `ExportWorkbook`** the CSV
 * and the workbook are built from — same columns, same hide-amounts decision,
 * same provenance. The server typesets it and does not decide what a holdings
 * list contains; that is what keeps the PDF from disagreeing with the CSV next
 * to it, and it is why the wire contract lives in `@scani/shared`.
 *
 * A hook rather than a module side effect because the tRPC client is created
 * inside the provider — there is no importable singleton to reach for, and
 * inventing one would be a second client with its own auth headers.
 *
 * Both refusals below are `UserFacingError` carrying a `ui.*` message (SC-311).
 * `uiT` rather than the app's `t`: this renderer is handed to `@scani/ui` and
 * runs inside its export path, so its copy belongs to the kit's bundle — the
 * one the kit's own toast resolves against. Thrown as plain `Error`s these
 * became "Unknown error", which is the absence-vs-refusal collapse the export
 * path was built to avoid.
 */
/**
 * The statement's own words and the two values it prints, in the reader's
 * language (SC-1199).
 *
 * The renderer is a printer and knows no language, so everything it sets that
 * is not the reader's data is resolved here. Three labels reuse the
 * `provenance.*` keys the CSV's `#` lines and the workbook's About sheet already
 * print, so the three formats of one export say the same thing in the same
 * words — which also changes the PDF's English for withheld amounts to the
 * sentence the other two formats already carried.
 *
 * The timestamp is formatted in UTC WITH the zone named, as the server did: a
 * statement is read by an accountant in a different zone than it was made in.
 * `Intl` supplies the connective — `at`, `в`, `à` — so there is no template for
 * it. In `en-GB` this is byte-identical to what the server printed before.
 *
 * `translate` and `dateLocale` are parameters so a test can ask for another
 * language without switching the one the whole kit renders in. These are KIT
 * keys, resolved against `@scani/ui`'s bundle like every `uiT` call here, so
 * `pdf-export.test.ts` proves they resolve rather than `i18n-keys.test.ts`,
 * which reads the app's own `en.json`.
 */
export function statementText(
  generatedAt: Date,
  rowCount: number | undefined,
  translate: typeof uiT = uiT,
  dateLocale: string = getFormatLocale().dateLocale
): StatementTextDtoType {
  return {
    total: translate('ui.export.statement.total'),
    pageOf: translate('ui.export.statement.pageOf', {
      page: '{{page}}',
      pages: '{{pages}}',
      interpolation: { escapeValue: false },
    }),
    account: translate('ui.export.statement.account'),
    generated: translate('ui.export.provenance.generated'),
    generatedAt: generatedAt.toLocaleString(dateLocale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    }),
    rows: translate('ui.export.provenance.rows'),
    rowCount: rowCount === undefined ? undefined : formatNumber(rowCount),
    amounts: translate('ui.export.provenance.amounts'),
    amountsWithheld: translate('ui.export.provenance.withheld'),
    characters: translate('ui.export.statement.characters'),
    unsupportedNote: translate('ui.export.statement.unsupportedNote', {
      mark: '{{mark}}',
      interpolation: { escapeValue: false },
    }),
    noRows: translate('ui.export.statement.noRows'),
  };
}

/**
 * The two characters the statement's figures are spelled with (SC-1199).
 *
 * Read from `Intl` rather than from a table, so a region the reader picks is
 * honoured with nothing to maintain. The sample is large enough to be grouped
 * in every locale — Spanish does not group a four-digit number at all.
 */
export function figureSeparators(numberLocale: string): FigureSeparatorsDtoType {
  const parts = new Intl.NumberFormat(numberLocale).formatToParts(1234567.5);
  const group = parts.find((part) => part.type === 'group')?.value;
  const decimal = parts.find((part) => part.type === 'decimal')?.value;
  if (!group || !decimal || group === decimal) return { group: ',', decimal: '.' };
  return { group, decimal };
}

/**
 * Every date cell with the words the PDF prints for it (SC-1199).
 *
 * `value` is untouched, so the wire still carries what a machine parses. In UTC,
 * as the renderer printed it before: the statement names its zone once, in the
 * generated line, and a cell that shifted by the reader's offset would disagree
 * with the CSV beside it by a day near midnight.
 */
export function withDisplayDates(
  sheet: ExportSheetDtoType,
  dateLocale: string
): ExportSheetDtoType {
  return {
    ...sheet,
    rows: sheet.rows.map((row) =>
      row.map((cell) => {
        if (cell.kind !== 'date') return cell;
        const at = new Date(cell.value);
        if (Number.isNaN(at.getTime())) return cell;
        const display = cell.withTime
          ? at.toLocaleString(dateLocale, {
              dateStyle: 'medium',
              timeStyle: 'short',
              timeZone: 'UTC',
            })
          : at.toLocaleDateString(dateLocale, { dateStyle: 'medium', timeZone: 'UTC' });
        return { ...cell, display };
      })
    ),
  };
}

export function useInstallPdfExport(): void {
  const utils = trpc.useContext();

  useEffect(() => {
    registerPdfRenderer(async (workbook) => {
      const sheet = workbook.sheets[0];
      if (!sheet) throw new UserFacingError(uiT('ui.export.nothingToExport'));
      // The server refuses past this too, and its refusal is the one that
      // matters — but a zod error arrives as a validation blob after a
      // megabyte has gone over the wire, and "Everything we have" on a
      // six-year net-worth history is 2,190 rows, so this is a request people
      // will actually make. Said here, in one sentence, before the round trip.
      if (sheet.rows.length > PDF_MAX_ROWS) {
        throw new UserFacingError(
          // `formatNumber`, never a bare `toLocaleString()` — the
          // argument-less form takes the RUNTIME's locale, so a refusal
          // translated into the reader's language quoted its two figures in
          // the device's (SC-762).
          uiT('ui.export.pdfTooManyRows', {
            max: formatNumber(PDF_MAX_ROWS),
            rows: formatNumber(sheet.rows.length),
          })
        );
      }

      const { dateLocale, numberLocale } = getFormatLocale();
      const { base64 } = await utils.client.exports.renderPdf.mutate({
        sheet: withDisplayDates(sheet, dateLocale),
        provenance: {
          ...workbook.provenance,
          // `Date` does not survive JSON, and the renderer only prints it.
          generatedAt: workbook.provenance.generatedAt.toISOString(),
        },
        text: statementText(workbook.provenance.generatedAt, workbook.provenance.rowCount),
        figures: figureSeparators(numberLocale),
      });

      // `Uint8Array.fromBase64` is not in Safari 17, which is the floor this
      // app still supports, so the decode is the boring loop.
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: 'application/pdf' });
    });
  }, [utils]);
}
