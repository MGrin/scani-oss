import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { RecordMovementSheet } from '../components/holdings/RecordMovementSheet';
import { useRecordMovement } from '../hooks/useRecordMovement';
import { V3_ROUTES } from '../lib/routes';

/**
 * The global "record a movement" action (SC-607) — the second way into the
 * same flow.
 *
 * ## Why a route rather than a button somewhere
 *
 * It belongs in the capture sheet, beside every other way data gets into
 * Scani, and every destination behind that sheet is a route. Reaching it from
 * the centre tab is what makes it the surface for recording SEVERAL movements
 * across accounts in one sitting, which is the case the holding's own sheet
 * cannot serve: from there you are already inside one holding.
 *
 * ## Why this page is almost empty
 *
 * It picks the holding and hands off. The form, its validation and its submit
 * are `RecordMovementSheet` and `useRecordMovement`, unchanged and unaware of
 * which entry point mounted them — two entry points into one flow, not two
 * flows. What this page owns is the one thing the peek's version does not: on
 * dismissal there is no drawer to fall back to, so it leaves for the holdings
 * list rather than a blank screen.
 */
export function RecordMovementPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const holdingsQuery = trpc.holdings.getWithDetails.useQuery();
  const leave = () => navigate(V3_ROUTES.holdings, { replace: true });
  const movement = useRecordMovement(leave);

  return (
    <PageLayout>
      <h1 className="text-title">{t('v3.holdings.movement.title')}</h1>
      <RecordMovementSheet
        open
        onOpenChange={(open) => {
          if (!open) leave();
        }}
        holding={null}
        holdings={holdingsQuery.data?.holdings ?? []}
        isSaving={movement.isSaving}
        onSubmit={movement.submit}
      />
    </PageLayout>
  );
}
