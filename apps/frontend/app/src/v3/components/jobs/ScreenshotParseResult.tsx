import { Button } from '@scani/ui/ui/button';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { readScreenshotParse } from '../../lib/review-holdings';
import { V3_CAPTURE_ROUTES } from '../../lib/routes';
import { DiscardedReviewCard } from './DiscardedReviewCard';
import { ReviewHoldingsCard } from './ReviewHoldingsCard';

/**
 * What an uploaded screenshot or statement turned into, and the confirm step
 * for it.
 *
 * v2's version reads its per-file counts out of the worker's `summary` while
 * deriving the extracted rows from `results`, so a job written before the
 * summary existed renders "0 succeeded, 0 failed" directly above the list it
 * extracted. Both numbers come from `results` here — see `readScreenshotParse`.
 *
 * The other correction is invisible in this file and is the reason it is a
 * rewrite: v2's aggregation maps every enriched field except `existingLabel`,
 * and that field is the one both halves of the duplicate-position guard key
 * on. It is carried now.
 */

const SUBJECT = {
  image: 'screenshot',
  pdf: 'statement',
  mixed: 'files',
} as const;

export function ScreenshotParseResult({
  result,
  jobId,
  actionTakenAt,
  reviewOutcome,
}: {
  result: unknown;
  jobId?: string;
  actionTakenAt?: Date | string | null;
  reviewOutcome?: string | null;
}) {
  const { t } = useTranslation();
  const parse = readScreenshotParse(result);
  const subject = SUBJECT[parse.kind];

  if (reviewOutcome === 'discarded') {
    return <DiscardedReviewCard actionTakenAt={actionTakenAt} subject={subject} />;
  }

  const allFailed = parse.failed > 0 && parse.succeeded === 0;

  return (
    <div className="flex flex-col gap-4">
      <Block className="flex flex-col">
        <div className="flex items-center gap-2 px-4 pt-4">
          {/* Colour only where nothing was read at all. v3 spends it on
              interactive affordance and gain/loss, so a partial read is carried
              by the icon's shape and by the block below that names the count. */}
          {parse.failed > 0 ? (
            <AlertTriangle
              className={`size-4 shrink-0 ${allFailed ? 'text-destructive' : 'text-muted-foreground'}`}
              aria-hidden="true"
            />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <h2 className="text-title">{t(`v3.jobs.screenshot.title.${parse.kind}`)}</h2>
        </div>
        {/* Two figures rather than a sentence assembled around a noun for the
            file type. "Parsed 3 {{noun}}s" is the shape that cannot be
            translated, and the count it needs is the one the figures state
            plainly. */}
        <DataRowList className="mt-3 border-t border-border">
          <DataRow
            label={t('v3.jobs.screenshot.filesRead')}
            value={t('v3.jobs.screenshot.ofTotal', {
              done: parse.succeeded,
              total: parse.totalFiles,
            })}
          />
          <DataRow
            label={t('v3.jobs.screenshot.holdingsFound')}
            value={<Numeric value={parse.holdings.length} format="plain" decimals={0} />}
          />
        </DataRowList>
      </Block>

      {parse.failed > 0 ? (
        <Block className="flex flex-col gap-2 p-4">
          <h2 className="text-title">
            {t('v3.jobs.screenshot.failedTitle', { count: parse.failed })}
          </h2>
          {/* The provider's own error (an OpenAI 400, a decode failure) stays
              out: it is implementation detail, not something a reader can act
              on. It is in the worker logs and on the raw job payload. */}
          <p className="text-body text-muted-foreground">
            {t(`v3.jobs.screenshot.failedAdvice.${parse.kind}`)}
          </p>
        </Block>
      ) : null}

      {parse.succeeded > 0 && !parse.accountId ? (
        <Block className="flex flex-col gap-2 p-4">
          <BlockHeader title={t('v3.jobs.screenshot.noAccount.title')} />
          {/* v2 sends the reader to the upload page "to pick the account and
              confirm the extracted holdings". That page has had no review step
              since the review moved onto the job — it starts a fresh upload —
              so the instruction described an action that could not be taken and
              the rows stayed stranded either way. This says what is true and
              offers the thing that does work. */}
          <p className="text-body text-muted-foreground">
            {t('v3.jobs.screenshot.noAccount.body')}
          </p>
          <Button asChild variant="outline" className="mt-1 self-start">
            <Link to={V3_CAPTURE_ROUTES.fileImport}>
              {t('v3.jobs.screenshot.noAccount.action')}
            </Link>
          </Button>
        </Block>
      ) : null}

      {parse.accountId && parse.holdings.length > 0 ? (
        <ReviewHoldingsCard
          accountId={parse.accountId}
          holdings={parse.holdings}
          source={subject}
          overallConfidence={parse.overallConfidence}
          jobId={jobId}
          actionTakenAt={actionTakenAt}
        />
      ) : null}
    </div>
  );
}
