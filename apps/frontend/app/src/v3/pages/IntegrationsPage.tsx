import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { IntegrationsList } from '../components/capture/IntegrationsList';

/**
 * Pick the service to connect.
 *
 * `measure="wide"` rather than the form measure the rest of capture uses,
 * because this half of the flow is a *list* — the form is the next screen. That
 * split is the port's one structural change: v2 opens the credential fields in
 * a dialog over the grid, which on a 390px phone puts two secrets and a PEM
 * block behind the software keyboard inside a box that cannot scroll past it.
 *
 * The "CSV / OFX / Screenshot Import" card v2 tacks onto the bottom is gone.
 * That was a second entry point to a screen the Add sheet already offers under
 * the heading a person actually reaches for, and putting it here made this page
 * a menu of two unrelated things.
 */
export function IntegrationsPage() {
  const { t } = useTranslation();
  const integrationsQuery = trpc.integrations.listAvailable.useQuery();

  return (
    <PageLayout measure="wide">
      <CaptureHeader
        title={t('v3.capture.integration.title')}
        description={t('v3.capture.integration.listSubtitle')}
      />

      <IntegrationsList
        integrations={integrationsQuery.data ?? []}
        query={mergeQueries(integrationsQuery)}
      />
    </PageLayout>
  );
}
