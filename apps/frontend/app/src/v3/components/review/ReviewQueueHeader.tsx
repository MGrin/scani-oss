import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { PageHeader } from '@scani/ui/v3/components/PageLayout';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  BALANCE_GAP_ANSWERED_PATH,
  BALANCE_GAP_REVIEW_PATH,
  TRANSFER_ANSWERED_PATH,
  TRANSFER_REVIEW_PATH,
  TRANSFER_RULES_PATH,
  V3_ROUTES,
} from '../../lib/routes';
import { BackLink } from '../BackLink';

const QUEUES = {
  transfers: {
    titleKey: 'v3.review.page.transfersTitle',
    viewLabelKey: 'v3.review.page.transferViewLabel',
    views: [
      { key: 'pending', path: TRANSFER_REVIEW_PATH, labelKey: 'v3.review.page.toClassify' },
      { key: 'answered', path: TRANSFER_ANSWERED_PATH, labelKey: 'v3.review.page.answered' },
      { key: 'rules', path: TRANSFER_RULES_PATH, labelKey: 'v3.review.page.rulesView' },
    ],
  },
  balances: {
    titleKey: 'v3.review.page.balancesTitle',
    viewLabelKey: 'v3.review.page.balanceViewLabel',
    views: [
      { key: 'pending', path: BALANCE_GAP_REVIEW_PATH, labelKey: 'v3.review.page.toExplain' },
      { key: 'answered', path: BALANCE_GAP_ANSWERED_PATH, labelKey: 'v3.review.page.answered' },
    ],
  },
} as const;

export type ReviewQueue = keyof typeof QUEUES;
export type ReviewQueueView<Q extends ReviewQueue> = (typeof QUEUES)[Q]['views'][number]['key'];

/**
 * Every review queue's views share one header (UI standard rules 1, 2 and 7,
 * SC-1433): back to Review above the title, and the queue, its answers and —
 * for transfers — its rules as a segmented control, the way Tokens and Bills
 * switch views. Until SC-1433 each transfer page put outline navigation
 * buttons in the header's action slot, which is the create action's place,
 * none of them led back, and the balance queue kept its answers in a
 * hand-made `<details>` under the list.
 */
export function ReviewQueueHeader<Q extends ReviewQueue>({
  queue,
  view,
}: {
  queue: Q;
  view: ReviewQueueView<Q>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const spec = QUEUES[queue];
  return (
    <>
      {/* Back link and title as one unit, spaced as `CaptureHeader` spaces
          them. As two page children they took the page's own gap and sat
          ~28px further apart than every capture screen (SC-1433). */}
      <div className="flex flex-col gap-2">
        <BackLink to={V3_ROUTES.review} label={t('v3.review.list.backToReview')} />
        <PageHeader title={t(spec.titleKey)} />
      </div>
      <Segmented
        value={view}
        onValueChange={(next) => {
          const target = spec.views.find((entry) => entry.key === next);
          if (target) navigate(target.path);
        }}
        aria-label={t(spec.viewLabelKey)}
      >
        {spec.views.map((entry) => (
          <SegmentedItem key={entry.key} value={entry.key}>
            {t(entry.labelKey)}
          </SegmentedItem>
        ))}
      </Segmented>
    </>
  );
}
