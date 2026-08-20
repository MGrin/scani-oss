import { Button } from '@scani/ui/ui/button';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { TransferRuleList } from '../components/review/TransferRuleList';
import { TRANSFER_REVIEW_PATH } from '../lib/routes';

/**
 * The standing rules about counterparty addresses, and the undo (SC-375).
 *
 * Its own page rather than a section of the queue for the reason the answered
 * list gets one: the queue's count reaching zero is the feedback that working
 * through it is finishing, and anything else on that page competes with it.
 * A rule is also not a transfer — it is a sentence about an address that
 * outlives every row it touches.
 */
export function TransferRulesPage() {
  const { t } = useTranslation();
  const rules = trpc.transferReview.rules.list.useQuery();
  const hidden = trpc.transferReview.rules.listHidden.useQuery();

  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.review.rules.title')}
        action={
          <Button asChild variant="outline">
            <Link to={TRANSFER_REVIEW_PATH}>{t('v3.review.answered.backToQueue')}</Link>
          </Button>
        }
      />
      <TransferRuleList rules={rules.data ?? []} hidden={hidden.data ?? []} />
    </PageLayout>
  );
}
