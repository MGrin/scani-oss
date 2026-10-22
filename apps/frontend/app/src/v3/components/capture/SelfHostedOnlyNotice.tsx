import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { V3_CAPTURE_ROUTES } from '../../lib/routes';
import { CaptureHeader } from './CaptureHeader';
import type { Integration } from './IntegrationsList';

// Each provider's own reason, in its own terms (design, SC-1731). Written out
// literally so the key check can see every key.
const REASON_KEYS: Record<string, string> = {
  bunq: 'v3.capture.integration.selfHostedOnlyReasonBunq',
  fio: 'v3.capture.integration.selfHostedOnlyReasonFio',
  investec: 'v3.capture.integration.selfHostedOnlyReasonInvestec',
};

/**
 * A service the hosted product lists and may not connect (SC-1729: bunq allows
 * its personal API key only in software the customer runs; SC-1731: Investec
 * issues credentials for the customer's own use). There is no form on purpose:
 * a field would invite a key this install must not hold.
 */
export function SelfHostedOnlyNotice({ integration }: { integration: Integration }) {
  const { t, i18n } = useTranslation();
  const name = integration.institution.name;
  const formats = integration.statementExportFormats;
  const reason = t(
    REASON_KEYS[integration.providerKey] ?? 'v3.capture.integration.selfHostedOnlyReasonOther',
    { name }
  );
  return (
    <PageLayout>
      <CaptureHeader
        title={t('v3.capture.integration.connectNamed', { name })}
        description={t('v3.capture.integration.selfHostedOnlyTitle')}
        backTo={V3_CAPTURE_ROUTES.integrations}
        backLabel={t('v3.capture.integration.allServices')}
      />
      <Block>
        <div className="flex flex-col gap-3 p-4">
          <p className="text-body text-muted-foreground">
            {formats.length > 0
              ? t('v3.capture.integration.selfHostedOnlyBodyExport', {
                  name,
                  reason,
                  formats: new Intl.ListFormat(i18n.language, { type: 'disjunction' }).format(
                    formats
                  ),
                })
              : t('v3.capture.integration.selfHostedOnlyBody', { name, reason })}
          </p>
          <Button asChild className="self-start">
            <Link to={V3_CAPTURE_ROUTES.fileImport}>
              {t('v3.capture.integrations.uploadInstead')}
            </Link>
          </Button>
        </div>
      </Block>
    </PageLayout>
  );
}
