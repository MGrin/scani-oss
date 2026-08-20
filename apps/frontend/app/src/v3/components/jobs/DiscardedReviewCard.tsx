import { formatDateTime } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { Ban } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * What a review looks like after the reader threw it away.
 *
 * Shared by every review renderer because the alternative is worse than
 * duplication: a stamped job with no recorded outcome renders as "already
 * imported", which is a false claim about someone's portfolio for the one
 * action that deliberately wrote nothing (SC-138).
 *
 * The subject is a discriminant, not a noun to interpolate. v2 takes a `noun`
 * string and drops it mid-sentence, which is the shape that cannot be
 * translated — Russian declines the noun and reorders the clause around it —
 * and it is the same defect as the English verb `describeQueryError` used to
 * splice into an otherwise translated sentence. Each subject gets a whole
 * sentence (SC-235).
 */
export type DiscardedSubject = 'screenshot' | 'statement' | 'files' | 'wallet';

export function DiscardedReviewCard({
  actionTakenAt,
  subject,
}: {
  actionTakenAt?: Date | string | null;
  subject: DiscardedSubject;
}) {
  const { t } = useTranslation();
  const when = actionTakenAt instanceof Date ? actionTakenAt : new Date(String(actionTakenAt));
  const whenLabel = actionTakenAt && !Number.isNaN(when.getTime()) ? formatDateTime(when) : null;

  return (
    <Block className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <Ban className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-title">{t('v3.jobs.review.discarded.title')}</h2>
      </div>
      {whenLabel ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.jobs.review.discarded.when', { when: whenLabel })}
        </p>
      ) : null}
      <p className="text-body text-muted-foreground">{t(`v3.jobs.review.discarded.${subject}`)}</p>
    </Block>
  );
}
