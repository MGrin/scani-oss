import { formatDate } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { extractionConfidence } from '../../lib/documents';

/**
 * One invoice the extractor found inside a file.
 *
 * The identity and the figure lead, the six supporting facts are rows under
 * them, and the decision is at the bottom — the same top-to-bottom order every
 * v3 record uses. v2 renders the same content as a `<dl class="grid-cols-2">`
 * with a `<Separator>`, which puts the label and its value at opposite edges of
 * a phone with nothing between them.
 *
 * A missing value is an em dash rather than an omitted row: which fields the
 * extractor failed to read is the thing a reviewer is checking for, and a row
 * that vanishes when it is empty hides exactly that.
 */

export interface ExtractionRecordItem {
  id: string;
  vendorNameRaw: string;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  totalAmount: string | null;
  currencyCode: string | null;
  paymentStatus: string | null;
  confidence: string | null;
  reviewState: string;
}

const REVIEW_STATE_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  pending: 'outline',
  accepted: 'default',
  rejected: 'secondary',
};

/**
 * The state, said once. The badge carries the readable phrasing rather than
 * the raw column value, so the record does not print "Accepted" as a subtitle
 * and "accepted" as a chip directly beside it — which is what v2 does and what
 * the first screenshot of this component showed.
 */
const REVIEW_STATE_LABEL: Record<string, string> = {
  pending: 'Awaiting review',
  accepted: 'Accepted',
  rejected: 'Rejected',
};

/**
 * `payment_status` is `'paid' | 'unpaid' | null`, and both nulls mean the model
 * could not tell — migration 0024 declines to default it for exactly that
 * reason. Rendering the raw value puts a lowercase word in a column of
 * sentence-case ones; rendering the null as "unpaid" would invent the answer
 * the column was deliberately left empty to avoid.
 */
function paymentStatusLabel(status: string | null): string {
  if (status === 'paid') return 'Paid';
  if (status === 'unpaid') return 'Unpaid';
  return 'Not stated';
}

interface ExtractionRecordProps {
  extraction: ExtractionRecordItem;
  onApprove: () => void;
  onReject: () => void;
  isRejecting: boolean;
}

export function ExtractionRecord({
  extraction,
  onApprove,
  onReject,
  isRejecting,
}: ExtractionRecordProps) {
  const [confirmingReject, setConfirmingReject] = useState(false);
  const confidence = extractionConfidence(extraction.confidence);
  const pending = extraction.reviewState === 'pending';

  return (
    <Block className="flex flex-col">
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-label">{extraction.vendorNameRaw}</h3>
          <p className="truncate text-caption text-muted-foreground">
            {extraction.invoiceNumber ? `Invoice ${extraction.invoiceNumber}` : 'No invoice number'}
          </p>
        </div>
        {/* Stacked, not side by side — the `<DataRow>` value/delta arrangement.
            A vendor name and a state chip competing for one 390px row leaves
            "Hetzner Online G…" beside a chip that could have gone anywhere,
            and the identity is the column that should not be giving way. */}
        <div className="flex shrink-0 flex-col items-end gap-1">
          {/* A total with no currency stays a bare number. v2 defaults it to
              USD, which turns "the extractor could not tell" into a specific
              and possibly wrong claim about money — the one mistake this
              screen exists to let a human catch. */}
          <span className="text-title">
            {extraction.currencyCode ? (
              <Numeric value={extraction.totalAmount} currency={extraction.currencyCode} />
            ) : (
              <Numeric value={extraction.totalAmount} format="plain" decimals={2} />
            )}
          </span>
          <Badge variant={REVIEW_STATE_VARIANT[extraction.reviewState] ?? 'outline'}>
            {REVIEW_STATE_LABEL[extraction.reviewState] ?? extraction.reviewState}
          </Badge>
        </div>
      </div>

      <DataRowList className="border-t border-border">
        <DataRow
          label="Issue date"
          value={extraction.issueDate ? formatDate(extraction.issueDate) : '—'}
        />
        <DataRow
          label="Due date"
          value={extraction.dueDate ? formatDate(extraction.dueDate) : '—'}
        />
        <DataRow label="Payment status" value={paymentStatusLabel(extraction.paymentStatus)} />
        <DataRow
          label="Confidence"
          value={confidence === null ? 'Not recorded' : `${confidence}%`}
        />
      </DataRowList>

      {pending ? (
        <div className="flex flex-col gap-1.5 border-t border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={isRejecting} onClick={onApprove}>
              Approve
              <ArrowRight className="ml-2 size-4" aria-hidden="true" />
            </Button>
            {/* Confirmed, unlike `Approve` (SC-73). Approving opens a form
                that saves nothing until it is submitted, so its tap is
                reversible by walking away. Rejecting writes `reviewState`
                immediately and this screen only offers the pair while the
                extraction is *pending* — so once it is rejected there is no
                control anywhere in v3 that brings it back, and re-running the
                extractor is the only route to the same invoice. `destructive`
                for exactly that: no inverse. */}
            <ConfirmAction
              label="Reject"
              confirmLabel="Reject this invoice"
              destructive
              open={confirmingReject}
              onOpenChange={setConfirmingReject}
              isPending={isRejecting}
              consequence={`The invoice ${extraction.invoiceNumber ? `${extraction.invoiceNumber} ` : ''}from ${extraction.vendorNameRaw} is marked rejected and this file stops offering it for review. No payment is created. Re-parsing the file is the only way to get it back.`}
              onConfirm={onReject}
            />
          </div>
          {/* One invoice cannot prove a cadence, so approving opens the form
              rather than writing a payment the user never confirmed. */}
          <p className="text-caption text-muted-foreground">
            Opens a recurring payment prefilled from this invoice. Nothing is saved until you
            confirm it.
          </p>
        </div>
      ) : null}
    </Block>
  );
}
