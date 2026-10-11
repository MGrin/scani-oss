import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { V3_ROUTES } from '../lib/routes';

/**
 * Where a household invite lands, after sign-in (SC-1647). Accepting moves no
 * data: it only lets this account read what the other members share.
 */
export function HouseholdAcceptPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.household.accept.title'));
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const preview = trpc.household.previewInvite.useQuery({ token }, { enabled: token.length > 0 });
  const accept = trpc.household.accept.useMutation({
    onSuccess: (joined) => {
      showSuccess(t('v3.household.accept.joined', { name: joined.name }));
      void utils.household.mine.invalidate();
      navigate(V3_ROUTES.settings, { replace: true });
    },
    onError: (error) => showError(error, t('v3.household.accept.accepting')),
  });

  const closed = (key: string) => (
    <>
      <h2 className="text-title">{t(key)}</h2>
      <Button variant="outline" onClick={() => navigate(V3_ROUTES.home, { replace: true })}>
        {t('v3.household.accept.home')}
      </Button>
    </>
  );

  let body: ReactNode;
  if (!token || preview.error) {
    body = closed('v3.household.accept.invalid');
  } else if (!preview.data) {
    body = <LoadingSpinner />;
  } else if (preview.data.state === 'expired') {
    body = closed('v3.household.accept.expired');
  } else if (preview.data.state === 'revoked') {
    body = closed('v3.household.accept.revoked');
  } else if (preview.data.state === 'used') {
    body = closed('v3.household.accept.used');
  } else {
    body = (
      <>
        <h2 className="text-title">
          {t('v3.household.accept.heading', {
            inviter: preview.data.inviterName,
            household: preview.data.householdName,
          })}
        </h2>
        <p className="max-w-md text-body text-muted-foreground">
          {t('v3.household.accept.explain')}
        </p>
        <div className="flex gap-2">
          <Button disabled={accept.isPending} onClick={() => accept.mutate({ token })}>
            {t('v3.household.accept.accept')}
          </Button>
          <Button variant="ghost" onClick={() => navigate(V3_ROUTES.home, { replace: true })}>
            {t('v3.household.accept.notNow')}
          </Button>
        </div>
      </>
    );
  }

  return (
    <PageLayout>
      <PageHeader title={t('v3.household.accept.title')} />
      <div className="flex flex-col items-center gap-4 py-12 text-center">{body}</div>
    </PageLayout>
  );
}
