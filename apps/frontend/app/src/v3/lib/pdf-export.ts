import { PDF_MAX_ROWS } from '@scani/shared';
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
          uiT('ui.export.pdfTooManyRows', {
            max: PDF_MAX_ROWS.toLocaleString(),
            rows: sheet.rows.length.toLocaleString(),
          })
        );
      }

      const { base64 } = await utils.client.exports.renderPdf.mutate({
        sheet,
        provenance: {
          ...workbook.provenance,
          // `Date` does not survive JSON, and the renderer only prints it.
          generatedAt: workbook.provenance.generatedAt.toISOString(),
        },
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
