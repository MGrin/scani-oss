import { ScaniLogo } from '@scani/ui/components/ScaniLogo';
import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Card, CardContent, CardDescription, CardHeader } from '@scani/ui/ui/card';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TwoFactorCodeForm } from '@/components/auth/TwoFactorCodeForm';
import { useAuth } from '@/contexts/AuthContext';
import { goToReturnTarget, safeReturnTo } from '@/lib/return-origins';
import { AuthPageExits } from '../components/AuthPageExits';

/**
 * `/sign-in/2fa`: where an email code or a magic link lands for an account
 * with 2FA on (SC-1646). The api has already set the challenge cookie; this
 * page only asks for the second factor. A challenge that expired is refused by
 * the api, and its message says to start again.
 */
export function TwoFactorChallenge() {
  const { t } = useTranslation();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnTo = safeReturnTo(searchParams.get('returnTo'), '/');
  useDocumentTitle(t('auth.twoFactor.title'));

  useEffect(() => {
    if (!loading && user) goToReturnTarget(returnTo, navigate);
  }, [loading, user, navigate, returnTo]);

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 py-12 px-4 sm:px-6 lg:px-8"
      style={{
        paddingTop: 'max(3rem, calc(3rem + var(--scani-inset-top, env(safe-area-inset-top, 0px))))',
        paddingBottom: 'max(3rem, calc(3rem + env(safe-area-inset-bottom)))',
        paddingLeft: 'max(1rem, calc(1rem + env(safe-area-inset-left)))',
        paddingRight: 'max(1rem, calc(1rem + env(safe-area-inset-right)))',
      }}
    >
      <div className="w-full max-w-md space-y-8 flex flex-col items-center">
        <div className="flex items-center gap-3">
          <ScaniLogo className="h-10 w-10" />
          <h1 className="text-3xl font-semibold tracking-tight">Scani</h1>
        </div>
        <Card className="w-full">
          <CardHeader className="space-y-1">
            <h2 className="text-2xl text-center font-semibold leading-none tracking-tight">
              {t('auth.twoFactor.title')}
            </h2>
            <CardDescription className="text-center">
              {t('auth.twoFactor.subtitle')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TwoFactorCodeForm
              allowTrustDevice
              onDone={() => goToReturnTarget(returnTo, navigate)}
            />
          </CardContent>
        </Card>
        <AuthPageExits />
      </div>
    </div>
  );
}
