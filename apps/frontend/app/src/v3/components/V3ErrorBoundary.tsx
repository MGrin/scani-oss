import { ErrorBoundary } from '@scani/ui/components/ErrorBoundary';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { reportClientError } from '@/lib/report-client-error';
import { V3_BASE } from '../lib/ui-version';

/**
 * v3's own crash boundary. Separate from v2's so a crash inside v3 can
 * never take v2 down with it, and so the recovery button returns to the
 * v3 home rather than dropping the user into the other interface.
 */
export function V3ErrorBoundary({ children }: { children: ReactNode }) {
  const { t } = useTranslation();

  return (
    <ErrorBoundary
      homeHref={V3_BASE}
      homeLabel={t('v3.common.errorBoundary.goHome')}
      onError={(error, info) => {
        void reportClientError({
          error,
          componentStack: info.componentStack ?? undefined,
        });
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
