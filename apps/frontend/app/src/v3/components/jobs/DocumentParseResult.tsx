import { Button } from '@scani/ui/ui/button';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { ArrowRight, CheckCircle2, Copy, FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { documentDetailPath, V3_PAYMENT_ROUTES } from '../../lib/routes';

/**
 * What came out of an invoice, on the screen the upload actually lands on.
 *
 * v3's `InvoiceUploadPage` navigates to `/v3/jobs/<id>`, so this is the first
 * thing a person sees after uploading a bill — and until V3-46 it was v2's
 * renderer, whose every row linked to `/documents/<id>` and stopped there. The
 * one action the whole flow exists for, turning the invoice into a recurring
 * payment, was two screens further on and reachable only by crossing into v2.
 *
 * So the extraction row *is* the action here. `PaymentFormPage` has read
 * `?fromExtraction=` since V3-13 and nothing in v3 had ever written it; this is
 * that producer. Approving does not write a payment — one invoice cannot prove
 * a cadence — it opens the form with the vendor, amount, currency and dates
 * already filled, which is the confirmation step the bridge was designed around.
 *
 * The document's own page stays a link rather than the destination: the reader
 * approving an extraction wants the payment form, and the file it came from is
 * the thing they check when the numbers look wrong.
 */

interface ExtractionSummary {
  id: string;
  vendorNameRaw: string;
  invoiceNumber: string | null;
  totalAmount: string | null;
  currencyCode: string | null;
}

interface DocumentParseSummary {
  documentId: string;
  deduped: boolean;
  invoiceCount: number;
  extractions: ExtractionSummary[];
}

/**
 * The worker's payload is `unknown` at this boundary — the job row stores
 * whatever the processor returned — so it is narrowed rather than asserted.
 * A shape this does not recognise renders as "no recognisable result" instead
 * of throwing inside the job page.
 */
export function asDocumentParseSummary(value: unknown): DocumentParseSummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.documentId !== 'string') return null;
  if (typeof record.deduped !== 'boolean') return null;
  if (!Array.isArray(record.extractions)) return null;
  return record as unknown as DocumentParseSummary;
}

export function DocumentParseResult({ result }: { result: unknown }) {
  const summary = asDocumentParseSummary(result);

  if (!summary) {
    return (
      <Block className="p-4">
        <p className="text-body text-muted-foreground">
          This job finished without a result we recognise, so there is nothing to review.
        </p>
      </Block>
    );
  }

  if (summary.deduped) {
    return (
      <Block className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <Copy className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-title">Already read once</h2>
        </div>
        <p className="text-body text-muted-foreground">
          This file matches one you sent before, so it wasn't read again — no second AI charge, and
          no duplicate invoices. Whatever it found the first time is on the original.
        </p>
        <Button asChild variant="outline" className="self-start">
          <Link to={documentDetailPath(summary.documentId)}>Open the original</Link>
        </Button>
      </Block>
    );
  }

  if (summary.invoiceCount === 0 || summary.extractions.length === 0) {
    return (
      <Block className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-title">No invoices in this file</h2>
        </div>
        <p className="text-body text-muted-foreground">
          The file was read but nothing in it looked like an invoice. Statements and balance
          screenshots go through Import a file instead — that's the one that creates holdings.
        </p>
        <Button asChild variant="outline" className="self-start">
          <Link to={documentDetailPath(summary.documentId)}>Open the file</Link>
        </Button>
      </Block>
    );
  }

  return (
    <Block className="flex flex-col">
      <BlockHeader
        title={`${summary.extractions.length} invoice${summary.extractions.length === 1 ? '' : 's'} found`}
        href={documentDetailPath(summary.documentId)}
        action="Open the file"
      />
      {/* The em dash lives in the value zone rather than removing the row: a
          figure the extractor could not read is the thing a reviewer is looking
          for, and a row that disappears when it is empty hides exactly that. */}
      <DataRowList className="border-t border-border">
        {summary.extractions.map((extraction) => (
          <DataRow
            key={extraction.id}
            label={extraction.vendorNameRaw || 'Unknown vendor'}
            sublabel={
              extraction.invoiceNumber ? `Invoice ${extraction.invoiceNumber}` : 'No invoice number'
            }
            value={
              // A total with no currency stays a bare number. Defaulting it to
              // USD turns "the extractor could not tell" into a specific and
              // possibly wrong claim about money.
              extraction.currencyCode ? (
                <Numeric value={extraction.totalAmount} currency={extraction.currencyCode} />
              ) : (
                <Numeric value={extraction.totalAmount} format="plain" decimals={2} />
              )
            }
          />
        ))}
      </DataRowList>
      <div className="flex flex-col gap-1.5 border-t border-border p-4">
        {summary.extractions.map((extraction) => (
          <Button
            key={extraction.id}
            asChild
            variant={summary.extractions.length === 1 ? 'default' : 'outline'}
            className="w-full justify-between"
          >
            <Link to={V3_PAYMENT_ROUTES.fromExtraction(extraction.id)}>
              <span className="truncate">
                {summary.extractions.length === 1
                  ? 'Turn this into a recurring payment'
                  : `Set up ${extraction.vendorNameRaw || 'this invoice'}`}
              </span>
              <ArrowRight className="ml-2 size-4 shrink-0" aria-hidden="true" />
            </Link>
          </Button>
        ))}
        <p className="flex items-start gap-1.5 text-caption text-muted-foreground">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            Opens a payment form filled in from the invoice. Nothing is saved until you confirm it —
            one invoice can't prove how often it repeats.
          </span>
        </p>
      </div>
    </Block>
  );
}
