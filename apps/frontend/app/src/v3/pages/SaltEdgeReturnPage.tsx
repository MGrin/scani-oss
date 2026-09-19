import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { V3_CAPTURE_ROUTES, V3_ROUTES } from '../lib/routes';

/**
 * Where Salt Edge's widget sends the reader back (SC-1244). The path is fixed
 * server-side in `saltedge.startConnect`, and Salt Edge appends `error_class`
 * when linking failed.
 *
 * The page claims nothing it cannot see: the import is enqueued by Salt Edge's
 * signed callback, not by this page loading, so it says the import runs in the
 * background rather than showing a job it does not know the id of.
 */
export function SaltEdgeReturnPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const errorClass = params.get('error_class');
  useDocumentTitle(t('v3.capture.integration.redirect.returnDocTitle'));

  if (errorClass) {
    return (
      <PageLayout>
        <CaptureHeader
          title={t('v3.capture.integration.redirect.failTitle')}
          description={t('v3.capture.integration.redirect.failBody', { reason: errorClass })}
          backTo={V3_CAPTURE_ROUTES.integrations}
          backLabel={t('v3.capture.integration.allServices')}
        />
        <Link
          to={`${V3_CAPTURE_ROUTES.integrations}/saltedge`}
          className="self-start text-label text-primary hover:underline"
        >
          {t('v3.capture.integration.redirect.tryAgain')}
        </Link>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <CaptureHeader
        title={t('v3.capture.integration.redirect.okTitle')}
        description={t('v3.capture.integration.redirect.okBody')}
        backTo={V3_CAPTURE_ROUTES.integrations}
        backLabel={t('v3.capture.integration.allServices')}
      />
      <Link to={V3_ROUTES.holdings} className="self-start text-label text-primary hover:underline">
        {t('v3.capture.integration.redirect.toHoldings')}
      </Link>
    </PageLayout>
  );
}
