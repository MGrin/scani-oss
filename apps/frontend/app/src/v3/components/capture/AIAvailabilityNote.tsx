import { Button } from '@scani/ui/ui/button';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { captureContextQuery } from '../../lib/capture';
import { V3_CAPTURE_ROUTES, V3_PAYMENT_ROUTES } from '../../lib/routes';
import { Callout } from '../Callout';

export function AIAvailabilityNote({
  state,
  invoice = false,
}: {
  state: 'unavailable' | 'transient' | 'unverified' | 'ready' | 'loading';
  invoice?: boolean;
}) {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  if (state === 'ready') return null;
  return (
    <Callout
      icon={Sparkles}
      role="status"
      action={
        <Button asChild variant="outline" size="sm">
          <Link
            to={
              invoice
                ? V3_PAYMENT_ROUTES.create
                : `${V3_CAPTURE_ROUTES.manualEntry}${captureContextQuery(params)}`
            }
          >
            {t('v3.capture.choice.manual')}
          </Link>
        </Button>
      }
    >
      <p className="text-muted-foreground">{t(`v3.capture.ai.${state}`)}</p>
    </Callout>
  );
}
