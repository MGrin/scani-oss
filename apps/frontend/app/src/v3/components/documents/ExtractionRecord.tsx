import { formatDate } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { TFunction } from 'i18next';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
const REVIEW_STATE_LABEL_KEYS: Record<string, string> = {
  pending: 'v3.documents.extraction.state.pending',
  accepted: 'v3.documents.extraction.state.accepted',
  rejected: 'v3.documents.extraction.state.rejected',
};

/**
 * `payment_status` is `'paid' | 'unpaid' | null`, and both nulls mean the model
 * could not tell — migration 0024 declines to default it for exactly that
 * reason. Rendering the raw value puts a lowercase word in a column of
 * sentence-case ones; rendering the null as "unpaid" would invent the answer
 * the column was deliberately left empty to avoid.
 */
function paymentStatusLabel(status: string | null, t: TFunction): string {
  if (status === 'paid') return t('v3.documents.extraction.paymentPaid');
  if (status === 'unpaid') return t('v3.documents.extraction.paymentUnpaid');
  return t('v3.documents.extraction.paymentNotStated');
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
  const { t } = useTranslation();
  const [confirmingReject, setConfirmingReject] = useState(false);
  const confidence = extractionConfidence(extraction.confidence);
  const pending = extraction.reviewState === 'pending';

  return (
    <Block className="flex flex-col">
      <div className="flex items-start justify-between gap-3 p-4 pb-3">
        <div className="min-w-0">
          <h3 className="truncate text-label">{extraction.vendorNameRaw}</h3>
          <p className="truncate text-caption text-muted-foreground">
            {extraction.invoiceNumber
              ? t('v3.documents.extraction.invoiceNumber', { number: extraction.invoiceNumber })
              : t('v3.documents.extraction.noInvoiceNumber')}
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
            {t(REVIEW_STATE_LABEL_KEYS[extraction.reviewState] ?? extraction.reviewState)}
          </Badge>
        </div>
      </div>

      <DataRowList className="border-t border-border">
        <DataRow
          label={t('v3.documents.extraction.issueDate')}
          value={extraction.issueDate ? formatDate(extraction.issueDate) : '—'}
        />
        <DataRow
          label={t('v3.documents.extraction.dueDate')}
          value={extraction.dueDate ? formatDate(extraction.dueDate) : '—'}
        />
        <DataRow
          label={t('v3.documents.extraction.paymentStatus')}
          value={paymentStatusLabel(extraction.paymentStatus, t)}
        />
        <DataRow
          label={t('v3.documents.extraction.confidence')}
          value={confidence === null ? t('v3.documents.extraction.notRecorded') : `${confidence}%`}
        />
      </DataRowList>

      {pending ? (
        <div className="flex flex-col gap-1.5 border-t border-border p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={isRejecting} onClick={onApprove}>
              {t('v3.documents.extraction.approve')}
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
              label={t('v3.documents.extraction.reject')}
              confirmLabel={t('v3.documents.extraction.rejectCommit')}
              destructive
              open={confirmingReject}
              onOpenChange={setConfirmingReject}
              isPending={isRejecting}
              // Two keys rather than one with an optional `{{number}} `: the
              // number and the space before it are one unit, and a language
              // that puts the number elsewhere in the sentence cannot express
              // that by interpolating a pre-spaced fragment.
              consequence={
                extraction.invoiceNumber
                  ? t('v3.documents.extraction.rejectConsequenceNumbered', {
                      number: extraction.invoiceNumber,
                      vendor: extraction.vendorNameRaw,
                    })
                  : t('v3.documents.extraction.rejectConsequence', {
                      vendor: extraction.vendorNameRaw,
                    })
              }
              onConfirm={onReject}
            />
          </div>
          {/* One invoice cannot prove a cadence, so approving opens the form
              rather than writing a payment the user never confirmed. */}
          <p className="text-caption text-muted-foreground">
            {t('v3.documents.extraction.approveNote')}
          </p>
        </div>
      ) : null}
    </Block>
  );
}
